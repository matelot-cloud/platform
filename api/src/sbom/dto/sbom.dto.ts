import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UploadSbomDto {
  @ApiProperty({ enum: ['source', 'image', 'artifact'] }) @IsIn(['source', 'image', 'artifact']) target: 'source' | 'image' | 'artifact';
  @ApiPropertyOptional({ description: 'repo@ref, image reference or artifact name; defaults from version/imageRef' }) @IsOptional() @IsString() @MaxLength(600) targetRef?: string;
  @ApiPropertyOptional({ description: 'Release version this SBOM describes' }) @IsOptional() @IsString() @MaxLength(100) version?: string;
  @ApiPropertyOptional({ description: 'Image reference (name:tag or name@digest) when target is image' }) @IsOptional() @IsString() @MaxLength(600) imageRef?: string;
  @ApiProperty({ description: 'The CycloneDX or SPDX JSON document' }) @IsObject() document: Record<string, unknown>;
}
