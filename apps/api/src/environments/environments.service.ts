import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { Environment, environments } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeChain } from '../rbac/scope.types';
import { CreateEnvironmentDto, UpdateEnvironmentDto } from './dto/environment.dto';

@Injectable()
export class EnvironmentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthenticatedUser, serviceChain: ScopeChain): Promise<Environment[]> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.serviceId, serviceChain.serviceId!), isNull(environments.archivedAt)))
      .orderBy(asc(environments.kind), asc(environments.name));
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'environment:read', serviceChain)) return rows;
    return rows.filter((e) => ctx.visibleEnvironmentIds.has(e.id));
  }

  async create(user: AuthenticatedUser, serviceChain: ScopeChain, dto: CreateEnvironmentDto): Promise<Environment> {
    const [environment] = await this.db
      .insert(environments)
      .values({ serviceId: serviceChain.serviceId!, slug: dto.slug, name: dto.name, kind: dto.kind, internetFacing: dto.internetFacing ?? false })
      .returning();
    await this.audit.record({
      organizationId: serviceChain.organizationId,
      actor: userActor(user),
      action: 'environment.created',
      resourceType: 'environment',
      resourceId: environment.id,
      after: environment,
    });
    return environment;
  }

  async get(chain: ScopeChain): Promise<Environment> {
    const [environment] = await this.db.select().from(environments).where(eq(environments.id, chain.environmentId!)).limit(1);
    if (!environment) throw new NotFoundException('Environment not found');
    return environment;
  }

  async update(user: AuthenticatedUser, chain: ScopeChain, dto: UpdateEnvironmentDto): Promise<Environment> {
    const before = await this.get(chain);
    const [after] = await this.db
      .update(environments)
      .set({ name: dto.name ?? before.name, kind: dto.kind ?? before.kind, internetFacing: dto.internetFacing ?? before.internetFacing })
      .where(eq(environments.id, before.id))
      .returning();
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(user),
      action: 'environment.updated',
      resourceType: 'environment',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }

  async archive(user: AuthenticatedUser, chain: ScopeChain): Promise<Environment> {
    const before = await this.get(chain);
    const [after] = await this.db.update(environments).set({ archivedAt: new Date() }).where(eq(environments.id, before.id)).returning();
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(user),
      action: 'environment.archived',
      resourceType: 'environment',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }
}
