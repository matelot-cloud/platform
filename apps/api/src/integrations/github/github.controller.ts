import { Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, RawBodyRequest, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { Public } from '../../auth/public.decorator';
import { DATABASE, Database } from '../../database/database.module';
import { integrations, webhookDeliveries } from '../../database/schema';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../database/errors';
import { QueueService } from '../../jobs/queue.service';
import { QUEUES } from '../../jobs/queues';
import { IntegrationsService } from '../integrations.service';
import { GithubAppClient } from './github-app.client';
import { GithubSyncService } from './github-sync.service';

/** Browser and GitHub-facing endpoints: App setup return and webhooks. Both are public by nature. */
@ApiExcludeController()
@Controller()
export class GithubController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly integrations: IntegrationsService,
    private readonly github: GithubAppClient,
    private readonly githubSync: GithubSyncService,
    private readonly queue: QueueService,
  ) {}

  @Public()
  @Get('integrations/github/callback')
  async callback(@Query('installation_id') installationId: string | undefined, @Query('state') state: string | undefined, @Query('setup_action') setupAction: string | undefined, @Res() res: Response) {
    if (!installationId) return res.redirect(302, this.integrations.webUrl('/integrations?error=missing_installation'));
    const target = await this.integrations.githubCallback(installationId, state, setupAction);
    return res.redirect(302, target);
  }

  /** Browsers (and GitHub's Setup URL, when misconfigured) land here with GET: explain instead of 404. */
  @Public()
  @Get(['webhooks/github', 'webhooks/github/:integrationId'])
  webhookInfo(@Res() res: Response) {
    res.status(200).json({ message: 'This is the GitHub webhook endpoint: GitHub servers POST events here. In the App settings use it as the Webhook URL, and use /api/v1/integrations/github/callback as the Setup URL (Redirect URI).' });
  }

  /** Platform-wide App webhook. */
  @Public()
  @Post('webhooks/github')
  @HttpCode(202)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    return this.handle(req, event, deliveryId, signature);
  }

  /** Webhook of a team-registered App: verified with that connection's own secret. */
  @Public()
  @Post('webhooks/github/:integrationId')
  @HttpCode(202)
  webhookFor(
    @Param('integrationId', ParseUUIDPipe) integrationId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    return this.handle(req, event, deliveryId, signature, integrationId);
  }

  /** Stores every delivery first (idempotent on the GitHub delivery id), then queues processing. */
  private async handle(req: RawBodyRequest<Request>, event: string | undefined, deliveryId: string | undefined, signature: string | undefined, integrationId?: string) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    let cfg;
    if (integrationId) {
      const [own] = await this.db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
      cfg = own ? this.githubSync.appConfigFor(own) : undefined;
      if (!cfg) throw new UnauthorizedException('Unknown connection');
    }
    if (!this.github.verifySignature(raw, signature, cfg)) throw new UnauthorizedException('Invalid webhook signature');
    if (!event || !deliveryId) throw new UnauthorizedException('Missing GitHub webhook headers');
    if (event === 'ping') return { ok: true, event };

    const payload = req.body as { installation?: { id: number } };
    const installationId = payload?.installation?.id ? String(payload.installation.id) : undefined;
    let stored;
    try {
      [stored] = await this.db
        .insert(webhookDeliveries)
        .values({ provider: 'github', providerDeliveryId: deliveryId, event, payload, integrationId: installationId ? await this.integrationIdFor(installationId) : null })
        .returning({ id: webhookDeliveries.id });
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) return { ok: true, duplicate: true };
      throw error;
    }
    await this.queue.enqueue(QUEUES.githubWebhooks, { deliveryId: stored.id }, { jobId: `delivery-${stored.id}` });
    return { ok: true, id: stored.id };
  }

  private async integrationIdFor(installationId: string): Promise<string | null> {
    const [row] = await this.db.select({ id: integrations.id }).from(integrations).where(eq(integrations.externalAccountId, installationId)).limit(1);
    return row?.id ?? null;
  }
}
