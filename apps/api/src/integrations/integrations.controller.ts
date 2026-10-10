import { IdentityService } from '../identity/identity.service';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ScopeType } from '../database/schema';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { AttachRepositoryDto } from './dto/integrations.dto';
import { IntegrationsService } from './integrations.service';

@ApiTags('integrations')
@ApiBearerAuth()
@Controller()
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService, private readonly identityService: IdentityService) {}

  /** Which providers this cell can connect (depends on cell configuration). */
  @Get('integrations/providers')
  providers() {
    return this.integrations.providers();
  }

  @Get('organizations/:organizationId/integrations')
  @RequirePermission('organization:read')
  list(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.integrations.listForOrganization(user, chain);
  }

  /** Create a token / password / SSH connection at the organization or (scopeType, scopeId) level. */
  @Post('organizations/:organizationId/integrations')
  @RequirePermission('organization:read')
  async create(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateIntegrationDto) {
    const created = await this.integrations.create(user, chain, dto);
    // Keyless: the subject now exists — hand back the exact trust to configure before Verify.
    if ('keyless' in created && created.keyless) return { ...created, identity: await this.integrations.identityFor(user, created.id, this.identityService.issuer) };
    return created;
  }

  /** Verify credentials without saving (wizard "Test connection"). */
  @Post('organizations/:organizationId/integrations/test')
  @RequirePermission('organization:read')
  test(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateIntegrationDto) {
    return this.integrations.test(user, chain, dto);
  }

  /** Deploy-key flow: after the public key was added on the host, check and go live. */
  /** Keyless connections (workload identity): issuer, subject and per-cloud setup steps for this connection. */
  @Get('integrations/:integrationId/identity')
  identity(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string) {
    return this.integrations.identityFor(user, integrationId, this.identityService.issuer);
  }

  @Post('integrations/:integrationId/verify')
  verify(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string) {
    return this.integrations.verify(user, integrationId);
  }

  /** Install link for a connection that owns its GitHub App (or uses the platform App). */
  @Get('integrations/:integrationId/install-url')
  installUrl(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string) {
    return this.integrations.installUrlFor(user, integrationId);
  }

  /** Matelot registry connection: the service repositories under its namespace. */
  @Get('integrations/:integrationId/matelot-repositories')
  matelotRepositories(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string) {
    return this.integrations.matelotRepositories(user, integrationId);
  }

  /** Own GitHub App: bind an installation that already exists on GitHub (or refresh the granted permissions). */
  @Post('integrations/:integrationId/link-installation')
  linkInstallation(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string) {
    return this.integrations.linkExistingInstallation(user, integrationId);
  }

  /** Connections that apply to a project (own + inherited from team, workspace, organization). */
  @Get('projects/:projectId/integrations')
  @RequirePermission('project:read')
  listForProject(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.integrations.listForChain(user, chain);
  }

  @Get('projects/:projectId/repositories')
  @RequirePermission('project:read')
  projectRepositories(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.integrations.repositoriesOfChain(user, chain);
  }

  @Get('organizations/:organizationId/integrations/github/install-url')
  @RequirePermission('organization:read')
  githubInstallUrl(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Query('scopeType') scopeType?: ScopeType, @Query('scopeId') scopeId?: string) {
    return this.integrations.githubInstallUrl(user, chain, scopeType, scopeId);
  }

  @Get('organizations/:organizationId/repositories')
  @RequirePermission('organization:read')
  organizationRepositories(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.integrations.repositoriesOfOrganization(user, chain);
  }

  @Get('integrations/:integrationId/repositories')
  integrationRepositories(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string) {
    return this.integrations.repositoriesOfIntegration(user, integrationId);
  }

  /** Registry connections a service can use (its path: project, team, workspace, organization). */
  @Get('services/:serviceId/registries')
  @RequirePermission('service:read')
  registries(@Scope() chain: ScopeChain) {
    return this.integrations.registriesForChain(chain);
  }

  /** Short-lived Docker credentials for a registry connection (CI: `secops registry login --connection`). */
  @Post('services/:serviceId/registries/:integrationId/credentials')
  @RequirePermission('registry:pull')
  dockerCredentials(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Param('integrationId', ParseUUIDPipe) integrationId: string) {
    return this.integrations.dockerCredentials(user, chain, integrationId);
  }

  /** ECR connections: repositories in the account/region. */
  @Get('integrations/:integrationId/ecr/repositories')
  ecrRepositories(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string) {
    return this.integrations.ecrRepositories(user, integrationId);
  }

  /** ECR connections: create a repository (scan on push, optional immutable tags). */
  @Post('integrations/:integrationId/ecr/repositories')
  ecrCreateRepository(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string, @Body() body: { name: string; scanOnPush?: boolean; immutableTags?: boolean }) {
    return this.integrations.ecrCreateRepository(user, integrationId, String(body.name ?? '').trim(), { scanOnPush: body.scanOnPush, immutableTags: body.immutableTags });
  }

  /** CI: ensure an ECR repository exists for a service (token needs registry:push; the connection must be on the service's path). */
  @Post('services/:serviceId/registries/:integrationId/repositories')
  @RequirePermission('registry:push')
  ecrEnsureRepository(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Param('integrationId', ParseUUIDPipe) integrationId: string, @Body() body: { name: string; scanOnPush?: boolean; immutableTags?: boolean }) {
    return this.integrations.ecrEnsureRepository(user, chain, integrationId, String(body.name ?? '').trim(), { scanOnPush: body.scanOnPush, immutableTags: body.immutableTags });
  }

  @Post('integrations/:integrationId/sync')
  @HttpCode(202)
  sync(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string) {
    return this.integrations.requestSync(user, integrationId);
  }

  /**
   * Deletes the connection, its repositories and their service links. Images pulling through it → 409 listing them,
   * unless `force=true` (query or body) detaches them. `permanent` is accepted for older web builds and ignored.
   */
  @Delete('integrations/:integrationId')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string, @Query('force') force?: string, @Body() body?: { force?: boolean | string }) {
    return this.integrations.remove(user, integrationId, { force: force === 'true' || body?.force === true || body?.force === 'true' });
  }

  /** Keeps the row and its repositories, marked disconnected; credentials are forgotten. */
  @Post('integrations/:integrationId/disconnect')
  disconnect(@CurrentUser() user: AuthenticatedUser, @Param('integrationId', ParseUUIDPipe) integrationId: string) {
    return this.integrations.disconnect(user, integrationId);
  }

  @Get('services/:serviceId/repositories')
  @RequirePermission('service:read')
  serviceRepositories(@Scope() chain: ScopeChain) {
    return this.integrations.serviceRepositories(chain);
  }

  @Post('services/:serviceId/repositories')
  @RequirePermission('service:write')
  attach(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: AttachRepositoryDto) {
    return this.integrations.attachRepository(user, chain, dto);
  }

  @Delete('services/:serviceId/repositories/:repositoryId')
  @RequirePermission('service:write')
  @HttpCode(204)
  async detach(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Param('repositoryId', ParseUUIDPipe) repositoryId: string) {
    await this.integrations.detachRepository(user, chain, repositoryId);
  }
}
