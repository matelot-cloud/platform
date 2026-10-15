/**
 * How roles are presented: GitLab-like order (most power first), a one-line description, the GitLab role a customer
 * coming from GitLab would map it to, and the scopes where the role makes sense. Authorization never reads this file —
 * ROLE_PERMISSIONS decides what a role can do; this decides what the members dialog offers where.
 */
import type { Role, ScopeType } from '../database/schema';
import { ROLE_PERMISSIONS } from './permissions';

export type MemberScope = Extract<ScopeType, 'ORGANIZATION' | 'WORKSPACE' | 'TEAM' | 'PROJECT'>;
export const MEMBER_SCOPES: readonly MemberScope[] = ['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT'];

export interface RoleInfo {
  role: Role;
  label: string;
  description: string;
  /** Closest GitLab role (Guest / Reporter / Developer / Maintainer / Owner) — docs/roles.md has the table. */
  gitlab: 'Guest' | 'Reporter' | 'Developer' | 'Maintainer' | 'Owner';
  scopes: readonly MemberScope[];
}

const ALL: readonly MemberScope[] = MEMBER_SCOPES;
const BELOW_ORG: readonly MemberScope[] = ['WORKSPACE', 'TEAM', 'PROJECT'];

export const ROLE_CATALOG: readonly RoleInfo[] = [
  { role: 'ORG_ADMIN', label: 'Organization admin', description: 'Everything in the organization: settings, members, connections, policies, billing and licence.', gitlab: 'Owner', scopes: ['ORGANIZATION'] },
  { role: 'SECURITY_ADMIN', label: 'Security admin', description: 'Security administration: policies, SLAs, notification channels, connections, members, exception approval, decisions.', gitlab: 'Maintainer', scopes: ALL },
  { role: 'CISO', label: 'CISO', description: 'Reads everything; accepts risk, approves exceptions, manages incidents and members.', gitlab: 'Maintainer', scopes: ['ORGANIZATION', 'WORKSPACE'] },
  { role: 'CTO', label: 'CTO', description: 'Reads everything; creates and changes workspaces, teams, projects and services; manages members.', gitlab: 'Maintainer', scopes: ['ORGANIZATION', 'WORKSPACE'] },
  { role: 'COMPLIANCE_OFFICER', label: 'Compliance officer', description: 'Reads everything; compliance and evidence, approves exceptions.', gitlab: 'Reporter', scopes: ALL },
  { role: 'TEAM_LEAD', label: 'Team lead', description: 'Runs a team: projects, services, environments, members, connections, runners, pipelines, decisions.', gitlab: 'Maintainer', scopes: BELOW_ORG },
  { role: 'PRODUCT_SECURITY_ENGINEER', label: 'Product security engineer', description: 'Triage: decisions on findings, remediations and issues, exception requests, pipelines, evidence.', gitlab: 'Developer', scopes: ALL },
  { role: 'DEVELOPER', label: 'Developer', description: 'Builds and ships: pipelines, images, SBOMs, releases, deployments, exception requests; reads findings.', gitlab: 'Developer', scopes: BELOW_ORG },
  { role: 'AUDITOR', label: 'Auditor', description: 'Reads everything, including the audit trail and evidence; changes nothing.', gitlab: 'Reporter', scopes: ALL },
  { role: 'EXTERNAL_CONSULTANT', label: 'External consultant', description: 'Reads everything and can update risk records; for outside assessors, ideally with an expiry date.', gitlab: 'Reporter', scopes: ALL },
  { role: 'READ_ONLY', label: 'Read only', description: 'Sees the structure, findings and SBOMs; no audit trail, no evidence, changes nothing.', gitlab: 'Guest', scopes: ALL },
];

export const ROLE_ORDER: readonly Role[] = ROLE_CATALOG.map((r) => r.role);
export function roleInfo(role: Role): RoleInfo {
  return ROLE_CATALOG.find((r) => r.role === role)!;
}
export function rolesForScope(scope: ScopeType): RoleInfo[] {
  return ROLE_CATALOG.filter((r) => (r.scopes as readonly ScopeType[]).includes(scope));
}

/** True when `role` grants nothing beyond the union of `held` (the "raise, never lower" and "not above own" rules). */
export function roleAddsNothing(role: Role, held: Iterable<string>): boolean {
  const have = new Set(held);
  return [...ROLE_PERMISSIONS[role]].every((p) => have.has(p));
}
