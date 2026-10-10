import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { AuditService } from './audit.service';

export class ListAuditEventsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** Cursor: only events created before this ISO timestamp. */
  @IsOptional()
  @IsISO8601()
  before?: string;
}

@ApiTags('audit')
@ApiBearerAuth()
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('organizations/:organizationId/audit-events')
  @RequirePermission('audit:read')
  list(@Scope() chain: ScopeChain, @Query() query: ListAuditEventsQuery) {
    return this.audit.listForOrganization(
      chain.organizationId,
      query.limit,
      query.before ? new Date(query.before) : undefined,
    );
  }
}
