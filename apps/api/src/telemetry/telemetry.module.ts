import { Global, Inject, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import type { AppConfig } from '../config/env';
import { DATABASE, type Database } from '../database/database.module';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { getMetrics, Metrics } from './metrics';
import { ObservabilityStatusService } from './observability-status.service';
import { PipelineTelemetry } from './pipeline-telemetry';
import { logsHandle } from './logs';
import { tracingHandle } from './tracing';
import { WorkerGauges } from './worker-gauges';

export class TelemetryLifecycle implements OnModuleInit, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  constructor(@Inject(ConfigService) private readonly config: AppConfig, private readonly metrics: Metrics, private readonly logger: Logger, @Inject(DATABASE) private readonly db: Database, private readonly status: ObservabilityStatusService) {}

  async onModuleInit(): Promise<void> {
    const pool = (this.db as unknown as { $client?: { totalCount: number; idleCount: number; waitingCount: number } }).$client;
    const refresh = () => {
      if (!pool) return;
      this.metrics.dbConnections.replace([
        { value: pool.totalCount - pool.idleCount, attributes: { state: 'used' } },
        { value: pool.idleCount, attributes: { state: 'idle' } },
        { value: pool.waitingCount, attributes: { state: 'pending' } },
      ]);
    };
    refresh();
    this.timer = setInterval(refresh, 5000);
    this.timer.unref();
    this.status.start();   // the process's telemetry heartbeat in Redis (Settings → Observability, `matelot doctor`)
    if (this.config.get('MATELOT_METRICS_ENABLED', { infer: true }) === false) return;
    // the port may still be held by the process being replaced (a restart on one host): three tries, 2 s apart
    for (let attempt = 1; ; attempt++) {
      try {
        const port = await this.metrics.listen(this.config.get('MATELOT_METRICS_PORT', { infer: true }));
        this.logger.log(`metrics on :${port}/metrics${tracingHandle() ? `; tracing on (${tracingHandle()!.exporter})` : '; tracing off'}${logsHandle() ? `; event logs → ${logsHandle()!.exporter}` : ''}`, 'Telemetry');
        return;
      } catch (error) {
        if (attempt < 3) { await new Promise((r) => setTimeout(r, 2000)); continue; }
        this.logger.warn(`metrics listener not started: ${error instanceof Error ? error.message : String(error)}`, 'Telemetry');
        return;
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.status.stop();
    await this.metrics.close();
    await Promise.all([tracingHandle()?.shutdown(5000), logsHandle()?.shutdown(5000)]);
  }
}

/**
 * Metrics on their own port (MATELOT_METRICS_ENABLED, default on), the HTTP RED interceptor, the pool gauges, and the
 * tracing flush inside Nest's shutdown (5 s cap) so a pod rollout does not drop the last spans of a pipeline job.
 * Imported by AppModule (api) and WorkerModule (worker).
 */
@Global()
@Module({
  providers: [
    { provide: Metrics, useFactory: () => getMetrics() },
    PipelineTelemetry,
    WorkerGauges,
    ObservabilityStatusService,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    TelemetryLifecycle,
  ],
  exports: [Metrics, PipelineTelemetry, WorkerGauges, ObservabilityStatusService],
})
export class TelemetryModule {}

