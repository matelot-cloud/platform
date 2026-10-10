import { and, eq, inArray, isNull, SQL } from 'drizzle-orm';
import { PgColumn } from 'drizzle-orm/pg-core';
import { Database } from '../database/database.module';
import { projects, teams } from '../database/schema';
import { ScopeChain } from './scope.types';

/** One project id, several (a workspace's or team's projects), or none (whole organization). */
export type ProjectScope = string | string[] | undefined;

/** drizzle condition for a project scope on a project-id column (undefined = no restriction). */
export function projectCondition(column: PgColumn, scope: ProjectScope): SQL | undefined {
  if (!scope) return undefined;
  if (Array.isArray(scope)) return scope.length ? inArray(column, scope) : eq(column, '00000000-0000-0000-0000-000000000000');
  return eq(column, scope);
}

/** Projects covered by a chain: the project itself, the team's projects, the workspace's projects, or everything (organization). */
export async function projectIdsForChain(db: Database, chain: ScopeChain): Promise<ProjectScope> {
  if (chain.projectId) return chain.projectId;
  if (chain.teamId) return (await db.select({ id: projects.id }).from(projects).where(and(eq(projects.teamId, chain.teamId), isNull(projects.archivedAt)))).map((p) => p.id);
  if (chain.workspaceId) return (await db.select({ id: projects.id }).from(projects).innerJoin(teams, eq(projects.teamId, teams.id)).where(and(eq(teams.workspaceId, chain.workspaceId), isNull(projects.archivedAt)))).map((p) => p.id);
  return undefined;
}
