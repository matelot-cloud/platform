import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import type { ScopeType } from '../database/schema';
import { GrantMembershipDto } from './dto/grant-membership.dto';
import { MembersService } from './members.service';
import { ScopeNamesService, ScopeSummary } from './scope-names.service';

export type { ScopeSummary };

/**
 * The original /memberships endpoints (CLI `membership grant|revoke`, `memberships list`), kept for compatibility. They
 * go through MembersService, so every rule of the members API applies to them too (no bypass).
 */
@Injectable()
export class MembershipsService {
  constructor(
    private readonly members: MembersService,
    private readonly names: ScopeNamesService,
  ) {}

  async listForScope(actor: AuthenticatedUser, scopeType: ScopeType, scopeId: string) {
    const { members } = await this.members.list(actor, scopeType, scopeId);
    return members
      .filter((m) => m.source === 'direct')
      .map((m) => ({ id: m.membershipId, role: m.role, scopeType, scopeId, createdAt: m.grantedAt, expiresAt: m.expiresAt, user: { id: m.user.id, email: m.user.email, displayName: m.user.displayName, lastLoginAt: m.user.lastLoginAt } }));
  }

  async grant(actor: AuthenticatedUser, dto: GrantMembershipDto) {
    const r = await this.members.add(actor, { scopeType: dto.scopeType, scopeId: dto.scopeId, role: dto.role, emails: dto.email ? [dto.email] : [], userIds: dto.userId ? [dto.userId] : [], expiresAt: dto.expiresAt, reason: dto.reason });
    const a = r.added[0]!;
    return { id: a.membershipId, role: a.role, scopeType: dto.scopeType, scopeId: dto.scopeId, updated: a.updated, user: { email: a.email }, invited: r.invited[0] ?? null };
  }

  revoke(actor: AuthenticatedUser, membershipId: string): Promise<void> {
    return this.members.remove(actor, membershipId);
  }

  describeScopes(items: { scopeType: ScopeType; scopeId: string }[]): Promise<Map<string, ScopeSummary>> {
    return this.names.describeScopes(items);
  }
}
