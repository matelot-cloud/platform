import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { Workspace, workspaces } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeChain } from '../rbac/scope.types';
import { CreateWorkspaceDto, UpdateWorkspaceDto } from './dto/workspace.dto';

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthenticatedUser, orgChain: ScopeChain): Promise<Workspace[]> {
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.organizationId, orgChain.organizationId), isNull(workspaces.archivedAt)))
      .orderBy(asc(workspaces.name));
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'workspace:read', orgChain)) return rows;
    return rows.filter((w) => ctx.visibleWorkspaceIds.has(w.id));
  }

  async create(user: AuthenticatedUser, orgChain: ScopeChain, dto: CreateWorkspaceDto): Promise<Workspace> {
    const [workspace] = await this.db
      .insert(workspaces)
      .values({ organizationId: orgChain.organizationId, slug: dto.slug, name: dto.name, description: dto.description })
      .returning();
    await this.audit.record({
      organizationId: orgChain.organizationId,
      actor: userActor(user),
      action: 'workspace.created',
      resourceType: 'workspace',
      resourceId: workspace.id,
      after: workspace,
    });
    return workspace;
  }

  async get(chain: ScopeChain): Promise<Workspace> {
    const [workspace] = await this.db.select().from(workspaces).where(eq(workspaces.id, chain.workspaceId!)).limit(1);
    if (!workspace) throw new NotFoundException('Workspace not found');
    return workspace;
  }

  async update(user: AuthenticatedUser, chain: ScopeChain, dto: UpdateWorkspaceDto): Promise<Workspace> {
    const before = await this.get(chain);
    const [after] = await this.db
      .update(workspaces)
      .set({ name: dto.name ?? before.name, description: dto.description ?? before.description })
      .where(eq(workspaces.id, before.id))
      .returning();
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(user),
      action: 'workspace.updated',
      resourceType: 'workspace',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }

  async archive(user: AuthenticatedUser, chain: ScopeChain): Promise<Workspace> {
    const before = await this.get(chain);
    const [after] = await this.db.update(workspaces).set({ archivedAt: new Date() }).where(eq(workspaces.id, before.id)).returning();
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(user),
      action: 'workspace.archived',
      resourceType: 'workspace',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }
}
