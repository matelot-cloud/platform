/**
 * Background refetches carry `x-matelot-poll: 1` (the cell records no trace of its own for them); the first fetch of a
 * query and queries without a refresh interval do not.   node test/poll-header.mjs
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost:5173/', pretendToBeVisual: true });
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'CustomEvent', 'Event', 'DOMParser', 'history', 'location', 'self']) {
  if (window[key] === undefined) continue;
  try { globalThis[key] = window[key]; } catch { Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true }); }
}
window.matchMedia = globalThis.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
window.ResizeObserver = globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = false;
window.localStorage.setItem('secops.refreshSeconds', '1');   // the dashboard refresh interval: 1 s

const calls = [];   // { path, poll }
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = window.fetch = async (input, init) => {
  const key = String(input).split('?')[0];
  calls.push({ path: key, poll: new Headers(init?.headers).get('x-matelot-poll') });
  if (key === '/api/v1/me') return json({ id: 'u1', email: 'admin@acme.local', platformRole: 'admin' });
  if (key === '/api/v1/organizations') return json([{ id: 'o1', slug: 'acme', name: 'ACME' }]);
  return json({ statusCode: 404 });
};

setTimeout(() => { console.error('poll header test: timed out'); process.exit(2); }, 60_000).unref();
const server = await createServer({ root, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { 'react-oidc-context': path.join(root, 'test/stubs/react-oidc-context.tsx'), 'react-apexcharts': path.join(root, 'test/stubs/react-apexcharts.tsx') } } });
let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed = true; };
try {
  const { mountProbe } = await server.ssrLoadModule('/test/poll-harness.tsx');
  const { root: reactRoot } = mountProbe(window.document.getElementById('root'));
  await new Promise((r) => setTimeout(r, 3500));   // the first fetch, then ≥ 2 interval refetches of /me
  const me = calls.filter((c) => c.path === '/api/v1/me');
  const orgs = calls.filter((c) => c.path === '/api/v1/organizations');
  check(me.length >= 3, `/me fetched ${me.length} times (first + interval refetches)`);
  check(me[0]?.poll === null, 'the first /me fetch is not a poll');
  check(me.slice(1).every((c) => c.poll === '1'), 'every later /me fetch carries x-matelot-poll: 1');
  check(orgs.length === 1 && orgs[0].poll === null, `/organizations (no interval): fetched once, no poll header (${orgs.length} call(s))`);
  check(window.document.body.textContent.includes('admin@acme.local / 1'), 'both hooks rendered their data');
  reactRoot.unmount();
} finally {
  await server.close();
}
if (failed) process.exit(1);
console.log("poll header ok"); process.exit(0);
