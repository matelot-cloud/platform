import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { COVERAGE_CHECKS, CoverageService, parseDays, parseGap } from './coverage.service';

export class CoverageQuery {
  /** Window for "security pipeline finished recently" (1–365, default 30). */
  @IsOptional()
  @Matches(/^\d{1,3}$/, { message: 'days must be a whole number between 1 and 365' })
  days?: string;

  /** Only services with this gap. */
  @IsOptional()
  @IsIn([...COVERAGE_CHECKS])
  gap?: string;

  /** Project: only services with at least one gap. */
  @IsOptional()
  @IsIn(['true', 'false', '1', '0'])
  uncovered?: string;

  @IsOptional()
  @Matches(/^\d{1,4}$/)
  limit?: string;
}

@ApiTags('coverage')
@ApiBearerAuth()
@Controller()
export class CoverageController {
  constructor(private readonly coverage: CoverageService) {}

  /** Service coverage of a project: per service, repository · security pipeline in the last N days · SBOM · policy · deployment. */
  @Get('projects/:projectId/coverage')
  @RequirePermission('project:read')
  project(@Scope() chain: ScopeChain, @Query() q: CoverageQuery) {
    return this.coverage.forProject(chain.target.id, { days: parseDays(q.days), gap: parseGap(q.gap), uncovered: q.uncovered === 'true' || q.uncovered === '1' });
  }

  /** Organization-wide coverage summary over the projects you can read, and the services with a gap (filter with `gap`). */
  @Get('organizations/:organizationId/coverage')
  @RequirePermission('organization:read')
  organization(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Query() q: CoverageQuery) {
    return this.coverage.forOrganization(user, chain, { days: parseDays(q.days), gap: parseGap(q.gap), limit: q.limit ? Number(q.limit) : undefined });
  }
}
