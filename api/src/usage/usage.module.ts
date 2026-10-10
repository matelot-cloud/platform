import { CallHandler, ExecutionContext, Global, Injectable, Module, NestInterceptor } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Observable } from 'rxjs';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

/** Records people (not CI tokens or runners) as active for the month on their first authenticated request. */
@Injectable()
export class UsageActivityInterceptor implements NestInterceptor {
  constructor(private readonly usage: UsageService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
      if (user?.id && !user.token) void this.usage.markActive(user.id);
    }
    return next.handle();
  }
}

@Global()
@Module({
  controllers: [UsageController],
  providers: [UsageService, { provide: APP_INTERCEPTOR, useClass: UsageActivityInterceptor }],
  exports: [UsageService],
})
export class UsageModule {}
