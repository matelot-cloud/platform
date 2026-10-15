import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { organizations, projects, ScopeType, teams, workspaces } from '../database/schema';

export interface ScopeSummary {
  type: ScopeType;
  id: string;
  slug: string;
  name: string;
}

/** Names and slugs of organizations, workspaces, teams and projects by id (GET /me, member lists, messages). */
@Injectable()
export class ScopeNamesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Resolves slug/name for the scopes in a list of memberships (for GET /me). */
  async describeScopes(items: { scopeType: ScopeType; scopeId: string }[]): Promise<Map<string, ScopeSummary>> {
    const result = new Map<string, ScopeSummary>();
    const ids = (type: ScopeType) => [...new Set(items.filter((m) => m.scopeType === type).map((m) => m.scopeId))];

    const add = (type: ScopeType, rows: { id: string; slug: string; name: string }[]) =>
      rows.forEach((r) => result.set(`${type}:${r.id}`, { type, ...r }));

    const orgIds = ids('ORGANIZATION');
    if (orgIds.length) {
      add(
        'ORGANIZATION',
        await this.db
          .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
          .from(organizations)
          .where(inArray(organizations.id, orgIds)),
      );
    }
    const wsIds = ids('WORKSPACE');
    if (wsIds.length) {
      add(
        'WORKSPACE',
        await this.db
          .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, wsIds)),
      );
    }
    const teamIds = ids('TEAM');
    if (teamIds.length) {
      add(
        'TEAM',
        await this.db.select({ id: teams.id, slug: teams.slug, name: teams.name }).from(teams).where(inArray(teams.id, teamIds)),
      );
    }
    const projectIds = ids('PROJECT');
    if (projectIds.length) {
      add(
        'PROJECT',
        await this.db
          .select({ id: projects.id, slug: projects.slug, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds)),
      );
    }
    return result;
  }
}
