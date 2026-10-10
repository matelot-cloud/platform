import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, hostname, platform } from 'node:os';
import { join } from 'node:path';
import { CellClient } from './client';
import type { RunnerConfig } from './protocol';
import { execute, LogShipper } from './executor';

const VERSION = '0.3.1';
const url = (process.env.RUNNER_URL ?? '').replace(/\/$/, '');
const dataDir = process.env.RUNNER_DATA_DIR ?? '/data';
const stateFile = join(dataDir, 'runner.json');
const name = process.env.RUNNER_NAME ?? hostname();
const tags = (process.env.RUNNER_TAGS ?? '').split(',').map((t) => t.trim()).filter(Boolean);

interface State {
  runnerId: string;
  runnerToken: string;
  url: string;
}

async function loadState(): Promise<State | null> {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8')) as State;
  } catch {
    return null;
  }
}

async function hasDocker(): Promise<boolean> {
  const { run } = await import('./git');
  return run('docker', ['version', '--format', '{{.Server.Version}}'], {}).then((r) => r.code === 0).catch(() => false);
}

let announcedVersion = '';
/** Configuration pushed by the cell: registry host aliases (merged with REGISTRY_HOST_ALIASES) and the latest agent version. */
function applyConfig(config?: RunnerConfig) {
  if (!config) return;
  const own = (process.env.REGISTRY_HOST_ALIASES_LOCAL ??= process.env.REGISTRY_HOST_ALIASES ?? '');
  const fromCell = Object.entries(config.registryHostAliases ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
  process.env.REGISTRY_HOST_ALIASES = [own, fromCell].filter(Boolean).join(',');
  if (config.latestVersion && config.latestVersion !== VERSION && announcedVersion !== config.latestVersion) {
    announcedVersion = config.latestVersion;
    console.warn(`runner agent ${VERSION} is outdated; the cell ships ${config.latestVersion} — rebuild the image and recreate the container`);
  }
}

async function main() {
  if (!url) throw new Error('RUNNER_URL is required (e.g. https://secops.example.com/api/v1)');
  await mkdir(dataDir, { recursive: true });
  const docker = await hasDocker();
  const { run } = await import('./git');
  const kubectl = await run('kubectl', ['version', '--client', '-o', 'json'], {}).then((r) => r.code === 0).catch(() => false);
  const syft = await run('syft', ['version'], {}).then((r) => r.code === 0).catch(() => false);
  const inCluster = !!process.env.KUBERNETES_SERVICE_HOST;
  const container = existsSync('/.dockerenv') || inCluster;
  const metadata = { os: platform(), arch: arch(), hostname: hostname(), docker, kubectl, syft, inCluster, container, version: VERSION };
  const autoTags = [...new Set([...tags, platform() === 'linux' ? 'linux' : platform(), ...(docker ? ['docker'] : []), ...(kubectl && (inCluster || process.env.KUBECONFIG || process.env.RUNNER_TAGS?.includes('kubernetes')) ? ['kubernetes'] : [])])];

  let state = await loadState();
  const client = new CellClient(url, state?.runnerToken ?? null);
  // Managed runners (the cell's own, Helm chart) register with the cell's managed secret on every start: the platform
  // replaces the record of the same name, so restarts and rescheduled pods never pile up offline duplicates.
  const managedSecret = process.env.RUNNER_MANAGED_SECRET;
  const register = async () => {
    const registrationToken = process.env.RUNNER_REGISTRATION_TOKEN;
    if (!managedSecret && !registrationToken) throw new Error('Not registered: set RUNNER_REGISTRATION_TOKEN (from the Runners page) for the first start');
    const reg = await client.register(managedSecret ? { managedSecret } : { registrationToken: registrationToken! }, name, autoTags, VERSION, metadata);
    applyConfig(reg.config);
    state = { runnerId: reg.runnerId, runnerToken: reg.runnerToken, url };
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
    client.setToken(reg.runnerToken);
    console.log(`registered as ${name} in pool "${reg.pool.name}"${managedSecret ? ' (managed)' : ''} (tags: ${autoTags.join(', ') || 'none'})`);
  };
  if (managedSecret || !state || state.url !== url) await register();
  else console.log(`resuming runner ${state.runnerId} (${name})`);
  /** A managed runner whose record was replaced or pruned gets 401: it registers again instead of failing forever. */
  const reRegisterOn401 = async (error: Error) => {
    if (!managedSecret || !/→ 401/.test(error.message)) return false;
    console.warn('runner token no longer accepted; registering again with the managed secret');
    await register().catch((e: Error) => console.error(`re-registration failed: ${e.message}`));
    return true;
  };

  let stopping = false;
  // the open long-poll claim is aborted on shutdown: a stopped runner must not be handed a job it will never run
  const claimAbort = new AbortController();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    claimAbort.abort();
    console.log('shutting down after the current job');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const heartbeat = setInterval(() => void client.heartbeat(metadata, autoTags).then((r) => applyConfig(r?.config)).catch((e: Error) => console.error(`heartbeat failed: ${e.message}`)), 15_000);
  await client.heartbeat(metadata, autoTags).then((r) => applyConfig(r?.config)).catch((e: Error) => console.error(`heartbeat failed: ${e.message}`));

  while (!stopping) {
    let job;
    try {
      job = await client.claim(20, claimAbort.signal);
    } catch (error) {
      if (stopping) break;
      if (await reRegisterOn401(error as Error)) continue;
      console.error(`claim failed: ${(error as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!job) continue;
    if (stopping) break; // never start a job after SIGTERM (the platform takes back an unstarted assignment)

    console.log(`job ${job.id} (${job.type}) assigned`);
    const log = new LogShipper(client, job.id);
    const controller = new AbortController();
    const lease = setInterval(() => {
      void client
        .jobHeartbeat(job.id)
        .then((r) => {
          if (r.cancelled) {
            log.system('cancelled by the platform');
            controller.abort();
          }
        })
        .catch((e: Error) => console.error(`job heartbeat failed: ${e.message}`));
    }, 20_000);
    const timeout = setTimeout(() => {
      log.system(`timeout after ${job.timeoutSeconds}s`);
      controller.abort();
    }, job.timeoutSeconds * 1000);
    try {
      await client.start(job.id);
      log.system(`runner ${name} v${VERSION} starting ${job.type} (attempt ${job.attempts})`);
      const { result } = await execute(job, client, log, controller.signal);
      log.system('done');
      await log.close();
      await client.complete(job.id, 'succeeded', result, undefined, 0);
      console.log(`job ${job.id} succeeded`);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const skipped = !!(error as { skipped?: boolean }).skipped;
      log.system(skipped ? `skipped: ${message}` : `failed: ${message}`);
      await log.close();
      await client.complete(job.id, skipped ? 'skipped' : 'failed', undefined, message, skipped ? undefined : ((error as { exitCode?: number }).exitCode ?? 1)).catch((e: Error) => console.error(`complete failed: ${e.message}`));
      console.error(`job ${job.id} ${skipped ? 'skipped' : 'failed'}: ${message}`);
    } finally {
      clearInterval(lease);
      clearTimeout(timeout);
    }
  }
  clearInterval(heartbeat);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
