import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { UsageService } from './usage.service';

export class UsageQuery {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month?: string;

  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}

@ApiTags('usage')
@ApiBearerAuth()
@Controller()
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  /** Usage of the organization for a month (default: the current one) with 12 months of history; `format=csv` exports the history. */
  @Get('organizations/:organizationId/usage')
  @RequirePermission('audit:read')
  async get(@Scope() chain: ScopeChain, @Query() query: UsageQuery, @Res({ passthrough: true }) res: { setHeader: (k: string, v: string) => void }) {
    const report = await this.usage.report(chain.organizationId, query.month);
    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="usage-${report.month}.csv"`);
      return this.usage.toCsv(report.history);
    }
    return report;
  }
}

