import IORedis from 'ioredis';

export interface WindowHit { count: number; resetAt: number }

/** Fixed-window counter: one key per bucket per window. */
export interface RateLimitStore {
  hit(bucket: string, windowMs: number, now?: number): Promise<WindowHit>;
}

/** Per-process counters (tests, single replica, or Redis unreachable). */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, WindowHit>();
  private lastPrune = 0;

  async hit(bucket: string, windowMs: number, now = Date.now()): Promise<WindowHit> {
    const start = Math.floor(now / windowMs) * windowMs;
    const key = `${bucket}:${start}`;
    const w = this.windows.get(key) ?? { count: 0, resetAt: start + windowMs };
    w.count++;
    this.windows.set(key, w);
    if (now - this.lastPrune > windowMs) {
      this.lastPrune = now;
      for (const [k, v] of this.windows) if (v.resetAt <= now) this.windows.delete(k);
    }
    return { ...w };
  }

  get size() { return this.windows.size; }
}

/**
 * Shared counters on the cell's Redis, so every API replica counts against the same window. Never blocks a request on
 * Redis: no offline queue, one try, and any error falls back to the per-process store (logged once per outage).
 */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: IORedis;
  private readonly fallback = new MemoryRateLimitStore();
  private degraded = false;

  constructor(url: string, private readonly onDegraded: (message: string | null) => void = () => undefined) {
    this.client = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000 });
    this.client.on('error', () => undefined);
    this.client.connect().catch(() => undefined);
  }

  async hit(bucket: string, windowMs: number, now = Date.now()): Promise<WindowHit> {
    const start = Math.floor(now / windowMs) * windowMs;
    const key = `rl:${bucket}:${start}`;
    try {
      const res = await this.client.multi().incr(key).pexpire(key, windowMs + 1000).exec();
      const count = Number(res?.[0]?.[1]);
      if (!Number.isFinite(count)) throw new Error('unexpected Redis reply');
      if (this.degraded) { this.degraded = false; this.onDegraded(null); }
      return { count, resetAt: start + windowMs };
    } catch (error) {
      if (!this.degraded) { this.degraded = true; this.onDegraded(error instanceof Error ? error.message : String(error)); }
      return this.fallback.hit(bucket, windowMs, now);
    }
  }

  async close() { this.client.disconnect(); }
}
