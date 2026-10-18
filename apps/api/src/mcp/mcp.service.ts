import { Injectable, Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * MCP server generated from the API's OpenAPI document: every endpoint becomes a tool
 * (path + query + body → one input schema), executed through the HTTP layer itself so the
 * usual guards, validation, RBAC and audit trail apply. The caller's Authorization header
 * is forwarded unchanged, so a read-scoped personal token yields a read-only MCP.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  method: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  bodyParams: string[];
  readOnly: boolean;
  destructive: boolean;
}

type Schema = Record<string, any>;

const SKIP_PATH = [/^\/auth\b/, /^\/oauth\b/, /^\/health/, /^\/mcp\b/, /^\/runner\b/, /^\/webhooks\b/, /^\/ingest\b/, /\.zip$/, /\/download$/, /^\/registry\/v2/];
const MAX_OUTPUT = 60_000;
/** Routes only a platform administrator (sudo token or web session of an admin) should see. */
const ADMIN_PATH = [/^\/admin\b/, /^\/organizations$/, /^\/runners\b/, /^\/cell\b/];

export interface McpPrincipal {
  email: string;
  displayName: string | null;
  platformRole: 'user' | 'admin';
  /** true when the token grants the platform-admin bypass (admin user with a session or a sudo token). */
  effectiveAdmin: boolean;
  tokenScope: 'read' | 'write' | 'sudo' | 'session';
  memberships: { role: string; scopeType: string; scopeId: string; name: string | null }[];
}

export const INSTRUCTIONS = `Matelot is a product-security platform: it knows which version of each service runs in which environment, what is inside it (SBOM, vulnerabilities, secrets, IaC findings), which policies gate a deployment, who is fixing what (remediation, SLAs, Jira/GitHub issues), and produces signed CRA evidence.

Hierarchy: organization → workspace → team → project → service → environment (dev / test / prod …). Most tools take an id of one of these; list tools (organizations_list, workspaces_list, projects_list, services_list, environments_list) discover ids. Security views (findings, risk, components, policies, remediation, CRA readiness, notification channels) exist at project, team and workspace level; use the one matching the question's scope.

Typical flows:
- "why is prod blocked": environments_gate (latest gate evaluation) → findings with severity/kev filters for the project → policies at the environment's scope → exceptions.
- "fix first": remediation queue for the project/workspace → remediations create → remediations issue (Jira / GitHub).
- "accept a risk": exceptions create (time-boxed, reason required) → exceptions approve.
- "prove compliance": cra readiness → releases list → evidence summary / vex.
- Deployments are recorded by CI (deploy / promote); avoid recording deployments from a conversation unless the user explicitly asks. A gate evaluation with only a version (no image/digest) registers that version as a release; prefer reading the latest gate result (environments / policies latest) over running a new one.
- Token scope is a mask over the user's own roles: a "read" token is read-only; "write" does everything the roles allow for day-to-day work (create workspaces / teams / projects, run pipelines, push to the registry, decide on findings, remediations / issues, request exceptions, connect git hosts / registries below the organization) but cannot administer (approve exceptions, policies / SLAs / channels, memberships, organization-wide connections and credential changes, organization settings, runner pools) nor archive / delete anything — those need "sudo". See docs/roles.md.

Large lists: every GET tool accepts max_items (default 50) and fields (comma list) to keep answers small; use the tool's own filters (severity, status, kev, q, running) first.
- Call matelot_start_here first in a new session: it returns these instructions plus who the token acts as and its memberships.

Before any tool that creates, changes or deletes something (create/update/delete/approve/revoke/set/apply/disconnect), state what you are about to do and confirm with the user unless they already asked for exactly that. Never invent ids: look them up. Responses are JSON from the API; summarise them for the user rather than dumping them.`;

@Injectable()
export class McpService {
  private readonly log = new Logger(McpService.name);
  private tools: McpTool[] = [];
  private base = 'http://127.0.0.1:3000/api/v1';

  load(doc: OpenAPIObject, port: number | string) {
    this.base = `http://127.0.0.1:${port}/api/v1`;
    const schemas: Record<string, Schema> = (doc.components?.schemas as Record<string, Schema>) ?? {};
    const resolve = (s: Schema | undefined, depth = 0): Schema => {
      if (!s) return { type: 'string' };
      if (s.$ref) {
        const name = String(s.$ref).split('/').pop()!;
        return depth > 3 ? { type: 'object', description: name } : resolve(schemas[name], depth + 1);
      }
      const out: Schema = { ...s };
      delete out.nullable;
      if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties as Record<string, Schema>).map(([k, v]) => [k, resolve(v, depth + 1)]));
      if (out.items) out.items = resolve(out.items, depth + 1);
      if (out.allOf) { const merged: Schema = { type: 'object', properties: {}, required: [] }; for (const part of out.allOf) { const r = resolve(part, depth + 1); Object.assign(merged.properties, r.properties ?? {}); merged.required.push(...(r.required ?? [])); } return merged; }
      return out;
    };
    const names = new Set<string>();
    const tools: McpTool[] = [];
    const prefix = '/api/v1';
    for (const [rawPath, item] of Object.entries(doc.paths ?? {})) {
      const path = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
      if (SKIP_PATH.some((r) => r.test(path))) continue;
      for (const method of ['get', 'post', 'patch', 'put', 'delete'] as const) {
        const op = (item as Record<string, any>)[method];
        if (!op) continue;
        const name = this.toolName(op.operationId, method, path, names);
        const props: Record<string, Schema> = {};
        const required: string[] = [];
        const pathParams: string[] = [];
        const queryParams: string[] = [];
        for (const p of [...((item as any).parameters ?? []), ...(op.parameters ?? [])]) {
          const s = resolve(p.schema);
          props[p.name] = { ...s, description: p.description ?? (p.in === 'path' ? `${p.name} (uuid)` : undefined) };
          if (p.in === 'path') { pathParams.push(p.name); required.push(p.name); }
          else if (p.in === 'query') { queryParams.push(p.name); if (p.required) required.push(p.name); }
        }
        // Nest does not always emit path parameters into the document: add the placeholders from the path itself.
        for (const m of path.matchAll(/[:{]([A-Za-z0-9_]+)}?/g)) {
          const pn = m[1]!;
          if (!pathParams.includes(pn)) { pathParams.push(pn); required.push(pn); props[pn] = { type: 'string', description: `${pn} (uuid)` }; }
        }
        const bodyParams: string[] = [];
        const body = op.requestBody?.content?.['application/json']?.schema;
        if (body) {
          const bs = resolve(body);
          if (bs.properties) {
            for (const [k, v] of Object.entries(bs.properties as Record<string, Schema>)) { if (!(k in props)) { props[k] = v; bodyParams.push(k); } }
            for (const r of bs.required ?? []) if (!required.includes(r)) required.push(r);
          } else { props.body = { ...bs, description: 'Request body' }; bodyParams.push('body'); }
        }
        if (method === 'get') {
          props.max_items = { type: 'integer', description: 'When the response is a list: keep only the first N items (default 50, max 500). Handled by the MCP layer; combine with the tool\'s own filters to narrow first.' };
          props.fields = { type: 'string', description: 'Comma-separated field names to keep on each list item (e.g. "id,severity,componentName,fixedVersion"). Reduces output size.' };
        }
        const destructive = method === 'delete' || /revoke|disconnect|remove|reject|rotate/.test(path);
        const summary = String(op.summary ?? op.description ?? '').trim();
        tools.push({
          name,
          description: `${summary || humanize(method, path)}. ${method.toUpperCase()} ${path}${destructive ? ' (destructive)' : ''}`.slice(0, 1000),
          inputSchema: { type: 'object', properties: props, ...(required.length ? { required } : {}), additionalProperties: false },
          method: method.toUpperCase(), path, pathParams, queryParams, bodyParams, readOnly: method === 'get', destructive,
        });
      }
    }
    this.tools = tools.sort((a, b) => a.name.localeCompare(b.name));
    this.log.log(`MCP: ${tools.length} tools generated from OpenAPI`);
  }

  private toolName(operationId: string | undefined, method: string, path: string, taken: Set<string>): string {
    let base: string;
    const multi = operationId ? /\[\d+\]$/.test(operationId) : false;
    const literals = path.split('/').filter((seg) => seg && !seg.startsWith(':') && !seg.startsWith('{')).map((seg) => seg.replace(/[^a-z0-9]+/gi, '_'));
    if (operationId && operationId.includes('_')) {
      const [ctrl, fn] = operationId.replace(/\[\d+\]$/, '').split('_');
      base = `${snake(ctrl!.replace(/Controller$/, ''))}_${snake(fn!)}`;
      if (multi && literals[0]) base += `_${literals[0]}`; // scoped routes: one tool per scope kind (workspaces / teams / projects)
    } else base = `${method}_${literals.join('_')}`;
    base = base.replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase().slice(0, 60);
    let name = base; let i = 2;
    while (taken.has(name)) name = `${base}_${literals[literals.length - 1] && !base.endsWith(literals[literals.length - 1]!) ? literals[literals.length - 1]!.toLowerCase() : i++}`;
    name = name.replace(/[^a-z0-9_-]/g, '_');
    taken.add(name);
    return name;
  }

  /** Who the token acts as: resolved through the API itself so the same RBAC rules apply (sudo vs restricted). */
  async principal(authorization: string | undefined, tokenScope: McpPrincipal['tokenScope']): Promise<McpPrincipal | null> {
    if (!authorization) return null;
    try {
      const res = await fetch(`${this.base}/me`, { headers: { accept: 'application/json', authorization } });
      if (!res.ok) return null;
      const me = (await res.json()) as { user: { email: string; displayName: string | null; platformRole: 'user' | 'admin' }; memberships: { role: string; scopeType: string; scopeId: string; scope: { name: string } | null }[] };
      const effectiveAdmin = me.user.platformRole === 'admin' && (tokenScope === 'session' || tokenScope === 'sudo');
      return { email: me.user.email, displayName: me.user.displayName, platformRole: me.user.platformRole, effectiveAdmin, tokenScope, memberships: me.memberships.map((m) => ({ role: m.role, scopeType: m.scopeType, scopeId: m.scopeId, name: m.scope?.name ?? null })) };
    } catch {
      return null;
    }
  }

  /** Tools this principal can use: no admin routes for non-admins, GET-only for read tokens. */
  visible(p: McpPrincipal | null): McpTool[] {
    const readOnly = p?.tokenScope === 'read';
    const admin = !!p?.effectiveAdmin;
    return this.tools.filter((t) => (admin || !ADMIN_PATH.some((r) => r.test(t.path))) && (!readOnly || t.readOnly));
  }

  identity(p: McpPrincipal | null): string {
    if (!p) return '';
    const who = `${p.displayName ?? p.email} <${p.email}>`;
    const power = p.effectiveAdmin ? 'PLATFORM ADMINISTRATOR of this Matelot cell: every organization, workspace, team, project and admin route is available.' : p.tokenScope === 'read' ? 'read-only token: querying only, no tool that changes anything is available.' : 'regular member: only the scopes listed below (and what they contain) are visible or changeable; admin routes are hidden.';
    const rows = p.memberships.slice(0, 60).map((m) => `- ${m.role} on ${m.scopeType.toLowerCase()} ${m.name ?? ''} (${m.scopeId})`).join('\n');
    return `\n\nYou are acting as ${who} — ${power}\nToken scope: ${p.tokenScope}. Actions are audited under this user.${rows ? `\nMemberships:\n${rows}` : p.effectiveAdmin ? '\nMemberships: none needed (platform administrator).' : '\nMemberships: none. Unless the user is a cell administrator (then every organization is visible, and administration needs a sudo token), nothing is visible with this token: the user needs a workspace, team or project membership.'}${p.memberships.length > 60 ? `\n… ${p.memberships.length - 60} more` : ''}\nWhen the user asks about something outside these scopes, say it is not visible to them rather than guessing.`;
  }

  startHere(p: McpPrincipal | null) {
    return { name: 'matelot_start_here', description: 'Call this first: how Matelot is organised, the main flows, and who this connection acts as (user, role, token scope, memberships with ids). No side effects.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
  }

  list(p: McpPrincipal | null = null): { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }[] {
    return [this.startHere(p), ...this.visible(p).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive, idempotentHint: t.readOnly } }))];
  }

  async call(name: string, args: Record<string, unknown>, authorization: string | undefined, p: McpPrincipal | null = null): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    if (name === 'matelot_start_here') return { content: [{ type: 'text', text: INSTRUCTIONS + this.identity(p) }] };
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
    if (p?.tokenScope === 'read' && !tool.readOnly) return { content: [{ type: 'text', text: `This personal token is read-only; ${name} would ${tool.method} ${tool.path}. Create a token with scope "write" to use it.` }], isError: true };
    if (p && !p.effectiveAdmin && ADMIN_PATH.some((r) => r.test(tool.path))) return { content: [{ type: 'text', text: `${name} is a platform-administrator tool; ${p.email} is not an administrator here (or the token is not sudo).` }], isError: true };
    let path = tool.path;
    for (const p of tool.pathParams) {
      const v = args[p];
      if (v === undefined || v === null || v === '') return { content: [{ type: 'text', text: `Missing path parameter "${p}"` }], isError: true };
      path = path.replace(`:${p}`, encodeURIComponent(String(v))).replace(`{${p}}`, encodeURIComponent(String(v)));
    }
    const qs = new URLSearchParams();
    for (const q of tool.queryParams) if (args[q] !== undefined && args[q] !== null && args[q] !== '') qs.set(q, String(args[q]));
    const body: Record<string, unknown> = {};
    if (tool.bodyParams.length === 1 && tool.bodyParams[0] === 'body' && args.body && typeof args.body === 'object') Object.assign(body, args.body);
    else for (const b of tool.bodyParams) if (args[b] !== undefined) body[b] = args[b];
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ''}`;
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'matelot-mcp/1.0' };
    if (authorization) headers.authorization = authorization;
    if (tool.method !== 'GET') headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, { method: tool.method, headers, body: tool.method === 'GET' ? undefined : JSON.stringify(body) });
    } catch (e) {
      return { content: [{ type: 'text', text: `Request failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
    const text = await res.text();
    let pretty = text;
    try {
      let data: unknown = JSON.parse(text);
      let note = '';
      const maxItems = Math.min(500, Math.max(1, Number(args.max_items ?? 50) || 50));
      const fields = typeof args.fields === 'string' && args.fields.trim() ? args.fields.split(',').map((f) => f.trim()).filter(Boolean) : null;
      const shape = (arr: unknown[]): unknown[] => {
        const total = arr.length;
        let out = arr.slice(0, maxItems);
        if (fields) out = out.map((it) => (it && typeof it === 'object' ? Object.fromEntries(fields.filter((f) => f in (it as Record<string, unknown>)).map((f) => [f, (it as Record<string, unknown>)[f]])) : it));
        if (total > out.length) note = `Showing ${out.length} of ${total} items (max_items=${maxItems}). Narrow with the tool's filters (severity, status, kev, q, …) or raise max_items.`;
        return out;
      };
      if (Array.isArray(data)) data = shape(data);
      else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).items)) data = { ...(data as Record<string, unknown>), items: shape((data as Record<string, unknown>).items as unknown[]) };
      pretty = JSON.stringify(data);
      if (note) pretty = `${note}\n${pretty}`;
    } catch { /* not json */ }
    if (pretty.length > MAX_OUTPUT) pretty = `${pretty.slice(0, MAX_OUTPUT)}\n… (truncated at ${MAX_OUTPUT} chars of ${pretty.length}; use fields= and max_items= or the tool's filters)`;
    if (!res.ok) return { content: [{ type: 'text', text: `HTTP ${res.status} ${tool.method} ${path}\n${pretty || res.statusText}` }], isError: true };
    return { content: [{ type: 'text', text: pretty || `${res.status} (no content)` }] };
  }

  count() { return this.tools.length; }
}

const VERB: Record<string, string> = { get: 'Get', post: 'Create', patch: 'Update', put: 'Replace', delete: 'Delete' };
/** "GET /projects/{projectId}/findings/summary" → "Get the findings summary of a project". */
function humanize(method: string, path: string): string {
  const segs = path.split('/').filter(Boolean);
  const literal = segs.filter((x) => !x.startsWith(':') && !x.startsWith('{')).map((x) => x.replace(/[-_]/g, ' '));
  const params = segs.filter((x) => x.startsWith(':') || x.startsWith('{')).map((x) => x.replace(/[:{}]/g, '').replace(/Id$/, ''));
  const last = literal[literal.length - 1] ?? 'resource';
  const endsWithParam = segs[segs.length - 1]?.startsWith(':') || segs[segs.length - 1]?.startsWith('{');
  const verb = method === 'get' ? (endsWithParam ? 'Get one' : 'List / get') : VERB[method] ?? method;
  const of = params.length ? ` of ${params.join(' / ')}` : '';
  const action = method === 'post' && /^(test|approve|sync|verify|apply|recompute|retry|cancel|promote|gate|complete|skip|issue|enrich|reconcile|snapshots?)$/.test(last) ? `${last[0]!.toUpperCase()}${last.slice(1)}` : `${verb} ${last}`;
  return `${action}${of}`;
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
