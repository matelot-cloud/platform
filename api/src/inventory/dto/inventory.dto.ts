import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Length, MaxLength, IsInt, Max, Min } from 'class-validator';

export class CreateReleaseDto {
  @ApiProperty({ example: '4.2.0' }) @IsString() @Length(1, 100) version: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) tag?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) commitSha?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() repositoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() releasedAt?: string;
}

export class CreateImageDto {
  @ApiProperty({ example: 'ghcr.io/acme/payment-api' }) @IsString() @Length(1, 400) name: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Registry connection; omit for a public image' }) @IsOptional() @IsUUID() integrationId?: string;
  @ApiPropertyOptional({ description: 'Plain HTTP registry (local development only)' }) @IsOptional() @IsBoolean() insecure?: boolean;
}

export class RecordDeploymentDto {
  @ApiPropertyOptional({ description: 'Seconds to wait for the image SBOM and its correlation before policy enforcement (max 25 per call; clients loop)' }) @IsOptional() @IsInt() @Min(0) @Max(25) waitCorrelation?: number;
  @ApiPropertyOptional({ description: 'Version of the service (matches a release when it exists)' }) @IsOptional() @IsString() @MaxLength(100) version?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() releaseId?: string;
  @ApiPropertyOptional({ description: 'Image reference as deployed: name:tag or name@sha256:…' }) @IsOptional() @IsString() @MaxLength(600) imageRef?: string;
  @ApiPropertyOptional({ enum: ['api', 'cli', 'manual'] }) @IsOptional() @IsIn(['api', 'cli', 'manual']) source?: 'api' | 'cli' | 'manual';
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() deployedAt?: string;

  @ApiPropertyOptional({ description: 'Commit of the deployed build; used when the deployment creates the release' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  commitSha?: string;
}

export class EnvironmentSettingsDto {
  @ApiPropertyOptional({ example: 'payments-prod' }) @IsOptional() @IsString() @MaxLength(253) kubernetesNamespace?: string;
  @ApiPropertyOptional({ description: 'kubectl context name on the runner (optional)' }) @IsOptional() @IsString() @MaxLength(200) kubernetesContext?: string;
  @ApiPropertyOptional({ description: 'Runner tag that identifies runners with access to this cluster', example: 'kubernetes' }) @IsOptional() @IsString() @MaxLength(100) runnerTag?: string;
  @ApiPropertyOptional({ description: 'Protected: only CI tokens explicitly allowed for this environment can push/promote into it' }) @IsOptional() @IsBoolean() protected?: boolean;
}
