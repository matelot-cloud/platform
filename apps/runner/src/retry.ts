/** Which failures are worth another try: the cell being unreachable or temporarily unavailable, never a 4xx. */
export function isTransient(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  const cause = String(((error as Error & { cause?: { code?: string; message?: string } })?.cause?.code) ?? (error as Error & { cause?: { message?: string } })?.cause?.message ?? '');
  if (/→ (502|503|504|429)\b/.test(message)) return true;
  if (/→ \d{3}\b/.test(message)) return false; // any other HTTP status is an answer, not an outage
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|socket hang up|network/i.test(message + ' ' + cause);
}

/**
 * Keep calling `fn` until it succeeds, backing off from 2 s to 60 s between transient failures (the API scaled down,
 * restarting, behind a reloading ingress…); a non-transient error is thrown at once. `until()` stops the loop.
 */
export async function retryTransient<T>(what: string, fn: () => Promise<T>, opts: { until?: () => boolean; log?: (m: string) => void; maxDelayMs?: number } = {}): Promise<T> {
  const log = opts.log ?? ((m) => console.error(m));
  let delay = 2000;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransient(error) || opts.until?.()) throw error;
      log(`${what} failed (${(error as Error).message}); retrying in ${Math.round(delay / 1000)} s`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, opts.maxDelayMs ?? 60_000);
    }
  }
}
