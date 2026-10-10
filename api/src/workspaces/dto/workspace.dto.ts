import { OmitType, PartialType } from '@nestjs/swagger';
import { NamedNodeDto } from '../../common/dto';

export class CreateWorkspaceDto extends NamedNodeDto {}
export class UpdateWorkspaceDto extends PartialType(OmitType(CreateWorkspaceDto, ['slug'] as const)) {}
