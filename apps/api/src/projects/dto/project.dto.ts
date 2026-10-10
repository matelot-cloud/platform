import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { NamedNodeDto } from '../../common/dto';
import { Criticality, criticalityEnum } from '../../database/schema';

export class CreateProjectDto extends NamedNodeDto {
  @ApiPropertyOptional({ enum: criticalityEnum.enumValues, default: 'MEDIUM' })
  @IsOptional()
  @IsIn(criticalityEnum.enumValues)
  criticality?: Criticality;
}

export class AutomationDto {
  @ApiPropertyOptional({ enum: ['default_branch', 'all', 'off'], description: 'Run the security pipeline when code is pushed' })
  @IsOptional()
  @IsIn(['default_branch', 'all', 'off'])
  pipelineOnPush?: 'default_branch' | 'all' | 'off';

  @ApiPropertyOptional({ description: 'Pipeline template to run (security, checkout)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  template?: string;
}

export class UpdateProjectDto extends PartialType(OmitType(CreateProjectDto, ['slug'] as const)) {
  @ApiPropertyOptional({ type: AutomationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AutomationDto)
  automation?: AutomationDto;
}
