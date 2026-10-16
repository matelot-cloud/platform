/**
 * Members at every level, the invite dialog, service accounts, Administration → Users and the one-time setup page,
 * in the real app (jsdom + fake API). Also checks the dialog header (close button in the header row, never over the
 * title or the first field) and the person-name fallback (no name → e-mail, initials from the local part).
 *   node test/members-flow.mjs
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost:5173/overview', pretendToBeVisual: true });
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'CustomEvent', 'Event', 'DOMParser', 'history', 'location', 'self', 'crypto']) {
  if (window[key] === undefined) continue;
  try { globalThis[key] = window[key]; } catch { Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true }); }
}
window.matchMedia = globalThis.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
window.ResizeObserver = globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.scrollTo = () => {};
window.confirm = () => true;
Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });

const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const NEW_WS = '88888888-8888-4888-8888-888888888881';
const NEW_TEAM = '88888888-8888-4888-8888-888888888882';
const NEW_PROJECT = '88888888-8888-4888-8888-888888888883';
const now = new Date().toISOString();
// the seeded admin of the review: no first / last name in Keycloak
const me = { id: 'u1', email: 'ciso@globex.test', displayName: null, lastLoginAt: now, platformRole: 'admin' };
const role = (r, label, gitlab, scopes, grantable = true) => ({ role: r, label, description: `${label}: what it can do`, gitlab, scopes, grantable });
const PROJECT_ROLES = [role('SECURITY_ADMIN', 'Security admin', 'Maintainer', ['PROJECT'], false), role('DEVELOPER', 'Developer', 'Developer', ['PROJECT']), role('READ_ONLY', 'Read only', 'Guest', ['PROJECT'])];
const member = (id, user, roleName, roleLabel, source, inheritedFrom = null, extra = {}) => ({ membershipId: id, user: { kind: 'human', lastLoginAt: now, disabled: false, displayName: null, ...user }, role: roleName, roleLabel, source, inheritedFrom, grantedBy: { id: 'u1', email: 'ciso@globex.test' }, grantedAt: now, expiresAt: null, expired: false, canEdit: source === 'direct', ...extra });
const posts = [];
let serviceAccounts = [];
const routes = {
  '/config.json': { productName: 'Matelot', keycloakUrl: 'http://localhost:8080', realm: 'platform', clientId: 'platform-web', apiBaseUrl: '/api/v1', docsUrl: 'https://matelot.cloud/docs/latest/' },
  '/api/v1/meta': { version: '0.1.0', rootOrganizationSlug: 'globex', roles: ['ORG_ADMIN', 'DEVELOPER'], scopeTypes: ['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT'], criticalities: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], permissions: [], rolePermissions: {}, features: { inherited_members: true, member_expiry: true, bulk_invite: true, invite_links: true, user_admin: true, service_accounts: true, scope_access_tokens: true, custom_roles: false } },
  '/api/v1/me': { user: me, memberships: [{ id: 'm1', role: 'ORG_ADMIN', scopeType: 'ORGANIZATION', scopeId: ORG, scope: { type: 'ORGANIZATION', id: ORG, slug: 'globex', name: 'Globex' } }] },
  '/api/v1/organizations': [{ id: ORG, slug: 'globex', name: 'Globex', parentId: null, createdAt: now, updatedAt: now, archivedAt: null }],
  [`/api/v1/organizations/${ORG}/workspaces`]: [{ id: WS, organizationId: ORG, slug: 'payments', name: 'Payments', description: null, createdAt: now, updatedAt: now }],
  [`/api/v1/organizations/${ORG}/teams`]: [{ id: TEAM, slug: 'backend', name: 'Backend', description: null, createdAt: now, updatedAt: now, workspaceId: WS, workspaceSlug: 'payments', workspaceName: 'Payments' }],
  [`/api/v1/organizations/${ORG}/projects`]: [{ id: PROJECT, slug: 'payment-api', name: 'Payment API', description: null, criticality: 'HIGH', createdAt: now, updatedAt: now, teamId: TEAM, teamSlug: 'backend', teamName: 'Backend', workspaceId: WS, workspaceSlug: 'payments', workspaceName: 'Payments' }],
  [`/api/v1/members?scopeType=PROJECT&scopeId=${PROJECT}`]: { scope: { type: 'PROJECT', id: PROJECT, slug: 'payment-api', name: 'Payment API' }, canManage: true, members: [
    member('d1', { id: 'u2', email: 'jane.doe@globex.test', displayName: 'Jane Doe' }, 'DEVELOPER', 'Developer', 'direct', null, { expiresAt: '2027-01-31T23:59:59Z' }),
    member('i1', { id: 'u1', email: 'ciso@globex.test' }, 'ORG_ADMIN', 'Organization admin', 'inherited', { type: 'ORGANIZATION', id: ORG, slug: 'globex', name: 'Globex' }),
    member('i2', { id: 'u3', email: 'lead@globex.test' }, 'TEAM_LEAD', 'Team lead', 'inherited', { type: 'TEAM', id: TEAM, slug: 'backend', name: 'Backend' }),
    member('d2', { id: 'u9', email: 'bot-renovate-1a2b3c4d@project-44444444.bots.matelot.invalid', displayName: 'Renovate', kind: 'service_account' }, 'DEVELOPER', 'Developer', 'direct'),
  ] },
  [`/api/v1/members/roles?scopeType=PROJECT&scopeId=${PROJECT}`]: PROJECT_ROLES,
  [`/api/v1/members/candidates?scopeType=PROJECT&scopeId=${PROJECT}&q=sam`]: [{ id: 'u5', email: 'sam@globex.test', displayName: 'Sam Lee', kind: 'human' }],
  [`/api/v1/members?scopeType=TEAM&scopeId=${TEAM}`]: { scope: { type: 'TEAM', id: TEAM, slug: 'backend', name: 'Backend' }, canManage: true, members: [member('t1', { id: 'u3', email: 'lead@globex.test' }, 'TEAM_LEAD', 'Team lead', 'direct')] },
  [`/api/v1/members?scopeType=WORKSPACE&scopeId=${WS}`]: { scope: { type: 'WORKSPACE', id: WS, slug: 'payments', name: 'Payments' }, canManage: false, members: [member('w1', { id: 'u1', email: 'ciso@globex.test' }, 'ORG_ADMIN', 'Organization admin', 'inherited', { type: 'ORGANIZATION', id: ORG, slug: 'globex', name: 'Globex' }, { canEdit: false })] },
  [`/api/v1/members?scopeType=ORGANIZATION&scopeId=${ORG}`]: { scope: { type: 'ORGANIZATION', id: ORG, slug: 'globex', name: 'Globex' }, canManage: true, members: [member('o1', { id: 'u1', email: 'ciso@globex.test' }, 'ORG_ADMIN', 'Organization admin', 'direct', null, { canEdit: false })] },
  '/api/v1/admin/users/capabilities': { keycloak: true, email: false, canChangeCellRole: true },
  '/api/v1/admin/users': [{ id: 'u1', email: 'ciso@globex.test', displayName: null, kind: 'human', platformRole: 'admin', disabledAt: null, lastLoginAt: now, createdAt: now, membershipCount: 1, signInReady: true }, { id: 'u7', email: 'new@globex.test', displayName: null, kind: 'human', platformRole: 'user', disabledAt: null, lastLoginAt: null, createdAt: now, membershipCount: 0, signInReady: false }, { id: 'u9', email: 'bot-renovate-1a2b3c4d@project-44444444.bots.matelot.invalid', displayName: 'Renovate', kind: 'service_account', platformRole: 'user', disabledAt: null, lastLoginAt: null, createdAt: now, membershipCount: 1, signInReady: false }],
  '/api/v1/admin/users/u7': { user: { id: 'u7', email: 'new@globex.test', displayName: null, kind: 'human', platformRole: 'user', disabledAt: null, lastLoginAt: null, createdAt: now, signInReady: false, ownerScopeType: null, ownerScopeId: null, description: null }, memberships: [{ id: 'm7', role: 'DEVELOPER', scopeType: 'PROJECT', scopeId: PROJECT, scope: { type: 'PROJECT', id: PROJECT, slug: 'payment-api', name: 'Payment API' }, expiresAt: null, expired: false, grantedAt: now }], tokens: [] },
  '/api/v1/invites/tok123': { email: 'new@globex.test', purpose: 'invite', expiresAt: '2026-10-22T10:00:00Z', minLength: 12 },
};
const json = (b, status = 200) => new Response(b === undefined ? null : JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = window.fetch = async (input, init) => {
  const u = new URL(String(input), 'http://localhost');
  const key = u.pathname + u.search;
  const method = init?.method ?? 'GET';
  if (method !== 'GET') {
    const body = init?.body ? JSON.parse(init.body) : null;
    posts.push({ method, key, body });
    if (key === '/api/v1/members') return json({ added: body.emails.map((e) => ({ membershipId: 'n', email: e, role: body.role, updated: false })), skipped: [], invited: [{ email: 'new@globex.test', setupLink: 'http://localhost:5173/invite/tok123', emailed: false, viaIdentityProvider: false }] });
    if (key === '/api/v1/scope-access-tokens') { serviceAccounts = [{ id: 'sa1', name: body.name, username: 'bot-ci@x.invalid', description: null, ownerScopeType: 'PROJECT', ownerScopeId: PROJECT, disabled: false, createdAt: now, activeTokens: 1, memberships: [{ role: body.role, scopeType: 'PROJECT', scopeId: PROJECT, expiresAt: null }] }]; return json({ serviceAccount: serviceAccounts[0], token: { id: 't1', name: body.name, scope: body.scope, prefix: 'spt_abcd', expiresAt: '2027-01-01T00:00:00Z', expired: false, lastUsedAt: null, lastUsedIp: null, revokedAt: null, source: 'service_account', createdAt: now, token: 'spt_SECRET-shown-once' } }); }
    if (key === '/api/v1/invites/tok123') return json({ email: 'new@globex.test', signInUrl: 'http://localhost:5173/' });
    // first-run structure: the created node is added to the lists the app reads
    if (key === `/api/v1/organizations/${ORG}/workspaces`) { const ws = { id: NEW_WS, organizationId: ORG, slug: body.slug, name: body.name, description: null, createdAt: now, updatedAt: now }; routes[key] = [...routes[key], ws]; return json(ws); }
    if (key === `/api/v1/workspaces/${NEW_WS}/teams`) { const t = { id: NEW_TEAM, slug: body.slug, name: body.name, description: null, createdAt: now, updatedAt: now, workspaceId: NEW_WS, workspaceSlug: 'mobile', workspaceName: 'Mobile' }; routes[`/api/v1/organizations/${ORG}/teams`] = [...routes[`/api/v1/organizations/${ORG}/teams`], t]; return json(t); }
    if (key === `/api/v1/teams/${NEW_TEAM}/projects`) { const pr = { id: NEW_PROJECT, slug: body.slug, name: body.name, description: null, criticality: body.criticality, createdAt: now, updatedAt: now, teamId: NEW_TEAM, teamSlug: 'apps', teamName: 'Apps team', workspaceId: NEW_WS, workspaceSlug: 'mobile', workspaceName: 'Mobile' }; routes[`/api/v1/organizations/${ORG}/projects`] = [...routes[`/api/v1/organizations/${ORG}/projects`], pr]; return json(pr); }
    if (key === '/api/v1/admin/users/u7/reset-password') return json({ temporaryPassword: false, setupLink: 'http://localhost:5173/invite/reset456', emailed: false });
    return json({});
  }
  if (key === `/api/v1/service-accounts?scopeType=PROJECT&scopeId=${PROJECT}`) return json(serviceAccounts);
  const body = routes[key];
  return body === undefined ? json({ statusCode: 404, message: `no fixture for ${key}` }, 404) : json(body);
};

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.error ?? e.message)));
setTimeout(() => { console.error('members flow test: timed out'); process.exit(2); }, 120_000).unref();
const server = await createServer({ root, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { 'react-oidc-context': path.join(root, 'test/stubs/react-oidc-context.tsx'), 'react-apexcharts': path.join(root, 'test/stubs/react-apexcharts.tsx') } } });
let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed = true; };
const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));
const text = (el = window.document.body) => el.textContent.replace(/\s+/g, ' ');
const buttons = (scope = window.document) => [...scope.querySelectorAll('button')];
const button = (label, scope) => buttons(scope).find((b) => b.textContent.trim() === label);
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const type = (el, value) => { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const go = async (to) => { window.history.pushState({}, '', to); window.dispatchEvent(new window.PopStateEvent('popstate')); await settle(1500); };
const dialog = () => window.document.querySelector('[role="dialog"]');

try {
  await server.ssrLoadModule('/src/main.tsx');
  await settle(1500);

  // ---- A2: no display name → e-mail, initials from the local part (not "TT", not the domain)
  await go('/overview');
  const avatar = [...window.document.querySelectorAll('header span')].find((s) => /^[A-Z?]{1,3}$/.test(s.textContent.trim()) && s.className.includes('rounded-full'));
  check(avatar?.textContent.trim() === 'CI', `header avatar initials from the e-mail local part ("${avatar?.textContent.trim()}")`);
  check(text(window.document.querySelector('header')).includes('ciso@globex.test'), 'header shows the e-mail when there is no name');

  // ---- project members: direct + inherited with source links, bot badge, expiry
  await go(`/projects/${PROJECT}/members`);
  const t = text();
  check(t.includes('Jane Doe') && t.includes('jane.doe@globex.test') && t.includes('Developer'), 'direct member with name, e-mail and role');
  check(t.includes('Inherited from organization Globex') && t.includes('Inherited from team Backend'), 'inherited rows say where they come from');
  const links = [...window.document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  check(links.includes('/members') && links.includes(`/workspaces/${WS}/teams/${TEAM}/members`), 'inherited rows link to where they are granted (org, team page)');
  check(t.includes('Renovate') && t.includes('bot'), 'service account member shows a bot badge');
  check(t.includes('2 direct · 2 inherited'), 'counts direct vs inherited');
  const rowOf = (needle) => [...window.document.querySelectorAll('tbody tr')].find((r) => text(r).includes(needle));
  check(!!button('Edit', rowOf('Jane Doe')) && !button('Edit', rowOf('lead@globex.test')), 'only direct rows are editable');

  // ---- invite dialog: header with the close button, role picker with GitLab mapping, bulk e-mails
  click(button('Invite members'));
  await settle();
  const d = dialog();
  check(!!d && text(d).includes('Invite members'), 'invite dialog opens');
  const header = d.firstElementChild;
  const close = d.querySelector('button[aria-label="Close"]');
  check(!!close && header.contains(close) && text(header).includes('Invite members') && !d.querySelector('form').contains(close), 'close button sits in the header row with the title, outside the form');
  check(text(d).includes('Security admin') && text(d).includes('GitLab Maintainer') && text(d).includes('above your own role here'), 'roles with GitLab equivalents; one above the caller is marked');
  check(d.querySelector('input[type="radio"][value="SECURITY_ADMIN"]').disabled, 'a role above your own cannot be picked');
  type(d.querySelector('#inv-search'), 'sam');
  await settle(1200);
  const sam = buttons(d).find((b) => text(b).includes('Sam Lee'));
  check(!!sam, 'search finds people');
  if (sam) click(sam);
  await settle(300);
  type(d.querySelector('#inv-emails'), 'new@globex.test, other@globex.test');
  type(d.querySelector('#inv-exp'), '2027-03-31');
  await settle(300);
  check(text(d).includes('3 people selected'), 'picked person + two e-mails');
  click(button('Invite 3', d));
  await settle(1200);
  const post = posts.find((p) => p.key === '/api/v1/members');
  check(post && post.body.role === 'DEVELOPER' && post.body.userIds[0] === 'u5' && post.body.emails.length === 2 && post.body.expiresAt === '2027-03-31' && post.body.scopeType === 'PROJECT', 'POST /members with role, users, e-mails, expiry');
  check(text(dialog()).includes('Members added') && text(dialog()).includes('http://localhost:5173/invite/tok123') && text(dialog()).includes('No e-mail on this cell'), 'result shows the one-time setup link to copy');
  click(button('Done', dialog()));
  await settle();

  // ---- service accounts tab: project access token in one step, token shown once
  click(buttons().find((b) => b.getAttribute('role') === 'tab' && b.textContent.includes('Service accounts')));
  await settle();
  check(text().includes('No service accounts yet') && text().includes('Pipelines use CI tokens instead'), 'service accounts tab explains bots vs CI tokens');
  click(button('New access token'));
  await settle();
  const sd = dialog();
  check(text(sd).includes('New project access token'), 'project access token dialog');
  type(sd.querySelector('#tk-name'), 'Renovate CI');
  await settle(200);
  click(button('Create', sd));
  await settle(1200);
  const sat = posts.find((p) => p.key === '/api/v1/scope-access-tokens');
  check(sat && sat.body.role === 'DEVELOPER' && sat.body.scope === 'read' && sat.body.expiresInDays === 90, 'POST /scope-access-tokens with role, scope, expiry');
  check(text(dialog()).includes('spt_SECRET-shown-once') && text(dialog()).includes('shown only once'), 'the token is shown once');
  click(button('Done', dialog()));
  await settle(1000);
  check(text().includes('Renovate CI'), 'the new bot is listed');

  // ---- team and workspace pages exist; read-only when the caller cannot manage
  await go(`/workspaces/${WS}/teams/${TEAM}/members`);
  check(text().includes('Members — Backend (team)') && text().includes('lead@globex.test') && !!button('Invite members'), 'team members page');
  await go(`/workspaces/${WS}/members`);
  check(text().includes('Inherited from organization Globex') && !button('Invite members'), 'workspace page: inherited only, no invite without membership:write');
  await go(`/workspaces/${WS}/projects`);
  click(buttons().find((b) => text(b).trim().startsWith('Backend') && b.className.includes('ps-12')));
  await settle();
  check([...window.document.querySelectorAll('a')].some((a) => a.getAttribute('href') === `/workspaces/${WS}/teams/${TEAM}` && a.textContent.includes('Open team')), 'selected team links to the team');

  // ---- Administration → Users: people / service accounts, manage dialog, reset link
  await go('/admin/users');
  check(text().includes('Users of this cell') && text().includes('new@globex.test') && text().includes('invited') && !text().includes('Renovate'), 'people tab: invited user, bots elsewhere');
  click(buttons().find((b) => b.getAttribute('role') === 'tab' && b.textContent.includes('Service accounts')));
  await settle();
  check(text().includes('Renovate') && text().includes('tokens only'), 'service accounts tab');
  click(buttons().find((b) => b.getAttribute('role') === 'tab' && b.textContent.includes('People')));
  await settle();
  click(button('Manage', rowOf('new@globex.test')));
  await settle(1200);
  const md = dialog();
  check(text(md).includes('Roles (1)') && text(md).includes('Payment API') && text(md).includes('Delete user'), 'manage dialog: roles across scopes, delete');
  click(button('Send a reset link', md));
  await settle(1000);
  check(text(dialog()).includes('http://localhost:5173/invite/reset456'), 'reset link shown once (no SMTP)');
  click(dialog().querySelector('button[aria-label="Close"]'));
  await settle();
  check(!dialog(), 'the header close button closes the dialog');

  // ---- first run: creating a workspace lands inside it with the next step, then team → project
  const createNode = async (name, label) => { type(window.document.querySelector('#node-name'), name); await settle(200); click(button(label, dialog())); await settle(1200); };
  await go('/projects');
  click(button('New workspace'));
  await settle();
  await createNode('Mobile', 'Create workspace');
  const step = () => text(window.document.querySelector('[data-testid="next-step"]'));
  check(window.location.pathname === `/workspaces/${NEW_WS}` && step().includes('Create a team') && text().includes('Overview — Mobile (workspace)'), 'new workspace: inside it, next step "Create a team"');
  click(button('Create a team'));
  await settle();
  await createNode('Apps team', 'Create team');
  check(window.location.pathname === `/workspaces/${NEW_WS}/teams/${NEW_TEAM}` && step().includes('Create the first project of this team') && text().includes('Overview — Apps team (team)'), 'new team: inside it, next step "Create the first project"');
  click(button('New project'));
  await settle();
  await createNode('Mobile app', 'Create project');
  check(window.location.pathname === `/projects/${NEW_PROJECT}` && text().includes('Overview — Mobile app (project)') && [...window.document.querySelectorAll('nav[aria-label="Breadcrumb"] li')].map((li) => li.textContent.replace('›', '').trim()).join(' › ') === 'Globex › Mobile › Apps team › Mobile app › Overview', 'new project: inside it, full breadcrumb');

  // ---- one-time setup page (no sign-in)
  await go('/invite/tok123');
  check(text().includes('Welcome to Matelot') && text().includes('new@globex.test'), 'setup page shows the account');
  type(window.document.querySelector('#pw'), 'correct horse battery');
  type(window.document.querySelector('#pw2'), 'correct horse battery');
  await settle(200);
  click(button('Set password'));
  await settle(1000);
  check(posts.some((p) => p.key === '/api/v1/invites/tok123' && p.body.password === 'correct horse battery') && text().includes('Password set'), 'password set through the link');
} catch (error) {
  console.error('members flow test crashed:', error);
  failed = true;
} finally {
  if (errors.length) { console.error('window errors:', errors); failed = true; }
  await server.close().catch(() => undefined);
  process.exit(failed ? 1 : 0);
}
