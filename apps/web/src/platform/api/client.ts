import { useCallback } from 'react';
import { useAuth } from 'react-oidc-context';
import { useRuntimeConfig } from '../runtime-config';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ApiRequest = <T>(path: string, init?: RequestInit & { json?: unknown; raw?: boolean; poll?: boolean }) => Promise<T>;

/**
 * A poll — a background refetch the app makes on its own (refresh interval, window focus), not something the user did —
 * tells the cell so: `x-matelot-poll: 1`, and the cell records no trace of its own for it (telemetry/sampler.ts; one
 * open tab was 150 root traces in 10 minutes). `asPoll(fn)` marks every api() call fn makes synchronously: the header
 * is read when the request is built, before the first await, so the flag never leaks into another call.
 */
let polling = 0;
export function asPoll<T>(fn: () => T): T {
  polling++;
  try { return fn(); } finally { polling--; }
}
export const POLL_HEADER = 'x-matelot-poll';

/** A fetch bound to the current access token and the configured API base URL. */
export function useApi(): ApiRequest {
  const auth = useAuth();
  const { apiBaseUrl } = useRuntimeConfig();
  const token = auth.user?.access_token;

  return useCallback<ApiRequest>(
    async (path, init) => {
      const headers = new Headers(init?.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      if (polling > 0 || init?.poll) headers.set(POLL_HEADER, '1');
      let body = init?.body;
      if (init?.json !== undefined) {
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(init.json);
      }
      const { json: _json, raw, poll: _poll, ...rest } = init ?? {};
      const response = await fetch(`${apiBaseUrl}${path}`, { ...rest, headers, body });
      if (response.status === 204) return undefined as never;
      if (raw) {
        if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`);
        return (await response.blob()) as never;
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = Array.isArray(payload?.message) ? payload.message.join('; ') : payload?.message;
        throw new ApiError(response.status, message ?? `Request failed (${response.status})`);
      }
      return payload;
    },
    [apiBaseUrl, token]
  );
}

export const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
