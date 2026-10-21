import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { McpService } from './mcp/mcp.service';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { context as otelContext } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { AppModule } from './app.module';
import { DatabaseExceptionFilter } from './common/database-exception.filter';
import { listenWithRetry } from './common/listen';
import { publicApiBase } from './config/public-url';
import { RateLimitInterceptor } from './common/rate-limit/rate-limit.interceptor';
import { requestContextMiddleware } from './common/request-context';
import { AppConfig, parseList } from './config/env';

async function bootstrap(): Promise<void> {
  // module initialisation (signing keys, caches) runs outside any request: its queries are not spans (telemetry/trim.ts)
  const app = await otelContext.with(suppressTracing(otelContext.active()), () => NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true }));
  app.useLogger(app.get(Logger));

  const config = app.get<AppConfig>(ConfigService);
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
  const corsOrigins = parseList(config.get('CORS_ORIGINS', { infer: true }));

  // Behind the ingress controller: trust X-Forwarded-* for req.ip (audit trail) and protocol.
  app.set('trust proxy', 1);
  app.useBodyParser('json', { limit: '32mb', type: ['application/json', 'application/*+json'] });
  app.use(requestContextMiddleware);
  app.use(helmet({ contentSecurityPolicy: isProduction ? undefined : false }));
  app.enableCors({ origin: corsOrigins.length ? corsOrigins : false, credentials: true });

  app.setGlobalPrefix('api/v1', { exclude: ['.well-known/oauth-authorization-server', '.well-known/oauth-protected-resource', '.well-known/oauth-protected-resource/api/v1/mcp', '.well-known/openid-configuration', '.well-known/jwks.json'] });
  // OAuth clients post form-encoded token requests; MCP clients discover the authorization server from the 401 on /mcp.
  app.use(require('express').urlencoded({ extended: false })); // express ships with @nestjs/platform-express
  app.use('/api/v1/mcp', (req: { protocol: string; get: (h: string) => string | undefined }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    // the resource metadata URL: the configured public base, else what the request was addressed to
    const issuer = config.get('API_PUBLIC_URL', { infer: true }) || config.get('WEB_BASE_URL', { infer: true }) ? publicApiBase(config) : `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/api/v1/mcp"`);
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new DatabaseExceptionFilter(app.get(HttpAdapterHost).httpAdapter, app.get(RateLimitInterceptor)));
  app.enableShutdownHooks();

  const openapi = new DocumentBuilder()
    .setTitle('Product Security & Compliance Platform API')
    .setDescription('Tenant-cell API: organizations, workspaces, teams, projects, RBAC and audit trail.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, openapi);
  SwaggerModule.setup('api/docs', app, document);

  const port = config.get('PORT', { infer: true });
  app.get(McpService).load(document, port);
  // onModuleInit hooks (signing keys, caches) run here, outside any request: not spans. Listening starts OUTSIDE the
  // suppressed context — the server's handlers inherit the context `listen` is called in, and requests must be traced.
  await otelContext.with(suppressTracing(otelContext.active()), () => app.init());
  await listenWithRetry(app, port, '0.0.0.0', { log: (m) => app.get(Logger).warn(m) });
}

void bootstrap();
