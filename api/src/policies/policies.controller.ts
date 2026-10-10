import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, IsInt, Max, Min } from 'class-validator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import type { PolicyRules } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeChain, scopeParamsFor } from '../rbac/scope.types';
import { GateSubject, PoliciesService } from './policies.service';
import { ExceptionsService } from './exceptions.service';
import { POLICY_TEMPLATES } from './templates';

class PolicyDto {
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsArray() environmentKinds?: string[];
  @IsObject() rules: PolicyRules;
  @IsOptional() @IsIn(['block', 'warn']) action?: 'block' | 'warn';
  @IsOptional() @IsBoolean() enforceOnDeploy?: boolean;
}
class PolicyPatchDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() environmentKinds?: string[];
  @IsOptional() @IsObject() rules?: PolicyRules;
  @IsOptional() @IsIn(['block', 'warn']) action?: 'block' | 'warn';
  @IsOptional() @IsBoolean() enforceOnDeploy?: boolean;
}
class ExceptionDto {
  @IsIn(['vulnerability', 'code']) kind: 'vulnerability' | 'code';
  @IsString() @MaxLength(200) matchId: string;
  @IsOptional() @IsString() @MaxLength(300) matchComponent?: string;
  @IsOptional() @IsIn(['accepted', 'false_positive', 'not_affected']) status?: 'accepted' | 'false_positive' | 'not_affected';
  @IsString() @MaxLength(2000) reason: string;
  @IsOptional() @IsString() @MaxLength(500) ticketUrl?: string;
  @IsString() expiresAt: string;
  @IsOptional() @IsBoolean() approve?: boolean;
}
class TemplateDto { @IsString() template: string; @IsOptional() @IsString() @MaxLength(120) name?: string }
class GateDto {
  @IsOptional() @IsString() @MaxLength(500) imageRef?: string;
  @IsOptional() @IsString() @MaxLength(100) digest?: string;
  @IsOptional() @IsString() @MaxLength(100) version?: string;
  @IsOptional() @IsString() @MaxLength(100) ref?: string;
  /** Seconds to wait for the image's SBOM and its correlation before evaluating (0 = evaluate now; max 25 per call — clients loop). */
  @IsOptional() @IsInt() @Min(0) @Max(25) waitCorrelation?: number;
}

@ApiTags('policies')
@ApiBearerAuth()
@Controller()
export class PoliciesController {
  constructor(
    private readonly policies: PoliciesService,
    private readonly exceptions: ExceptionsService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /** Ready-made policies (CRA baseline, production baseline, …). */
  @Get('policy-templates')
  templates() {
    return POLICY_TEMPLATES;
  }

  /** Create a policy from a template at the organization / workspace / team / project. */
  @Post('organizations/:organizationId/policies/from-template')
  @RequirePermission('policy:write')
  fromTemplateOrg(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: TemplateDto) { return this.fromTemplate(user, chain, dto); }
  @Post('workspaces/:workspaceId/policies/from-template')
  @RequirePermission('policy:write')
  fromTemplateWs(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: TemplateDto) { return this.fromTemplate(user, chain, dto); }
  @Post('teams/:teamId/policies/from-template')
  @RequirePermission('policy:write')
  fromTemplateTeam(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: TemplateDto) { return this.fromTemplate(user, chain, dto); }
  @Post('projects/:projectId/policies/from-template')
  @RequirePermission('policy:write')
  fromTemplateProject(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: TemplateDto) { return this.fromTemplate(user, chain, dto); }
  private fromTemplate(user: AuthenticatedUser, chain: ScopeChain, dto: TemplateDto) {
    const t = POLICY_TEMPLATES.find((x) => x.id === dto.template);
    if (!t) throw new Error(`unknown template ${dto.template}`);
    return this.policies.create(user, chain, { name: dto.name ?? t.name, description: t.description, environmentKinds: t.environmentKinds, rules: t.rules, action: t.action, enforceOnDeploy: t.enforceOnDeploy });
  }

  // ---- exceptions
  @Get('organizations/:organizationId/exceptions')
  @RequirePermission('policy:read')
  listExceptions(@Scope() chain: ScopeChain, @Query('active') active?: string) { return this.exceptions.list(chain.organizationId, { active: active === undefined ? undefined : active === 'true' }); }
  @Post('organizations/:organizationId/exceptions')
  @RequirePermission('exception:write')
  async createExceptionOrg(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: ExceptionDto) { return this.exceptions.create(user, chain, { ...dto, approve: dto.approve !== false && (await this.canApprove(user, chain)) }); }
  @Post('projects/:projectId/exceptions')
  @RequirePermission('exception:write')
  async createExceptionProject(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: ExceptionDto) { return this.exceptions.create(user, chain, { ...dto, approve: dto.approve !== false && (await this.canApprove(user, chain)) }); }
  @Post('services/:serviceId/exceptions')
  @RequirePermission('exception:write')
  async createExceptionService(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: ExceptionDto) { return this.exceptions.create(user, chain, { ...dto, approve: dto.approve !== false && (await this.canApprove(user, chain)) }); }
  @Post('exceptions/:exceptionId/approve')
  async approveException(@CurrentUser() user: AuthenticatedUser, @Param('exceptionId', ParseUUIDPipe) id: string) {
    await this.assertException(user, id, 'exception:approve');
    return this.exceptions.approve(user, id);
  }
  @Delete('exceptions/:exceptionId')
  @HttpCode(200)
  async revokeException(@CurrentUser() user: AuthenticatedUser, @Param('exceptionId', ParseUUIDPipe) id: string, @Query('reason') reason?: string) {
    await this.assertException(user, id);
    return this.exceptions.revoke(user, id, reason);
  }
  /** Approvers (security admin, compliance, CISO, org admin) make an exception active at once; others create it pending approval. */
  private async canApprove(user: AuthenticatedUser, chain: ScopeChain): Promise<boolean> {
    const ctx = await this.access.forUser(user.id);
    return this.authz.hasPermission(ctx, 'exception:approve', chain);
  }

  private async assertException(user: AuthenticatedUser, id: string, permission: 'exception:write' | 'exception:approve' = 'exception:write') {
    const e = await this.exceptions.byId(id);
    const chain = await this.resolver.resolveChain(scopeParamsFor(e.scopeType, e.scopeId));
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, permission, chain);
  }

  @Get('organizations/:organizationId/policies')
  @RequirePermission('policy:read')
  list(@Scope() chain: ScopeChain) {
    return this.policies.listForOrganization(chain.organizationId);
  }

  /** Policies in force on a project / workspace / team (defined there or inherited, marked). */
  @Get('projects/:projectId/policies')
  @RequirePermission('policy:read')
  projectPolicies(@Scope() chain: ScopeChain) {
    return this.policies.inForce(chain);
  }

  @Get('workspaces/:workspaceId/policies')
  @RequirePermission('policy:read')
  workspacePolicies(@Scope() chain: ScopeChain) {
    return this.policies.inForce(chain);
  }

  @Get('teams/:teamId/policies')
  @RequirePermission('policy:read')
  teamPolicies(@Scope() chain: ScopeChain) {
    return this.policies.inForce(chain);
  }

  @Post('organizations/:organizationId/policies')
  @RequirePermission('policy:write')
  createOrg(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: PolicyDto) {
    return this.policies.create(user, chain, dto);
  }

  @Post('projects/:projectId/policies')
  @RequirePermission('policy:write')
  createProject(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: PolicyDto) {
    return this.policies.create(user, chain, dto);
  }

  @Post('workspaces/:workspaceId/policies')
  @RequirePermission('policy:write')
  createWorkspace(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: PolicyDto) {
    return this.policies.create(user, chain, dto);
  }

  @Post('teams/:teamId/policies')
  @RequirePermission('policy:write')
  createTeam(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: PolicyDto) {
    return this.policies.create(user, chain, dto);
  }

  @Patch('policies/:policyId')
  async update(@CurrentUser() user: AuthenticatedUser, @Param('policyId', ParseUUIDPipe) policyId: string, @Body() dto: PolicyPatchDto) {
    await this.assertPolicy(user, policyId, 'policy:write');
    return this.policies.update(user, policyId, dto);
  }

  @Delete('policies/:policyId')
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('policyId', ParseUUIDPipe) policyId: string) {
    await this.assertPolicy(user, policyId, 'policy:write');
    return this.policies.remove(user, policyId);
  }

  /** The gate: evaluate an image / version against the environment's policies (CI: `secops gate`). */
  @Post('environments/:environmentId/gate')
  @RequirePermission('gate:evaluate')
  gate(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: GateDto) {
    const subject: GateSubject = { imageRef: dto.imageRef, digest: dto.digest, version: dto.version, ref: dto.ref };
    if (!subject.imageRef && !subject.digest && !subject.version && !subject.ref) throw new Error('Give an imageRef, digest, version or ref');
    return this.policies.evaluate(chain, subject, { environmentId: chain.environmentId!, actor: user.token ? `token ${user.token.name}` : user.email, waitCorrelationMs: (dto.waitCorrelation ?? 0) * 1000 });
  }

  @Get('environments/:environmentId/gate')
  @RequirePermission('policy:read')
  latest(@Scope() chain: ScopeChain) {
    return this.policies.latestForEnvironment(chain.environmentId!);
  }

  @Get('services/:serviceId/gate-evaluations')
  @RequirePermission('policy:read')
  evaluations(@Scope() chain: ScopeChain) {
    return this.policies.listForService(chain.serviceId!);
  }

  private async assertPolicy(user: AuthenticatedUser, policyId: string, permission: 'policy:read' | 'policy:write') {
    const p = await this.policies.policyById(policyId);
    const chain = await this.resolver.resolveChain(scopeParamsFor(p.scopeType, p.scopeId));
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, permission, chain);
  }
}
