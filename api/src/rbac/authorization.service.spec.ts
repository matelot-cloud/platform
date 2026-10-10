import { AccessContext } from './access.service';
import { AuthorizationService } from './authorization.service';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from './permissions';
import { buildChain } from './scope.types';

const ORG = '11111111-1111-4111-8111-111111111111';
const CHILD_ORG = '22222222-2222-4222-8222-222222222222';
const WS = '33333333-3333-4333-8333-333333333333';
const TEAM = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const OTHER_PROJECT = '66666666-6666-4666-8666-666666666666';
const SERVICE = '77777777-7777-4777-8777-777777777777';
const ENVIRONMENT = '88888888-8888-4888-8888-888888888888';

const orgChain = buildChain({ organizationId: ORG });
const projectChain = buildChain({ organizationId: ORG, workspaceId: WS, teamId: TEAM, projectId: PROJECT });
const otherProjectChain = buildChain({ organizationId: ORG, workspaceId: WS, teamId: TEAM, projectId: OTHER_PROJECT });

describe('AuthorizationService', () => {
  const authz = new AuthorizationService();

  it('defines permissions for every role', () => {
    for (const role of ROLES) expect(ROLE_PERMISSIONS[role].size).toBeGreaterThan(0);
    expect(ROLE_PERMISSIONS.ORG_ADMIN.size).toBe(PERMISSIONS.length);
  });

  it('inherits organization-level roles down to projects', () => {
    const ctx = new AccessContext('u1', [{ scopeType: 'ORGANIZATION', scopeId: ORG, role: 'ORG_ADMIN' }]);
    expect(authz.can(ctx, 'project:write', projectChain)).toBe(true);
    expect(authz.can(ctx, 'policy:write', projectChain)).toBe(true);
  });

  it('inherits parent-organization roles into subsidiaries', () => {
    const ctx = new AccessContext('u1', [{ scopeType: 'ORGANIZATION', scopeId: ORG, role: 'SECURITY_ADMIN' }]);
    const subsidiaryChain = buildChain({ organizationId: CHILD_ORG }, [ORG]);
    expect(authz.can(ctx, 'vulnerability:write', subsidiaryChain)).toBe(true);
    expect(authz.can(ctx, 'organization:create_child', subsidiaryChain)).toBe(false);
  });

  it('scopes project-level roles to that project only', () => {
    const ctx = new AccessContext('u1', [{ scopeType: 'PROJECT', scopeId: PROJECT, role: 'DEVELOPER' }]);
    expect(authz.can(ctx, 'project:write', projectChain)).toBe(true);
    expect(authz.can(ctx, 'project:read', otherProjectChain)).toBe(false);
    expect(authz.can(ctx, 'project:write', otherProjectChain)).toBe(false);
  });

  it('never lets a lower scope grant permissions upwards', () => {
    const ctx = new AccessContext('u1', [{ scopeType: 'PROJECT', scopeId: PROJECT, role: 'DEVELOPER' }]);
    expect(authz.can(ctx, 'workspace:write', orgChain)).toBe(false);
    expect(authz.can(ctx, 'audit:read', orgChain)).toBe(false);
  });

  it('allows structural visibility of ancestors through a descendant membership', () => {
    const ctx = new AccessContext('u1', [{ scopeType: 'PROJECT', scopeId: PROJECT, role: 'DEVELOPER' }]);
    ctx.visibleOrganizationIds.add(ORG);
    expect(authz.can(ctx, 'organization:read', orgChain)).toBe(true);
    expect(authz.can(ctx, 'organization:write', orgChain)).toBe(false);
  });

  it('keeps auditors read-only', () => {
    const ctx = new AccessContext('u1', [{ scopeType: 'ORGANIZATION', scopeId: ORG, role: 'AUDITOR' }]);
    expect(authz.can(ctx, 'audit:read', orgChain)).toBe(true);
    expect(authz.can(ctx, 'evidence:read', projectChain)).toBe(true);
    for (const permission of PERMISSIONS.filter((p) => !p.endsWith(':read'))) {
      expect(authz.can(ctx, permission, projectChain)).toBe(false);
    }
  });

  it('extends inheritance and scoping to services and environments', () => {
    const envChain = buildChain({ organizationId: ORG, workspaceId: WS, teamId: TEAM, projectId: PROJECT, serviceId: SERVICE, environmentId: ENVIRONMENT });
    const dev = new AccessContext('u1', [{ scopeType: 'PROJECT', scopeId: PROJECT, role: 'DEVELOPER' }]);
    expect(authz.can(dev, 'environment:write', envChain)).toBe(true);

    const envOnly = new AccessContext('u2', [{ scopeType: 'ENVIRONMENT', scopeId: ENVIRONMENT, role: 'READ_ONLY' }]);
    envOnly.visibleServiceIds.add(SERVICE);
    envOnly.visibleProjectIds.add(PROJECT);
    expect(authz.can(envOnly, 'environment:read', envChain)).toBe(true);
    expect(authz.can(envOnly, 'service:read', buildChain({ organizationId: ORG, workspaceId: WS, teamId: TEAM, projectId: PROJECT, serviceId: SERVICE }))).toBe(true);
    expect(authz.can(envOnly, 'service:write', envChain)).toBe(false);
    expect(authz.can(envOnly, 'project:write', projectChain)).toBe(false);
  });

  it('gives cell administrators every permission everywhere without memberships', () => {
    const admin = new AccessContext('root', [], true);
    expect(authz.can(admin, 'organization:create_child', orgChain)).toBe(true);
    expect(authz.can(admin, 'audit:read', buildChain({ organizationId: CHILD_ORG }))).toBe(true);
    expect(authz.can(admin, 'environment:write', buildChain({ organizationId: ORG, workspaceId: WS, teamId: TEAM, projectId: PROJECT, serviceId: SERVICE, environmentId: ENVIRONMENT }))).toBe(true);
    const plain = new AccessContext('u', [], false);
    expect(authz.can(plain, 'organization:read', orgChain)).toBe(false);
  });

  it('unions permissions from multiple roles on the chain', () => {
    const ctx = new AccessContext('u1', [
      { scopeType: 'ORGANIZATION', scopeId: ORG, role: 'READ_ONLY' },
      { scopeType: 'TEAM', scopeId: TEAM, role: 'TEAM_LEAD' },
    ]);
    expect(authz.can(ctx, 'membership:write', projectChain)).toBe(true);
    expect(authz.can(ctx, 'membership:write', orgChain)).toBe(false);
  });
});
