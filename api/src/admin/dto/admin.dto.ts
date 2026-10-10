import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PlatformRole, platformRoleEnum } from '../../database/schema';

export class UpdateUserAdminDto {
  @ApiPropertyOptional({ enum: platformRoleEnum.enumValues })
  @IsOptional()
  @IsIn(platformRoleEnum.enumValues)
  platformRole?: PlatformRole;

  @ApiPropertyOptional({ description: 'false blocks the user from signing in' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
