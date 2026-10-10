import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, ConflictException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsString } from 'class-validator';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeChain } from '../rbac/scope.types';
import { EvidenceService } from './evidence.service';
import { ReadinessService } from './readiness.service';
import { DATABASE, Database } from '../database/database.module';
import { Inject } from '@nestjs/common';
import { releases, services } from '../database/schema';
import { eq, inArray } from 'drizzle-orm';
import { projectIdsForChain } from '../rbac/scope-projects';

class VerifyDto { @IsString() checksums: string; @IsString() signature: string; @IsObject() fileHashes: Record<string, string> }

@ApiTags('cra')
@ApiBearerAuth()
@Controller()
export class CraController {
  constructor(
    private readonly evidence: EvidenceService,
    private readonly readiness: ReadinessService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /** Evidence summary (JSON) for a release. */
  @Get('releases/:releaseId/evidence')
  async summary(@CurrentUser() user: AuthenticatedUser, @Param('releaseId', ParseUUIDPipe) id: string) {
    await this.assertRelease(user, id);
    return this.evidence.summary(id);
  }

  /** Evidence and VEX of a release whose SBOMs are not correlated would certify "no findings" that nobody checked. */
  private async assertCorrelated(releaseId: string, allow?: string) {
    const s = await this.evidence.summary(releaseId);
    if (s.correlation.status === 'done' || s.correlation.status === 'none' || allow === 'true') return;
    throw new ConflictException(`Release SBOM correlation is ${s.correlation.status}: evidence would not reflect its findings. Wait for correlation (or re-run it), or pass ?allowUncorrelated=true to export anyway.`);
  }

  /** Evidence bundle (.zip): manifest, findings, gate, deployments, SBOMs, evidence.md, signed checksums. */
  @Get('releases/:releaseId/evidence.zip')
  async bundle(@CurrentUser() user: AuthenticatedUser, @Param('releaseId', ParseUUIDPipe) id: string, @Res() res: Response, @Query('allowUncorrelated') allow?: string) {
    await this.assertRelease(user, id);
    await this.assertCorrelated(id, allow);
    const { filename, data } = await this.evidence.bundle(user, id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(data.length));
    res.end(data);
  }

  /** OpenVEX document of a release's decisions. */
  @Get('releases/:releaseId/vex')
  async vex(@CurrentUser() user: AuthenticatedUser, @Param('releaseId', ParseUUIDPipe) id: string, @Query('allowUncorrelated') allow?: string) {
    await this.assertRelease(user, id);
    await this.assertCorrelated(id, allow);
    return this.evidence.vex(id);
  }

  /** Verify a bundle's checksums.txt / checksums.sig (computed client-side hashes of the files). */
  @Post('evidence/verify')
  verify(@Body() dto: VerifyDto) {
    return this.evidence.verify(dto.checksums, dto.signature, dto.fileHashes);
  }

  @Get('services/:serviceId/cra/readiness')
  @RequirePermission('service:read')
  readinessService(@Scope() chain: ScopeChain) {
    return this.readiness.forService(chain.serviceId!);
  }

  @Get('projects/:projectId/cra/readiness')
  @RequirePermission('service:read')
  async readinessProject(@Scope() chain: ScopeChain) {
    const svc = await this.db.select({ id: services.id }).from(services).where(eq(services.projectId, chain.projectId!));
    return Promise.all(svc.map((s) => this.readiness.forService(s.id)));
  }

  @Get(['workspaces/:workspaceId/cra/readiness', 'teams/:teamId/cra/readiness'])
  @RequirePermission('service:read')
  async readinessScoped(@Scope() chain: ScopeChain, @Query('team') team?: string) {
    const scope = await projectIdsForChain(this.db, team ? ({ ...chain, teamId: team, projectId: undefined } as ScopeChain) : chain);
    const ids = Array.isArray(scope) ? scope : scope ? [scope] : [];
    if (!ids.length) return [];
    const svc = await this.db.select({ id: services.id }).from(services).where(inArray(services.projectId, ids));
    return Promise.all(svc.map((s) => this.readiness.forService(s.id)));
  }

  private async assertRelease(user: AuthenticatedUser, releaseId: string) {
    const [r] = await this.db.select({ serviceId: releases.serviceId }).from(releases).where(eq(releases.id, releaseId)).limit(1);
    if (!r) throw new Error('Release not found');
    const chain = await this.resolver.resolveChain({ serviceId: r.serviceId });
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, 'sbom:read', chain);
  }
}
