import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { Organization, organizations } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { buildChain, ScopeChain } from '../rbac/scope.types';
import { CreateOrganizationDto, UpdateOrganizationDto } from './dto/organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
    private readonly audit: AuditService,
  ) {}

  /** Organizations the user can see: through a membership on it, a parent, or anything inside it. */
  async listVisible(user: AuthenticatedUser): Promise<Organization[]> {
    const ctx = await this.access.forUser(user.id);
    const all = await this.db.select().from(organizations).where(isNull(organizations.archivedAt)).orderBy(asc(organizations.name));
    const parentOf = new Map(all.map((o) => [o.id, o.parentId]));

    const ancestorsOf = (id: string): string[] => {
      const out: string[] = [];
      let current = parentOf.get(id);
      while (current && !out.includes(current)) {
        out.push(current);
        current = parentOf.get(current);
      }
      return out;
    };

    return all.filter((org) => this.authz.can(ctx, 'organization:read', buildChain({ organizationId: org.id }, ancestorsOf(org.id))));
  }

  async get(chain: ScopeChain): Promise<Organization> {
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, chain.organizationId)).limit(1);
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async createChild(user: AuthenticatedUser, dto: CreateOrganizationDto): Promise<Organization> {
    const parentChain = await this.resolver.resolveChain({ organizationId: dto.parentId });
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, 'organization:create_child', parentChain);

    const [org] = await this.db.insert(organizations).values({ slug: dto.slug, name: dto.name, parentId: dto.parentId }).returning();
    await this.audit.record({
      organizationId: org.id,
      actor: userActor(user),
      action: 'organization.created',
      resourceType: 'organization',
      resourceId: org.id,
      after: org,
    });
    return org;
  }

  async update(user: AuthenticatedUser, chain: ScopeChain, dto: UpdateOrganizationDto): Promise<Organization> {
    const before = await this.get(chain);
    const [after] = await this.db.update(organizations).set({ name: dto.name }).where(eq(organizations.id, before.id)).returning();
    await this.audit.record({
      organizationId: after.id,
      actor: userActor(user),
      action: 'organization.updated',
      resourceType: 'organization',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }
}
