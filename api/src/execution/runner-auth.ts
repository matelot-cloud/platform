import { CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { Runner, runnerPools, runners } from '../database/schema';

export const RUNNER_AUTH_KEY = 'runnerAuth';
/** Marks an endpoint as runner-facing: authenticated by a runner token, not a user JWT. */
export const RunnerAuth = () => SetMetadata(RUNNER_AUTH_KEY, true);

export interface RunnerPrincipal {
  runner: Runner;
  pool: typeof runnerPools.$inferSelect;
}

export const CurrentRunner = createParamDecorator((_data: unknown, ctx: ExecutionContext): RunnerPrincipal => {
  return ctx.switchToHttp().getRequest<{ runner: RunnerPrincipal }>().runner;
});

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;

@Injectable()
export class RunnerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const runnerRoute = this.reflector.getAllAndOverride<boolean>(RUNNER_AUTH_KEY, [context.getHandler(), context.getClass()]);
    if (!runnerRoute) return true;
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; runner?: RunnerPrincipal }>();
    const header = request.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token.startsWith('rt_')) throw new UnauthorizedException('Runner token required');
    const [row] = await this.db.select({ runner: runners, pool: runnerPools }).from(runners).innerJoin(runnerPools, eq(runners.poolId, runnerPools.id)).where(eq(runners.tokenHash, hashToken(token))).limit(1);
    if (!row) throw new UnauthorizedException('Unknown runner token');
    request.runner = row;
    return true;
  }
}
