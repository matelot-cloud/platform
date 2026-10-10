import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Role, roleEnum, ScopeType, scopeTypeEnum } from '../../database/schema';

export class GrantMembershipDto {
  @ApiProperty({ example: 'jane@acme.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ enum: roleEnum.enumValues })
  @IsIn(roleEnum.enumValues)
  role: Role;

  @ApiProperty({ enum: scopeTypeEnum.enumValues })
  @IsIn(scopeTypeEnum.enumValues)
  scopeType: ScopeType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  scopeId: string;

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
