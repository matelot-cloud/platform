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
      'runner:read',          // sees the pools and runners their jobs run on (a write-scoped token of an admin is downgraded to this role)
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
