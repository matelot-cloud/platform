import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { SLUG_MESSAGE, SLUG_REGEX } from '../config/slug';

/** Shared shape for named hierarchy nodes (workspace, team, project). */
export class NamedNodeDto {
  @ApiProperty({ example: 'payments', description: 'URL-safe identifier, unique within the parent' })
  @IsString()
  @Length(1, 63)
  @Matches(SLUG_REGEX, { message: `slug ${SLUG_MESSAGE}` })
  slug: string;

  @ApiProperty({ example: 'Payments' })
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
