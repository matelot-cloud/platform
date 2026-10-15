import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { CompleteInviteDto } from './dto/members.dto';
import { InvitesService } from './invites.service';

/** One-time setup links (invites, password resets): reachable without signing in, the token is the credential. */
@ApiTags('members')
@Controller('invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Public()
  @Get(':token')
  describe(@Param('token') token: string) {
    return this.invites.describe(token);
  }

  @Public()
  @Post(':token')
  @HttpCode(200)
  complete(@Param('token') token: string, @Body() dto: CompleteInviteDto) {
    return this.invites.complete(token, dto.password);
  }
}
