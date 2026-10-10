import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { OnboardingService } from './onboarding.service';

@ApiTags('onboarding')
@ApiBearerAuth()
@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  /** "Get started" checklist: each step's state computed from what exists, with where to do it (web path, CLI). */
  @Get('organizations/:organizationId/onboarding')
  @RequirePermission('organization:read')
  async status(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.onboarding.status(chain.organizationId, { canManage: await this.onboarding.canManage(user, chain) });
  }

  /** Hide the checklist on the Overview for everyone in the organization. */
  @Post('organizations/:organizationId/onboarding/dismiss')
  @HttpCode(200)
  @RequirePermission('organization:write')
  dismiss(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.onboarding.setDismissed(user, chain.organizationId, true);
  }

  /** Show it again. */
  @Post('organizations/:organizationId/onboarding/restore')
  @HttpCode(200)
  @RequirePermission('organization:write')
  restore(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.onboarding.setDismissed(user, chain.organizationId, false);
  }
}
