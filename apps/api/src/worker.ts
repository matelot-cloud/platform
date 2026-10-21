/** Worker entrypoint: `node dist/worker.js`. Consumes queues; no HTTP server. */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap(): Promise<void> {
  // module initialisation (signing keys, caches) runs outside any request or loop: its queries are not spans
  await context.with(suppressTracing(context.active()), async () => {
    const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
    app.useLogger(app.get(Logger));
    app.enableShutdownHooks();
    await app.init();
  });
}

void bootstrap();
