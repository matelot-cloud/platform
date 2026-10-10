import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { ScopeType } from '../../database/schema';

/** What a CI token may ever do. Reads are limited to what a pipeline needs to make decisions. */
export const CI_TOKEN_PERMISSIONS = ['release:write', 'deployment:write', 'job:create', 'job:read', 'service:read', 'environment:read', 'project:read', 'sbom:write', 'gate:evaluate', 'registry:push', 'registry:pull'] as const;
export type CiTokenPermission = (typeof CI_TOKEN_PERMISSIONS)[number];

export const CI_TOKEN_PRESETS: Record<string, { label: string; description: string; permissions: CiTokenPermission[] }> = {
  deploy: { label: 'Report releases and deployments', description: 'For the deploy job: record what was released and where it runs.', permissions: ['release:write', 'deployment:write', 'service:read', 'environment:read', 'project:read'] },
  registry: { label: 'Push and pull images (built-in registry)', description: 'For the build job: docker login to the platform registry with this token.', permissions: ['registry:push', 'registry:pull', 'service:read', 'project:read'] },
  pipeline: { label: 'Run security pipelines and gates', description: 'For the build job: start pipelines, read results, evaluate gates, upload SBOMs, push images.', permissions: ['job:create', 'job:read', 'sbom:write', 'gate:evaluate', 'registry:push', 'registry:pull', 'service:read', 'environment:read', 'project:read'] },
  full: { label: 'Everything a pipeline can do', description: 'Both of the above.', permissions: [...CI_TOKEN_PERMISSIONS] },
};

export class CreateTokenDto {
  @ApiProperty({ example: 'github-actions deploy' }) @IsString() @Length(1, 120) name: string;
  @ApiPropertyOptional({ enum: ['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT'], default: 'PROJECT' }) @IsOptional() @IsIn(['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT']) scopeType?: ScopeType;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() scopeId?: string;
  @ApiPropertyOptional({ enum: Object.keys(CI_TOKEN_PRESETS), default: 'deploy' }) @IsOptional() @IsIn(Object.keys(CI_TOKEN_PRESETS)) preset?: keyof typeof CI_TOKEN_PRESETS;
  @ApiPropertyOptional({ type: [String], description: 'Explicit permissions (subset of the CI set); overrides preset' }) @IsOptional() @IsArray() @IsIn(CI_TOKEN_PERMISSIONS, { each: true }) permissions?: CiTokenPermission[];
  @ApiPropertyOptional({ description: 'Days until expiry (1–365); omit for no expiry' }) @IsOptional() @IsInt() @Min(1) @Max(365) expiresInDays?: number;
  @ApiPropertyOptional({ type: [String], description: 'Environment slugs this token may deploy to (required for protected environments)' }) @IsOptional() @IsArray() @IsString({ each: true }) environments?: string[];
}
