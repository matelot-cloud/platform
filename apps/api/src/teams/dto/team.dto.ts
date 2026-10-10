import { OmitType, PartialType } from '@nestjs/swagger';
import { NamedNodeDto } from '../../common/dto';

export class CreateTeamDto extends NamedNodeDto {}
export class UpdateTeamDto extends PartialType(OmitType(CreateTeamDto, ['slug'] as const)) {}
