/**
 * `matelot login [--url https://matelot.example]`: OAuth 2.1 authorization-code flow with PKCE against the cell,
 * loopback redirect (RFC 8252), token stored in ~/.config/matelot/credentials.json and refreshed when it expires.
 * Env (MATELOT_TOKEN / MATELOT_KEY_ID+SECRET) still wins when set, so CI is unaffected.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export const CLI_CLIENT_ID = 'matelot-cli';
export const credentialsPath = () => process.env.MATELOT_CREDENTIALS ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'matelot', 'credentials.json');

export interface StoredCredentials { url: string; accessToken: string; refreshToken?: string; expiresAt: string | null; scope: string; user?: string }
/** Older files used snake_case; read both. */
function normalise(raw: Record<string, unknown>): StoredCredentials {
  return { url: String(raw.url ?? ''), accessToken: String(raw.accessToken ?? raw.access_token ?? ''), refreshToken: (raw.refreshToken ?? raw.refresh_token ?? undefined) as string | undefined, expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : typeof raw.expires_at === 'number' && Number.isFinite(raw.expires_at) ? new Date(raw.expires_at).toISOString() : null, scope: String(raw.scope ?? ''), user: raw.user as string | undefined };
}

export function readCredentials(url?: string): StoredCredentials | null {
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  try { const all = JSON.parse(readFileSync(p, 'utf8')) as Record<string, Record<string, unknown>>; const key = (url ?? Object.keys(all)[0] ?? '').replace(/\/$/, ''); return all[key] ? normalise(all[key]) : null; } catch { return null; }
}
export function writeCredentials(c: StoredCredentials): void {
  const p = credentialsPath(); mkdirSync(join(p, '..'), { recursive: true });
  let all: Record<string, StoredCredentials> = {}; try { all = JSON.parse(readFileSync(p, 'utf8')); } catch { /* new file */ }
  all[c.url.replace(/\/$/, '')] = c; writeFileSync(p, JSON.stringify(all, null, 2)); try { chmodSync(p, 0o600); } catch { /* windows */ }
}

/**
 * Open the user's browser: $BROWSER first, then the platform openers (macOS open; Windows start; Linux/WSL xdg-open,
 * wslview, sensible-browser, x-www-browser). A missing opener is NOT fatal — the 'error' event is handled, the next
 * candidate is tried, and the caller prints the URL to copy. Resolves true when some opener started.
 */
export function openBrowser(url: string): Promise<boolean> {
  const candidates: [string, string[]][] = [];
  if (process.env.BROWSER) candidates.push([process.env.BROWSER, [url]]);
  if (process.platform === 'darwin') candidates.push(['open', [url]]);
  else if (process.platform === 'win32') candidates.push(['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]);
  else candidates.push(['xdg-open', [url]], ['wslview', [url]], ['sensible-browser', [url]], ['x-www-browser', [url]]);
  return candidates.reduce<Promise<boolean>>((prev, [cmd, args]) => prev.then((ok) => ok ? true : new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false)); // ENOENT etc.: try the next one
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  })), Promise.resolve(false));
}

/** Runs the browser flow; `opts.open` lets tests drive the consent step. Returns stored credentials. */
/**
 * fetch that honours 429 + Retry-After (≤ 60 s, at most 3 retries; a note on stderr). The OAuth calls are anonymous, so
 * they share the per-address window with the consent page's own requests; a 429 was refused before anything ran (the
 * authorization code is not consumed), so repeating it is safe.
 */
export function retryingFetch(f: typeof fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (let attempt = 0; ; attempt++) {
      const res = await f(input, init);
      const wait = Number(res.headers.get('retry-after'));
      if (res.status !== 429 || !Number.isFinite(wait) || wait < 0 || wait > 60 || attempt >= 3) return res;
      process.stderr.write(`rate limited by the platform; retrying in ${wait} s\n`);
      await sleep(wait * 1000);
    }
  }) as typeof fetch;
}

/** OAuth discovery through whatever proxy fronts the cell: a non-JSON answer almost always means /.well-known is routed
 *  to the web app instead of the API (Caddy / ingress / dev proxy must forward it). */
export async function discover(base: string, f: typeof fetch): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  const u = `${base}/.well-known/oauth-authorization-server`;
  let res: Response;
  try { res = await f(u); } catch (e) { throw new Error(`cannot reach ${u}: ${(e as Error).message}`); }
  const text = await res.text();
  let meta: { authorization_endpoint?: string; token_endpoint?: string };
  try { meta = JSON.parse(text); } catch {
    const html = /^\s*</.test(text);
    throw new Error(`${u} returned ${html ? 'HTML' : 'something that is not JSON'} (HTTP ${res.status}) — is /.well-known routed to the API by the reverse proxy / ingress of this cell?`);
  }
  if (!res.ok || !meta.authorization_endpoint || !meta.token_endpoint) throw new Error(`${u} answered HTTP ${res.status} without OAuth metadata: ${text.slice(0, 200)}`);
  const mismatch = discoveryMismatch(base, meta as { authorization_endpoint: string; token_endpoint: string });
  if (mismatch) console.error(`warning: ${mismatch}`);
  return meta as { authorization_endpoint: string; token_endpoint: string };
}

/** The advertised endpoints must live on the origin the user connected to; otherwise the login link points at an address
 *  that is not exposed (the API's listen port behind a proxy). Returns the warning text, or null when consistent. */
export function discoveryMismatch(base: string, meta: { authorization_endpoint?: string; token_endpoint?: string }): string | null {
  let origin: string; try { origin = new URL(base).origin; } catch { return null; }
  const off = ['authorization_endpoint', 'token_endpoint'].map((k) => meta[k as 'authorization_endpoint']).filter((v): v is string => !!v).filter((v) => { try { return new URL(v).origin !== origin; } catch { return true; } });
  if (!off.length) return null;
  return `the cell advertises ${new URL(off[0]!).origin} but you connected to ${origin} — check API_PUBLIC_URL on the cell (it must be the public URL, not the API's listen address); the sign-in link below may not open`;
}

export async function login(url: string, scope: 'read' | 'write' | 'sudo', opts: { open?: (authorizeUrl: string) => void; noBrowser?: boolean; timeoutMs?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): Promise<StoredCredentials> {
  const base = url.replace(/\/$/, '');
  const f = retryingFetch(opts.fetchImpl ?? fetch, opts.sleep);
  const meta = await discover(base, f);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      // a stale tab (another login's state) must not end THIS login: answer it and keep listening for the right callback
      if (u.searchParams.get('state') !== state) { res.writeHead(400, { 'content-type': 'text/html' }); res.end('<p>This sign-in window is no longer valid (state mismatch). Go back to the terminal and use the current link.</p>'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(err ? `<p>Login refused (${err}). You can close this tab.</p>` : '<p>matelot is logged in. You can close this tab.</p>');
      server.close();
      if (err) reject(new Error(`authorization refused: ${err}`));
      else resolve(u.searchParams.get('code') ?? '');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const authorize = `${meta.authorization_endpoint}?${new URLSearchParams({ response_type: 'code', client_id: CLI_CLIENT_ID, redirect_uri: `http://127.0.0.1:${port}/callback`, scope, state, code_challenge: challenge, code_challenge_method: 'S256' })}`;
      (opts.open ?? ((a) => {
        if (opts.noBrowser) { console.error(`Sign in by opening this link in a browser:\n  ${a}\n(waiting for the callback)`); return; }
        void openBrowser(a).then((ok) => console.error(ok ? `Opening your browser to sign in… If it does not open, visit:\n  ${a}` : `No browser opener found (set $BROWSER, or use --no-browser). Open this link:\n  ${a}\n(waiting for the callback)`));
      }))(authorize);
      (server as unknown as { redirectUri: string }).redirectUri = `http://127.0.0.1:${port}/callback`;
      setTimeout(() => { server.close(); reject(new Error('login timed out (no browser callback)')); }, opts.timeoutMs ?? 300_000).unref();
    });
    (server as unknown as { onPort?: (p: number) => void }).onPort = undefined;
  }).then(async (c) => c);
  const redirectUri = (code as unknown as { redirectUri?: string }).redirectUri; void redirectUri;
  const tokenRes = await f(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CLI_CLIENT_ID, code_verifier: verifier }) });
  const tok = (await tokenRes.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string; error?: string; error_description?: string };
  if (!tokenRes.ok || !tok.access_token) throw new Error(`token exchange failed: ${tok.error ?? tokenRes.status} ${tok.error_description ?? (tok as { message?: string }).message ?? ''}`.trim());
  const expiresIn = Number.isFinite(Number(tok.expires_in)) && Number(tok.expires_in) > 0 ? Number(tok.expires_in) : 86400;
  if (!tok.refresh_token) console.error('warning: the server issued no refresh token; you will have to run `matelot login` again when this one expires');
  const creds: StoredCredentials = { url: base, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(), scope: tok.scope ?? scope };
  writeCredentials(creds);
  return creds;
}

/** Refresh when the stored access token is (nearly) expired; returns the usable access token or null. */
export async function freshToken(url: string, fetchImplRaw: typeof fetch = fetch, sleep?: (ms: number) => Promise<void>): Promise<string | null> {
  const fetchImpl = retryingFetch(fetchImplRaw, sleep);
  const c = readCredentials(url);
  if (!c || !c.accessToken) return null;
  if (c.expiresAt && new Date(c.expiresAt).getTime() - Date.now() > 60_000) return c.accessToken;
  if (!c.refreshToken) return c.expiresAt ? null : c.accessToken; // unknown expiry, no refresh: try it
  try {
    const meta = await discover(c.url, fetchImpl);
    const r = await fetchImpl(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: CLI_CLIENT_ID }) });
    const tok = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!r.ok || !tok.access_token) return null;
    writeCredentials({ ...c, accessToken: tok.access_token, refreshToken: tok.refresh_token ?? c.refreshToken, expiresAt: new Date(Date.now() + (tok.expires_in ?? 86400) * 1000).toISOString(), scope: tok.scope ?? c.scope });
    return tok.access_token;
  } catch { return null; }
}

/** Revoke the stored refresh token (and with it the access token) at the server, then forget it locally. */
export async function logout(url?: string, fetchImpl: typeof fetch = fetch): Promise<{ url: string; revoked: boolean } | null> {
  const c = readCredentials(url);
  if (!c) return null;
  let revoked = false;
  try { const r = await fetchImpl(`${c.url}/api/v1/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: c.refreshToken ?? c.accessToken }) }); revoked = r.ok; } catch { revoked = false; }
  writeCredentials({ url: c.url, accessToken: '', refreshToken: undefined, expiresAt: null, scope: c.scope });
  return { url: c.url, revoked };
}
