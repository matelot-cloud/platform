import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { repositoryRoleEnum } from '../../database/schema';

export class AttachRepositoryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  repositoryId: string;

  @ApiPropertyOptional({ enum: repositoryRoleEnum.enumValues, default: 'primary' })
  @IsOptional()
  @IsIn(repositoryRoleEnum.enumValues)
  role?: (typeof repositoryRoleEnum.enumValues)[number];
}
