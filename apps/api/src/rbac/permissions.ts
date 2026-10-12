import { roleEnum, type Role } from '../database/schema';

/**
 * Every permission the platform knows about. Roles are static sets of these; the domains
 * that arrive in later steps (vulnerabilities, policies, compliance…) are already named so
 * roles stay complete as endpoints appear.
 */
export const PERMISSIONS = [
  'organization:read',
  'organization:write',
  'organization:create_child',
  'workspace:read',
  'workspace:write',
  'team:read',
  'team:write',
  'project:read',
  'project:write',
  'service:read',
  'service:write',
  'environment:read',
  'environment:write',
  'integration:read',
  'integration:write',
  'integration:connect',
  'repository:read',
  'membership:read',
  'membership:write',
  'audit:read',
  'sbom:read',
  'sbom:write',
  'vulnerability:read',
  'vulnerability:write',
  'policy:read',
  'policy:write',
  'policy:exception_request',
  'policy:exception_approve',
  /** Exceptions are time-boxed risk acceptances, not policies: request/create one, approve one. */
  'exception:write',
  'exception:approve',
  'compliance:read',
  'compliance:write',
  'evidence:read',
  'evidence:write',
  'risk:read',
  'risk:write',
  'risk:accept',
  'incident:read',
  'incident:write',
  'release:read',
  'release:write',
  'gate:evaluate',
  'registry:push',
  'registry:pull',
  'deployment:read',
  'deployment:write',
  'runner:read',
  'runner:write',
  'job:read',
  'job:create',
  'job:cancel',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Token scopes (personal access tokens, `matelot login`): a MASK over the user's own permissions, never a different
 * role. `read` keeps the reads (plus pulling images and evaluating a gate); `write` keeps everything the user can do
 * except the administrative permissions below; `sudo` keeps all of it. So an organization administrator with the
 * default `write` login creates workspaces, projects and services, runs pipelines, pushes images, records releases and
 * deployments, decides on findings — and needs `sudo` only for members, organization settings, policies, approvals,
 * runner pools and connections. Archiving (the `*:write` of structure) stays reversible, so it is not sudo-only.
 */
export type TokenScope = 'read' | 'write' | 'sudo';
export const SUDO_ONLY: ReadonlySet<Permission> = new Set<Permission>([
  'organization:write',        // organization settings, renames, archiving an organization
  'organization:create_child', // subsidiaries
  'membership:write',          // members and roles
  'integration:write',         // connections hold credentials
  'integration:connect',
  'policy:write',              // organization-wide rules, notification channels, SLA settings
  'policy:exception_approve',
  'exception:approve',
  'risk:accept',
  'compliance:write',
  'runner:write',              // runner pools and registration tokens
]);
const READ_SCOPE_EXTRAS: ReadonlySet<Permission> = new Set<Permission>(['registry:pull', 'gate:evaluate']);
export function scopeAllows(scope: TokenScope, permission: Permission): boolean {
  if (scope === 'sudo') return true;
  if (scope === 'read') return permission.endsWith(':read') || READ_SCOPE_EXTRAS.has(permission);
  return !SUDO_ONLY.has(permission);
}

export const ROLES: readonly Role[] = roleEnum.enumValues;

const ALL: ReadonlySet<Permission> = new Set(PERMISSIONS);
const READS: ReadonlySet<Permission> = new Set(PERMISSIONS.filter((p) => p.endsWith(':read')));
const STRUCTURE_READS: ReadonlySet<Permission> = new Set<Permission>([
  'organization:read',
  'workspace:read',
  'team:read',
  'project:read',
  'service:read',
  'environment:read',
  'repository:read',
]);

const of = (...permissions: Permission[]): ReadonlySet<Permission> => new Set(permissions);
const union = (...sets: ReadonlySet<Permission>[]): ReadonlySet<Permission> =>
  new Set(sets.flatMap((s) => [...s]));

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  ORG_ADMIN: ALL,
  SECURITY_ADMIN: union(
    READS,
    of(
      'workspace:write',
      'team:write',
      'project:write',
      'service:write',
      'environment:write',
      'membership:write',
      'integration:write',
      'integration:connect',
      'vulnerability:write',
      'policy:write',
      'policy:exception_approve', 'exception:approve', 'exception:write',
      'evidence:write',
      'risk:write',
      'incident:write',
    ),
  ),
  COMPLIANCE_OFFICER: union(
    READS,
    of('compliance:write', 'evidence:write', 'policy:exception_approve', 'exception:approve', 'exception:write', 'risk:write'),
  ),
  CISO: union(READS, of('risk:accept', 'policy:exception_approve', 'exception:approve', 'exception:write', 'incident:write', 'membership:write')),
  CTO: union(READS, of('workspace:write', 'team:write', 'project:write', 'service:write', 'environment:write', 'membership:write')),
  TEAM_LEAD: union(
    STRUCTURE_READS,
    of(
      'team:write',
      'project:write',
      'service:write',
      'environment:write',
      'membership:read',
      'membership:write',
      'integration:read',
      'integration:write',
      'integration:connect',
      'runner:read',
      'runner:write',
      'job:read',
      'job:create',
      'job:cancel',
      'release:write',
      'deployment:write',
      'registry:pull',
      'registry:push',
      'sbom:read',
      'sbom:write',
      'vulnerability:read',
      'vulnerability:write',
      'policy:read',
      'policy:exception_request', 'exception:write',
      'compliance:read',
      'evidence:read',
      'risk:read',
      'incident:read',
      'incident:write',
    ),
  ),
  PRODUCT_SECURITY_ENGINEER: union(
    STRUCTURE_READS,
    of(
      'job:read',
      'job:create',
      'job:cancel',
      'runner:read',          // sees the pools and runners their jobs run on
      'membership:read',
      'integration:read',
      'sbom:read',
      'vulnerability:read',
      'vulnerability:write',
      'policy:read',
      'policy:exception_request', 'exception:write',
      'compliance:read',
      'evidence:read',
      'evidence:write',
      'risk:read',
      'risk:write',
      'incident:read',
      'incident:write',
    ),
  ),
  DEVELOPER: union(
    STRUCTURE_READS,
    of(
      'project:write',
      'service:write',
      'environment:write',
      'integration:read',
      'integration:write',
      'integration:connect',
      'runner:read',
      'runner:write',
      'job:read',
      'job:create',
      'job:cancel',
      'release:write',
      'deployment:write',
      'registry:pull',
      'registry:push',
      'sbom:read',
      'sbom:write',
      'vulnerability:read',
      'risk:read',
      'vulnerability:write',
      'policy:read',
      'policy:exception_request', 'exception:write',
    ),
  ),
  AUDITOR: READS,
  EXTERNAL_CONSULTANT: union(READS, of('risk:write')),
  READ_ONLY: union(STRUCTURE_READS, of('sbom:read', 'vulnerability:read', 'policy:read', 'compliance:read', 'risk:read', 'job:read')),
};

export function isPermission(value: string): value is Permission {
  return ALL.has(value as Permission);
}
