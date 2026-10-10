import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { NOTIFICATION_EVENTS } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeChain, scopeParamsFor } from '../rbac/scope.types';
import { NotificationsService } from './notifications.service';
import { ConfigApplyService, ConfigDocument } from './config-apply.service';
import { Query } from '@nestjs/common';

class ChannelDto { @IsString() @MaxLength(100) name: string; @IsIn(['slack', 'webhook', 'teams', 'email']) kind: 'slack' | 'webhook' | 'teams' | 'email'; @IsString() @MaxLength(1000) url: string; @IsOptional() @IsArray() events?: string[]; @IsOptional() @IsUUID() projectId?: string | null }
class ChannelPatchDto { @IsOptional() @IsString() @MaxLength(100) name?: string; @IsOptional() @IsString() @MaxLength(1000) url?: string; @IsOptional() @IsArray() events?: string[]; @IsOptional() @IsBoolean() enabled?: boolean; @IsOptional() @IsUUID() projectId?: string | null }

@ApiTags('notifications')
@ApiBearerAuth()
@Controller()
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly configApply: ConfigApplyService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /** What this cell can deliver: e-mail needs SMTP configured by the operator. */
  /** Configuration as code: channels, policies and SLAs for a scope, applied idempotently (name-keyed). `?dryRun=true` plans only. */
  @Post(['organizations/:organizationId/config/apply', 'workspaces/:workspaceId/config/apply', 'teams/:teamId/config/apply', 'projects/:projectId/config/apply'])
  @RequirePermission('policy:write')
  apply(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() doc: ConfigDocument, @Query('dryRun') dryRun?: string) {
    return this.configApply.apply(user, chain, doc, dryRun === 'true');
  }

  @Get('notification-capabilities')
  capabilities() { return { slack: true, teams: true, webhook: true, email: !!this.notifications.smtp() }; }

  @Get('notification-events')
  events() { return NOTIFICATION_EVENTS.map((e) => ({ id: e, description: { 'gate.fail': 'A policy gate failed (CI, pipeline or deploy)', 'deployment.production': 'Something was deployed to a production environment', 'deployment.rejected': 'A deployment was rejected by a policy', 'sla.overdue': 'Findings past their SLA (daily)', 'kev.production': 'A known-exploited vulnerability appeared in production', 'exception.expiring': 'An exception expires within 7 days', 'secret.detected': 'A secret was found in a repository' }[e] })); }

  /** Channels in force at a level (own + inherited from above). */
  @Get(['organizations/:organizationId/notification-channels', 'workspaces/:workspaceId/notification-channels', 'teams/:teamId/notification-channels', 'projects/:projectId/notification-channels'])
  @RequirePermission('project:read')
  list(@Scope() chain: ScopeChain) { return this.notifications.list(chain.organizationId, chain); }

  /** Create at a level: organization (everything), workspace / team / project (only events under it). */
  @Post(['organizations/:organizationId/notification-channels', 'workspaces/:workspaceId/notification-channels', 'teams/:teamId/notification-channels', 'projects/:projectId/notification-channels'])
  @RequirePermission('project:write')
  create(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: ChannelDto) { return this.notifications.create(user, chain, dto); }

  @Patch('notification-channels/:channelId')
  async update(@CurrentUser() user: AuthenticatedUser, @Param('channelId', ParseUUIDPipe) id: string, @Body() dto: ChannelPatchDto) { await this.assert(user, id); return this.notifications.update(user, id, dto); }

  @Delete('notification-channels/:channelId')
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('channelId', ParseUUIDPipe) id: string) { await this.assert(user, id); return this.notifications.remove(user, id); }

  @Post('notification-channels/:channelId/test')
  async test(@CurrentUser() user: AuthenticatedUser, @Param('channelId', ParseUUIDPipe) id: string) { await this.assert(user, id); return this.notifications.test(user, id); }

  private async assert(user: AuthenticatedUser, id: string) {
    const c = await this.notifications.byId(id);
    const chain = await this.resolver.resolveChain(c.scopeType === 'ORGANIZATION' || !c.scopeId ? { organizationId: c.organizationId } : scopeParamsFor(c.scopeType, c.scopeId));
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, 'project:write', chain);
  }
}
