import { Inject, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, IsBoolean } from 'class-validator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { projectIdsForChain } from '../rbac/scope-projects';
import { DATABASE, Database } from '../database/database.module';
import { ScopeChain } from '../rbac/scope.types';
import { RemediationService } from './remediation.service';

class SlaDto { @IsOptional() @IsInt() @Min(1) @Max(3650) critical?: number; @IsOptional() @IsInt() @Min(1) @Max(3650) high?: number; @IsOptional() @IsInt() @Min(1) @Max(3650) medium?: number; @IsOptional() @IsInt() @Min(1) @Max(3650) low?: number }
class SettingsDto { @IsOptional() @IsObject() slaDays?: SlaDto | null; @IsOptional() @IsIn(['github', 'gitlab', 'bitbucket', 'jira']) issueProvider?: 'github' | 'gitlab' | 'bitbucket' | 'jira' | null; @IsOptional() @IsString() @MaxLength(300) issueBoard?: string | null; @IsOptional() @IsUUID() defaultIssueIntegrationId?: string | null; @IsOptional() @IsString() @MaxLength(20) jiraProjectKey?: string | null }
class CreateRemediationDto {
  /** Create even if an active remediation for the same advisory / component exists. */
  @IsOptional() @IsBoolean() force?: boolean;
  @IsIn(['vulnerability', 'code']) kind: 'vulnerability' | 'code';
  @IsString() @MaxLength(200) matchId: string;
  @IsOptional() @IsString() @MaxLength(300) componentName?: string;
  @IsOptional() @IsUUID() ownerId?: string;
  @IsOptional() @IsString() @MaxLength(200) ownerEmail?: string;
  @IsOptional() @IsString() dueAt?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsString() @MaxLength(300) title?: string;
}
class UpdateRemediationDto {
  @IsOptional() @IsIn(['open', 'in_progress', 'done', 'wont_fix']) status?: 'open' | 'in_progress' | 'done' | 'wont_fix';
  @IsOptional() @IsUUID() ownerId?: string | null;
  @IsOptional() @IsString() @MaxLength(200) ownerEmail?: string;
  @IsOptional() @IsString() dueAt?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsString() @MaxLength(300) title?: string;
}
class IssueDto { @IsOptional() @IsIn(['github', 'gitlab', 'bitbucket', 'jira']) provider?: 'github' | 'gitlab' | 'bitbucket' | 'jira'; @IsOptional() @IsUUID() integrationId?: string; @IsOptional() @IsString() @MaxLength(20) projectKey?: string }

@ApiTags('remediation')
@ApiBearerAuth()
@Controller()
export class RemediationController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly remediation: RemediationService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
  ) {}

  // ---- settings (SLA, issue tracker)
  @Get('organizations/:organizationId/remediation/settings')
  @RequirePermission('vulnerability:read')
  settings(@Scope() chain: ScopeChain) { return this.remediation.settings(chain.organizationId); }

  @Patch('organizations/:organizationId/remediation/settings')
  @RequirePermission('policy:write')
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: SettingsDto) { return this.remediation.updateSettings(user, chain.organizationId, dto); }

  // scoped settings: each scope stores only what it overrides; a project's effective settings resolve through its chain
  @Get('workspaces/:workspaceId/remediation/settings')
  @RequirePermission('vulnerability:read')
  wsSettings(@Scope() chain: ScopeChain) { return this.remediation.settingsAt(chain.organizationId, 'WORKSPACE', chain.workspaceId!); }
  @Patch('workspaces/:workspaceId/remediation/settings')
  @RequirePermission('policy:write')
  wsUpdate(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: SettingsDto) { return this.remediation.updateSettings(user, chain.organizationId, dto, 'WORKSPACE', chain.workspaceId!); }
  @Get('teams/:teamId/remediation/settings')
  @RequirePermission('vulnerability:read')
  teamSettings(@Scope() chain: ScopeChain) { return this.remediation.settingsAt(chain.organizationId, 'TEAM', chain.teamId!); }
  @Patch('teams/:teamId/remediation/settings')
  @RequirePermission('policy:write')
  teamUpdate(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: SettingsDto) { return this.remediation.updateSettings(user, chain.organizationId, dto, 'TEAM', chain.teamId!); }
  @Get('projects/:projectId/remediation/settings')
  @RequirePermission('vulnerability:read')
  projectSettings(@Scope() chain: ScopeChain) { return this.remediation.settingsAt(chain.organizationId, 'PROJECT', chain.projectId!); }
  @Patch('projects/:projectId/remediation/settings')
  @RequirePermission('policy:write')
  projectUpdate(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: SettingsDto) { return this.remediation.updateSettings(user, chain.organizationId, dto, 'PROJECT', chain.projectId!); }
  /** Run the inbound tracker sync now (otherwise hourly): closed issues → done, reopened issues → open. */
  @Post('organizations/:organizationId/remediations/sync-trackers')
  @RequirePermission('policy:write')
  syncTrackers(@Scope() chain: ScopeChain) { return this.remediation.syncFromTrackers(chain.organizationId); }

  /** What actually applies to this project (SLA days, issue provider, Jira key) and where each value comes from. */
  @Get('projects/:projectId/remediation/settings/effective')
  @RequirePermission('vulnerability:read')
  effective(@Scope() chain: ScopeChain) { return this.remediation.effectiveSettings(chain.projectId!); }

  // ---- fix-first queue
  @Get('organizations/:organizationId/remediation/queue')
  @RequirePermission('vulnerability:read')
  orgQueue(@Scope() chain: ScopeChain, @Query('limit') limit?: string) { return this.remediation.queue(chain.organizationId, { limit: limit ? Number(limit) : undefined }); }

  @Get('projects/:projectId/remediation/queue')
  @RequirePermission('vulnerability:read')
  projectQueue(@Scope() chain: ScopeChain, @Query('limit') limit?: string) { return this.remediation.queue(chain.organizationId, { projectId: chain.projectId!, limit: limit ? Number(limit) : undefined }); }

  @Get(['workspaces/:workspaceId/remediation/queue', 'teams/:teamId/remediation/queue'])
  @RequirePermission('vulnerability:read')
  async scopedQueue(@Scope() chain: ScopeChain, @Query('team') team?: string, @Query('limit') limit?: string) { return this.remediation.queue(chain.organizationId, { projectId: await projectIdsForChain(this.db, team ? ({ ...chain, teamId: team, projectId: undefined } as ScopeChain) : chain), limit: limit ? Number(limit) : undefined }); }
  @Get(['workspaces/:workspaceId/remediations', 'teams/:teamId/remediations'])
  @RequirePermission('vulnerability:read')
  async scopedList(@Scope() chain: ScopeChain, @Query('status') status?: string, @Query('team') team?: string) { return this.remediation.list(chain.organizationId, { projectId: await projectIdsForChain(this.db, team ? ({ ...chain, teamId: team, projectId: undefined } as ScopeChain) : chain), status: status?.split(',').filter(Boolean) }); }

  @Get('services/:serviceId/remediation/queue')
  @RequirePermission('vulnerability:read')
  serviceQueue(@Scope() chain: ScopeChain) { return this.remediation.queue(chain.organizationId, { serviceId: chain.serviceId! }); }

  // ---- remediations
  @Get('organizations/:organizationId/remediations')
  @RequirePermission('vulnerability:read')
  listOrg(@Scope() chain: ScopeChain, @Query('status') status?: string, @Query('owner') owner?: string) { return this.remediation.list(chain.organizationId, { status: status?.split(',').filter(Boolean), ownerId: owner }); }

  @Get('projects/:projectId/remediations')
  @RequirePermission('vulnerability:read')
  listProject(@Scope() chain: ScopeChain, @Query('status') status?: string) { return this.remediation.list(chain.organizationId, { projectId: chain.projectId!, status: status?.split(',').filter(Boolean) }); }

  @Post('services/:serviceId/remediations')
  @RequirePermission('vulnerability:write')
  create(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateRemediationDto) { return this.remediation.create(user, chain.organizationId, { serviceId: chain.serviceId!, ...dto }); }

  @Get('remediations/:remediationId')
  async show(@CurrentUser() user: AuthenticatedUser, @Param('remediationId', ParseUUIDPipe) id: string) { await this.assert(user, id, 'vulnerability:read'); return this.remediation.byId(id); }

  @Patch('remediations/:remediationId')
  async update(@CurrentUser() user: AuthenticatedUser, @Param('remediationId', ParseUUIDPipe) id: string, @Body() dto: UpdateRemediationDto) { await this.assert(user, id, 'vulnerability:write'); return this.remediation.update(user, id, dto); }

  /** Open a GitHub (service repository) or Jira issue and link it. */
  @Post('remediations/:remediationId/issue')
  async issue(@CurrentUser() user: AuthenticatedUser, @Param('remediationId', ParseUUIDPipe) id: string, @Body() dto: IssueDto) { await this.assert(user, id, 'vulnerability:write'); return this.remediation.createIssue(user, id, dto); }

  private async assert(user: AuthenticatedUser, id: string, permission: 'vulnerability:read' | 'vulnerability:write') {
    const r = await this.remediation.byId(id);
    const chain = await this.resolver.resolveChain({ serviceId: r.serviceId });
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, permission, chain);
  }
}
