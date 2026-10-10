import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Length, Matches } from 'class-validator';
import { SLUG_MESSAGE, SLUG_REGEX } from '../../config/slug';

export class CreateOrganizationDto {
  @ApiProperty({ format: 'uuid', description: 'Parent organization (subsidiary / MSSP customer model)' })
  @IsUUID()
  parentId: string;

  @ApiProperty({ example: 'acme-iot' })
  @IsString()
  @Length(1, 63)
  @Matches(SLUG_REGEX, { message: `slug ${SLUG_MESSAGE}` })
  slug: string;

  @ApiProperty({ example: 'ACME IoT GmbH' })
  @IsString()
  @Length(1, 120)
  name: string;
}

export class UpdateOrganizationDto {
  @ApiProperty({ example: 'ACME Corporation' })
  @IsString()
  @Length(1, 120)
  name: string;
}
