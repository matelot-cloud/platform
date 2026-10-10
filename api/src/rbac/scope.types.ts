import type { ScopeType } from '../database/schema';
import type { Permission } from './permissions';

export interface ScopeRef {
  type: ScopeType;
  id: string;
}

/** Route/body parameters that identify where in the hierarchy a request points. */
export interface ScopeParams {
  organizationId?: string;
  workspaceId?: string;
  teamId?: string;
  projectId?: string;
  serviceId?: string;
  environmentId?: string;
}

/**
 * A resolved position in the hierarchy. `refs` lists every scope whose memberships apply,
 * from the root organization down to the target (parent orgs, org, workspace, team, project).
 */
export interface ScopeChain {
  organizationId: string;
  /** Ancestor organizations, nearest parent first. */
  organizationAncestorIds: string[];
  workspaceId?: string;
  teamId?: string;
  projectId?: string;
  serviceId?: string;
  environmentId?: string;
  refs: ScopeRef[];
  target: ScopeRef;
}

export interface ResolvedIds {
  organizationId: string;
  workspaceId?: string;
  teamId?: string;
  projectId?: string;
  serviceId?: string;
  environmentId?: string;
}

export function buildChain(ids: ResolvedIds, organizationAncestorIds: string[] = []): ScopeChain {
  const refs: ScopeRef[] = [
    ...[...organizationAncestorIds].reverse().map((id): ScopeRef => ({ type: 'ORGANIZATION', id })),
    { type: 'ORGANIZATION', id: ids.organizationId },
  ];
  if (ids.workspaceId) refs.push({ type: 'WORKSPACE', id: ids.workspaceId });
  if (ids.teamId) refs.push({ type: 'TEAM', id: ids.teamId });
  if (ids.projectId) refs.push({ type: 'PROJECT', id: ids.projectId });
  if (ids.serviceId) refs.push({ type: 'SERVICE', id: ids.serviceId });
  if (ids.environmentId) refs.push({ type: 'ENVIRONMENT', id: ids.environmentId });
  return { ...ids, organizationAncestorIds, refs, target: refs[refs.length - 1] };
}

/** The permission that lets a user *see* a scope of the given type. */
export function structureReadPermission(type: ScopeType): Permission {
  switch (type) {
    case 'ORGANIZATION':
      return 'organization:read';
    case 'WORKSPACE':
      return 'workspace:read';
    case 'TEAM':
      return 'team:read';
    case 'PROJECT':
      return 'project:read';
    case 'SERVICE':
      return 'service:read';
    case 'ENVIRONMENT':
      return 'environment:read';
  }
}

export function scopeParamsFor(type: ScopeType, id: string): ScopeParams {
  switch (type) {
    case 'ORGANIZATION':
      return { organizationId: id };
    case 'WORKSPACE':
      return { workspaceId: id };
    case 'TEAM':
      return { teamId: id };
    case 'PROJECT':
      return { projectId: id };
    case 'SERVICE':
      return { serviceId: id };
    case 'ENVIRONMENT':
      return { environmentId: id };
  }
}
