import type { INestApplication } from '@nestjs/common';

/**
 * Binds the HTTP port, waiting out a predecessor that is still releasing it. In `make dev` the Nest CLI respawns the
 * API as soon as the shell wrapping the old process exits — the old node process may still be in its graceful
 * shutdown (~250 ms: pools, Redis, timers) and hold the port, so the new one died with EADDRINUSE on every restart.
 * Only EADDRINUSE is retried (every `delayMs`, at most `attempts` times); anything else fails at once.
 */
export async function listenWithRetry(app: Pick<INestApplication, 'listen'>, port: number, host: string, opts: { attempts?: number; delayMs?: number; log?: (message: string) => void } = {}): Promise<void> {
  const attempts = opts.attempts ?? 40;
  const delayMs = opts.delayMs ?? 250;
  for (let i = 1; ; i++) {
    try {
      await app.listen(port, host);
      if (i > 1) opts.log?.(`port ${port} free after ${((i - 1) * delayMs) / 1000}s; listening`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || i >= attempts) throw error;
      if (i === 1) opts.log?.(`port ${port} is still held (a previous instance shutting down?); retrying for up to ${(attempts * delayMs) / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
