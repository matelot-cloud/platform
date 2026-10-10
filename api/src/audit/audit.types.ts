import type { AuthenticatedUser } from '../auth/authenticated-user';
import type { ActorType } from '../database/schema';

export interface AuditActor {
  type: ActorType;
  id?: string;
  label?: string;
}

export const SYSTEM_ACTOR: AuditActor = { type: 'SYSTEM', label: 'platform' };

export function userActor(user: AuthenticatedUser): AuditActor {
  if (user.token) return { type: 'SYSTEM', id: user.token.id, label: `CI token ${user.token.name}` };
  return { type: 'USER', id: user.id, label: user.email };
}

export interface AuditEntry {
  organizationId?: string | null;
  actor: AuditActor;
  /** Dotted verb: "<resource>.<event>" e.g. "project.created" */
  action: string;
  resourceType: string;
  resourceId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}
