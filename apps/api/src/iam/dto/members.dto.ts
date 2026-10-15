import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Role, roleEnum, ScopeType, scopeTypeEnum } from '../../database/schema';

const MEMBER_SCOPE_TYPES = ['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT'] as const;

export class ScopeQuery {
  @ApiProperty({ enum: MEMBER_SCOPE_TYPES }) @IsIn(MEMBER_SCOPE_TYPES) scopeType: ScopeType;
  @ApiProperty({ format: 'uuid' }) @IsUUID() scopeId: string;
}

export class CandidatesQuery extends ScopeQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) q?: string;
}

export class AddMembersDto extends ScopeQuery {
  @ApiProperty({ enum: roleEnum.enumValues }) @IsIn(roleEnum.enumValues) role: Role;
  @ApiPropertyOptional({ type: [String], description: 'Existing users (people or service accounts of this scope)' })
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) userIds?: string[];
  @ApiPropertyOptional({ type: [String], description: 'E-mail addresses; unknown ones are invited' })
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsEmail({}, { each: true }) emails?: string[];
  @ApiPropertyOptional({ description: 'YYYY-MM-DD or ISO timestamp' }) @IsOptional() @IsString() expiresAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: roleEnum.enumValues }) @IsOptional() @IsIn(roleEnum.enumValues) role?: Role;
  @ApiPropertyOptional({ nullable: true, description: 'YYYY-MM-DD / ISO; null clears the expiry' })
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() expiresAt?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ReasonQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class CreateServiceAccountDto extends ScopeQuery {
  @ApiProperty({ example: 'Jira sync' }) @IsString() @MaxLength(100) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional({ enum: roleEnum.enumValues, description: 'Membership at the owning scope (optional; can be added later)' })
  @IsOptional() @IsIn(roleEnum.enumValues) role?: Role;
  @ApiPropertyOptional() @IsOptional() @IsString() expiresAt?: string;
}

export class ServiceAccountTokenDto {
  @ApiProperty() @IsString() @MaxLength(100) name: string;
  @ApiProperty({ enum: ['read', 'write'] }) @IsIn(['read', 'write']) scope: 'read' | 'write';
  @ApiPropertyOptional({ minimum: 1, maximum: 3650 }) @IsOptional() @IsInt() @Min(1) @Max(3650) expiresInDays?: number;
}

export class ScopeAccessTokenDto extends ScopeQuery {
  @ApiProperty({ example: 'Renovate' }) @IsString() @MaxLength(100) name: string;
  @ApiProperty({ enum: roleEnum.enumValues }) @IsIn(roleEnum.enumValues) role: Role;
  @ApiProperty({ enum: ['read', 'write'] }) @IsIn(['read', 'write']) scope: 'read' | 'write';
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(3650) expiresInDays?: number;
}

export class ToggleDto {
  @ApiProperty() @IsIn([true, false]) disabled: boolean;
}

export class CreateUserDto {
  @ApiProperty() @IsEmail() email: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @ApiPropertyOptional({ description: 'Set a temporary password (changed at first login); without it a one-time setup link is issued' })
  @IsOptional() @IsString() @MaxLength(200) temporaryPassword?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ResetPasswordDto {
  @ApiPropertyOptional({ description: 'Temporary password; without it a one-time reset link is issued' })
  @IsOptional() @IsString() @MaxLength(200) temporaryPassword?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class CompleteInviteDto {
  @ApiProperty() @IsString() @MaxLength(200) password: string;
}

export { scopeTypeEnum };
