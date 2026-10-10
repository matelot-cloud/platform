import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { NamedNodeDto } from '../../common/dto';
import { Criticality, criticalityEnum, ServiceKind, serviceKindEnum } from '../../database/schema';

export class CreateServiceDto extends NamedNodeDto {
  @ApiPropertyOptional({ enum: serviceKindEnum.enumValues, default: 'other' })
  @IsOptional()
  @IsIn(serviceKindEnum.enumValues)
  kind?: ServiceKind;

  @ApiPropertyOptional({ enum: criticalityEnum.enumValues, description: 'Omit to inherit the project criticality' })
  @IsOptional()
  @IsIn(criticalityEnum.enumValues)
  criticality?: Criticality;
}

export class UpdateServiceDto extends PartialType(OmitType(CreateServiceDto, ['slug'] as const)) {}
