/**
 * Parity guard: every mutating API route (= every MCP write tool) has a `matelot` CLI command, and every API call
 * the web app makes targets a documented route. Walks the sources, so it runs without a database.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const API = resolve(__dirname);
const CLI = resolve(__dirname, '../../cli/src');
const WEB = resolve(__dirname, '../../web/src');
const walk = (dir: string, out: string[] = []): string[] => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p, out); } else out.push(p); } return out; };
const norm = (p: string) => p.replace(/\/api\/v1/, '').replace(/\?.*$/, '').replace(/:\w+|\{[^}]+\}|\$\{[^}]*\}/g, '{x}').replace(/\/+$/, '');
const SCOPES = ['organizations', 'workspaces', 'teams', 'projects', 'services'];
/** `${expr}` → `{x}` with nested braces honoured; a `${scope}s/` prefix (e.g. `${t}s/${id}`) becomes a scope segment. */
function stripTemplates(t: string): string {
  let out = ''; let i = 0;
  while (i < t.length) {
    if (t[i] === '$' && t[i + 1] === '{') {
      let depth = 0; let j = i + 1;
      for (; j < t.length; j++) { if (t[j] === '{') depth++; else if (t[j] === '}') { depth--; if (depth === 0) break; } }
      out += '{x}'; i = j + 1;
    } else out += t[i++];
  }
  // `${t}s/${id}` → a scope segment; a trailing `${query}` glued to the path is a query string
  return out.replace(/\/\{x\}s\/\{x\}\//g, '/{x}/').replace(/\{x\}s\//g, '{x}/').replace(/([^/])\{x\}$/g, '$1').replace(/\?.*$/, '');
}
/** A call like api(`${cond ? `/projects/${p}/x` : `/organizations/${o}/x`}`) checks every branch literal. */
function candidates(t: string): string[] {
  const inner = [...t.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  const rest = t.replace(/^\$\{[\s\S]*\}/, '');
  return inner.length ? inner.map((i) => stripTemplates(i + (t.startsWith('${') ? rest : ''))) : [stripTemplates(t)];
}
const expand = (p: string) => (p.startsWith('/{x}/') ? SCOPES.map((s) => p.replace('/{x}/', `/${s}/{x}/`)) : [p]);

/** Every api(`…`, {…}) call in a source file, with the template captured even when it nests `${cond ? `a` : `b`}`. */
function apiCalls(s: string): { 1: string; 2?: string }[] {
  const out: { 1: string; 2?: string }[] = [];
  const re = /\bapi(?:<[^(]*?>)?\(\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let i = m.index + m[0].length; let depth = 0; let tpl = '';
    for (; i < s.length; i++) { const c = s[i]; if (c === '$' && s[i + 1] === '{') { depth++; tpl += c; continue; } if (c === '}' && depth > 0) { depth--; tpl += c; continue; } if (c === '`' && depth === 0) break; tpl += c; }
    const opts = /^\s*,\s*\{([^}]*)\}/.exec(s.slice(i + 1, i + 400));
    out.push({ 1: tpl, 2: opts?.[1] });
  }
  return out;
}

/** API routes from controllers (method, path, excluded-from-OpenAPI). */
function apiRoutes() {
  const routes: { method: string; path: string; excluded: boolean }[] = [];
  for (const f of walk(API).filter((x) => x.endsWith('.controller.ts'))) {
    const s = readFileSync(f, 'utf8');
    const ctrl = /@Controller\(\s*(?:'([^']*)')?/.exec(s);
    const prefix = ctrl?.[1] ?? '';
    const excluded = s.includes('@ApiExcludeController');
    for (const m of s.matchAll(/@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)'|\[([^\]]*)\])?\s*\)/g)) {
      const paths = m[2] !== undefined ? [m[2]] : m[3] ? m[3].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')) : [''];
      for (const p of paths) routes.push({ method: m[1]!.toUpperCase(), path: norm('/' + [prefix, p].filter(Boolean).join('/').replace(/\/+/g, '/')), excluded });
    }
  }
  return routes;
}
/** CLI coverage: RESOURCES entries + CUSTOM_COMMANDS. */
function cliCoverage() {
  const rs = readFileSync(join(CLI, 'resources.ts'), 'utf8');
  const set = new Set<string>();
  for (const m of rs.matchAll(/method:\s*'(\w+)',\s*path:\s*'([^']+)'/g)) for (const p of expand(norm(m[2]!))) set.add(`${m[1]!.toUpperCase()} ${p}`);
  return set;
}
/** Routes that are not user actions: runner protocol, webhooks, MCP transport, registry event sink, OAuth. */
const NOT_USER_ACTIONS = /^\/(runner|webhooks|mcp|registry\/events|auth|oauth|integrations\/github\/callback)/;

describe('UI ⇄ API ⇄ CLI parity', () => {
  const routes = apiRoutes();
  it('finds the routes', () => { expect(routes.length).toBeGreaterThan(200); });

  it('every mutating API route (MCP write tool) has a matelot command', () => {
    const cli = cliCoverage();
    const missing = routes.filter((r) => r.method !== 'GET' && !r.excluded && !NOT_USER_ACTIONS.test(r.path) && !cli.has(`${r.method} ${r.path}`)).map((r) => `${r.method} ${r.path}`);
    expect([...new Set(missing)].sort()).toEqual([]);
  });

  it('every API call of the web app targets a documented route (no private/web-only endpoints)', () => {
    const known = new Set(routes.filter((r) => !r.excluded).flatMap((r) => expand(r.path).map((p) => `${r.method} ${p}`)));
    const unknown: string[] = [];
    for (const f of walk(WEB).filter((x) => /\.(ts|tsx)$/.test(x))) {
      const s = readFileSync(f, 'utf8');
      for (const m of apiCalls(s)) {
        const method = (/method:\s*'(\w+)'/.exec(m[2] ?? '')?.[1] ?? 'GET').toUpperCase();
        // each branch candidate must resolve; a scope-generic path (`/{x}/…`) resolves when any scope has the route
        for (const c of candidates(m[1]!)) {
          const path = norm(c);
          if (!/[a-z]/.test(path)) continue; // fully dynamic (`${base}`): nothing to check statically
          if (!expand(path).some((p) => known.has(`${method} ${p}`))) unknown.push(`${method} ${path}  (${f.replace(WEB + '/', '')})`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
