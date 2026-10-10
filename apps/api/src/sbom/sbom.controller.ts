import { Inject, Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { projectIdsForChain } from '../rbac/scope-projects';
import { DATABASE, Database } from '../database/database.module';
import { ScopeChain } from '../rbac/scope.types';
import { UploadSbomDto } from './dto/sbom.dto';
import { SbomService } from './sbom.service';

@ApiTags('sbom')
@ApiBearerAuth()
@Controller()
export class SbomController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly sbom: SbomService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /** CI upload: the pipeline generated the SBOM itself (e.g. Syft with its own registry access). */
  @Post('services/:serviceId/sboms')
  @RequirePermission('sbom:write')
  upload(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: UploadSbomDto) {
    return this.sbom.ingest({
      organizationId: chain.organizationId,
      serviceId: chain.serviceId!,
      source: 'ci_upload',
      target: dto.target,
      targetRef: dto.targetRef ?? (dto.target === 'image' ? (dto.imageRef ?? 'image') : dto.version ? `source@${dto.version}` : 'source'),
      document: dto.document,
      releaseVersion: dto.version ?? null,
      imageRef: dto.imageRef ?? null,
      createdBy: user,
    });
  }

  @Get('services/:serviceId/sboms')
  @RequirePermission('sbom:read')
  list(@Scope() chain: ScopeChain) {
    return this.sbom.listForService(chain.serviceId!);
  }

  @Get('sboms/:sbomId')
  async get(@CurrentUser() user: AuthenticatedUser, @Param('sbomId', ParseUUIDPipe) sbomId: string, @Query('q') q?: string) {
    const sbom = await this.assert(user, sbomId);
    const { rawGz: _r, ...rest } = sbom;
    return { ...rest, components: await this.sbom.componentsOf(sbomId, q) };
  }

  @Get('sboms/:sbomId/download')
  @Header('Content-Type', 'application/json')
  async download(@CurrentUser() user: AuthenticatedUser, @Param('sbomId', ParseUUIDPipe) sbomId: string) {
    await this.assert(user, sbomId);
    return (await this.sbom.raw(sbomId)).toString('utf8');
  }

  @Get('sboms/:from/diff/:to')
  async diff(@CurrentUser() user: AuthenticatedUser, @Param('from', ParseUUIDPipe) from: string, @Param('to', ParseUUIDPipe) to: string) {
    const a = await this.assert(user, from);
    const b = await this.assert(user, to);
    return { from: { id: a.id, targetRef: a.targetRef }, to: { id: b.id, targetRef: b.targetRef }, ...(await this.sbom.diff(from, to)) };
  }

  /** Organization-wide component search: "which services contain lodash 4.17.20?" */
  @Get(['workspaces/:workspaceId/components', 'teams/:teamId/components', 'projects/:projectId/components'])
  @RequirePermission('sbom:read')
  async scopedComponents(@Scope() chain: ScopeChain, @Query('q') q?: string, @Query('team') team?: string) {
    return this.sbom.search(chain.organizationId, q ?? '', 200, await projectIdsForChain(this.db, team ? ({ ...chain, teamId: team, projectId: undefined } as ScopeChain) : chain));
  }

  @Get('organizations/:organizationId/components')
  @RequirePermission('sbom:read')
  search(@Scope() chain: ScopeChain, @Query('q') q = '') {
    if (q.trim().length < 2) return [];
    return this.sbom.search(chain.organizationId, q.trim());
  }

  @Get('projects/:projectId/sbom-summary')
  @RequirePermission('project:read')
  summary(@Scope() chain: ScopeChain) {
    return this.sbom.projectSummary(chain.projectId!);
  }

  private async assert(user: AuthenticatedUser, sbomId: string) {
    const sbom = await this.sbom.get(sbomId);
    const chain = await this.resolver.resolveChain({ serviceId: sbom.serviceId });
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, 'sbom:read', chain);
    return sbom;
  }
}
