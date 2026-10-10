import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { AdminService } from './admin.service';
import { UpdateUserAdminDto } from './dto/admin.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  listUsers(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.listUsers(user);
  }

  @Patch('users/:userId')
  updateUser(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: UpdateUserAdminDto) {
    return this.admin.updateUser(user, userId, dto);
  }
}
