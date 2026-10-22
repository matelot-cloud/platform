import { Body, Controller, HttpCode, Post, Headers, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { BackupReportsService } from './backup-reports.service';

export class BackupReportDto {
  @IsIn(['succeeded', 'failed']) status: 'succeeded' | 'failed';
  @IsOptional() @IsIn(['dump', 'upload']) step?: string;
  @IsOptional() @IsInt() @Min(0) startedAt?: number;
  @IsOptional() @IsString() @MaxLength(300) archive?: string;
  @IsOptional() @IsNumber() @Min(0) bytes?: number;
  @IsOptional() @IsString() @MaxLength(300) destination?: string;
  @IsOptional() @IsString() @MaxLength(2000) error?: string;
}

/**
 * The backup job's report of each run (files/backup-report.sh). Not a user API: authenticated with the cell-local
 * BACKUP_REPORT_TOKEN (generated, in <release>-api-secrets / Compose secrets/api), reached on the cluster network only.
 */
@ApiExcludeController()
@Controller('internal/backup-reports')
export class BackupReportsController {
  constructor(private readonly reports: BackupReportsService) {}

  @Public()
  @Post()
  @HttpCode(202)
  async report(@Headers('authorization') authorization: string | undefined, @Body() dto: BackupReportDto) {
    if (!this.reports.isTokenValid(authorization)) throw new UnauthorizedException('Invalid backup report token');
    const row = await this.reports.record(dto);
    return { id: row.id, status: row.status };
  }
}
