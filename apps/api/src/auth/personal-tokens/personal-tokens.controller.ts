import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import type { AuthenticatedUser } from '../authenticated-user';
import { CurrentUser } from '../current-user.decorator';
import { PersonalTokensService, PersonalTokenScope } from './personal-tokens.service';

class CreatePersonalTokenDto {
  @IsString() @MaxLength(100) name: string;
  @IsIn(['read', 'write', 'sudo']) scope: PersonalTokenScope;
  @IsInt() @Min(1) @Max(365) expiresInDays: number;
}

@ApiTags('me')
@ApiBearerAuth()
@Controller('me/tokens')
export class PersonalTokensController {
  constructor(private readonly tokens: PersonalTokensService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    return { tokens: await this.tokens.list(user), canCreateSudo: await this.tokens.isAdmin(user) };
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePersonalTokenDto) {
    return this.tokens.create(user, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tokens.revoke(user, id);
  }
}
