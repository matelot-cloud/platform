/**
 * Keyless registry connection UI: an unverified ACR keyless connection opens Manage on Identity, shows the exact
 * subject and the federated-credential command, Verify reports the cloud's refusal (lastError), and succeeds once
 * the trust is configured.   node test/keyless-verify.mjs
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost:5173/connections', pretendToBeVisual: true });
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'CustomEvent', 'Event', 'DOMParser', 'history', 'location', 'self']) {
  if (window[key] === undefined) continue;
  try { globalThis[key] = window[key]; } catch { Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true }); }
}
window.matchMedia = globalThis.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
window.ResizeObserver = globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.scrollTo = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '99999999-9999-4999-8999-999999999999';
const now = new Date().toISOString();
const SUBJECT = `integration:${ID}`;
const integration = { id: ID, organizationId: ORG, provider: 'registry', authType: 'azure_wif', name: 'ACR · matelottest', status: 'pending', externalAccountId: `registry:matelottest.azurecr.io:${ORG}:1`, lastSyncedAt: null, lastError: null, createdAt: now, settings: { baseUrl: 'matelottest.azurecr.io', keyless: true, verified: false }, scope: { type: 'ORGANIZATION', id: ORG, name: 'ACME' } };
let trusted = false;
const state = { verified: false, verifiedAt: null, lastError: null };
const verifyCalls = [];
const calls = [];
const DISC = '88888888-8888-4888-8888-888888888888';
const identity = () => ({
  issuer: 'https://matelot.example', subject: SUBJECT, authType: 'azure_wif', keyless: true, ...state,
  jwksUri: 'https://matelot.example/.well-known/jwks.json', openidConfiguration: 'https://matelot.example/.well-known/openid-configuration', warning: null,
  gcp: { audience: 'x', principal: 'p', steps: [] }, aws: { audience: 'sts.amazonaws.com', providerArn: 'arn', trustPolicy: {}, steps: [] },
  azure: { audience: 'api://AzureADTokenExchange', steps: [
    `App registration app-client → Certificates & secrets → Federated credentials → Add → "Other issuer": issuer https://matelot.example, subject identifier ${SUBJECT} (exact match), audience api://AzureADTokenExchange`,
    `  az ad app federated-credential create --id app-client --parameters '{"name":"matelot-99999999","issuer":"https://matelot.example","subject":"${SUBJECT}","audiences":["api://AzureADTokenExchange"]}'`,
    'Container registry → Access control (IAM): AcrPull (or AcrPush) for that app registration',
    `Verify the connection (Manage → Identity → Verify, or: matelot connection verify --id ${ID})`,
  ] },
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = window.fetch = async (input, init) => {
  const url = String(input);
  const key = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
  if (key === `/api/v1/integrations/${ID}/identity`) return json(identity());
  if (key === `/api/v1/integrations/${ID}/verify` && init?.method === 'POST') {
    verifyCalls.push(Date.now());
    if (!trusted) { state.lastError = 'Entra token exchange failed: 400 AADSTS70021: No matching federated identity record found for presented assertion.'; return json({ statusCode: 400, message: `Connection check failed: ${state.lastError}` }, 400); }
    Object.assign(state, { verified: true, verifiedAt: new Date().toISOString(), lastError: null });
    return json({ ...integration, settings: { ...integration.settings, verified: true }, verified: true, account: 'matelottest.azurecr.io (keyless · app app-client federated credential)' });
  }
  if (key === `/api/v1/integrations/${DISC}/identity`) return json({ ...identity(), subject: `integration:${DISC}`, status: 'disconnected', disconnected: true, verified: false, params: { tenantId: 'tenant-1', clientId: 'app-client-1' } });
  if (key === `/api/v1/integrations/${ID}/disconnect` && init?.method === 'POST') { calls.push(`POST ${key}`); return json({ ...integration, status: 'disconnected' }); }
  if (key === `/api/v1/integrations/${ID}` && init?.method === 'DELETE') {
    const full = new URL(url, 'http://localhost').search;
    calls.push(`DELETE ${key}${full}`);
    if (!full.includes('force=true')) return json({ statusCode: 409, message: '1 container image(s) pull through "ACR · matelottest": matelottest.azurecr.io/demo. Delete with force to detach them, or disconnect instead.', images: ['matelottest.azurecr.io/demo'] }, 409);
    return json({ deleted: true, id: ID, name: integration.name, repositories: 0, imagesDetached: ['matelottest.azurecr.io/demo'] });
  }
  return json({ statusCode: 404, message: `no fixture for ${key}` }, 404);
};

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.error ?? e.message)));
setTimeout(() => { console.error('keyless verify test: timed out'); process.exit(2); }, 60_000).unref();
const server = await createServer({ root, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { 'react-oidc-context': path.join(root, 'test/stubs/react-oidc-context.tsx'), 'react-apexcharts': path.join(root, 'test/stubs/react-apexcharts.tsx') } } });

let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed = true; };
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const text = () => window.document.body.textContent.replace(/\s+/g, ' ');
const button = (label) => [...window.document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
try {
  // Logos follow the cloud, whatever the auth: stored secret, keyless, or a token / login to a cloud host
  const { providerBrand } = await server.ssrLoadModule('/src/platform/components/EnvironmentManager.tsx');
  const brandCases = [
    ['aws', null, 'ecr'], ['aws_wif', null, 'ecr'], ['gcp', null, 'gar'], ['gcp_wif', null, 'gar'], ['azure', null, 'acr'], ['azure_wif', null, 'acr'],
    ['basic', 'matelottest.azurecr.io', 'acr'], ['token', '123456789012.dkr.ecr.eu-central-1.amazonaws.com', 'ecr'], ['basic', 'https://europe-west3-docker.pkg.dev', 'gar'],
    ['token', 'ghcr.io', 'github'], ['basic', 'docker.io', 'docker'], ['none', null, 'docker'],
  ];
  for (const [auth, host, want] of brandCases) check(providerBrand('registry', auth, host) === want, `registry ${auth}${host ? ` @ ${host}` : ''} → ${want} logo`);
  const { mountManager } = await server.ssrLoadModule('/test/keyless-harness.tsx');
  const root = mountManager(window.document.getElementById('root'), integration, ORG);
  await settle(1200);
  check(text().includes('Workload identity federation'), 'an unverified keyless connection opens Manage on Identity');
  check([...window.document.querySelectorAll('img')].some((img) => img.getAttribute('src') === '/images/brands/acr.png'), 'keyless ACR connection shows the Azure (ACR) logo, not Docker');
  check(text().includes('Not verified yet'), 'shows "Not verified yet"');
  check(text().includes(`Subject (exact)${SUBJECT}`) || text().includes(SUBJECT), `shows the exact subject ${SUBJECT}`);
  check(!text().includes('integration:pending'), 'never shows integration:pending');
  check(text().includes('az ad app federated-credential create') && text().includes(`"subject":"${SUBJECT}"`), 'federated credential command carries the exact subject');
  check(text().includes(`matelot connection verify --id ${ID}`), 'CLI verify command shown');

  button('Verify').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  check(verifyCalls.length === 1, 'Verify calls POST /integrations/:id/verify');
  check(text().includes('AADSTS70021'), 'the cloud refusal is shown');
  check(text().includes('Not verified yet'), 'still unverified after a refusal');

  trusted = true; // the team adds the federated credential
  button('Verify').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(1200);
  check(verifyCalls.length === 2, 'second Verify sent');
  check(text().includes('Verified'), 'shows Verified after the trust is configured');
  check(text().includes('keyless · app app-client'), 'shows the verified account');
  check(!text().includes('AADSTS70021'), 'the previous error is cleared');
  check(!!button('Verify again'), 'button becomes "Verify again"');

  // Actions: Disconnect is its own call; Delete → 409 lists the images → "Detach images and delete" forces
  window.confirm = () => true;
  const tab = (label) => [...window.document.querySelectorAll('button')].find((b) => b.textContent.trim() === label || b.textContent.trim().endsWith(label));
  tab('Actions').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  button('Disconnect')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  check(calls.includes(`POST /api/v1/integrations/${ID}/disconnect`), 'Disconnect calls POST /integrations/:id/disconnect (not DELETE)');
  button('Delete').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  check(calls.includes(`DELETE /api/v1/integrations/${ID}`), 'Delete calls DELETE /integrations/:id');
  check(text().includes('matelottest.azurecr.io/demo'), 'the 409 lists the images that pull through the connection');
  button('Detach images and delete').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  check(calls.includes(`DELETE /api/v1/integrations/${ID}?force=true`), '"Detach images and delete" sends force=true');

  // A disconnected keyless connection: no setup steps, no Verify, real (non-secret) values
  root.unmount();
  const el2 = window.document.createElement('div');
  window.document.body.innerHTML = '';
  window.document.body.appendChild(el2);
  mountManager(el2, { ...integration, id: DISC, status: 'disconnected', settings: { ...integration.settings, keylessParams: { tenantId: 'tenant-1', clientId: 'app-client-1' } } }, ORG);
  await settle(1000);
  tab('Identity · keyless')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  check(text().includes('Disconnected — create the connection again'), 'disconnected keyless shows "Disconnected — create the connection again"');
  check(!text().includes('Not verified yet') && !button('Verify'), 'no "Not verified yet" and no Verify button when disconnected');
  check(!text().includes('az ad app federated-credential'), 'no setup steps when disconnected');
  check(text().includes('app-client-1') && !text().includes('CLIENT_ID'), 'shows the real clientId, not the CLIENT_ID placeholder');
} catch (error) {
  console.error('keyless verify test crashed:', error);
  failed = true;
} finally {
  if (errors.length) { console.error('window errors:', errors); failed = true; }
  await server.close().catch(() => undefined);
  process.exit(failed ? 1 : 0);
}
