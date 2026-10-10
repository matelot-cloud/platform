import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { SLUG_REGEX } from '../../config/slug';
import { JobStatus, jobTypeEnum, ScopeType } from '../../database/schema';

export class CreatePoolDto {
  @ApiPropertyOptional({ enum: ['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT'] })
  @IsOptional()
  @IsIn(['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT'])
  scopeType?: ScopeType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  scopeId?: string;

  @ApiProperty({ example: 'default' })
  @IsString()
  @Matches(SLUG_REGEX)
  @Length(1, 63)
  slug: string;

  @ApiProperty({ example: 'Default pool' })
  @IsString()
  @Length(1, 120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ type: [String], example: ['linux', 'docker'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class RegisterRunnerDto {
  /** From the Runners page (self-hosted runners). Either this or managedSecret. */
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(10, 200) registrationToken?: string;
  /** The cell's managed runners (Helm chart): MANAGED_RUNNER_SECRET. */
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(32, 400) managedSecret?: string;
  @ApiProperty() @IsString() @Length(1, 120) name: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) version?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class HeartbeatDto {
  @ApiPropertyOptional({ enum: ['online', 'draining'] }) @IsOptional() @IsIn(['online', 'draining']) status?: 'online' | 'draining';
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class ClaimDto {
  @ApiPropertyOptional({ description: 'Seconds to wait for a job (long poll), max 25' }) @IsOptional() @IsInt() @Min(0) @Max(25) waitSeconds?: number;
}

export class LogChunkDto {
  @IsInt() @Min(0) seq: number;
  @IsOptional() @IsIn(['stdout', 'stderr', 'system']) stream?: 'stdout' | 'stderr' | 'system';
  @IsString() @MaxLength(64_000) content: string;
}

export class AppendLogsDto {
  @IsArray() chunks: LogChunkDto[];
}

export class CompleteJobDto {
  @ApiProperty({ enum: ['succeeded', 'failed', 'skipped'] }) @IsIn(['succeeded', 'failed', 'skipped']) status: Extract<JobStatus, 'succeeded' | 'failed' | 'skipped'>;
  @IsOptional() @IsObject() result?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(4000) error?: string;
  @IsOptional() @IsInt() exitCode?: number;
}

export class CreateJobDto {
  @ApiProperty({ enum: jobTypeEnum.enumValues, default: 'repository_check' })
  @IsIn(jobTypeEnum.enumValues)
  type: (typeof jobTypeEnum.enumValues)[number];

  @ApiPropertyOptional({ format: 'uuid', description: 'Repository to work on (defaults to the primary repository of the service)' })
  @IsOptional()
  @IsUUID()
  repositoryId?: string;

  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) requiredTags?: string[];
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() poolId?: string;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(30) @Max(21600) timeoutSeconds?: number;
}

export class CreatePipelineDto {
  @ApiPropertyOptional({ description: 'Built-in template key (security, checkout). Default: security' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  template?: string;

  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() repositoryId?: string;
  @ApiPropertyOptional({ description: 'Branch or tag; default: the repository default branch' }) @IsOptional() @IsString() @MaxLength(200) ref?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) requiredTags?: string[];
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() poolId?: string;
}
