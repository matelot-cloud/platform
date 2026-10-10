import { ArgumentsHost, Catch, ConflictException, HttpException } from '@nestjs/common';
import { AbstractHttpAdapter, BaseExceptionFilter } from '@nestjs/core';
import { PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '../database/errors';
import type { RateLimitInterceptor } from './rate-limit/rate-limit.interceptor';

/**
 * Turns Postgres constraint violations into 409s, and counts failed authentication (401) / refused authorization (403)
 * against the rate limits — a 429 replaces them once over the limit. Everything else falls through to Nest's defaults.
 */
@Catch()
export class DatabaseExceptionFilter extends BaseExceptionFilter {
  constructor(adapter?: AbstractHttpAdapter, private readonly limiter?: Pick<RateLimitInterceptor, 'onAuthFailure'>) {
    super(adapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const code = pgErrorCode(exception);
    if (code === PG_UNIQUE_VIOLATION) {
      return super.catch(new ConflictException('A record with the same unique value already exists'), host);
    }
    if (code === PG_FOREIGN_KEY_VIOLATION) {
      return super.catch(new ConflictException('The referenced record does not exist or is still in use'), host);
    }
    const status = exception instanceof HttpException ? exception.getStatus() : 0;
    if (this.limiter && host.getType() === 'http' && (status === 401 || status === 403)) {
      const http = host.switchToHttp();
      void this.limiter.onAuthFailure(http.getRequest(), http.getResponse(), status)
        .then((replacement) => super.catch(replacement ?? exception, host))
        .catch(() => super.catch(exception, host));
      return;
    }
    return super.catch(exception, host);
  }
}
