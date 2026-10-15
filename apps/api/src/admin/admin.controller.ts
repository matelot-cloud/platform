import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateUserDto, ReasonQuery, ResetPasswordDto } from '../iam/dto/members.dto';
import { UserAdminService } from '../iam/user-admin.service';
import { UpdateUserAdminDto } from './dto/admin.dto';

class ListUsersQuery {
  @IsOptional() @IsIn(['human', 'service_account']) kind?: string;
}

/** Administration → Users (cell administrators and admins of the root organization; with a token: sudo). */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly users: UserAdminService) {}

  @Get('users')
  listUsers(@CurrentUser() user: AuthenticatedUser, @Query() q: ListUsersQuery) {
    return this.users.list(user, q.kind);
  }

  /** What this cell can do for user administration: Keycloak admin API, e-mail, cell-role changes by the caller. */
  @Get('users/capabilities')
  capabilities(@CurrentUser() user: AuthenticatedUser) {
    return this.users.capabilities(user);
  }

  @Get('users/:userId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.users.detail(user, userId);
  }

  @Post('users')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUserDto) {
    return this.users.create(user, dto);
  }

  @Patch('users/:userId')
  updateUser(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: UpdateUserAdminDto) {
    return this.users.update(user, userId, dto);
  }

  @Post('users/:userId/reset-password')
  @HttpCode(200)
  resetPassword(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: ResetPasswordDto) {
    return this.users.resetPassword(user, userId, dto);
  }

  @Delete('users/:userId')
  @HttpCode(200)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseUUIDPipe) userId: string, @Query() q: ReasonQuery) {
    return this.users.remove(user, userId, q.reason);
  }
}
