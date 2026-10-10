/** Overview "Get started" card: steps from the API, next step expanded, Hide → "Show the setup checklist" → back. */
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost:5173/overview', pretendToBeVisual: true });
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'CustomEvent', 'Event', 'DOMParser', 'history', 'location', 'self']) {
  if (window[key] === undefined) continue;
  try { globalThis[key] = window[key]; } catch { Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true }); }
}
window.matchMedia = globalThis.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
window.ResizeObserver = globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const ORG = '11111111-1111-4111-8111-111111111111';
let dismissedAt = null;
let canManage = true;
let completedAt = null;
const calls = [];
const st = (id, title, done, extra = {}) => ({ id, title, description: `${title}: why it matters`, done, href: `/somewhere/${id}`, cli: `matelot ${id}`, detail: null, ...extra });
const body = () => {
  const steps = [st('connect_source', 'Connect your source code', true), st('create_service', 'Create a project and a service', false), st('notifications', 'Send alerts somewhere', false, { optional: true })];
  return { organizationId: ORG, canManage, steps, completed: 1, total: 3, requiredRemaining: 1, complete: false, completedAt, dismissedAt, visible: !dismissedAt && !completedAt, next: steps[1] };
};
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = window.fetch = async (input, init) => {
  const key = new URL(String(input), 'http://localhost').pathname;
  if (key === `/api/v1/organizations/${ORG}/onboarding`) return json(body());
  if (key.endsWith('/onboarding/dismiss') && init?.method === 'POST') { calls.push('dismiss'); dismissedAt = new Date().toISOString(); return json(body()); }
  if (key.endsWith('/onboarding/restore') && init?.method === 'POST') { calls.push('restore'); dismissedAt = null; return json(body()); }
  return json({ statusCode: 404, message: `no fixture for ${key}` }, 404);
};

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.error ?? e.message)));
setTimeout(() => { console.error('onboarding card test: timed out'); process.exit(2); }, 60_000).unref();
const server = await createServer({ root, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { 'react-oidc-context': path.join(root, 'test/stubs/react-oidc-context.tsx'), 'react-apexcharts': path.join(root, 'test/stubs/react-apexcharts.tsx') } } });
let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed = true; };
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const text = () => window.document.body.textContent.replace(/\s+/g, ' ');
const button = (label) => [...window.document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
try {
  const { mountGetStarted } = await server.ssrLoadModule('/test/keyless-harness.tsx');
  mountGetStarted(window.document.getElementById('root'), ORG);
  await settle(1200);
  check(text().includes('Set up your organization') && text().includes('1 of 3 done'), 'card shows progress');
  check(!window.document.querySelector('.line-through'), 'no strikethrough anywhere');
  check(!text().includes('Connect your source code'), 'completed steps are folded away');
  button('Show 1 completed step').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(300);
  check(text().includes('Connect your source code'), '"Show 1 completed step" reveals them');
  button('Hide completed steps').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(300);
  check(text().includes('Next: create a project and a service.'), 'names the next step');
  check(text().includes('Create a project and a service: why it matters') && text().includes('matelot create_service'), 'the next step is expanded (description + CLI)');
  check(!text().includes('Connect your source code: why it matters'), 'done steps are collapsed');
  check([...window.document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/somewhere/create_service'), 'open link to where the step is done');
  check(window.document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '33', 'progress bar 33%');
  button('Hide').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  check(calls.includes('dismiss'), 'Hide calls POST …/onboarding/dismiss');
  check(!text().includes('Set up your organization') && text().includes('Setup 1/3 done.'), 'hidden: only a one-line reminder remains');
  button('Show the setup checklist').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  check(calls.includes('restore') && text().includes('Set up your organization'), '"Show the setup checklist" restores the card');

  // a developer (cannot change the organization) never sees it; nor does anyone once setup was complete
  const { mountGetStarted: mount2 } = await server.ssrLoadModule('/test/keyless-harness.tsx');
  for (const [label, setup] of [['a developer', () => { canManage = false; }], ['setup complete once', () => { canManage = true; completedAt = '2026-10-08T15:00:00Z'; }]]) {
    setup();
    window.document.body.innerHTML = '<div id="r2"></div>';
    mount2(window.document.getElementById('r2'), ORG);
    await settle(900);
    check(!text().includes('Set up your organization') && !text().includes('Setup 1/3'), `${label}: nothing on the Overview`);
  }
} catch (error) {
  console.error('onboarding card test crashed:', error);
  failed = true;
} finally {
  if (errors.length) { console.error('window errors:', errors); failed = true; }
  await server.close().catch(() => undefined);
  process.exit(failed ? 1 : 0);
}
