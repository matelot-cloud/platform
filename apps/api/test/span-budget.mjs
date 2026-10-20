#!/usr/bin/env node
/**
 * Span budget, end to end: the built api and worker (dist/, tracing preload on, OTEL_TRACES_EXPORTER=file) run a
 * security pipeline with a fake runner that behaves like the real one (traceparent on every call, log batches
 * unsampled) — the real http / express / pg / ioredis instrumentations, the trimming rules (telemetry/trim.ts), the
 * pipeline-level spans under service "matelot-pipeline". Fails when the pipeline's trace holds more than BUDGET spans,
 * when a /logs batch became a span, or when the root span is not where the docs say to search for it.
 *
 *   DATABASE_URL=… REDIS_URL=… node test/span-budget.mjs        (CI: api job, after the build; needs Postgres + Redis)
 * Prints the breakdown by span name so a regression shows where the spans come from.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET = Number(process.env.SPAN_BUDGET ?? 150);
const PORT = Number(process.env.SPAN_BUDGET_PORT ?? 3123);
const IDP_PORT = Number(process.env.FAKE_IDP_PORT ?? 8089);
const DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://platform:platform@localhost:5432/platform';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const MANAGED_SECRET = 'span-budget-managed-secret-0123456789abcdef';
const T = mkdtempSync(join(tmpdir(), 'span-budget-'));
const files = { api: join(T, 'api.jsonl'), worker: join(T, 'worker.jsonl') };
const children = [];
const log = (m) => process.stdout.write(`${m}\n`);

if (!existsSync(join(API_DIR, 'dist/telemetry/tracing.js'))) { console.error('build the api first (pnpm --filter @secops/api build)'); process.exit(2); }

function start(name, args, env, logFile) {
  const child = spawn(process.execPath, args, { cwd: API_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));
  child.on('exit', (code) => { if (code && !child.expected) { console.error(`${name} exited with ${code}:\n${out.slice(-20).join('')}`); } });
  children.push(child);
  return { child, out };
}
async function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null) return;
  child.expected = true;
  child.kill(signal);
  await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 15000); child.once('exit', () => { clearTimeout(t); r(); }); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 60000) { const d = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() > d) throw new Error(`timed out waiting for ${what}`); await sleep(500); } }

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
let token, runnerToken;
const base = `http://127.0.0.1:${PORT}/api/v1`;
async function api(path, body, auth = token, headers = {}) {
  const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

let orgId;
try {
  // 1. the fake identity provider, the api and the worker (their spans go to one file each)
  const idpUp = await fetch(`http://127.0.0.1:${IDP_PORT}/realms/platform/protocol/openid-connect/certs`).then((r) => r.ok).catch(() => false);
  if (!idpUp) start('fake-idp', ['test/fake-idp.js', 'serve'], { FAKE_IDP_PORT: String(IDP_PORT) });   // a developer's own instance is reused
  await waitFor(() => fetch(`http://127.0.0.1:${IDP_PORT}/realms/platform/protocol/openid-connect/certs`).then((r) => r.ok), 'fake idp');
  const env = {
    NODE_ENV: 'production', DATABASE_URL, REDIS_URL, PORT: String(PORT), KEYCLOAK_ISSUER: `http://localhost:${IDP_PORT}/realms/platform`, KEYCLOAK_AUDIENCE: 'platform-api',
    CELL_ENCRYPTION_KEY: '0000000000000000000000000000000000000000000000000000000000000001', BOOTSTRAP_ORG_SLUG: 'acme', BOOTSTRAP_ADMIN_EMAILS: 'admin@acme.local',
    MANAGED_RUNNER_SECRET: MANAGED_SECRET, MATELOT_METRICS_ENABLED: 'false', MATELOT_TRACING_ENABLED: 'true', OTEL_TRACES_EXPORTER: 'file', LOG_LEVEL: 'warn', APP_VERSION: 'span-budget',
  };
  execFileSync(process.execPath, ['dist/migrate.js'], { cwd: API_DIR, env: { ...process.env, ...env }, stdio: 'pipe' });
  start('api', ['-r', './dist/telemetry/tracing.js', 'dist/main.js'], { ...env, MATELOT_COMPONENT: 'api', OTEL_TRACES_FILE: files.api });
  start('worker', ['-r', './dist/telemetry/tracing.js', 'dist/worker.js'], { ...env, MATELOT_COMPONENT: 'worker', OTEL_TRACES_FILE: files.worker });
  await waitFor(() => fetch(`${base}/health/ready`).then((r) => r.ok), 'api ready', 90000);
  token = execFileSync(process.execPath, ['test/fake-idp.js', 'token', 'admin@acme.local'], { cwd: API_DIR, env: { ...process.env, FAKE_IDP_PORT: String(IDP_PORT) }, encoding: 'utf8' }).trim().split('\n').pop();
  await api('/me');   // first sign-in: the bootstrap admin exists from here on

  // 2. an organization with a service and a repository (what a security pipeline needs)
  const s = randomUUID().slice(0, 8);
  const seed = await db.query(`
    with org as (insert into organizations (slug, name) values ($1, 'Span budget') returning id),
    ws as (insert into workspaces (organization_id, slug, name) select id, 'w', 'w' from org returning id),
    tm as (insert into teams (workspace_id, slug, name) select id, 't', 't' from ws returning id),
    pj as (insert into projects (team_id, slug, name) select id, 'p', 'p' from tm returning id),
    sv as (insert into services (project_id, slug, name) select id, 'demo', 'demo' from pj returning id),
    ig as (insert into integrations (organization_id, scope_type, scope_id, provider, auth_type, name, status, external_account_id, settings) select id, 'ORGANIZATION', id, 'git', 'none', 'git', 'connected', $2, '{}'::jsonb from org returning id),
    rp as (insert into repositories (integration_id, external_id, full_name, default_branch, clone_url) select id, 'r', 'acme/demo', 'main', 'https://git.example.com/acme/demo.git' from ig returning id),
    link as (insert into service_repositories (service_id, repository_id) select sv.id, rp.id from sv, rp returning service_id)
    select (select id from org) as org, (select service_id from link) as service`, [`sb-${s}`, `sb-${s}`]);
  orgId = seed.rows[0].org;
  const serviceId = seed.rows[0].service;

  // 3. the pipeline, and a fake runner that behaves like the real one
  const pipeline = await api(`/services/${serviceId}/pipelines`, { template: 'security' });
  const traceId = pipeline.traceParent.split('-')[1];
  log(`pipeline ${pipeline.number} created, trace ${traceId}`);
  const reg = await api('/runner/register', { managedSecret: MANAGED_SECRET, name: `budget-runner-${s}`, tags: ['linux'], version: '0.3.3', metadata: { os: 'linux' } }, token);
  runnerToken = reg.runnerToken;
  const runnerCall = (path, body, traceparent) => api(path, body, runnerToken, traceparent ? { traceparent } : {});
  const deadline = Date.now() + 120000;
  let done = 0;
  while (Date.now() < deadline) {
    const job = await runnerCall('/runner/jobs/claim', { waitSeconds: 2 });
    if (!job) {
      const [{ status }] = (await db.query('select status from pipelines where id = $1', [pipeline.id])).rows;
      if (['succeeded', 'failed', 'cancelled'].includes(status)) break;
      continue;
    }
    if (job.pipelineId !== pipeline.id) {   // a stale job of a development database: not ours, hand it back finished
      await runnerCall(`/runner/jobs/${job.id}/complete`, { status: 'skipped', error: 'span-budget: not this pipeline' });
      continue;
    }
    // the real runner: its job span under job.traceParent, every call with the traceparent header, log batches unsampled
    const jobSpan = `00-${job.traceParent.split('-')[1]}-${randomUUID().replace(/-/g, '').slice(0, 16)}-01`;
    await runnerCall(`/runner/jobs/${job.id}/start`, {}, jobSpan);
    if (job.type !== 'sca') await runnerCall(`/runner/jobs/${job.id}/credentials`, {}, jobSpan);
    for (let b = 0; b < 4; b++) await runnerCall(`/runner/jobs/${job.id}/logs`, { chunks: [{ seq: b * 2, stream: 'stdout', content: `line ${b}\n` }, { seq: b * 2 + 1, stream: 'system', content: 'tick\n' }] }, jobSpan.replace(/-01$/, '-00'));
    if (job.type === 'sca') await runnerCall(`/runner/jobs/${job.id}/correlate`, {}, jobSpan).catch(() => undefined);
    await runnerCall(`/runner/jobs/${job.id}/complete`, { status: 'succeeded', result: job.type === 'repository_check' ? { commit: 'b7e1c0de'.padEnd(40, '0'), branch: 'main' } : {}, exitCode: 0 }, jobSpan);
    done++;
  }
  const final = (await db.query('select status from pipelines where id = $1', [pipeline.id])).rows[0].status;
  log(`${done} runner jobs completed; pipeline ${final} (the policy_eval job runs on the worker)`);
  if (!['succeeded', 'failed'].includes(final)) throw new Error(`pipeline did not finish: ${final}`);
  // empty polls: a runner asks for work every 20 s whether or not there is any; nothing is queued now, so these must
  // leave no span at all (the poll's own span is trimmed, the loop runs with instrumentation suppressed)
  const EMPTY_POLLS = 6;
  for (let i = 0; i < EMPTY_POLLS; i++) await runnerCall('/runner/jobs/claim', { waitSeconds: 0 });

  // 4. flush (SIGTERM → the 5 s-capped shutdown flush) and count
  for (const c of children.slice(1)) await stop(c);
  const spans = [files.api, files.worker].filter(existsSync).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const trace = spans.filter((x) => x.traceId === traceId);
  const byName = new Map();
  for (const x of trace) byName.set(`${x.service} · ${x.name}`, (byName.get(`${x.service} · ${x.name}`) ?? 0) + 1);
  log(`\n${trace.length} spans in the pipeline's trace (budget ${BUDGET}); by name:`);
  for (const [name, n] of [...byName].sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(4)}  ${name}`);
  const problems = [];
  if (trace.length > BUDGET) problems.push(`${trace.length} spans > budget ${BUDGET}`);
  const logs = trace.filter((x) => /\/logs$/.test(x.name));
  if (logs.length) problems.push(`${logs.length} /logs batch(es) became spans (the runner must send them unsampled)`);
  const root = trace.find((x) => !x.parentSpanId);
  if (!root) problems.push('no root span in the trace');
  else {
    if (root.name !== 'pipeline Security pipeline') problems.push(`root span is "${root.name}"`);
    if (root.service !== 'matelot-pipeline') problems.push(`root span under service "${root.service}" (docs say matelot-pipeline)`);
  }
  const jobSpans = trace.filter((x) => x.service === 'matelot-pipeline' && x.name.startsWith('job '));
  if (jobSpans.length !== 7) problems.push(`${jobSpans.length} job spans, expected 7 (one per job of the security template)`);
  // every runner job: its job span, the claim, /start and /complete — all in the pipeline's trace, none elsewhere
  const runnerKinds = ['repository_check', 'sbom', 'secrets', 'sca', 'sast', 'iac'];
  for (const kind of runnerKinds) {
    const jobSpan = jobSpans.find((x) => x.name === `job ${kind}`);
    if (!jobSpan) { problems.push(`job ${kind}: no job span in the pipeline trace`); continue; }
    const claim = trace.filter((x) => x.name === 'claim' && x.attributes['matelot.job.kind'] === kind);
    if (claim.length !== 1) problems.push(`job ${kind}: ${claim.length} claim span(s) in the pipeline trace, expected 1`);
    else if (claim[0].parentSpanId !== jobSpan.spanId) problems.push(`job ${kind}: the claim span is not under the job span`);
  }
  const startsInTrace = trace.filter((x) => x.name.endsWith('/:jobId/start')).length;
  const completesInTrace = trace.filter((x) => x.name.endsWith('/:jobId/complete')).length;
  if (startsInTrace !== runnerKinds.length || completesInTrace !== runnerKinds.length) problems.push(`${startsInTrace} /start and ${completesInTrace} /complete spans in the pipeline trace, expected ${runnerKinds.length} each`);
  const strays = spans.filter((x) => x.traceId !== traceId && (x.name.endsWith('/:jobId/start') || x.name.endsWith('/:jobId/complete') || x.name === 'claim') && (x.attributes['matelot.job.id'] ? jobSpans.some((j) => j.attributes['matelot.job.id'] === x.attributes['matelot.job.id']) : true));
  if (strays.length) problems.push(`${strays.length} /start, /complete or claim span(s) of this pipeline's jobs landed in another trace`);
  // the empty polls: zero spans — no root named after the claim route, no span at all after the pipeline finished
  const pollRoots = spans.filter((x) => /\/runner\/jobs\/claim$/.test(x.name));
  if (pollRoots.length) problems.push(`${pollRoots.length} claim poll span(s) exported (${EMPTY_POLLS} empty polls must add 0 spans)`);
  if (!trace.some((x) => x.name === 'gate evaluate' && x.service === 'matelot-worker')) problems.push('the worker\'s gate evaluation is not in the trace');
  const redis = trace.filter((x) => x.scope === '@opentelemetry/instrumentation-ioredis');
  if (redis.some((x) => x.durationMs < 5)) problems.push(`${redis.filter((x) => x.durationMs < 5).length} sub-5 ms Redis span(s) survived the trimming`);
  if (trace.some((x) => x.name === 'pg-pool.connect')) problems.push('pg-pool.connect spans survived the trimming');
  if (problems.length) { console.error(`\nspan budget FAILED:\n  ${problems.join('\n  ')}`); process.exitCode = 1; }
  else log(`\nspan budget ok: ${trace.length} ≤ ${BUDGET}; root "${root.name}" under ${root.service}; ${jobSpans.length} job spans; no /logs spans`);
} finally {
  for (const c of children) await stop(c);
  if (orgId) await db.query('delete from organizations where id = $1', [orgId]).catch(() => undefined);
  await db.end();
}
