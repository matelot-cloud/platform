import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestWithContext } from './permission.guard';
import type { ScopeChain } from './scope.types';

/** The ScopeChain resolved by @RequirePermission() for this request. */
export const Scope = createParamDecorator((_data: unknown, ctx: ExecutionContext): ScopeChain => {
  const chain = ctx.switchToHttp().getRequest<RequestWithContext>().scopeChain;
  if (!chain) throw new Error('@Scope() requires @RequirePermission() on the same route');
  return chain;
});
