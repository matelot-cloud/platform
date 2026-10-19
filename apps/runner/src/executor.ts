import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CellClient } from './client';
import { parseSemgrep, parseTrivy } from './code-scan';
import { gitEnvironment, run, sanitize } from './git';
import type { Credentials, Job, LogChunk } from './protocol';
import { phase } from './telemetry';

/** Collects log lines and ships them to the cell in batches. */
export class LogShipper {
  private seq = 0;
  private buffer: LogChunk[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly client: CellClient,
    private readonly jobId: string,
  ) {
    this.timer = setInterval(() => void this.flush(), 1000);
  }

  write(stream: LogChunk['stream'], content: string) {
    if (!content) return;
    this.buffer.push({ seq: this.seq++, stream, content: sanitize(content) });
    if (this.buffer.length >= 50) void this.flush();
  }

  system(message: string) {
    this.write('system', `${message}\n`);
  }

  async flush() {
    if (!this.buffer.length) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await this.client.logs(this.jobId, batch);
    } catch (error) {
      this.buffer.unshift(...batch);
      process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'error', component: 'runner', msg: `log upload failed: ${(error as Error).message}` })}\n`);
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

async function countFiles(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await countFiles(full);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files++;
      bytes += (await stat(full)).size;
    }
  }
  return { files, bytes };
}

async function clone(job: Job, credentials: Credentials, workspace: string, log: LogShipper, signal: AbortSignal): Promise<string> {
  if (credentials.kind === 'none') throw new Error('job has no repository');
  const target = join(workspace, 'repo');
  const ref = String(job.payload.ref ?? credentials.defaultBranch ?? '');
  const isSha = /^[0-9a-f]{7,40}$/i.test(ref);
  log.system(`cloning ${credentials.fullName}${ref ? ` @ ${ref}` : ''} over ${credentials.kind}`);
  const { env, cleanup } = await gitEnvironment(credentials);
  try {
    if (isSha) {
      // A specific commit (pipeline on push): init + fetch the commit by hash (GitHub/GitLab allow it), fall back to a full fetch.
      await run('git', ['init', '-q', target], { env, signal });
      await run('git', ['-C', target, 'remote', 'add', 'origin', credentials.url], { env, signal });
      let fetched = await run('git', ['-C', target, 'fetch', '--depth', '1', 'origin', ref], { env, signal, onLine: (s, l) => log.write(s, l) });
      if (fetched.code !== 0) {
        log.system('shallow fetch by commit refused by the host; fetching the whole repository');
        fetched = await run('git', ['-C', target, 'fetch', 'origin'], { env, signal, onLine: (s, l) => log.write(s, l) });
        if (fetched.code !== 0) throw new Error(`git fetch failed (${fetched.code}): ${sanitize(fetched.stderr.trim().split('\n').slice(-2).join(' '))}`);
      }
      const co = await run('git', ['-C', target, 'checkout', '-q', 'FETCH_HEAD'], { env, signal });
      if (co.code !== 0) {
        const co2 = await run('git', ['-C', target, 'checkout', '-q', ref], { env, signal });
        if (co2.code !== 0) throw new Error(`git checkout ${ref} failed: ${sanitize(co2.stderr.trim())}`);
      }
    } else {
      const args = ['clone', '--depth', String(job.payload.depth ?? 1), '--no-tags', ...(ref ? ['--branch', ref] : []), credentials.url, target];
      const result = await run('git', args, { env, signal, onLine: (s, l) => log.write(s, l) });
      if (result.code !== 0) throw new Error(`git clone failed (${result.code}): ${sanitize(result.stderr.trim().split('\n').slice(-2).join(' '))}`);
    }
  } finally {
    await cleanup();
  }
  return target;
}

/** Job types the agent knows. Later steps add sbom, sca, sast … as separate modules. */
/** REGISTRY_HOST_ALIASES: comma-separated "from=to" host mappings applied to image references (dev: localhost:5000=host.docker.internal:5000). */
function aliasRegistryHost(ref: string): string {
  const map = (process.env.REGISTRY_HOST_ALIASES ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('=') as [string, string]);
  const slash = ref.indexOf('/');
  const host = slash === -1 ? ref : ref.slice(0, slash);
  const to = map.find(([from]) => from.toLowerCase() === host.toLowerCase())?.[1];
  return to ? to + (slash === -1 ? '' : ref.slice(slash)) : ref;
}

export async function execute(job: Job, client: CellClient, log: LogShipper, signal: AbortSignal): Promise<{ result: Record<string, unknown> }> {
  const workspace = await mkdtemp(join(process.env.RUNNER_WORKDIR ?? tmpdir(), 'job-'));
  try {
    switch (job.type) {
      case 'repository_check': {
        const credentials = await client.credentials(job.id);
        const repo = await phase('checkout', () => clone(job, credentials, workspace, log, signal));
        const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
        const date = (await run('git', ['log', '-1', '--format=%cI'], { cwd: repo })).stdout.trim();
        const author = (await run('git', ['log', '-1', '--format=%an'], { cwd: repo })).stdout.trim();
        const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).stdout.trim();
        const size = await countFiles(repo);
        log.system(`HEAD ${head.slice(0, 12)} on ${branch}, ${size.files} files, ${(size.bytes / 1024).toFixed(0)} KiB`);
        return { result: { commit: head, branch, committedAt: date, author, files: size.files, bytes: size.bytes } };
      }
      case 'custom': {
        const command = String(job.payload.command ?? '');
        if (!command) throw new Error('custom job needs payload.command');
        let cwd = workspace;
        if (job.repositoryId) {
          const credentials = await client.credentials(job.id);
          cwd = await phase('checkout', () => clone(job, credentials, workspace, log, signal));
        }
        log.system(`$ ${command}`);
        const result = await run('sh', ['-c', command], { cwd, signal, onLine: (s, l) => log.write(s, l) });
        if (result.code !== 0) throw Object.assign(new Error(`command exited with ${result.code}`), { exitCode: result.code });
        return { result: { exitCode: 0 } };
      }
      case 'sbom': {
        const target = String(job.payload.target ?? (job.payload.imageRef ? 'image' : 'source')) as 'source' | 'image';
        const output = join(workspace, 'bom.cdx.json');
        const syftEnv: NodeJS.ProcessEnv = { ...process.env, SYFT_CHECK_FOR_APP_UPDATE: 'false' };
        let targetRef: string;
        let scanTarget: string;
        let version: string | undefined;
        let imageRef: string | undefined;
        if (target === 'image') {
          imageRef = String(job.payload.imageRef ?? '');
          if (!imageRef) throw new Error('sbom image job needs payload.imageRef');
          // Inside Docker, "localhost:5000" is the container itself: REGISTRY_HOST_ALIASES="localhost:5000=host.docker.internal:5000" maps hosts.
          const aliased = aliasRegistryHost(imageRef);
          if (aliased !== imageRef) log.system(`registry host alias: ${imageRef.split('/')[0]} → ${aliased.split('/')[0]}`);
          const reg = await client.registryCredentials(job.id);
          if (reg.kind === 'registry') {
            syftEnv.SYFT_REGISTRY_AUTH_AUTHORITY = aliasRegistryHost(reg.host);
            syftEnv.SYFT_REGISTRY_AUTH_USERNAME = reg.username;
            syftEnv.SYFT_REGISTRY_AUTH_PASSWORD = reg.secret;
            log.system(`using registry credentials for ${aliasRegistryHost(reg.host)}`);
          }
          if (/^(localhost|127\.0\.0\.1|host\.docker\.internal)(:|\/)/.test(aliased) || /^[^/]+:\d+\//.test(aliased) && !aliased.includes('.')) syftEnv.SYFT_REGISTRY_INSECURE_USE_HTTP = 'true';
          targetRef = imageRef;
          scanTarget = `registry:${aliased}`;
          version = job.payload.version ? String(job.payload.version) : undefined;
        } else {
          const credentials = await client.credentials(job.id);
          const repo = await phase('checkout', () => clone(job, credentials, workspace, log, signal));
          const ref = String(job.payload.ref ?? (credentials.kind !== 'none' ? credentials.defaultBranch ?? 'HEAD' : 'HEAD'));
          targetRef = `${credentials.kind !== 'none' ? credentials.fullName : 'source'}@${ref}`;
          scanTarget = `dir:${repo}`;
          version = job.payload.version ? String(job.payload.version) : /^v?\d+\.\d+/.test(ref) ? ref : undefined;
        }
        log.system(`syft ${scanTarget}`);
        const result = await phase('tool syft', () => run('syft', [scanTarget, '-o', `cyclonedx-json=${output}`], { env: syftEnv, signal, onLine: (s, l) => log.write(s, l) }), { 'matelot.tool': 'syft' });
        if (result.code !== 0) {
          const lines = `${result.stderr}\n${result.stdout}`.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter((l) => l && !/checking for.*update|newer version/i.test(l));
          const reason = lines.filter((l) => /error|fail|denied|unauthorized|refused|not found|no such|timeout|unable/i.test(l)).slice(-2).join(' · ') || lines.slice(-2).join(' · ');
          throw new Error(`syft failed (${result.code}): ${sanitize(reason) || 'no output'}`);
        }
        const document = JSON.parse(await readFile(output, 'utf8')) as { components?: unknown[] };
        const count = document.components?.length ?? 0;
        log.system(`${count} components found; uploading`);
        const stored = await phase('upload sbom', () => client.sbom(job.id, { target, targetRef, version, imageRef, document }));
        log.system(stored.deduplicated ? 'identical SBOM already stored' : `stored SBOM ${stored.id} (${stored.componentCount} components${stored.releaseId ? ', linked to release' : ''})`);
        return { result: { sbomId: stored.id, components: stored.componentCount, target, targetRef, linkedToRelease: !!stored.releaseId } };
      }
      case 'kubernetes_inventory': {
        const namespace = String(job.payload.namespace ?? '');
        if (!namespace) throw new Error('kubernetes_inventory needs payload.namespace');
        const context = job.payload.context ? ['--context', String(job.payload.context)] : [];
        log.system(`listing workloads in namespace ${namespace}${context.length ? ` (context ${context[1]})` : ''}`);
        const kinds = ['deployments', 'statefulsets', 'daemonsets', 'cronjobs'];
        const workloads: { name: string; kind: string; replicas?: number; images: string[] }[] = [];
        for (const kind of kinds) {
          const result = await run('kubectl', [...context, '-n', namespace, 'get', kind, '-o', 'json'], { signal, onLine: (s, l) => (s === 'stderr' ? log.write('stderr', l) : undefined) });
          if (result.code !== 0) throw new Error(`kubectl get ${kind} failed (${result.code}): ${result.stderr.trim().split('\n').slice(-1)[0]}`);
          const list = JSON.parse(result.stdout) as { items: { metadata: { name: string }; spec: Record<string, unknown> }[] };
          for (const item of list.items) {
            const spec = item.spec as { replicas?: number; template?: { spec?: { containers?: { image: string }[] } }; jobTemplate?: { spec?: { template?: { spec?: { containers?: { image: string }[] } } } } };
            const containers = spec.template?.spec?.containers ?? spec.jobTemplate?.spec?.template?.spec?.containers ?? [];
            workloads.push({ name: item.metadata.name, kind: kind.replace(/s$/, ''), replicas: spec.replicas, images: containers.map((c) => c.image) });
          }
        }
        // Running pods tell us the resolved digests when the cluster reports them.
        const pods = await run('kubectl', [...context, '-n', namespace, 'get', 'pods', '-o', 'json'], { signal });
        const digests = new Map<string, string>();
        if (pods.code === 0) {
          const list = JSON.parse(pods.stdout) as { items: { status?: { containerStatuses?: { image: string; imageID: string }[] } }[] };
          for (const pod of list.items) for (const c of pod.status?.containerStatuses ?? []) if (c.imageID.includes('@sha256:')) digests.set(c.image, c.imageID.replace(/^docker-pullable:\/\//, ''));
        }
        for (const w of workloads) w.images = w.images.map((i) => digests.get(i) ?? i);
        log.system(`${workloads.length} workloads, ${workloads.reduce((n, w) => n + w.images.length, 0)} container images`);
        return { result: { namespace, workloads } };
      }
      case 'secrets':
      case 'iac': {
        const scanner = job.type === 'secrets' ? 'secret' : 'misconfig';
        const version = await phase('tool trivy --version', () => run('trivy', ['--version'], { signal })).catch(() => ({ code: 127, stdout: '', stderr: '' }));
        if (version.code !== 0) throw Object.assign(new Error('trivy is not installed on this runner (use the runner image, or install trivy)'), { skipped: true });
        const credentials = await client.credentials(job.id);
        const repo = await phase('checkout', () => clone(job, credentials, workspace, log, signal));
        const output = join(workspace, `${job.type}.json`);
        // Offline: secret rules are built in; misconfiguration checks use the bundle embedded in the binary.
        const args = ['fs', '--scanners', scanner, '--format', 'json', '--output', output, '--quiet', '--skip-db-update', '--skip-java-db-update', ...(scanner === 'misconfig' ? ['--skip-check-update'] : []), '--exit-code', '0', repo];
        log.system(`trivy ${args.filter((a) => a !== repo).join(' ')} <repository>`);
        const result = await phase('tool trivy', () => run('trivy', args, { env: { ...process.env, TRIVY_NO_PROGRESS: 'true', TRIVY_CACHE_DIR: join(workspace, '.trivy') }, signal, onLine: (s, l) => log.write(s, l) }), { 'matelot.tool': 'trivy' });
        if (result.code !== 0) throw new Error(`trivy failed (${result.code}): ${sanitize(result.stderr.trim().split('\n').slice(-2).join(' · ')) || 'no output'}`);
        const report = JSON.parse(await readFile(output, 'utf8')) as Parameters<typeof parseTrivy>[0];
        // Paths relative to the repository root.
        for (const r of report.Results ?? []) r.Target = r.Target.replace(`${repo}/`, '');
        const findings = parseTrivy(report);
        const bySeverity = findings.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {});
        log.system(`${findings.length} ${job.type === 'secrets' ? 'secrets' : 'misconfigurations'} found${findings.length ? ` (${Object.entries(bySeverity).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}; uploading`);
        const ref = String(job.payload.ref ?? (credentials.kind !== 'none' ? credentials.defaultBranch ?? 'HEAD' : 'HEAD'));
        const stored = await phase('upload findings', () => client.codeFindings(job.id, { kind: job.type === 'secrets' ? 'secret' : 'iac', ref, findings }));
        log.system(`${stored.opened} new, ${stored.seen} already known, ${stored.fixed} fixed since the last scan`);
        return { result: { kind: job.type, findings: findings.length, bySeverity, opened: stored.opened, fixed: stored.fixed } };
      }
      case 'sca': {
        // Dependency vulnerabilities = SBOM × advisories: ask the platform to correlate now (it waits for the run) and
        // report what the pipeline's SBOM carries, so the pipeline shows real numbers and the gate stage has fresh data.
        log.system('correlating the service SBOMs against the advisory sources (OSV / NVD / KEV / EPSS)…');
        const r = await phase('correlate', () => client.correlate(job.id));
        if (!r.sbomId) { log.system('no SBOM for this service yet: run the inventory stage first'); return { result: { correlated: r.result, sbomId: null } }; }
        const f = r.findings ?? { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, packages: 0 };
        log.system(`SBOM ${r.sbomId.slice(0, 8)} · ${r.components ?? '?'} components · open vulnerabilities: ${f.critical} critical · ${f.high} high · ${f.medium} medium · ${f.low} low · ${f.unknown} unknown (${f.packages} package findings)`);
        log.system('policies decide in the next stage; details under Vulnerabilities → Dependencies');
        return { result: { correlated: r.result, sbomId: r.sbomId, components: r.components, findings: f } };
      }
      case 'sast': {
        // Static analysis with Semgrep (installed in the runner image). Rules: payload.config (a registry pack such as
        // p/ci, p/security-audit, or a path/URL), default "auto" when the runner has network, else the bundled p/ci.
        const version = await phase('tool semgrep --version', () => run('semgrep', ['--version'], { signal })).catch(() => ({ code: 127, stdout: '', stderr: '' }));
        if (version.code !== 0) throw Object.assign(new Error('semgrep is not installed on this runner (use the runner image, or pip install semgrep)'), { skipped: true });
        const credentials = await client.credentials(job.id);
        const repo = await phase('checkout', () => clone(job, credentials, workspace, log, signal));
        const output = join(workspace, 'sast.json');
        // Rules: p/security-audit (broad, security-focused) + p/secrets by default; `auto` only when asked. Several
        // --config flags are allowed; each is a registry pack (p/…), a path, or a URL. p/python found 2 of 4 planted issues,
        // p/security-audit found all 4 — hence the default.
        const configs = String(job.payload.config ?? process.env.SEMGREP_CONFIG ?? 'p/security-audit,p/secrets').split(',').map((c) => c.trim()).filter(Boolean);
        const config = configs.join(',');
        const args = ['scan', ...configs.flatMap((c) => ['--config', c]), '--json', '--output', output, '--quiet', '--metrics=off', '--disable-version-check', '--timeout', '120', repo];
        log.system(`semgrep ${args.filter((a) => a !== repo).join(' ')} <repository> (v${version.stdout.trim()})`);
        const result = await phase('tool semgrep', () => run('semgrep', args, { env: { ...process.env, SEMGREP_SEND_METRICS: 'off' }, signal, onLine: (st, l) => log.write(st, l) }), { 'matelot.tool': 'semgrep' });
        // exit 0 = clean, 1 = findings (we do not use --error), anything else = failure
        if (result.code !== 0 && result.code !== 1) throw new Error(`semgrep failed (${result.code}): ${sanitize(result.stderr.trim().split('\n').slice(-2).join(' · ')) || 'no output'}`);
        const report = JSON.parse(await readFile(output, 'utf8')) as Parameters<typeof parseSemgrep>[0];
        for (const e of report.errors ?? []) if (e.message) log.system(`semgrep: ${sanitize(e.message).slice(0, 200)}`);
        const ruleCount = (report as { paths?: { scanned?: string[] } }).paths?.scanned?.length;
        log.system(`rules: ${config}${report.results !== undefined ? ` · ${new Set((report.results ?? []).map((r) => r.check_id)).size} rule(s) matched` : ''}${ruleCount !== undefined ? ` · ${ruleCount} file(s) scanned` : ''}`);
        const findings = parseSemgrep(report, repo);
        const bySeverity = findings.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {});
        log.system(`${findings.length} code finding${findings.length === 1 ? '' : 's'}${findings.length ? ` (${Object.entries(bySeverity).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}`);
        const ref = String(job.payload.ref ?? (credentials.kind !== 'none' ? credentials.defaultBranch ?? 'HEAD' : 'HEAD'));
        const stored = await phase('upload findings', () => client.codeFindings(job.id, { kind: 'sast', ref, findings }));
        log.system(`${stored.opened} new, ${stored.seen} already known, ${stored.fixed} fixed since the last scan`);
        return { result: { kind: 'sast', findings: findings.length, bySeverity, opened: stored.opened, fixed: stored.fixed } };
      }
      default:
        throw Object.assign(new Error(`job type ${job.type} is not available in this runner version (arrives with a later platform step)`), { skipped: true });
    }
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
