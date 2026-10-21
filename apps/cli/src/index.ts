#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CliError, configFromEnv, isTlsCode, request, unreachableDetail, VERSION } from './client';
import type { Config } from './client';
import { signatureHeader } from './signing';
import { readZip } from './zip-read';
import { registryInfoText, type RegistryInfo } from './registry-info';
import { membersSummary } from './members-text';
import { serviceText, type ServiceSummary } from './service-text';
import { when } from './format';
import { credentialsPath, discoveryMismatch, freshToken, listCells, login, logout, normalizeCellUrl, resolveCellUrl, setCurrentCell } from './login';
import { FIELD_FLAGS, PARAM_FLAGS, policyRulesFromFlags, RESOURCES, RULE_FLAGS, RULE_NO_FLAGS, rulesSummary, SCOPE_SEGMENTS, slaDaysFromFlags } from './resources';

const sum = (c?: Record<string, number> | null) => (c ? Object.values(c).reduce((a, b) => a + b, 0) : 0);
interface GateResult { result: 'pass' | 'warn' | 'fail'; pending?: boolean; correlation?: { status: string; error: string | null; waitedMs: number } | null; violations: { policyName: string; action: string; message: string }[]; policies: { name: string }[]; facts: { sbomId: string | null; findings: Record<string, number> | null; kevOpen: number | null; secretsOpen: number; iacOpen?: Record<string, number> | null; sastOpen?: Record<string, number> | null } }
/** --wait-correlation N (seconds, total budget; the server is asked in ≤ 25 s slices). Default: 300 in CI (CI env var or a CI token), 0 for a person at a terminal. */
function waitCorrelationSeconds(flags: Record<string, unknown>): number {
  if (flags['wait-correlation'] !== undefined) return Math.max(0, Number(flags['wait-correlation']) || 0);
  const ci = !!process.env.CI || !!process.env.MATELOT_KEY_ID || !!process.env.SECOPS_KEY_ID;
  return ci ? 300 : 0;
}

const HELP = `matelot ${VERSION} — Matelot product-security platform CLI

Environment: MATELOT_URL + MATELOT_KEY_ID, MATELOT_SECRET (CI token)  or  MATELOT_URL + MATELOT_TOKEN (personal access token). SECOPS_* names are accepted too.

Commands
  whoami                                                 identity and permissions of the token
  doctor   [--url URL]                                   health of a cell: API, version, login, organization, runners, registry (exit 1 when something is wrong)
  login    --url URL [--scope read|write|sudo] [--no-browser]   sign in through the browser (OAuth; prints the link when no browser can be opened); logout revokes it
  cells                                                  stored logins (URL, user, scope, expiry) with the current one marked; use <URL> makes one current
  use      <URL>                                         target that stored login from now on (--url and MATELOT_URL still win per command)
  mcp      [--check]                                    how to connect Claude (Code / Desktop) to this cell's MCP server; --check runs the handshake
  vulnerabilities recorrelate [--org ID | --service ID] [--wait]   re-run advisory correlation (asynchronous job)
  evidence export|verify|summary|vex                     CRA evidence bundles (export --release ID --out f.zip · verify f.zip · vex --release ID)
  apply    --file config.yaml --scope projects/ID [--dry-run]   configuration as code: channels, policies, SLAs (idempotent; env-var substitution)
  evidence export --release ID [--out file.zip]         download the signed CRA evidence bundle of a release
  evidence verify <bundle.zip>                           check a bundle's checksums and signature against this cell
  gate     --env <environmentId> --image REF | --version V | --ref SHA [--wait-correlation 300]   evaluate policies; exit 2 = blocking policy, 3 = SBOM not correlated (pending/failed), 4 = auth
  deploy   --env <environmentId> [--version X] [--image REF]   "version X now runs in environment"
  release  --service <serviceId> --version X [--notes T]  record a release
  pipeline --service <serviceId> [--template security] [--ref REF] [--wait]  run a pipeline
  promote  --env <environmentId> --tag X                 copy build image <project>/<service>:X into the environment repository (= deploy)
  registry login [--connection NAME|ID --service ID]    docker login: the cell's registry, or an ECR/ACR/Docker Hub connection (short-lived credentials from the platform)
  registry connections --service <serviceId>              list the registry connections a service can use
  registry path --service <serviceId> [--env <environmentId>]   built-in registry: the full pushable reference (host included) of the build (or environment) image
  registry path --service <serviceId> --connection NAME --repository NAME [--create]   external registry (ECR/ACR/Hub…): image path; --create makes the ECR repository if missing
  sbom     --service <serviceId> --file bom.json --target source|image [--version X] [--image REF]
  request  <METHOD> </api/v1/path> [json-body]           any endpoint

Resource commands (matelot <resource> <verb> [--org|--workspace|--team|--project|--service|--env|--id …] [--json] [--body '{json}']):
${RESOURCES.map((r) => `  ${`${r.resource} ${r.verb}`.padEnd(26)} ${r.summary}`).join('\n')}
  Policy rule flags: --max-severity high|none --block-kev --block-secrets --require-sbom --max-iac high --max-sast high --honour-decisions (each with a --no-… form; create sends every rule, block rules off unless given) --environments production,staging --action block|warn --enforce

Options: --json (raw output), --quiet
`;

function parse(argv: string[]): { command: string; positional: string[]; flags: Record<string, string | true> } {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { command, positional, flags };
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);
const need = (flags: Record<string, string | true>, name: string) => {
  const v = str(flags[name]);
  if (!v) throw new CliError(`--${name} is required`);
  return v;
};

async function main() {
  const { command, positional, flags } = parse(process.argv.slice(2).map((a) => (a === '-f' ? '--file' : a)));
  const out = (data: unknown, human: string) => {
    if (flags.quiet) return;
    console.log(flags.json ? JSON.stringify(data, null, 2) : human);
  };
  if (command === 'help' || command === '--help' || command === '-h') return console.log(HELP);
  if (flags.help || positional.includes('--help') || positional.includes('-h')) {
    // Per-command help never needs credentials.
    const verb = positional[0];
    const matches = RESOURCES.filter((r) => r.resource === command && (!verb || r.verb === verb));
    if (matches.length) { for (const r of matches) console.log(`matelot ${r.resource} ${r.verb}\n  ${r.summary}\n  ${r.method} ${r.path}${r.fields?.length ? `\n  fields: ${r.fields.map((f) => '--' + (Object.entries(FIELD_FLAGS).find(([, v]) => v === f)?.[0] ?? f)).join(' ')}` : ''}\n  common: --json --body '{json}'${r.path.includes(':') ? ` and path flags: ${[...r.path.matchAll(/:(\w+)/g)].map((m) => '--' + (Object.entries(PARAM_FLAGS).find(([, v]) => v === m[1])?.[0] ?? m[1])).join(' ')}` : ''}`); return; }
    const line = HELP.split('\n').filter((l) => l.trim().startsWith(command + ' ') || l.trim().startsWith(command + '  '));
    console.log(line.length ? line.join('\n') : `no help for "${command}"; run matelot --help`);
    return;
  }
  if (command === 'version' || command === '--version') return console.log(VERSION);
  // --url targets a cell for ANY command (whoami, doctor, resources…): it wins over MATELOT_URL and the current cell
  if (str(flags.url) && command !== 'login') process.env.MATELOT_URL = str(flags.url)!;
  if (command === 'cells') {
    const cells = listCells();
    out(cells, cells.length ? cells.map((c) => `${c.current ? '*' : ' '} ${c.url.padEnd(40)} ${(c.user ?? '').padEnd(28)} ${c.scope.padEnd(6)} ${c.loggedOut ? 'logged out' : c.valid ? `valid until ${c.expiresAt ?? 'unknown'}` : `expired ${c.expiresAt}`}`).join('\n') + `\n(* = current; --url or MATELOT_URL override it; matelot use <url> changes it)` : 'no stored logins: matelot login --url https://…');
    return;
  }
  if (command === 'use') {
    const u = positional[0]; if (!u) throw new CliError('usage: matelot use <url>');
    const current = normalizeCellUrl(u); setCurrentCell(current); out({ current }, `current cell: ${current}`); return;
  }
  if (command === 'login') {
    const url = str(flags.url) ?? process.env.MATELOT_URL ?? process.env.SECOPS_URL;
    if (!url) throw new CliError('usage: matelot login --url https://matelot.example [--scope read|write|sudo]');
    const scope = (str(flags.scope) ?? 'write') as 'read' | 'write' | 'sudo';
    const creds = await login(url, scope, { noBrowser: !!flags['no-browser'] });
    const me = await request<{ user: { email: string } }>({ url: creds.url, keyId: '', secret: '', token: creds.accessToken }, 'GET', '/api/v1/me').catch(() => null);
    const RANK = { read: 1, write: 2, sudo: 3 } as const;
    const narrowed = RANK[(creds.scope as 'read' | 'write' | 'sudo')] < RANK[scope];
    if (narrowed) console.error(`warning: granted ${creds.scope}, not ${scope} — ${scope === 'sudo' ? 'only platform administrators can hold sudo, or you chose a narrower scope on the consent page' : 'you chose a narrower scope on the consent page'}`);
    out({ url: creds.url, requestedScope: scope, scope: creds.scope, narrowed, expiresAt: creds.expiresAt, refreshToken: !!creds.refreshToken, user: me?.user.email ?? null }, `logged in to ${creds.url}${me ? ` as ${me.user.email}` : ''} (scope ${creds.scope}${narrowed ? `, requested ${scope}` : ''}, expires ${creds.expiresAt}); stored in ${credentialsPath()}`);
    return;
  }
  if (command === 'doctor') { await doctor(str(flags.url), !!flags.json); return; }
  // a one-time setup link needs no login: the cell comes from the link itself (or MATELOT_URL)
  if (command === 'invite') {
    const link = str(flags.link) ?? '';
    const url = normalizeCellUrl(/^https?:\/\//.test(link) ? link.replace(/\/invite\/.*$/, '') : (process.env.MATELOT_URL ?? process.env.SECOPS_URL ?? resolveCellUrl(undefined, process.env) ?? ''));
    if (!url) throw new CliError('usage: matelot invite show|accept --link https://<cell>/invite/<token> [--password …]');
    await runResource(command, positional, flags, { url, keyId: '', secret: '', anonymous: true });
    return;
  }
  const config = configFromEnv();
  if (config.fromLogin) { const t = await freshToken(config.url); if (!t) throw new CliError(`your login to ${config.url} expired: run matelot login --url ${config.url}`); config.token = t; }

  // resource commands win when the verb matches (e.g. `sbom findings`, `pipeline show`, `registry info`)
  if (RESOURCES.some((r) => r.resource === command && r.verb === positional[0])) {
    await runResource(command, positional, flags, config);
    return;
  }
  switch (command) {
    case 'whoami': {
      const me = await request<{ kind: string; name?: string; scope?: { type: string; id: string }; permissions?: string[]; email?: string }>(config, 'GET', '/api/v1/api-tokens/whoami');
      out(me, me.kind === 'token' ? `token "${me.name}" on ${me.scope?.type.toLowerCase()} ${me.scope?.id}\npermissions: ${me.permissions?.join(', ')}` : `user ${me.email}`);
      return;
    }
    case 'logout': {
      const r = await logout(str(flags.url) ?? config.url ?? undefined);
      out({ loggedOut: !!r, revoked: r?.revoked ?? false }, r ? `logged out of ${r.url}${r.revoked ? ' (token revoked at the server)' : ' (server revocation failed; the token expires on its own)'}` : 'no stored login');
      return;
    }
    case 'mcp': {
      // The MCP server lives in the API (every endpoint is a tool). Personal tokens only: CI tokens sign requests.
      const url = `${config.url}/api/v1/mcp`;
      if (!config.token) throw new CliError('MCP needs a personal access token (MATELOT_TOKEN, scope read or write): create one in the web app under Account → Access tokens.');
      if (flags.check) {
        const r = await request<{ result?: { serverInfo?: { name: string; version: string }; protocolVersion?: string } }>(config, 'POST', '/api/v1/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'matelot-cli', version: VERSION } } });
        const t = await request<{ result?: { tools?: unknown[] } }>(config, 'POST', '/api/v1/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        out({ url, server: r.result?.serverInfo, protocol: r.result?.protocolVersion, tools: t.result?.tools?.length ?? 0 }, `MCP ok: ${r.result?.serverInfo?.name} ${r.result?.serverInfo?.version} (${r.result?.protocolVersion}) — ${t.result?.tools?.length ?? 0} tools at ${url}`);
        return;
      }
      const tokenHint = config.token.startsWith('spt_') ? config.token : 'spt_…';
      out({ url, transport: 'http', header: 'Authorization: Bearer <personal token>' }, `Matelot MCP server: ${url}

Claude Code:
  claude mcp add --transport http matelot ${url} --header "Authorization: Bearer ${tokenHint}"

Claude Desktop (claude_desktop_config.json → mcpServers):
  "matelot": { "type": "http", "url": "${url}", "headers": { "Authorization": "Bearer ${tokenHint}" } }

Read-only token → Claude can query everything (findings, gate, queue, CRA readiness) but not change anything.
Write token → Claude can also create exceptions, remediations, issues, policies, channels. Every call is checked by RBAC and written to the audit trail under your user.
Check the handshake: matelot mcp --check`);
      return;
    }
    case 'vulnerabilities': {
      if (positional[0] === 'recorrelate') {
        // Asynchronous on the API (a job): --wait polls until done, --service limits the scope.
        // Scope: --service, else --org, else the token's organization when it has exactly one.
        let org = str(flags.org);
        if (!flags.service && !org) {
          const me = await request<{ memberships?: { scopeType: string; scopeId: string }[] }>(config, 'GET', '/api/v1/me');
          const orgs = [...new Set((me.memberships ?? []).filter((m) => m.scopeType === 'ORGANIZATION').map((m) => m.scopeId))];
          if (orgs.length === 1) org = orgs[0];
          else throw new CliError(orgs.length ? `the token belongs to ${orgs.length} organizations: pass --org ID` : 'pass --org ID or --service ID (the token lists no organization membership)');
        }
        const scopePath = flags.service ? `/api/v1/services/${str(flags.service)}` : `/api/v1/organizations/${org}`;
        const path = `${scopePath}/findings/recorrelate`;
        let job = await request<{ jobId: string; status: string; position: number; result: Record<string, number> | null; error: string | null }>(config, 'POST', path, {});
        if (!flags.wait) { out(job, `correlation ${job.status}${job.status === 'queued' ? ` (position ${job.position})` : ''}: job ${job.jobId}; poll with --wait or GET ${scopePath}/correlation/jobs/${job.jobId} (jobs live in the API's memory: an API restart forgets them, the run itself is retried from the SBOM status)`); return; }
        const started = Date.now();
        while (job.status === 'queued' || job.status === 'running') {
          if (Date.now() - started > Number(flags.timeout ?? 1800) * 1000) throw new CliError(`still ${job.status} after ${flags.timeout ?? 1800}s (job ${job.jobId})`);
          await new Promise((r) => setTimeout(r, 2000));
          try { job = await request(config, 'GET', `${scopePath}/correlation/jobs/${job.jobId}`, undefined, 60_000, { poll: true }); }
          catch (e) { if (String(e).includes('404')) throw new CliError(`job ${job.jobId} is gone: the API restarted (jobs live in memory). The correlation itself is retried automatically; check \`matelot findings summary\` in a minute or run recorrelate again.`); throw e; }
        }
        if (job.status === 'failed') throw new CliError(`correlation failed: ${job.error}`);
        out(job, `correlation done: checked ${job.result?.checked ?? 0} components, ${job.result?.newAdvisories ?? 0} new advisories, ${job.result?.findingsOpened ?? 0} opened, ${job.result?.findingsFixed ?? 0} fixed`);
        return;
      }
      if (await runResource(command, positional, flags, config)) return;
      throw new CliError('usage: matelot vulnerabilities recorrelate [--org ID | --service ID] [--wait] [--timeout 1800]');
    }
    case 'apply': {
      // apply -f config.yaml --scope projects/ID|workspaces/ID|teams/ID|organizations/ID [--dry-run]
      const file = str(flags.file);
      if (!file) throw new CliError('usage: matelot apply --file <file.yaml|json> --scope <organizations|workspaces|teams|projects>/<id> [--dry-run]');
      const doc = loadConfigFile(file) as Record<string, unknown>;
      const scope = (str(flags.scope) ?? (typeof doc.scope === 'string' ? doc.scope : undefined))?.replace(/^\/+|\/+$/g, '');
      if (!scope) throw new CliError('--scope is required (or a top-level "scope:" in the file), e.g. projects/<id>');
      const { scope: _s, ...body } = doc;
      const r = await request<{ dryRun: boolean; changes: { kind: string; name: string; action: string; detail?: string }[] }>(config, 'POST', `/api/v1/${scope}/config/apply${flags['dry-run'] ? '?dryRun=true' : ''}`, body);
      if (flags.json) { console.log(JSON.stringify(r, null, 2)); return; }
      const icon: Record<string, string> = { create: '+', update: '~', unchanged: '=', skip: '!' };
      console.log(`${r.dryRun ? 'plan (dry run)' : 'applied'} at ${scope}:`);
      for (const c of r.changes) console.log(`  ${icon[c.action] ?? '?'} ${c.kind.padEnd(8)} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
      const n = r.changes.filter((c) => c.action !== 'unchanged').length;
      console.log(n ? `${n} change${n === 1 ? '' : 's'}${r.dryRun ? ' would be made' : ''}` : 'nothing to change');
      return;
    }
    case 'evidence': {
      // evidence export --release ID [--out file.zip] · evidence verify <bundle.zip>
      const verb = positional[0];
      if (verb === 'export') {
        const rel = need(flags, 'release');
        const out = str(flags.out) ?? `evidence-${rel.slice(0, 8)}.zip`;
        const res = await fetch(`${config.url}/api/v1/releases/${rel}/evidence.zip`, { headers: { Authorization: config.token ? `Bearer ${config.token}` : signatureHeader(config.keyId, config.secret, 'GET', `/api/v1/releases/${rel}/evidence.zip`, Buffer.alloc(0)) } });
        if (!res.ok) throw new CliError(`${res.status} ${(await res.text()).slice(0, 200)}`);
        const buf = Buffer.from(await res.arrayBuffer());
        require('node:fs').writeFileSync(out, buf);
        const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1];
        console.log(`wrote ${out} (${buf.length} bytes${name ? `, ${name}` : ''}) — contains manifest.json, findings.json, gate.json, deployments.json, sboms/, evidence.md, checksums.txt, checksums.sig`);
        return;
      }
      if (verb === 'verify') {
        const file = positional[1] ?? str(flags.file);
        if (!file) throw new CliError('usage: matelot evidence verify <bundle.zip>');
        const { createHash } = require('node:crypto') as typeof import('node:crypto');
        // In-process: no dependency on the `unzip` binary, no child-process buffer limit (was ENOBUFS on ~1 MB bundles).
        const entries = readZip(readFileSync(file));
        const list = entries.map((e) => e.name);
        const read = (n: string) => { const e = entries.find((x) => x.name === n); if (!e) throw new CliError(`${n} missing from the bundle`); return e.data(); };
        const fileHashes: Record<string, string> = {};
        for (const n of list) if (!['checksums.txt', 'checksums.sig'].includes(n) && !n.endsWith('/')) fileHashes[n] = createHash('sha256').update(read(n)).digest('hex');
        const r = await request<{ signatureValid: boolean; files: { name: string; ok: boolean }[] }>(config, 'POST', '/api/v1/evidence/verify', { checksums: read('checksums.txt').toString('utf8'), signature: read('checksums.sig').toString('utf8'), fileHashes });
        for (const f of r.files) console.log(`  ${f.ok ? 'ok  ' : 'FAIL'} ${f.name}`);
        console.log(r.signatureValid ? 'signature: valid (produced by this cell)' : 'signature: INVALID');
        if (!r.signatureValid || r.files.some((f) => !f.ok)) process.exitCode = 2;
        return;
      }
      if (await runResource(command, positional, flags, config)) return;
      throw new CliError('usage: matelot evidence export --release ID [--out file.zip] | evidence verify <bundle.zip> | evidence summary --id ID');
    }
    case 'gate': {
      const env = need(flags, 'env');
      // Right after a push the image SBOM may not exist or still be correlating: wait for it in short server calls
      // (≤ 25 s each, so no ingress times out) until the budget is spent. Default 300 s in CI, 0 interactively.
      const budget = waitCorrelationSeconds(flags);
      const body = { imageRef: str(flags.image), version: str(flags.version), ref: str(flags.ref), digest: str(flags.digest) };
      if (!body.imageRef && !body.version && !body.ref && !body.digest) throw new CliError('give --image, --version, --ref or --digest');
      const started = Date.now();
      let ev: GateResult;
      for (;;) {
        const remaining = Math.max(0, budget - Math.round((Date.now() - started) / 1000));
        const slice = Math.min(25, remaining);
        ev = await request<GateResult>(config, 'POST', `/api/v1/environments/${env}/gate`, { ...body, waitCorrelation: slice }, (slice + 60) * 1000);
        const st = ev.correlation?.status;
        if (!ev.pending || st === 'failed' || remaining <= 0 || budget === 0) break;
        if (!flags.json) console.error(`waiting for ${st === 'no_sbom' ? 'the image SBOM' : 'SBOM correlation'}… (${Math.min(budget, Math.round((Date.now() - started) / 1000))} s / ${budget} s)`);
      }
      if (flags.json) { console.log(JSON.stringify(ev, null, 2)); }
      else if (ev.pending) {
        // No partial counts: they are not knowledge yet.
        const st = ev.correlation?.status;
        console.log(`gate: PENDING — ${st === 'failed' ? `SBOM correlation failed (${ev.correlation?.error ?? 'unknown error'})` : st === 'no_sbom' ? `no SBOM for this image after ${budget}s (nothing scanned yet)` : `SBOM correlation not finished after ${budget}s`}; findings unknown, nothing evaluated. Retry, raise --wait-correlation, or check the SBOM job / API log.`);
      } else {
        console.log(`gate: ${ev.result.toUpperCase()} — ${ev.policies.length} polic${ev.policies.length === 1 ? 'y' : 'ies'} applied (sbom ${ev.facts.sbomId ? 'yes' : 'no'} · critical ${ev.facts.findings?.critical ?? 0} · high ${ev.facts.findings?.high ?? 0} · kev ${ev.facts.kevOpen ?? 0} · secrets ${ev.facts.secretsOpen} · iac ${sum(ev.facts.iacOpen)} · sast ${sum(ev.facts.sastOpen)})${Date.now() - started > 1500 ? ` · waited ${Math.round((Date.now() - started) / 1000)}s for correlation` : ''}`);
        for (const v of ev.violations) console.log(`  ${v.action === 'block' ? '✗' : '!'} ${v.policyName}: ${v.message}`);
      }
      if (ev.pending) { process.exitCode = 3; return; } // 3 = not evaluated (SBOM missing / correlation pending or failed) — distinct from 2 = policy violation
      if (ev.result === 'fail') process.exitCode = 2;
      return;
    }
    case 'deploy': {
      const env = need(flags, 'env');
      // --commit (or MATELOT_COMMIT) records the build's commit; used when this deployment creates the release.
      const budget = waitCorrelationSeconds(flags);
      const body = { source: 'api', version: str(flags.version), imageRef: str(flags.image), commitSha: str(flags.commit) ?? process.env.MATELOT_COMMIT ?? process.env.SECOPS_COMMIT ?? undefined };
      if (!body.version && !body.imageRef) throw new CliError('give --version and/or --image');
      // Policy enforcement needs the image's SBOM correlated: short server calls (≤ 25 s) until the budget is spent.
      const started = Date.now();
      let d!: { id: string; version: string | null; releaseId: string | null; imageRef: string | null };
      for (;;) {
        const remaining = Math.max(0, budget - Math.round((Date.now() - started) / 1000));
        const slice = Math.min(25, remaining);
        try { d = await request(config, 'POST', `/api/v1/environments/${env}/deployments`, { ...body, waitCorrelation: slice }, (slice + 60) * 1000); break; }
        catch (e) {
          if (!(e instanceof CliError) || e.code !== 'correlation_pending' || remaining <= 0 || budget === 0 || /failed/.test(e.message)) throw e;
          console.error(`waiting for the image SBOM / its correlation before the deployment is evaluated… (${Math.min(budget, Math.round((Date.now() - started) / 1000))} s / ${budget} s)`);
        }
      }
      out(d, `recorded deployment ${d.version ?? d.imageRef} (${d.releaseId ? 'linked to its release' : 'no matching release yet'})`);
      for (const w of (d as { warnings?: string[] }).warnings ?? []) console.error(`warning: ${w}`);
      return;
    }
    case 'release': {
      const service = need(flags, 'service');
      const r = await request<{ version: string }>(config, 'POST', `/api/v1/services/${service}/releases`, { version: need(flags, 'version'), notes: str(flags.notes) });
      out(r, `recorded release ${r.version}`);
      return;
    }
    case 'pipeline': {
      const service = need(flags, 'service');
      const p = await request<{ id: string; number: number; status: string; jobs: { name: string; status: string }[] }>(config, 'POST', `/api/v1/services/${service}/pipelines`, { template: str(flags.template) ?? 'security', ref: str(flags.ref) });
      if (!flags.wait) out(p, `started pipeline #${p.number} (${p.jobs.length} jobs)`);
      else if (!flags.json) console.error(`started pipeline #${p.number} (${p.jobs.length} jobs); waiting…`);
      if (flags.wait) {
        const deadline = Date.now() + Number(str(flags.timeout) ?? 1800) * 1000;
        let last = p;
        while (Date.now() < deadline && !['succeeded', 'failed', 'cancelled'].includes(last.status)) {
          await new Promise((r) => setTimeout(r, 5000));
          last = await request(config, 'GET', `/api/v1/pipelines/${p.id}`, undefined, 60_000, { poll: true });   // polls are not traced by the cell
        }
        out(last, `pipeline #${last.number}: ${last.status} — ${last.jobs.map((j) => `${j.name}=${j.status}`).join(', ')}`);
        if (last.status !== 'succeeded') process.exitCode = 1;
      }
      return;
    }
    case 'registry': {
      const sub = positional[0];
      if (sub === 'connections') {
        const list = await request<{ id: string; name: string; host: string; type: string; level: string }[]>(config, 'GET', `/api/v1/services/${need(flags, 'service')}/registries`);
        if (flags.json) console.log(JSON.stringify(list, null, 2));
        else for (const c of list) console.log(`${c.name}\t${c.type}\t${c.host}\t(${c.level}) ${c.id}`);
        return;
      }
      if (sub === 'login') {
        const connection = str(flags.connection);
        if (connection) {
          // External registry (ECR, ACR, Docker Hub, GHCR…): the platform exchanges the connection's credentials for short-lived Docker credentials.
          const service = need(flags, 'service');
          const list = await request<{ id: string; name: string; host: string; type: string }[]>(config, 'GET', `/api/v1/services/${service}/registries`);
          const match = list.find((c) => c.id === connection || c.name.toLowerCase() === connection.toLowerCase());
          if (!match) throw new CliError(`no registry connection "${connection}" on this service's path (available: ${list.map((c) => c.name).join(', ') || 'none'})`);
          const cred = await request<{ host: string; username: string; password: string; expiresAt: string; type: string }>(config, 'POST', `/api/v1/services/${service}/registries/${match.id}/credentials`);
          const r = spawnSync('docker', ['login', cred.host, '-u', cred.username, '--password-stdin'], { input: cred.password, stdio: ['pipe', 'inherit', 'inherit'] });
          if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('docker is not installed on this runner (needed for `registry login`)');
          if (r.status !== 0) throw new CliError(`docker login ${cred.host} failed`);
          if (!flags.quiet) console.log(`logged in to ${cred.host} (${cred.type}) via connection "${match.name}"; credentials expire ${cred.expiresAt}`);
          return;
        }
        const info = await request<{ available: boolean; host: string | null }>(config, 'GET', '/api/v1/registry/info');
        if (!info.available || !info.host) throw new CliError('this cell has no built-in registry');
        // CI token: key id / secret. Personal token (MATELOT_TOKEN=spt_…): username "token", the token as password — the
        // registry grants what the user's RBAC allows on each repository.
        const username = config.token ? 'token' : config.keyId;
        const password = config.token ? config.token : config.secret;
        if (!username || !password) throw new CliError('no credentials: set MATELOT_KEY_ID + MATELOT_SECRET (CI token) or MATELOT_TOKEN (personal token)');
        const r = spawnSync('docker', ['login', info.host, '-u', username, '--password-stdin'], { input: password, stdio: ['pipe', 'inherit', 'inherit'] });
        if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('docker is not installed on this runner (needed for `registry login`)');
        if (r.status !== 0) throw new CliError(`docker login ${info.host} failed`);
        if (!flags.quiet) console.log(`logged in to ${info.host} as ${username}${config.token ? ' (personal token)' : ' (CI token)'} — docker push "$(matelot registry path --service <serviceId>)":<tag>`);
        return;
      }
      if (sub === 'path') {
        const connection = str(flags.connection);
        if (connection) {
          const service = need(flags, 'service');
          const repository = need(flags, 'repository');
          const list = await request<{ id: string; name: string; host: string; type: string }[]>(config, 'GET', `/api/v1/services/${service}/registries`);
          const match = list.find((c) => c.id === connection || c.name.toLowerCase() === connection.toLowerCase());
          if (!match) throw new CliError(`no registry connection "${connection}" on this service's path (available: ${list.map((c) => c.name).join(', ') || 'none'})`);
          if (flags.create && match.type === 'ecr') {
            const repo = await request<{ repositoryUri: string }>(config, 'POST', `/api/v1/services/${service}/registries/${match.id}/repositories`, { name: repository, scanOnPush: true, immutableTags: !!flags['immutable-tags'] });
            console.log(repo.repositoryUri);
            return;
          }
          console.log(`${match.host}/${repository}`);
          return;
        }
        const env = str(flags.env);
        if (env) {
          const r = await request<{ available: boolean; host?: string; repository?: string }>(config, 'GET', `/api/v1/environments/${env}/registry`);
          if (!r.available) throw new CliError('this cell has no built-in registry');
          console.log(`${r.host}/${r.repository}`);
          return;
        }
        const r = await request<{ available: boolean; image?: string; environments?: { slug: string; repository: string }[] }>(config, 'GET', `/api/v1/services/${need(flags, 'service')}/registry`);
        if (!r.available) throw new CliError('this cell has no built-in registry');
        if (flags.json) console.log(JSON.stringify(r, null, 2));
        else console.log(r.image);
        return;
      }
      throw new CliError('usage: registry login | registry path --service <id> [--env <id>]');
    }
    case 'promote': {
      const env = need(flags, 'env');
      const commit = str(flags.commit) ?? process.env.MATELOT_COMMIT ?? process.env.SECOPS_COMMIT;
      const r = await request<{ from: string; to: string; digest: string | null }>(config, 'POST', `/api/v1/environments/${env}/promote`, { tag: need(flags, 'tag'), ...(commit ? { commit } : {}) }, 300_000);
      out(r, `promoted ${r.from} → ${r.to}${r.digest ? ` (${r.digest.slice(0, 19)}…)` : ''}; deployment recorded`);
      return;
    }
    case 'sbom': {
      const service = need(flags, 'service');
      const document = JSON.parse(readFileSync(need(flags, 'file'), 'utf8')) as Record<string, unknown>;
      const s = await request<{ id: string; componentCount: number; deduplicated: boolean; releaseId: string | null }>(config, 'POST', `/api/v1/services/${service}/sboms`, { target: str(flags.target) ?? 'source', version: str(flags.version), imageRef: str(flags.image), document });
      out(s, `${s.deduplicated ? 'identical SBOM already stored' : `stored SBOM with ${s.componentCount} components`}${s.releaseId ? ' (linked to release)' : ''}`);
      return;
    }
    case 'request': {
      const [method, path, body] = positional;
      if (!method || !path) throw new CliError('usage: request <METHOD> </api/v1/path> [json]');
      const r = await request(config, method.toUpperCase(), path, body ? JSON.parse(body) : undefined);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    default: {
      if (await runResource(command, positional, flags, config)) return;
      throw new CliError(`unknown command "${command}"\n${HELP}`);
    }
  }
}


// Minimal YAML subset for configuration files: maps, lists ("- "), scalars, inline [a, b] arrays, comments, ${ENV} substitution.
function parseSimpleYaml(text: string): unknown {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, '').replace(/^#.*$/, '')).filter((l) => l.trim());
  const scalar = (v: string): unknown => {
    const t = v.trim();
    if (t === '' || t === 'null' || t === '~') return null;
    if (t === 'true') return true; if (t === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== null && x !== '');
    return t.replace(/^["']|["']$/g, '');
  };
  let i = 0;
  const parseBlock = (indent: number): unknown => {
    const isList = lines[i] && lines[i].trimStart().startsWith('- ') && lines[i].search(/\S/) === indent;
    const out: Record<string, unknown> | unknown[] = isList ? [] : {};
    while (i < lines.length) {
      const line = lines[i]; const ind = line.search(/\S/);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`unexpected indentation at line: ${line.trim()}`);
      const body = line.trim();
      if (Array.isArray(out)) {
        if (!body.startsWith('- ')) break;
        const item = body.slice(2);
        i++;
        if (item.includes(':') && !item.startsWith('[') && !/^["']/.test(item)) {
          // "- key: value" starts a map continued by deeper-indented lines; treat the first pair as part of the map
          const [k, ...rest] = item.split(':'); const v = rest.join(':').trim();
          const map: Record<string, unknown> = {};
          if (v === '') { map[k.trim()] = parseBlock(ind + 4); } else map[k.trim()] = scalar(v);
          while (i < lines.length && lines[i].search(/\S/) > ind) { const sub = parseBlock(lines[i].search(/\S/)); Object.assign(map, sub as Record<string, unknown>); }
          out.push(map);
        } else out.push(scalar(item));
      } else {
        const idx = body.indexOf(':');
        if (idx < 0) throw new Error(`expected "key: value" at: ${body}`);
        const key = body.slice(0, idx).trim(); const v = body.slice(idx + 1).trim();
        i++;
        if (v === '') { out[key] = i < lines.length && lines[i].search(/\S/) > ind ? parseBlock(lines[i].search(/\S/)) : null; }
        else out[key] = scalar(v);
      }
    }
    return out;
  };
  return parseBlock(lines.length ? lines[0].search(/\S/) : 0);
}
function loadConfigFile(file: string): unknown {
  const raw = require('node:fs').readFileSync(file, 'utf8').replace(/\$\{([A-Z0-9_]+)\}/g, (_: string, k: string) => { if (process.env[k] === undefined) throw new CliError(`environment variable ${k} is not set (referenced in ${file})`); return process.env[k] as string; });
  if (file.endsWith('.json')) return JSON.parse(raw);
  try { return JSON.parse(raw); } catch { return parseSimpleYaml(raw); }
}

// ---- declarative resource commands ------------------------------------------------------------
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
const cell = (v: unknown): string => (v === null || v === undefined ? '—' : Array.isArray(v) ? v.map(cell).join(',') : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? when(v) : String(v));
function table(rows: Record<string, unknown>[], columns?: string[]) {
  if (!rows.length) { console.log('(empty)'); return; }
  const cols = columns ?? Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object').slice(0, 7);
  const data = rows.map((r) => cols.map((c) => { const s = cell(get(r, c)); return s.length > 48 ? `${s.slice(0, 46)}…` : s; }));
  const widths = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i].length)));
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join('  '));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const d of data) console.log(d.map((v, i) => v.padEnd(widths[i])).join('  '));
}
async function runResource(resource: string, positional: string[], flags: Record<string, string | true>, config: ReturnType<typeof configFromEnv>): Promise<boolean> {
  if ((resource === 'usage' || resource === 'onboarding') && (positional[0] === undefined || positional[0].startsWith('-'))) positional = ['show', ...positional];
  // `matelot coverage [--project ID] [--uncovered]`: the project's table with --project, the organization's otherwise
  if (resource === 'coverage' && (positional[0] === undefined || positional[0].startsWith('-'))) positional = [flags.project ? 'project' : 'show', ...positional];
  const verb = positional[0];
  const cmd = RESOURCES.find((r) => r.resource === resource && r.verb === verb);
  if (!cmd) {
    const verbs = RESOURCES.filter((r) => r.resource === resource).map((r) => r.verb);
    if (verbs.length) throw new CliError(`usage: matelot ${resource} <${verbs.join('|')}> …`);
    return false;
  }
  // `--scope projects/ID` for the commands that take scopeType + scopeId in the body / query (members, service accounts)
  if (cmd.fields?.includes('scopeType') && !cmd.path.includes(':scope') && typeof flags.scope === 'string') {
    const raw = flags.scope.replace(/^\/+|\/+$/g, '');
    const m = /^([a-z]+)\/([0-9a-f-]{36})$/i.exec(raw);
    const type = raw === 'org' ? 'ORGANIZATION' : m ? SCOPE_SEGMENTS[m[1]!.toLowerCase()] : undefined;
    if (!type) throw new CliError('--scope must be organizations/ID, workspaces/ID, teams/ID, projects/ID (or org for your organization)');
    const id = raw === 'org' ? await defaultOrg(config) : m![2]!;
    const { scope: _s, ...rest } = flags;
    flags = { ...rest, 'scope-type': type, 'scope-id': id! };
  }
  // a one-time setup link may be given whole: https://cell/invite/TOKEN
  if (typeof flags.link === 'string') flags = { ...flags, link: flags.link.replace(/^.*\/invite\//, '').replace(/[?#].*$/, '') };
  // path params from flags (or a positional id)
  let path = cmd.path;
  for (const [flag, name] of Object.entries(PARAM_FLAGS)) {
    const param = new RegExp(`:${name}(?![A-Za-z])`);   // ":to" must not match ":tokenId"
    if (!param.test(path)) continue;
    const v = str(flags[flag]) ?? (name === 'id' ? positional[1] : undefined) ?? process.env[`SECOPS_${flag.toUpperCase()}`] ?? (flag === 'org' ? await defaultOrg(config) : undefined);
    if (!v) throw new CliError(`--${flag} is required for "matelot ${resource} ${verb}"`);
    path = path.replace(param, name === 'scope' ? v.replace(/^\/+|\/+$/g, '') : encodeURIComponent(v));
  }
  // fields from flags
  // Unknown flags are an error, not silently ignored (a typo like --enforced must not create a policy without enforcement)
  const known = new Set<string>(['json', 'quiet', 'body', 'help', 'wait', 'timeout', 'force', 'limit', 'offset', 'q', ...Object.keys(PARAM_FLAGS), ...RULE_FLAGS, ...RULE_NO_FLAGS, 'component', 'project', ...(cmd.fields ?? []), ...Object.entries(FIELD_FLAGS).filter(([, v]) => (cmd.fields ?? []).includes(v)).map(([k]) => k), ...(('query' in cmd ? (cmd as { query?: string[] }).query : undefined) ?? [])]);
  if (cmd.fields?.includes('slaDays')) for (const k of ['critical', 'high', 'medium', 'low', 'unknown']) known.add(k);
  const unknown = Object.keys(flags).filter((k) => !known.has(k));
  if (unknown.length) throw new CliError(`unknown flag${unknown.length === 1 ? '' : 's'} for "matelot ${resource} ${verb}": ${unknown.map((k) => '--' + k).join(', ')} (run matelot ${resource} ${verb} --help)`);
  const payload: Record<string, unknown> = { ...(cmd.body ?? {}) };
  for (const f of cmd.fields ?? []) {
    const aliases = [f, ...(f === 'componentName' ? ['component'] : f === 'projectId' ? ['project'] : []), ...Object.entries(FIELD_FLAGS).filter(([, v]) => v === f).map(([k]) => k)];
    const flag = aliases.find((a) => flags[a] !== undefined) ?? f;
    const raw = flags[flag];
    if (raw === undefined) continue;
    if (f === 'expiresAt' && (raw === 'none' || raw === 'never')) { payload[f] = null; continue; }
    if (f === 'expiresAt' && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) { payload[f] = `${raw}T23:59:59Z`; continue; }
    payload[f] = raw === true ? true : ['environmentKinds', 'environments', 'events', 'emails', 'userIds'].includes(f) ? String(raw).split(',').map((x) => x.trim()).filter(Boolean) : f === 'expiresInDays' || f === 'limit' || f === 'days' ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  // --body '{...}': raw JSON merged last — nested fields (auth, rules, settings) exactly as the web app sends them
  if (typeof flags.body === 'string') { try { Object.assign(payload, JSON.parse(flags.body)); } catch { throw new CliError('--body must be valid JSON'); } }
  for (const b of ['protected', 'internetFacing', 'enforceOnDeploy', 'enabled', 'scanOnPush', 'immutableTags']) if (typeof payload[b] === 'string') payload[b] = payload[b] === 'true';
  if (cmd.fields?.includes('rules')) { const rules = policyRulesFromFlags(flags, cmd.method === 'POST' ? 'create' : 'update'); if (rules) payload.rules = rules; }
  if (cmd.fields?.includes('slaDays')) { const sla = slaDaysFromFlags(flags); if (sla) payload.slaDays = sla; }
  if (cmd.fields?.includes('dueAt') && typeof payload.dueAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.dueAt)) payload.dueAt = `${payload.dueAt}T23:59:59Z`;
  let url = path;
  let body: unknown;
  if (cmd.method === 'GET' || cmd.method === 'DELETE') { const q = new URLSearchParams(); for (const [k, v] of Object.entries(payload)) q.set(k, Array.isArray(v) ? v.join(',') : String(v)); if ([...q].length) url += `?${q}`; }
  else body = payload;
  const res = await request<unknown>(config, cmd.method, url, body);
  if (typeof res === 'string' && !flags.json) { process.stdout.write(res.endsWith('\n') ? res : `${res}\n`); return true; } // CSV and other text
  if (resource === 'registry' && verb === 'info' && !flags.json && res && typeof res === 'object') { console.log(registryInfoText(res as RegistryInfo)); return true; }
  if (resource === 'usage' && !flags.json && res && typeof res === 'object') { console.log(usageText(res as UsageReport)); return true; }
  if (resource === 'service' && verb === 'show' && !flags.json && res && typeof res === 'object') { console.log(serviceText(res as ServiceSummary)); return true; }
  if (resource === 'onboarding' && !flags.json && res && typeof res === 'object') { console.log(onboardingText(res as OnboardingReport, verb)); return true; }
  if (resource === 'coverage' && !flags.json && res && typeof res === 'object') { console.log(coverageText(res as CoverageReport, flags.uncovered === true || flags.uncovered === 'true')); return true; }
  const summary = flags.json ? null : connectionSummary(resource, verb, res) ?? membersSummary(resource, verb, res);
  if (summary !== null) { if (!flags.quiet) console.log(summary); return true; }
  if (flags.json || !Array.isArray(res) && !(res && typeof res === 'object' && Array.isArray((res as Record<string, unknown>).tokens))) console.log(JSON.stringify(res, null, 2));
  else {
    let rows = (Array.isArray(res) ? res : (res as { tokens: Record<string, unknown>[] }).tokens) as Record<string, unknown>[];
    if (resource === 'policies') rows = rows.map((r) => ({ ...r, rules: rulesSummary(r.rules as Record<string, unknown> | null) }));
    table(rows, cmd.columns);
  }
  if (cmd.failWhen && get(res, cmd.failWhen.field) === cmd.failWhen.equals) { process.exitCode = 2; return true; }
  if (!flags.quiet) keylessHint(resource, verb, res);
  return true;
}
/** Keyless registry connections are created unverified: say what to trust and how to verify (stderr, so --json stays pure). */
function keylessHint(resource: string, verb: string, res: unknown) {
  if (resource !== 'connection' || !res || typeof res !== 'object') return;
  const r = res as { id?: string; keyless?: boolean; verified?: boolean; account?: string; identity?: { subject: string; issuer: string; warning?: string | null } };
  if (verb === 'create' && r.keyless && r.verified === false && r.id) {
    const subject = r.identity?.subject ?? `integration:${r.id}`;
    console.error(`\nkeyless connection created, not verified yet.\n  1. trust issuer ${r.identity?.issuer ?? '(see matelot connection identity)'} for the exact subject ${subject}\n     (steps: matelot connection identity --id ${r.id})\n  2. matelot connection verify --id ${r.id}`);
    if (r.identity?.warning) console.error(`  warning: ${r.identity.warning}`);
  }
}
/** One-line results for connection verbs whose JSON is noise in a terminal; null = print the JSON as usual. */
function connectionSummary(resource: string, verb: string, res: unknown): string | null {
  if (resource !== 'connection' || !res || typeof res !== 'object') return null;
  const r = res as { id?: string; name?: string; status?: string; verified?: boolean; account?: string; deleted?: boolean; repositories?: number; imagesDetached?: string[] };
  if (verb === 'verify' && r.verified) return `verified: ${r.account ?? r.id}`;
  if (verb === 'delete' && r.deleted) return `deleted ${r.name ?? r.id} (${r.repositories ?? 0} repositories removed${r.imagesDetached?.length ? `; images detached: ${r.imagesDetached.join(', ')}` : ''})`;
  if (verb === 'disconnect') return `disconnected ${r.name ?? r.id}`;
  return null;
}
/**
 * The only organization the caller can see, if there is exactly one. Network and server errors surface as they are
 * ("cannot reach …", 401…) instead of turning into a misleading "--org is required".
 */
async function defaultOrg(config: ReturnType<typeof configFromEnv>): Promise<string | undefined> {
  let orgs: { id: string }[];
  try {
    orgs = await request<{ id: string }[]>(config, 'GET', '/api/v1/organizations');
  } catch (error) {
    // a token that may not list organizations (CI tokens): say so, and how to continue
    if (error instanceof CliError && error.status === 403) throw new CliError(`${error.message} — this token cannot list organizations; pass --org <organization id>`, 403);
    throw error;
  }
  return Array.isArray(orgs) && orgs.length === 1 ? orgs[0].id : undefined;
}

// Exit codes: 1 error · 2 policy violation (gate/deploy rejected) · 3 not evaluated (no SBOM yet / correlation pending or failed) · 4 authentication (was 3 before 2.9.0)
// Never process.exit() with output still queued: stdout to a pipe is asynchronous on macOS and Windows, so
// `matelot … | grep …` could lose lines. Exit codes are set with process.exitCode; the error path flushes first.
main().catch((error: unknown) => {
  console.error(`matelot: ${error instanceof Error ? error.message : String(error)}`);
  const code = error instanceof CliError && error.code === 'correlation_pending' ? 3 : error instanceof CliError && error.status === 401 ? 4 : 1;
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
});

interface UsageMetrics { seats: { active: number | null; members: number }; projects: number; services: number; environments: number; pipelines: number; jobs: number; runnerMinutes: number; runnerMinutesByType: Record<string, number>; sboms: number }
interface UsageReport { month: string; live: boolean; computedAt: string; metrics: UsageMetrics; history: { month: string; final: boolean; metrics: UsageMetrics }[] }
/** `matelot usage`: the month as a short report, then the history table. */
function usageText(r: UsageReport): string {
  const m = r.metrics;
  const fmt = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  const lines = [
    `usage ${r.month} (${r.live ? 'live' : `snapshot ${r.computedAt}`}, UTC calendar month)`,
    `  active seats     ${m.seats.active === null ? '— (not tracked yet that month)' : `${fmt(m.seats.active)} of ${fmt(m.seats.members)} members`}`,
    `  runner minutes   ${fmt(m.runnerMinutes)}${Object.keys(m.runnerMinutesByType).length ? `  (${Object.entries(m.runnerMinutesByType).sort((a, b) => b[1] - a[1]).map(([t, v]) => `${t} ${fmt(v)}`).join(', ')})` : ''}`,
    `  jobs             ${fmt(m.jobs)}`,
    `  pipelines        ${fmt(m.pipelines)}`,
    `  sboms            ${fmt(m.sboms)}`,
    `  inventory        ${fmt(m.projects)} projects · ${fmt(m.services)} services · ${fmt(m.environments)} environments`,
  ];
  if (r.history.length > 1) {
    lines.push('', 'month     seats  runner-min  pipelines  jobs  sboms');
    for (const h of r.history) lines.push(`${h.month}  ${(h.metrics.seats.active === null ? '—' : String(h.metrics.seats.active)).padStart(5)}  ${fmt(h.metrics.runnerMinutes).padStart(10)}  ${String(h.metrics.pipelines).padStart(9)}  ${String(h.metrics.jobs).padStart(4)}  ${String(h.metrics.sboms).padStart(5)}${h.final || h.month === r.month ? '' : '  (in progress)'}`);
  }
  return lines.join('\n');
}

type CoverageCheck = { id: string; title: string; state: 'ok' | 'stale' | 'missing'; detail: string; cli: string | null };
type ServiceCoverage = { serviceName: string; projectName: string; covered: boolean; gaps: string[]; checks: CoverageCheck[] };
interface CoverageReport { days: number; projectId?: string; summary: { services: number; covered: number; checks: Record<string, { ok: number; stale: number; missing: number }> }; services?: ServiceCoverage[]; uncovered?: ServiceCoverage[]; uncoveredTotal?: number }
const COVERAGE_PHRASE: Record<string, (days: number) => string> = { repository: () => 'with a repository', pipeline: (d) => `scanned in the last ${d === 1 ? 'day' : `${d} days`}`, sbom: () => 'with an SBOM', policy: () => 'under a policy', deployment: () => 'with a deployment recorded' };
/** `matelot coverage`: per-check counts, a row per service (ok / gap / stale), and the commands that close each gap. */
function coverageText(r: CoverageReport, uncoveredOnly: boolean): string {
  const s = r.summary;
  const rows = (r.services ?? r.uncovered ?? []).filter((x) => !uncoveredOnly || !x.covered);
  const name = (x: ServiceCoverage) => (r.projectId ? x.serviceName : `${x.projectName} / ${x.serviceName}`);
  const fixes = (x: ServiceCoverage) => x.checks.filter((c) => c.state !== 'ok' && c.cli).flatMap((c) => [`  # ${c.id}: ${c.detail}`, `  ${c.cli}`]);
  if (uncoveredOnly) {
    if (!rows.length) return s.services ? `every service is covered (${s.services} of ${s.services})` : 'no services yet';
    return rows.flatMap((x, i) => [...(i ? [''] : []), `${name(x)} — ${x.gaps.length} gap${x.gaps.length === 1 ? '' : 's'}`, ...fixes(x)]).join('\n');
  }
  const lines = [`coverage: ${s.covered} of ${s.services} services fully covered (security pipeline window: ${r.days} day${r.days === 1 ? '' : 's'})`];
  for (const [id, c] of Object.entries(s.checks)) lines.push(`  ${id.padEnd(11)} ${`${c.ok}/${s.services} ${COVERAGE_PHRASE[id]?.(r.days) ?? ''}`.padEnd(36)}${c.missing ? `  ${c.missing} missing` : ''}${c.stale ? `  ${c.stale} stale` : ''}`);
  if (!rows.length) return lines.join('\n');
  const ids = Object.keys(s.checks);
  const width = Math.max(7, ...rows.map((x) => name(x).length));
  lines.push('', `${(r.projectId ? 'service' : 'project / service').padEnd(width)}  ${ids.map((id) => id.padEnd(10)).join(' ')}`);
  for (const x of rows) lines.push(`${name(x).padEnd(width)}  ${ids.map((id) => { const st = x.checks.find((c) => c.id === id)?.state; return (st === 'ok' ? 'ok' : st === 'stale' ? 'stale' : 'GAP').padEnd(10); }).join(' ').trimEnd()}`);
  if (r.uncoveredTotal !== undefined && r.uncoveredTotal > rows.length) lines.push(`… ${r.uncoveredTotal - rows.length} more (--limit)`);
  if (rows.some((x) => !x.covered)) lines.push('', 'fix with `matelot coverage' + (r.projectId ? ` --project ${r.projectId}` : '') + ' --uncovered`');
  return lines.join('\n');
}
interface OnboardingReport { steps: { id: string; title: string; done: boolean; cli: string | null; detail: string | null; optional?: boolean }[]; completed: number; total: number; complete: boolean; completedAt?: string | null; dismissedAt: string | null; next: { title: string; cli: string | null } | null }
/** `matelot onboarding`: one line per step, then the next one with its command. */
function onboardingText(r: OnboardingReport, verb: string): string {
  const state = r.completedAt ? ` — setup completed ${r.completedAt.slice(0, 10)}` : r.complete ? ' — required steps done' : '';
  const hidden = verb === 'dismiss' ? ' — checklist hidden on the Overview' : verb === 'restore' ? ' — checklist shown on the Overview' : r.dismissedAt && !r.completedAt ? ' — checklist hidden on the Overview' : '';
  const lines = [`setup ${r.completed}/${r.total}${state}${hidden}`];
  for (const s of r.steps) lines.push(`  [${s.done ? 'x' : ' '}] ${s.title}${s.optional ? ' (optional)' : ''}${s.detail ? `  — ${s.detail}` : ''}`);
  if (r.next) lines.push('', `next: ${r.next.title}`, ...(r.next.cli ? [`  ${r.next.cli}`] : []));
  return lines.join('\n');
}

/** `matelot doctor`: what an operator checks after `docker compose up -d` / `helm install` — unauthenticated probes
 * first (reachability, readiness, version), then everything the credentials allow (login, organization, runners,
 * registry). Prints one line per check; exit 1 when a check fails. */
async function doctor(urlFlag: string | undefined, json: boolean): Promise<void> {
  const url = resolveCellUrl(urlFlag) ?? '';
  if (!url) throw new CliError('usage: matelot doctor --url https://matelot.example (or MATELOT_URL, or a stored login: matelot cells)');
  const checks: { name: string; ok: boolean | null; detail: string }[] = [];
  const add = (name: string, ok: boolean | null, detail: string) => { checks.push({ name, ok, detail }); if (!json) console.log(`${ok === null ? '  --' : ok ? '  OK' : 'FAIL'}  ${name.padEnd(14)} ${detail}`); };
  const get = async (path: string, token?: string) => {
    const r = await fetch(`${url}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    let body: unknown = text; try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body };
  };
  // 1. reachable + ready — when it is not, and this is a Docker Compose cell (compose.yaml here, or MATELOT_COMPOSE_DIR),
  //    say which container is the problem instead of leaving the user with a timeout
  try {
    const r = await get('/api/v1/health/ready');
    add('api', r.status === 200, r.status === 200 ? `${url} ready` : `${url}/api/v1/health/ready → HTTP ${r.status}`);
    if (r.status !== 200) { add('version', null, `skipped: api not ready (HTTP ${r.status})`); composeDiagnosis(); return finish(); }
  } catch (e) {
    const detail = unreachableDetail(e);
    add('api', false, `${url} unreachable: ${detail}`);
    // the version line is still printed (scripts grep for it) and says why there is none
    add('version', null, `skipped: api unreachable${isTlsCode((e as { cause?: { code?: string } }).cause?.code) ? ` (${detail})` : ''}`);
    composeDiagnosis(); return finish();
  }
  // 2. version
  let version = '?';
  try { const r = await get('/api/v1/version'); const b = r.body as { version?: string } | undefined; version = b?.version ?? '?'; add('version', r.status === 200 && !!b?.version, r.status === 200 ? `API ${version} · CLI ${VERSION}` : `${url}/api/v1/version → HTTP ${r.status} (API older than 0.1.0?)`); }
  catch (e) { add('version', false, (e as Error).message); }
  // 3. OAuth discovery: what `matelot login` and MCP clients read first — must be JSON (not the web app) and must point
  //    back at this origin (not the API's listen address)
  try {
    const r = await get('/.well-known/oauth-authorization-server');
    const meta = r.body as { authorization_endpoint?: string; token_endpoint?: string } | string;
    if (typeof meta === 'string') add('discovery', false, `/.well-known/oauth-authorization-server returned ${/^\s*</.test(meta) ? 'HTML (the web app)' : 'non-JSON'} (HTTP ${r.status}) — route /.well-known/* to the API in the proxy / ingress`);
    else if (r.status !== 200 || !meta.authorization_endpoint) add('discovery', false, `/.well-known/oauth-authorization-server → HTTP ${r.status} without OAuth metadata`);
    else { const m = discoveryMismatch(url, meta); add('discovery', !m, m ?? `endpoints on ${new URL(meta.authorization_endpoint).origin} (matelot login will work)`); }
  } catch (e) { add('discovery', false, (e as Error).message); }
  // 4. credentials (optional: without any, the remaining checks are skipped, not failed)
  let config: Config | null = null;
  try { config = configFromEnv({ ...process.env, MATELOT_URL: url }); if (config.fromLogin) { const t = await freshToken(url); if (!t) throw new Error(`stored login for ${url} expired`); config.token = t; } }
  catch (e) { add('login', null, `skipped: ${(e as Error).message.split('\n')[0]} — run matelot login --url ${url} to check the rest`); return finish(); }
  config.url = url;
  let me: { kind: string; email?: string; name?: string } | null = null;
  try { me = await request(config, 'GET', '/api/v1/api-tokens/whoami'); add('login', true, `${me!.kind === 'token' ? `CI token "${me!.name}"` : `user ${me!.email}`} on ${url}`); }
  catch (e) { add('login', false, (e as Error).message); return finish(); }
  // 5. organization + runners + registry
  let orgs: { id: string; slug: string; name: string }[] = [];
  try { orgs = await request(config, 'GET', '/api/v1/organizations'); add('organization', orgs.length > 0, orgs.length ? orgs.map((o) => o.slug).join(', ') : 'no organization visible to these credentials'); }
  catch (e) { add('organization', false, (e as Error).message); }
  if (orgs[0]) {
    try {
      const pools = await request<{ name: string; managed?: boolean; runners: { name: string; status: string }[] }[]>(config, 'GET', `/api/v1/organizations/${orgs[0].id}/runner-pools`);
      const online = pools.flatMap((p) => p.runners.filter((r) => r.status === 'online'));
      const managed = pools.find((p) => p.managed);
      add('runners', online.length > 0, `${online.length ? `${online.length} online (${online.map((r) => r.name).join(', ')})${managed ? '' : ' · no managed pool'}` : 'no runner online: pipelines will queue (docker compose logs runner / the managed runner StatefulSet)'} — GET /organizations/${orgs[0].slug}/runner-pools: ${pools.length} pool(s) incl. the cell's managed pool`);
    } catch (e) { add('runners', false, (e as Error).message); }
  }
  try {
    const info = await request<{ available: boolean; host: string | null }>(config, 'GET', '/api/v1/registry/info');
    add('registry', info.available, info.available ? `${info.host} (matelot registry login)` : 'built-in registry not configured');
  } catch (e) { add('registry', false, (e as Error).message); }
  return finish();
  function composeDiagnosis(): void {
    const dir = process.env.MATELOT_COMPOSE_DIR ?? process.cwd();
    let exists = false; try { readFileSync(`${dir}/compose.yaml`); exists = true; } catch { /* not a compose folder */ }
    if (!exists) return;
    const ps = spawnSync('docker', ['compose', 'ps', '-a', '--format', 'json'], { cwd: dir, encoding: 'utf8' });
    if (ps.status !== 0) { add('compose', null, `docker compose ps failed in ${dir}: ${(ps.stderr || '').trim().split('\n')[0]}`); return; }
    const text = ps.stdout.trim();
    let rows: { Service?: string; State?: string; Health?: string; ExitCode?: number }[] = [];
    try { rows = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { add('compose', null, 'could not parse docker compose ps output'); return; }
    const fine = (c: typeof rows[number]) => (c.State === 'running' && (!c.Health || c.Health === 'healthy')) || (c.State === 'exited' && (c.ExitCode ?? 0) === 0); // one-shots (init, welcome) exit 0
    const bad = rows.filter((c) => !fine(c));
    if (!bad.length) { add('compose', null, 'every container is running and healthy: the cell may still be starting (docker compose logs -f welcome)'); return; }
    for (const c of bad) add(`compose/${c.Service}`, false, `${c.State}${c.Health ? ` (${c.Health})` : ''}${c.ExitCode ? ` (exit ${c.ExitCode})` : ''} — see docker compose logs ${c.Service}`);
  }
  function finish(): void {
    const failed = checks.filter((c) => c.ok === false);
    if (json) console.log(JSON.stringify({ url, version, checks, ok: failed.length === 0 }, null, 2));
    else console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nall checks passed (${url})`);
    if (failed.length) process.exitCode = 1;
  }
}
