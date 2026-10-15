import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Role, roleEnum, ScopeType, scopeTypeEnum } from '../../database/schema';

export class GrantMembershipDto {
  @ApiProperty({ example: 'jane@acme.com', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ format: 'uuid', required: false, description: 'An existing user (e.g. a service account) instead of an e-mail' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiProperty({ enum: roleEnum.enumValues })
  @IsIn(roleEnum.enumValues)
  role: Role;

  @ApiProperty({ enum: scopeTypeEnum.enumValues })
  @IsIn(scopeTypeEnum.enumValues)
  scopeType: ScopeType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  scopeId: string;

  @ApiProperty({ required: false, description: 'YYYY-MM-DD or ISO timestamp; the membership stops applying then' })
  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListMembershipsQuery {
  @ApiProperty({ enum: scopeTypeEnum.enumValues })
  @IsIn(scopeTypeEnum.enumValues)
  scopeType: ScopeType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  scopeId: string;
}
