import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, hostname, platform } from 'node:os';
import { join } from 'node:path';
import { isTransient, retryTransient } from './retry';
import { CellClient } from './client';
import type { RunnerConfig } from './protocol';
import { execute, LogShipper } from './executor';
import { JsonLogger, levelFromEnv, Metrics, setTracer, tracerFromEnv } from './telemetry';

const VERSION = '0.3.3';
const url = (process.env.RUNNER_URL ?? '').replace(/\/$/, '');
const dataDir = process.env.RUNNER_DATA_DIR ?? '/data';
const stateFile = join(dataDir, 'runner.json');
const name = process.env.RUNNER_NAME ?? hostname();
const tags = (process.env.RUNNER_TAGS ?? '').split(',').map((t) => t.trim()).filter(Boolean);

// observability (docs/observability.md): spans to OTEL_EXPORTER_OTLP_ENDPOINT when set, /metrics on RUNNER_METRICS_PORT
// (0 = off), JSON log lines with the trace id — the same resource attributes as the api and the worker
const resource = { 'service.name': 'matelot-runner', 'service.version': process.env.APP_VERSION ?? VERSION, 'deployment.environment': process.env.DEPLOYMENT_ENVIRONMENT ?? 'production', 'matelot.component': 'runner', 'matelot.runner.name': name, ...(process.env.MATELOT_CELL ? { 'matelot.cell': process.env.MATELOT_CELL } : {}) };
const tracer = tracerFromEnv(process.env, resource);
setTracer(tracer);
const logger = new JsonLogger({ component: 'runner', runner: name, ...(process.env.MATELOT_CELL ? { cell: process.env.MATELOT_CELL } : {}) }, tracer, levelFromEnv(process.env));
const metrics = new Metrics({ version: process.env.APP_VERSION ?? VERSION, commit: process.env.APP_COMMIT ?? 'unknown', node_version: process.version, component: 'runner' });

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
    logger.warn(`runner agent ${VERSION} is outdated; the cell ships ${config.latestVersion} — rebuild the image and recreate the container`);
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
  // Managed runners (RUNNER_MANAGED_SECRET) run in the cell without Kubernetes API access, so they never advertise the
  // `kubernetes` tag by themselves: cluster-inventory jobs stay on customer runners that can reach a cluster.
  const managedSecret = process.env.RUNNER_MANAGED_SECRET;
  const kubernetesCapable = kubectl && !managedSecret && (inCluster || !!process.env.KUBECONFIG || !!process.env.RUNNER_TAGS?.includes('kubernetes'));
  const autoTags = [...new Set([...tags, platform() === 'linux' ? 'linux' : platform(), ...(docker ? ['docker'] : []), ...(kubernetesCapable ? ['kubernetes'] : [])])];

  let state = await loadState();
  const client = new CellClient(url, state?.runnerToken ?? null);
  // Managed runners (the cell's own, Helm chart) register with the cell's managed secret on every start: the platform
  // replaces the record of the same name, so restarts and rescheduled pods never pile up offline duplicates.
  let stopping = false;
  const register = async () => {
    const registrationToken = process.env.RUNNER_REGISTRATION_TOKEN;
    if (!managedSecret && !registrationToken) throw new Error('Not registered: set RUNNER_REGISTRATION_TOKEN (from the Runners page) for the first start');
    // the cell may be down (restoring, upgrading, its ingress reloading): wait for it instead of exiting
    const reg = await retryTransient('registration', () => client.register(managedSecret ? { managedSecret } : { registrationToken: registrationToken! }, name, autoTags, VERSION, metadata), { until: () => stopping });
    applyConfig(reg.config);
    state = { runnerId: reg.runnerId, runnerToken: reg.runnerToken, url };
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
    client.setToken(reg.runnerToken);
    logger.info(`registered as ${name} in pool "${reg.pool.name}"${managedSecret ? ' (managed)' : ''} (tags: ${autoTags.join(', ') || 'none'})`);
  };
  if (managedSecret || !state || state.url !== url) await register();
  else logger.info(`resuming runner ${state.runnerId} (${name})`);
  /** A managed runner whose record was replaced or pruned gets 401: it registers again instead of failing forever. */
  const reRegisterOn401 = async (error: Error) => {
    if (!managedSecret || !/→ 401/.test(error.message)) return false;
    logger.warn('runner token no longer accepted; registering again with the managed secret');
    await register().catch((e: Error) => logger.error(`re-registration failed: ${e.message}`));
    return true;
  };

  // the open long-poll claim is aborted on shutdown: a stopped runner must not be handed a job it will never run
  const claimAbort = new AbortController();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    claimAbort.abort();
    logger.info('shutting down after the current job');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const metricsPort = Number(process.env.RUNNER_METRICS_PORT ?? 0);
  if (metricsPort > 0) await metrics.listen(metricsPort).then((p) => logger.info(`metrics on :${p}/metrics${tracer.enabled ? '; tracing on' : '; tracing off'}`)).catch((e: Error) => logger.warn(`metrics listener not started: ${e.message}`));
  metrics.set('matelot_runner_busy', {}, 0);

  const heartbeat = setInterval(() => void client.heartbeat(metadata, autoTags).then((r) => applyConfig(r?.config)).catch((e: Error) => logger.error(`heartbeat failed: ${e.message}`)), 15_000);
  await retryTransient('heartbeat', () => client.heartbeat(metadata, autoTags), { until: () => stopping }).then((r) => applyConfig(r?.config)).catch((e: Error) => logger.error(`heartbeat failed: ${e.message}`));

  while (!stopping) {
    let job;
    try {
      job = await client.claim(20, claimAbort.signal);
    } catch (error) {
      if (stopping) break;
      if (await reRegisterOn401(error as Error)) continue;
      logger.error(`claim failed: ${(error as Error).message}${isTransient(error) ? ' (cell unreachable; will keep trying)' : ''}`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!job) continue;
    if (stopping) break; // never start a job after SIGTERM (the platform takes back an unstarted assignment)

    // the job's span, under the pipeline's trace the cell fixed for it (job.traceParent); phases are its children
    const span = tracer.start(`job run ${job.type}`, job.traceParent ?? null, { 'matelot.job.id': job.id, 'matelot.job.kind': job.type, 'matelot.job.attempt': job.attempts, 'matelot.runner.name': name });
    const jobStarted = Date.now();
    await tracer.run(span, async () => {
    logger.info(`job ${job.id} (${job.type}) assigned`, { job: job.id, kind: job.type });
    metrics.set('matelot_runner_busy', {}, 1);
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
        .catch((e: Error) => logger.error(`job heartbeat failed: ${e.message}`));
    }, 20_000);
    const timeout = setTimeout(() => {
      log.system(`timeout after ${job.timeoutSeconds}s`);
      controller.abort();
    }, job.timeoutSeconds * 1000);
    let status = 'failed';
    try {
      await client.start(job.id);
      log.system(`runner ${name} v${VERSION} starting ${job.type} (attempt ${job.attempts})`);
      const { result } = await execute(job, client, log, controller.signal);
      log.system('done');
      await log.close();
      await client.complete(job.id, 'succeeded', result, undefined, 0);
      status = 'succeeded';
      span.setAttribute('matelot.job.exit_code', 0);
      logger.info(`job ${job.id} succeeded`, { job: job.id, kind: job.type, seconds: Math.round((Date.now() - jobStarted) / 1000) });
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const skipped = !!(error as { skipped?: boolean }).skipped;
      status = skipped ? 'skipped' : 'failed';
      const exitCode = skipped ? undefined : ((error as { exitCode?: number }).exitCode ?? 1);
      span.setAttribute('matelot.job.exit_code', exitCode ?? null);
      log.system(skipped ? `skipped: ${message}` : `failed: ${message}`);
      await log.close();
      await client.complete(job.id, skipped ? 'skipped' : 'failed', undefined, message, exitCode).catch((e: Error) => logger.error(`complete failed: ${e.message}`));
      logger.error(`job ${job.id} ${status}: ${message}`, { job: job.id, kind: job.type });
      if (!skipped) throw error;   // ends the span with the error status
    } finally {
      clearInterval(lease);
      clearTimeout(timeout);
      span.setAttribute('matelot.job.status', status);
      metrics.set('matelot_runner_busy', {}, 0);
      metrics.inc('matelot_runner_jobs_total', { kind: job.type, status });
      metrics.observe('matelot_runner_job_duration_seconds', { kind: job.type, phase: 'total' }, (Date.now() - jobStarted) / 1000, span.sampled && tracer.enabled ? { traceId: span.traceId, spanId: span.spanId } : undefined);
    }
    }).catch(() => undefined);   // the failure is reported above; the loop goes on
  }
  clearInterval(heartbeat);
  await metrics.close();
  await tracer.shutdown(5000);   // the last spans leave before the process does (SIGTERM on a pod rollout)
}

main().catch((error: Error) => {
  logger.error(error.message);
  process.exit(1);
});
