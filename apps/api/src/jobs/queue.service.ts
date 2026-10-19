import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsOptions, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { AppConfig } from '../config/env';
import { QueueName } from './queues';
import { currentTraceparent } from '../telemetry/spans';

/** Producer side of the job queues (BullMQ on the cell's Redis). */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();

  constructor(@Inject(ConfigService) config: AppConfig) {
    this.connection = new IORedis(config.get('REDIS_URL', { infer: true }), { maxRetriesPerRequest: null, lazyConnect: true });
  }

  /** Shared Redis connection (nonces, small caches). */
  get redis(): IORedis {
    return this.connection;
  }

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 } });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** The active trace travels with the job (`__traceparent`), so the worker's run is a child of the request that queued it. */
  enqueue<T extends object>(name: QueueName, data: T, options?: JobsOptions) {
    const traceparent = currentTraceparent();
    return this.queue(name).add(name, traceparent ? { ...data, __traceparent: traceparent } : data, options);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    await this.connection.quit().catch(() => undefined);
  }
}
