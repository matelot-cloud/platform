import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface RequestContextData {
  requestId: string;
  ip?: string;
  userAgent?: string;
  /** Set when the caller authenticated with a personal access token (limits admin rights unless scope = sudo). */
  personalToken?: { id: string; userId: string; scope: 'read' | 'write' | 'sudo' };
}

const storage = new AsyncLocalStorage<RequestContextData>();

/** Whatever is executing on behalf of the current HTTP request (used by the audit trail). */
export function currentRequestContext(): RequestContextData | undefined {
  return storage.getStore();
}

/** Plain Express middleware, registered with app.use() before Nest's own middleware. */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
  req.headers['x-request-id'] = requestId;
  res.setHeader('x-request-id', requestId);
  storage.run({ requestId, ip: req.ip, userAgent: req.headers['user-agent'] }, () => next());
}

/** Run `fn` inside a request context (tests, background jobs acting for a token). */
export function runWithRequestContext<T>(data: RequestContextData, fn: () => T): T { return storage.run(data, fn); }
