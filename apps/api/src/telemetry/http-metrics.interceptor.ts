import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { getMetrics } from './metrics';

/**
 * `http_server_request_duration_seconds{http_request_method,http_route,http_response_status_code}` — the route is
 * the TEMPLATE Express matched (`/api/v1/projects/:projectId`), never the raw path, so the series stay bounded.
 * Probes and the metrics page are not counted (they are not traced either). Runs after routing (an interceptor), so
 * 404s for unknown paths never reach it: those are not series we want.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    const route = routeTemplate(req);
    if (!route || route.includes('/health/')) return next.handle();
    const start = process.hrtime.bigint();
    const res = ctx.switchToHttp().getResponse<Response>();
    const record = (status: number) => getMetrics().httpRequestDuration.record(Number(process.hrtime.bigint() - start) / 1e9, { http_request_method: req.method, http_route: route, http_response_status_code: String(status) });
    return next.handle().pipe(tap({ next: () => record(res.statusCode), error: (e: unknown) => record(e instanceof HttpException ? e.getStatus() : 500) }));
  }
}

export function routeTemplate(req: { route?: { path?: string }; baseUrl?: string }): string | null {
  const path = req.route?.path;
  if (!path) return null;
  return `${req.baseUrl ?? ''}${path}`;
}
