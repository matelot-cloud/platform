import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { userActor } from '../audit/audit.types';
import { AuditService } from '../audit/audit.service';

class PromoteDto {
  @IsString() @Length(1, 128) tag: string;
  /** Commit the image was built from: recorded on the release when it has none. */
  @IsOptional() @IsString() @Length(7, 64) commit?: string;
}
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { parseScopes } from './registry-token';
import { RegistryEvent, RegistryService } from './registry.service';

@ApiTags('registry')
@Controller()
export class RegistryController {
  constructor(
    private readonly registry: RegistryService,
    private readonly audit: AuditService,
  ) {}

  /** For the UI: is there a built-in registry, where, and how to log in. */
  /** Read the built-in registry now and reconcile inventory + deployments (admins). */
  @Post('organizations/:organizationId/registry/reconcile')
  @RequirePermission('integration:write')
  reconcileNow(@Scope() chain: ScopeChain) {
    void chain;
    return this.registry.reconcile();
  }

  @Get('registry/info')
  info() {
    return this.registry.info();
  }

  /** Docker Distribution token endpoint (the registry redirects clients here). */
  @Public()
  @Get('registry/token')
  @ApiExcludeEndpoint()
  token(@Headers('authorization') authorization: string | undefined, @Query('scope') scope: string | string[] | undefined, @Query('service') _service?: string) {
    return this.registry.token(authorization, parseScopes(scope));
  }

  /** Registry push notifications (Distribution `notifications.endpoints`), secured by a shared secret. */
  @Public()
  @Post('registry/events')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async events(@Headers('authorization') authorization: string | undefined, @Body() body: { events?: RegistryEvent[] }) {
    if (!this.registry.isEventsSecretValid(authorization)) throw new UnauthorizedException('Invalid registry events secret');
    return this.registry.handleEvents(body.events ?? []);
  }

  /** The build repository of a service (CI pushes here). */
  @Get('services/:serviceId/registry')
  @ApiBearerAuth()
  @RequirePermission('service:read')
  async serviceRegistry(@Scope() chain: ScopeChain) {
    const info = await this.registry.serviceRepository(chain.serviceId!);
    if (!info) return { available: false };
    return { available: true, host: info.host, repository: info.repository, image: `${info.host}/${info.repository}`, environments: info.environments };
  }

  /** Where an environment's images live and how to pull/push them. */
  @Get('environments/:environmentId/registry')
  @ApiBearerAuth()
  @RequirePermission('environment:read')
  async environmentRegistry(@Scope() chain: ScopeChain) {
    const repo = await this.registry.environmentRepository(chain.environmentId!);
    if (!repo) return { available: false };
    return { available: true, host: repo.host, repository: repo.repository, build: repo.build, protected: repo.protected, pull: `docker pull ${repo.host}/${repo.repository}:<tag>`, push: `docker push ${repo.host}/${repo.repository}:<tag>` };
  }

  /** Promote a build image (<project>/<service>:<tag>) into this environment: copies it in the registry and records the deployment. */
  @Post('environments/:environmentId/promote')
  @ApiBearerAuth()
  @RequirePermission('deployment:write')
  async promote(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: PromoteDto) {
    const repo = await this.registry.environmentRepository(chain.environmentId!);
    if (repo?.protected && user.token && !user.token.environments?.includes(repo.repository.split('/').pop()!)) throw new BadRequestException(`Environment is protected: this CI token is not allowed to deploy to it`);
    try {
      const result = await this.registry.promote(chain.serviceId!, dto.tag, chain.environmentId!);
      if (dto.commit) await this.registry.recordReleaseCommit(chain.serviceId!, dto.tag, result.digest, dto.commit);
      await this.audit.record({ organizationId: chain.organizationId, actor: userActor(user), action: 'image.promoted', resourceType: 'environment', resourceId: chain.environmentId!, after: result });
      return result;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }
}
