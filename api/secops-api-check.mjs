#!/usr/bin/env node
/**
 * secops-api-check — calls every GET endpoint of the platform with your token and reports what works.
 *
 *   export SECOPS_URL=http://localhost:3000   SECOPS_TOKEN=spt_…        (personal access token)
 *   node secops-api-check.mjs [--org <id>] [--project <id>] [--service <id>] [--only <tag>] [--verbose] [--json]
 *
 * The list of endpoints comes from the platform's own OpenAPI document (/api/docs-json), so it always
 * covers everything the running version exposes. Ids are discovered from list responses. Read-only:
 * only GET requests are sent. Exit code 1 when anything fails (401 / 5xx / unexpected 4xx).
 */
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined; };
const BASE = (process.env.SECOPS_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.SECOPS_TOKEN ?? '';
if (!BASE || !TOKEN) { console.error('Set SECOPS_URL and SECOPS_TOKEN (a personal access token, spt_…)'); process.exit(2); }
const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' };
const color = process.stdout.isTTY && !flag('json');
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

async function call(path) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: r.status, ms: Date.now() - t0, body };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, body: String(e.cause?.code ?? e.message) };
  }
}

// ids we know, by path parameter name
const ids = {};
const setOnce = (k, v) => { if (v && typeof v === 'string' && !ids[k]) ids[k] = v; };
const firstId = (b) => (Array.isArray(b) ? b.find((x) => x && typeof x.id === 'string')?.id : undefined);
// "…/sboms" → sbomId, "…/runner-pools" → poolId, "…/jobs/active" → jobId
const PARAM_FOR = { sboms: 'sbomId', jobs: 'jobId', active: 'jobId', pipelines: 'pipelineId', findings: 'findingId', integrations: 'integrationId', repositories: 'repositoryId', images: 'imageId', 'runner-pools': 'poolId', runners: 'runnerId', memberships: 'membershipId', 'api-tokens': 'tokenId', tokens: 'id', users: 'userId', workspaces: 'workspaceId', teams: 'teamId', projects: 'projectId', services: 'serviceId', environments: 'environmentId' };

function learn(path, body) {
  const seg = path.split('?')[0].split('/').filter(Boolean);
  const last = seg[seg.length - 1];
  const key = PARAM_FOR[last];
  if (key) setOnce(key, firstId(body) ?? firstId(body?.tokens) ?? firstId(body?.items));
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body)) if (Array.isArray(v) && PARAM_FOR[k]) setOnce(PARAM_FOR[k], firstId(v));
    // project rows carry workspace/team ids; nested runners in pools
    if (Array.isArray(body.runners)) setOnce('runnerId', firstId(body.runners));
  }
  if (Array.isArray(body)) {
    const row = body[0];
    if (row?.workspaceId) setOnce('workspaceId', row.workspaceId);
    if (row?.teamId) setOnce('teamId', row.teamId);
    if (Array.isArray(row?.runners)) setOnce('runnerId', firstId(row.runners));
    if (row?.sbom?.id) setOnce('sbomId', row.sbom.id);
  }
}

const fill = (path) => {
  let missing = null;
  const out = path.replace(/\{(\w+)\}/g, (_, name) => {
    if (name === 'from' || name === 'to') return ids.sbomId ?? ((missing ??= name), `{${name}}`);
    return ids[name] ?? ((missing ??= name), `{${name}}`);
  });
  return { out, missing };
};

const summarize = (b) => {
  if (Array.isArray(b)) return `${b.length} item${b.length === 1 ? '' : 's'}`;
  if (b && typeof b === 'object') return Object.keys(b).slice(0, 5).join(', ') + (Object.keys(b).length > 5 ? ', …' : '');
  return typeof b === 'string' ? b.slice(0, 60) : '';
};

(async () => {
  const doc = await call('/api/docs-json');
  if (doc.status !== 200) { console.error(`cannot read ${BASE}/api/docs-json (${doc.status})`); process.exit(2); }
  // Seeds: who am I, and which organization / project / service to walk.
  const me = await call('/api/v1/me');
  if (me.status === 401) { console.error(c('31', 'Token rejected (401): invalid, expired or revoked.')); process.exit(1); }
  const orgs = await call('/api/v1/organizations');
  ids.organizationId = flag('org') || firstId(orgs.body);
  if (ids.organizationId) {
    const projects = await call(`/api/v1/organizations/${ids.organizationId}/projects`);
    learn('/projects', projects.body);
    if (flag('project')) ids.projectId = flag('project');
  }
  if (ids.projectId) learn('/services', (await call(`/api/v1/projects/${ids.projectId}/services`)).body);
  if (flag('service')) ids.serviceId = flag('service');
  if (ids.serviceId) learn('/environments', (await call(`/api/v1/services/${ids.serviceId}/environments`)).body);

  const only = flag('only');
  const ops = [];
  for (const [path, item] of Object.entries(doc.body.paths)) {
    const op = item.get;
    if (!op || path.includes('/runner/') || path.includes('/webhooks/') || path.includes('/download')) continue;
    const tag = op.tags?.[0] ?? 'other';
    if (only && tag !== only) continue;
      const required = (op.parameters ?? []).filter((x) => x.in === 'query' && x.required).map((x) => x.name);
    ops.push({ path, tag, summary: op.summary ?? '', query: required });
  }
  // two passes: the first learns ids that the second needs
  const results = new Map();
  for (let pass = 0; pass < 3; pass++) {
    for (const o of ops) {
      if (results.has(o.path) && results.get(o.path).status !== 'skip') continue;
      const { out: filled, missing } = fill(o.path);
      if (missing) { results.set(o.path, { ...o, status: 'skip', note: `needs ${missing}` }); continue; }
      const qs = o.query.map((n) => { const f = { scopeType: () => (ids.projectId ? 'PROJECT' : 'ORGANIZATION'), scopeId: () => ids.projectId ?? ids.organizationId, q: () => 'a', days: () => '30', limit: () => '20' }[n]; return f ? `${n}=${encodeURIComponent(f())}` : null; }).filter(Boolean).join('&');
      const out = qs ? `${filled}?${qs}` : filled;
      const r = await call(out);
      if (r.status >= 200 && r.status < 300) learn(out, r.body);
      results.set(o.path, { ...o, url: out, status: r.status, ms: r.ms, note: r.status >= 200 && r.status < 300 ? summarize(r.body) : typeof r.body === 'object' && r.body ? String(r.body.message ?? '') : String(r.body).slice(0, 80) });
    }
  }
  const rows = [...results.values()].sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path));
  // 403 = outside the token's reach; 404 = the discovered id does not apply (e.g. an ECR-only route on a git connection); 503 = feature not configured on this cell
  const verdict = (r) => (r.status === 'skip' ? 'SKIP' : r.status >= 200 && r.status < 300 ? 'PASS' : r.status === 403 ? 'DENIED' : r.status === 404 ? 'NOTFOUND' : r.status === 503 ? 'N/A' : 'FAIL');
  if (flag('json')) { console.log(JSON.stringify({ base: BASE, me: me.body, ids, results: rows.map((r) => ({ ...r, verdict: verdict(r) })) }, null, 2)); }
  else {
    const who = me.body?.user ?? me.body;
    console.log(`\n${c('1', 'secops API check')} · ${BASE} · as ${who?.email ?? '?'}${who?.platformRole === 'admin' ? ' (admin)' : ''}`);
    console.log(c('2', `organization ${ids.organizationId ?? '—'} · project ${ids.projectId ?? '—'} · service ${ids.serviceId ?? '—'} · environment ${ids.environmentId ?? '—'}\n`));
    let tag = '';
    for (const r of rows) {
      if (r.tag !== tag) { tag = r.tag; console.log(c('36', `── ${tag}`)); }
      const v = verdict(r);
      const col = { PASS: '32', DENIED: '33', NOTFOUND: '33', 'N/A': '2', SKIP: '2', FAIL: '31' }[v];
      if (v === 'SKIP' && !flag('verbose')) continue;
      console.log(`  ${c(col, v.padEnd(8))} ${String(r.status).padEnd(4)} ${String(r.ms ?? '').padStart(5)}ms  ${r.path.replace('/api/v1', '')}  ${c('2', r.note ?? '')}`);
    }
  }
  const count = (v) => rows.filter((r) => verdict(r) === v).length;
  const line = `${count('PASS')} passed · ${count('DENIED')} denied (outside this token's reach) · ${count('NOTFOUND')} not applicable to the sample id · ${count('N/A')} not configured on this cell · ${count('FAIL')} failed · ${count('SKIP')} skipped (no id to test with)`;
  if (!flag('json')) console.log(`\n${line}\n`);
  process.exit(count('FAIL') ? 1 : 0);
})();
