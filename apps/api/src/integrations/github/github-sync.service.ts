import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service';
import { SYSTEM_ACTOR } from '../../audit/audit.types';
import { DATABASE, Database } from '../../database/database.module';
import { Integration, integrations, projects, repositories, serviceRepositories, services, webhookDeliveries } from '../../database/schema';
import { AutomationService } from '../../execution/automation.service';
import { forwardRef, Optional } from '@nestjs/common';
import { CryptoService } from '../../common/crypto.service';
import type { IntegrationCredentials } from '../credentials';
import { GithubAppClient, GithubAppConfig, githubAppConfigFrom, GithubRepository } from './github-app.client';

/** Reconciles GitHub installations and webhook deliveries into the catalog. Runs in the worker. */
@Injectable()
export class GithubSyncService {
  private readonly logger = new Logger(GithubSyncService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly github: GithubAppClient,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    @Optional() @Inject(forwardRef(() => AutomationService)) private readonly automation?: AutomationService,
  ) {}

  /** The App to use for an integration: its own registered App, or the platform-wide one. */
  appConfigFor(integration: Integration): GithubAppConfig | undefined {
    if (integration.settings.appId && integration.credentialsEncrypted) {
      const creds = JSON.parse(this.crypto.decrypt(Buffer.from(integration.credentialsEncrypted))) as IntegrationCredentials;
      if (creds.type === 'app') return githubAppConfigFrom(integration.settings, creds.privateKey, creds.webhookSecret);
    }
    return undefined;
  }

  async syncInstallation(integrationId: string): Promise<{ upserted: number; removed: number }> {
    const [integration] = await this.db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
    if (!integration || integration.provider !== 'github' || !integration.externalAccountId) return { upserted: 0, removed: 0 };
    if (integration.status === 'disconnected') return { upserted: 0, removed: 0 };

    try {
      const installationId = integration.externalAccountId;
      const cfg = this.appConfigFor(integration);
      const remote = await this.github.listInstallationRepositories(installationId, cfg);
      let upserted = 0;
      for (const repo of remote) {
        await this.upsertRepository(integration, repo);
        upserted++;
      }
      const remoteIds = remote.map((r) => String(r.id));
      const removed = remoteIds.length
        ? await this.db.delete(repositories).where(and(eq(repositories.integrationId, integration.id), notInArray(repositories.externalId, remoteIds))).returning({ id: repositories.id })
        : await this.db.delete(repositories).where(eq(repositories.integrationId, integration.id)).returning({ id: repositories.id });

      await this.db.update(integrations).set({ status: 'connected', lastSyncedAt: new Date(), lastError: null }).where(eq(integrations.id, integration.id));
      await this.audit.record({
        organizationId: integration.organizationId,
        actor: SYSTEM_ACTOR,
        action: 'integration.synced',
        resourceType: 'integration',
        resourceId: integration.id,
        after: { repositories: upserted, removed: removed.length },
        reason: 'GitHub installation sync',
      });
      return { upserted, removed: removed.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`sync failed for integration ${integrationId}: ${message}`);
      await this.db.update(integrations).set({ status: 'error', lastError: message }).where(eq(integrations.id, integrationId));
      throw error;
    }
  }

  private async upsertRepository(integration: Integration, repo: GithubRepository): Promise<void> {
    const installationId = integration.externalAccountId!;
    const cfg = this.appConfigFor(integration);
    const [languages, protection] = await Promise.all([
      this.github.languages(installationId, repo.full_name, cfg).catch(() => ({})),
      repo.default_branch ? this.github.branchProtection(installationId, repo.full_name, repo.default_branch, cfg).catch(() => null) : Promise.resolve(null),
    ]);
    const values = {
      integrationId: integration.id,
      externalId: String(repo.id),
      fullName: repo.full_name,
      defaultBranch: repo.default_branch ?? null,
      visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
      archived: repo.archived,
      languages,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url ?? `${repo.html_url}.git`,
      sshUrl: repo.ssh_url ?? null,
      branchProtection: protection,
      lastSyncedAt: new Date(),
    };
    await this.db
      .insert(repositories)
      .values(values)
      .onConflictDoUpdate({ target: [repositories.integrationId, repositories.externalId], set: { ...values, integrationId: undefined, externalId: undefined } });
  }

  /** Processes one stored webhook delivery. Idempotent: reprocessing produces the same state. */
  async processDelivery(deliveryId: string): Promise<void> {
    const [delivery] = await this.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
    if (!delivery || delivery.status === 'processed') return;
    const payload = delivery.payload as {
      action?: string;
      installation?: { id: number };
      repository?: GithubRepository;
      repositories_added?: { id: number }[];
      repositories_removed?: { id: number }[];
      ref?: string;
    };
    const installationId = payload.installation?.id ? String(payload.installation.id) : undefined;

    try {
      const [integration] = installationId
        ? await this.db.select().from(integrations).where(and(eq(integrations.provider, 'github'), eq(integrations.externalAccountId, installationId))).limit(1)
        : [];

      if (!integration) {
        await this.finish(delivery.id, 'ignored', 'no integration for installation');
        return;
      }
      if (delivery.integrationId !== integration.id) await this.db.update(webhookDeliveries).set({ integrationId: integration.id }).where(eq(webhookDeliveries.id, delivery.id));

      switch (delivery.event) {
        case 'installation':
          if (payload.action === 'deleted' || payload.action === 'suspend') {
            await this.db.update(integrations).set({ status: 'disconnected', lastError: `installation ${payload.action}` }).where(eq(integrations.id, integration.id));
            await this.audit.record({ organizationId: integration.organizationId, actor: SYSTEM_ACTOR, action: 'integration.disconnected', resourceType: 'integration', resourceId: integration.id, reason: `webhook: installation ${payload.action}` });
          } else if (payload.action === 'unsuspend' || payload.action === 'created') {
            await this.db.update(integrations).set({ status: 'connected', lastError: null }).where(eq(integrations.id, integration.id));
            await this.syncInstallation(integration.id);
          }
          break;
        case 'installation_repositories':
          await this.syncInstallation(integration.id);
          break;
        case 'repository':
          if (payload.repository) {
            if (payload.action === 'deleted' || payload.action === 'transferred') {
              await this.db.delete(repositories).where(and(eq(repositories.integrationId, integration.id), eq(repositories.externalId, String(payload.repository.id))));
            } else {
              await this.upsertRepository(integration, payload.repository);
            }
          }
          break;
        case 'push':
          if (payload.repository) {
            const fresh = await this.github.repository(integration.externalAccountId!, payload.repository.full_name, this.appConfigFor(integration));
            await this.upsertRepository(integration, fresh ?? payload.repository);
            const push = payload as { ref?: string; after?: string; deleted?: boolean };
            if (push.ref?.startsWith('refs/heads/') && push.after && !push.deleted && this.automation) {
              const [repo] = await this.db.select({ id: repositories.id, defaultBranch: repositories.defaultBranch }).from(repositories).where(and(eq(repositories.integrationId, integration.id), eq(repositories.externalId, String(payload.repository.id)))).limit(1);
              if (repo) await this.automation.onPush(repo.id, push.ref.replace('refs/heads/', ''), push.after, repo.defaultBranch);
            }
          }
          break;
        default:
          await this.finish(delivery.id, 'ignored', `event ${delivery.event} not handled yet`);
          return;
      }
      await this.finish(delivery.id, 'processed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finish(delivery.id, 'failed', message);
      throw error;
    }
  }

  private finish(deliveryId: string, status: 'processed' | 'ignored' | 'failed', error?: string) {
    return this.db.update(webhookDeliveries).set({ status, error: error ?? null, processedAt: new Date() }).where(eq(webhookDeliveries.id, deliveryId));
  }

  /** Repositories for a set of integrations (helper for listings). */
  repositoriesFor(integrationIds: string[]) {
    if (!integrationIds.length) return Promise.resolve([]);
    return this.db.select().from(repositories).where(inArray(repositories.integrationId, integrationIds));
  }
}
