import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { SLUG_MESSAGE, SLUG_REGEX } from '../../config/slug';
import { EnvironmentKind, environmentKindEnum } from '../../database/schema';

export class CreateEnvironmentDto {
  @ApiProperty({ example: 'production' })
  @IsString()
  @Length(1, 63)
  @Matches(SLUG_REGEX, { message: `slug ${SLUG_MESSAGE}` })
  slug: string;

  @ApiProperty({ example: 'Production' })
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiProperty({ enum: environmentKindEnum.enumValues })
  @IsIn(environmentKindEnum.enumValues)
  kind: EnvironmentKind;

  @ApiPropertyOptional({ default: false, description: 'Reachable from the internet (risk-engine input)' })
  @IsOptional()
  @IsBoolean()
  internetFacing?: boolean;
}

export class UpdateEnvironmentDto extends PartialType(OmitType(CreateEnvironmentDto, ['slug'] as const)) {}
