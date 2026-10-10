import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { DATABASE, Database } from '../database/database.module';
import { environments } from '../database/schema';
import { JobsService } from '../execution/jobs.service';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { CreateImageDto, CreateReleaseDto, EnvironmentSettingsDto, RecordDeploymentDto } from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller()
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly jobs: JobsService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  // ---- releases
  @Get('services/:serviceId/releases')
  @RequirePermission('service:read')
  releases(@Scope() chain: ScopeChain) {
    return this.inventory.listReleases(chain.serviceId!);
  }

  @Post('services/:serviceId/releases')
  @RequirePermission('release:write')
  createRelease(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateReleaseDto) {
    return this.inventory.createRelease(user, chain, dto);
  }

  @Post('services/:serviceId/releases/sync')
  @RequirePermission('release:write')
  syncReleases(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.inventory.syncReleases(user, chain);
  }

  // ---- images
  @Get('services/:serviceId/images')
  @RequirePermission('service:read')
  images(@Scope() chain: ScopeChain) {
    return this.inventory.listImages(chain.serviceId!);
  }

  @Post('services/:serviceId/images')
  @RequirePermission('service:write')
  addImage(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateImageDto) {
    return this.inventory.addImage(user, chain, dto);
  }

  @Post('services/:serviceId/images/:imageId/sync')
  @RequirePermission('service:write')
  syncImage(@Scope() _chain: ScopeChain, @Param('imageId', ParseUUIDPipe) imageId: string) {
    return this.inventory.syncImage(imageId);
  }

  @Delete('services/:serviceId/images/:imageId')
  @RequirePermission('service:write')
  @HttpCode(204)
  async removeImage(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Param('imageId', ParseUUIDPipe) imageId: string) {
    await this.inventory.removeImage(user, chain, imageId);
  }

  // ---- deployments
  /** Joined inventory of a service: environments (what runs), releases (images, where), images (releases, where). */
  @Get('services/:serviceId/inventory')
  @RequirePermission('service:read')
  overview(@Scope() chain: ScopeChain) {
    return this.inventory.serviceOverview(chain.serviceId!);
  }

  @Get('services/:serviceId/deployments')
  @RequirePermission('service:read')
  deployments(@Scope() chain: ScopeChain) {
    return this.inventory.deploymentsOfService(chain.serviceId!);
  }

  /** CI/CD or the CLI: "version X is now running here". */
  @Post('environments/:environmentId/deployments')
  @RequirePermission('deployment:write')
  async record(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: RecordDeploymentDto) {
    if (user.token) {
      const [env] = await this.db.select({ slug: environments.slug, settings: environments.settings }).from(environments).where(eq(environments.id, chain.environmentId!)).limit(1);
      if (env?.settings.protected === true && !user.token.environments?.includes(env.slug)) throw new (await import('@nestjs/common')).ForbiddenException('Environment is protected: this CI token is not allowed to deploy to it');
    }
    return this.inventory.recordDeployment(user, chain, dto);
  }

  @Patch('environments/:environmentId/settings')
  @RequirePermission('environment:write')
  async settings(@Scope() chain: ScopeChain, @Body() dto: EnvironmentSettingsDto) {
    const [env] = await this.db.select().from(environments).where(eq(environments.id, chain.environmentId!)).limit(1);
    const settings = { ...(env?.settings ?? {}), ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) };
    const [after] = await this.db.update(environments).set({ settings }).where(eq(environments.id, chain.environmentId!)).returning();
    return after;
  }

  /** Runs a `kubernetes_inventory` job on a runner that can reach the cluster; its result becomes deployments. */
  @Post('environments/:environmentId/kubernetes-sync')
  @RequirePermission('deployment:write')
  async kubernetesSync(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    const [env] = await this.db.select().from(environments).where(eq(environments.id, chain.environmentId!)).limit(1);
    const namespace = env?.settings.kubernetesNamespace ? String(env.settings.kubernetesNamespace) : '';
    if (!namespace) throw new (await import('@nestjs/common')).BadRequestException('Set the Kubernetes namespace in the environment settings first');
    const serviceChain = { ...chain };
    return this.jobs.create(user, serviceChain, {
      type: 'kubernetes_inventory',
      requiredTags: [String(env!.settings.runnerTag ?? 'kubernetes')],
      payload: { namespace, context: env!.settings.kubernetesContext ?? null, environmentId: env!.id },
      timeoutSeconds: 300,
    });
  }

  @Get('projects/:projectId/inventory')
  @RequirePermission('project:read')
  summary(@Scope() chain: ScopeChain) {
    return this.inventory.projectSummary(chain.projectId!);
  }

  @Get('organizations/:organizationId/deployments')
  @RequirePermission('deployment:read')
  orgDeployments(@Scope() chain: ScopeChain) {
    return this.inventory.currentDeployments(chain.organizationId);
  }
}
