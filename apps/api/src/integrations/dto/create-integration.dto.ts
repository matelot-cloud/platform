import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, IsUUID, Length, MaxLength, ValidateNested } from 'class-validator';
import { ScopeType, scopeTypeEnum } from '../../database/schema';

export class IntegrationAuthDto {
  @ApiProperty({ enum: ['none', 'token', 'basic', 'ssh', 'app', 'aws', 'azure', 'gcp', 'gcp_wif', 'aws_wif', 'azure_wif'], description: '*_wif = keyless (workload identity federation): the cell exchanges its own OIDC token at the cloud; no secret is stored' })
  @IsIn(['none', 'token', 'basic', 'ssh', 'app', 'aws', 'azure', 'gcp', 'gcp_wif', 'aws_wif', 'azure_wif'])
  type: 'none' | 'token' | 'basic' | 'ssh' | 'app' | 'aws' | 'azure' | 'gcp' | 'gcp_wif' | 'aws_wif' | 'azure_wif';

  @ApiPropertyOptional({ description: 'GitHub App: App ID' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  appId?: string;

  @ApiPropertyOptional({ description: 'GitHub App: slug (github.com/apps/<slug>)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  slug?: string;

  @ApiPropertyOptional({ description: 'GitHub App: webhook secret' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  webhookSecret?: string;

  @ApiPropertyOptional({ description: 'Personal / project access token' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  token?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  password?: string;

  @ApiPropertyOptional({ description: 'SSH: let the platform generate the key pair; the public key is returned to add as a deploy key' })
  @IsOptional()
  @IsBoolean()
  generateKey?: boolean;

  @ApiPropertyOptional({ description: 'Private key (PEM / OpenSSH), no passphrase' })
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  privateKey?: string;

  @ApiPropertyOptional({ description: 'AWS ECR: access key id of an IAM user/role with ecr:GetAuthorizationToken + pull (and push if needed)' }) @IsOptional() @IsString() @MaxLength(128) accessKeyId?: string;
  @ApiPropertyOptional({ description: 'AWS ECR: secret access key' }) @IsOptional() @IsString() @MaxLength(256) secretAccessKey?: string;
  @ApiPropertyOptional({ description: 'AWS ECR: region, e.g. eu-central-1' }) @IsOptional() @IsString() @MaxLength(32) region?: string;
  @ApiPropertyOptional({ description: 'Azure ACR: tenant id of the service principal' }) @IsOptional() @IsString() @MaxLength(64) tenantId?: string;
  @ApiPropertyOptional({ description: 'Azure ACR: client (application) id of the service principal' }) @IsOptional() @IsString() @MaxLength(64) clientId?: string;
  @ApiPropertyOptional({ description: 'Azure ACR: client secret of the service principal' }) @IsOptional() @IsString() @MaxLength(512) clientSecret?: string;
  @ApiPropertyOptional({ description: 'gcp_wif: workload identity pool provider (projects/NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER)' }) @IsOptional() @IsString() @MaxLength(400) provider?: string;
  @ApiPropertyOptional({ description: 'gcp_wif: service account e-mail to impersonate' }) @IsOptional() @IsString() @MaxLength(200) serviceAccount?: string;
  @ApiPropertyOptional({ description: 'aws_wif: IAM role ARN that trusts this cell (OIDC provider = API_PUBLIC_URL, sub = integration:<id>)' }) @IsOptional() @IsString() @MaxLength(400) roleArn?: string;
  @ApiPropertyOptional({ description: 'Google Artifact Registry / GCR: service-account key file content (JSON)' }) @IsOptional() @IsString() serviceAccountJson?: string;
}

export class ScopeDto {
  @ApiProperty({ enum: ['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT'] })
  @IsIn(scopeTypeEnum.enumValues)
  scopeType: ScopeType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  scopeId: string;
}

export class CreateIntegrationDto {
  @ApiPropertyOptional({ enum: ['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT'], description: 'Level the connection lives at (default: the organization)' })
  @IsOptional()
  @IsIn(['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT'])
  scopeType?: 'ORGANIZATION' | 'WORKSPACE' | 'TEAM' | 'PROJECT';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  scopeId?: string;

  @ApiProperty({ enum: ['github', 'github_token', 'gitlab', 'git', 'registry', 'jira', 'bitbucket', 'matelot'] })
  @IsIn(['github', 'github_token', 'gitlab', 'git', 'registry', 'jira', 'bitbucket', 'matelot'])
  provider: 'github' | 'github_token' | 'gitlab' | 'git' | 'registry' | 'jira' | 'bitbucket' | 'matelot';

  @ApiProperty({ example: 'GitLab · payments group' })
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiPropertyOptional({ description: 'GitLab base URL (default https://gitlab.com) or GitHub API URL' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'GitHub organization/user or GitLab group path to limit the inventory' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  owner?: string;

  @ApiPropertyOptional({ description: 'For provider git: the repository URL (https://… or git@host:group/repo.git)' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  repositoryUrl?: string;

  @ApiProperty({ type: IntegrationAuthDto })
  @ValidateNested()
  @Type(() => IntegrationAuthDto)
  auth: IntegrationAuthDto;
}
