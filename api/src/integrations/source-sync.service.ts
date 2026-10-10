import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, notInArray } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { CryptoService } from '../common/crypto.service';
import { DATABASE, Database } from '../database/database.module';
import { probeJira } from '../remediation/issues';
import { Integration, integrations, repositories } from '../database/schema';
import type { IntegrationCredentials } from './credentials';
import { isSshUrl, lsRemote, repositoryNameFromUrl } from './git/git-remote';
import { githubToken, gitlab, RemoteRepository } from './git/token-providers';
import { bitbucket } from './git/token-providers';
import { RegistryClient } from '../inventory/registry.client';
import { dockerCredentialsFor } from './registry-auth';
import { GithubSyncService } from './github/github-sync.service';

/** Dispatches "sync this integration" to the right provider strategy. Runs in the worker. */
@Injectable()
export class SourceSyncService {
  private readonly logger = new Logger(SourceSyncService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly github: GithubSyncService,
  ) {}

  credentialsOf(integration: Integration): IntegrationCredentials {
    if (!integration.credentialsEncrypted) return { type: 'none' };
    const c = JSON.parse(this.crypto.decrypt(Buffer.from(integration.credentialsEncrypted))) as IntegrationCredentials;
    // keyless types: the OIDC subject is the connection id, only known after insert
    if (c.type === 'gcp_wif' || c.type === 'aws_wif' || c.type === 'azure_wif') c.integrationId = integration.id;
    return c;
  }

  /**
   * A successful use of the connection (source sync, image sync): connected, no last error, no pending reason.
   * Never revives a disconnected connection, and an unverified keyless one stays pending until Verify succeeds.
   */
  async markHealthy(integrationId: string): Promise<void> {
    const [row] = await this.db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
    if (!row || row.status === 'disconnected') return;
    if (row.settings.keyless === true && row.settings.verified !== true) return;
    const { pendingReason: _drop, ...settings } = row.settings as Record<string, unknown>;
    await this.db.update(integrations).set({ status: 'connected', lastSyncedAt: new Date(), lastError: null, settings }).where(eq(integrations.id, integrationId));
  }

  async sync(integrationId: string): Promise<{ upserted: number; removed: number }> {
    const [integration] = await this.db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
    if (!integration || integration.status === 'disconnected') return { upserted: 0, removed: 0 };
    if (integration.provider === 'github') return this.github.syncInstallation(integrationId);
    // Keyless connections stay quiet until the cloud trust exists and Verify succeeded (no error state on a fresh row).
    if (integration.settings.keyless === true && integration.settings.verified !== true) {
      await this.db.update(integrations).set({ lastError: 'not verified yet: configure the cloud trust (Manage → Identity), then Verify' }).where(eq(integrations.id, integrationId));
      return { upserted: 0, removed: 0 };
    }

    try {
      const remote = await this.inventory(integration);
      let upserted = 0;
      for (const repo of remote) {
        const values = { integrationId: integration.id, ...repo, lastSyncedAt: new Date() };
        await this.db.insert(repositories).values(values).onConflictDoUpdate({ target: [repositories.integrationId, repositories.externalId], set: { ...values, integrationId: undefined, externalId: undefined } });
        upserted++;
      }
      const ids = remote.map((r) => r.externalId);
      const removed = ids.length
        ? await this.db.delete(repositories).where(and(eq(repositories.integrationId, integration.id), notInArray(repositories.externalId, ids))).returning({ id: repositories.id })
        : [];
      await this.markHealthy(integration.id);
      await this.audit.record({ organizationId: integration.organizationId, actor: SYSTEM_ACTOR, action: 'integration.synced', resourceType: 'integration', resourceId: integration.id, after: { repositories: upserted, removed: removed.length }, reason: `${integration.provider} sync` });
      return { upserted, removed: removed.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`sync failed for ${integration.provider} integration ${integrationId}: ${message}`);
      await this.db.update(integrations).set({ status: 'error', lastError: message }).where(eq(integrations.id, integrationId));
      throw error;
    }
  }

  /** Verifies credentials / reachability before an integration is saved; returns a label for the account. */
  async probe(provider: Integration['provider'], settings: Record<string, unknown>, credentials: IntegrationCredentials): Promise<string> {
    const baseUrl = String(settings.baseUrl ?? '');
    switch (provider) {
      case 'github_token':
        if (credentials.type !== 'token') throw new Error('GitHub needs a token');
        return githubToken.probe(baseUrl || 'https://api.github.com', credentials.token);
      case 'gitlab':
        if (credentials.type !== 'token') throw new Error('GitLab needs a token');
        return gitlab.probe(baseUrl || 'https://gitlab.com', credentials.token);
      case 'bitbucket': {
        if (credentials.type !== 'basic') throw new Error('Bitbucket needs a username + app password, or x-token-auth + access token');
        return bitbucket.probe({ username: credentials.username, password: credentials.password }, settings.owner ? String(settings.owner) : undefined);
      }
      case 'jira': {
        if (credentials.type !== 'basic') throw new Error('Jira needs your Atlassian e-mail and an API token');
        if (!baseUrl) throw new Error('Jira site URL is required (https://<site>.atlassian.net)');
        return probeJira(baseUrl, credentials.username, credentials.password);
      }
      case 'registry': {
        let host = String(settings.baseUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
        if (!host) throw new Error('Registry host is required (e.g. ghcr.io, registry.gitlab.com, harbor.example.com)');
        // Docker Hub answers the registry API on registry-1.docker.io, whatever people type.
        if (['docker.io', 'index.docker.io', 'hub.docker.com', 'www.docker.com'].includes(host)) host = 'registry-1.docker.io';
        const docker = await dockerCredentialsFor(host, credentials);
        const client = new RegistryClient({ registry: host, repository: '' }, docker ? { type: 'basic', username: docker.username, password: docker.password } : { type: 'none' }, String(settings.baseUrl).startsWith('http://'));
        await client.ping();
        return credentials.type === 'gcp' ? `${host} (Artifact Registry token valid until ${docker!.expiresAt.toISOString().slice(0, 16)}Z)` : credentials.type === 'aws' ? `${host} (ECR token valid until ${docker!.expiresAt.toISOString().slice(0, 16)}Z)` : credentials.type === 'azure' ? `${host} (ACR service principal accepted)` : credentials.type === 'gcp_wif' ? `${host} (keyless · ${credentials.serviceAccount} via workload identity)` : credentials.type === 'aws_wif' ? `${host} (keyless · ${credentials.roleArn})` : credentials.type === 'azure_wif' ? `${host} (keyless · app ${credentials.clientId} federated credential)` : host;
      }
      case 'git': {
        const url = String(settings.repositoryUrl ?? '');
        if (!url) throw new Error('repositoryUrl is required');
        if (isSshUrl(url) && credentials.type !== 'ssh' && credentials.type !== 'none') throw new Error('SSH URLs authenticate with an SSH key');
        const info = await lsRemote(url, credentials);
        return `${repositoryNameFromUrl(url)} (${info.defaultBranch ?? 'no default branch'}, ${info.refs} branches)`;
      }
      default:
        throw new Error(`provider ${provider} is not probed here`);
    }
  }

  private async inventory(integration: Integration): Promise<RemoteRepository[]> {
    const credentials = this.credentialsOf(integration);
    const settings = integration.settings;
    const baseUrl = String(settings.baseUrl ?? '');
    switch (integration.provider) {
      case 'github_token':
        if (credentials.type !== 'token') throw new Error('missing token');
        return githubToken.listRepositories(baseUrl || 'https://api.github.com', credentials.token, settings.owner ? String(settings.owner) : undefined);
      case 'gitlab':
        if (credentials.type !== 'token') throw new Error('missing token');
        return gitlab.listRepositories((baseUrl || 'https://gitlab.com').replace(/\/$/, ''), credentials.token, settings.owner ? String(settings.owner) : undefined);
      case 'bitbucket': {
        if (credentials.type !== 'basic') throw new Error('missing app password');
        if (!settings.owner) throw new Error('Bitbucket workspace is required');
        return bitbucket.listRepositories({ username: credentials.username, password: credentials.password }, String(settings.owner));
      }
      case 'registry':
      case 'jira':
      case 'matelot':
        return [];
      case 'git': {
        const url = String(settings.repositoryUrl);
        const info = await lsRemote(url, credentials);
        const ssh = isSshUrl(url);
        return [{ externalId: url, fullName: repositoryNameFromUrl(url), defaultBranch: info.defaultBranch, visibility: null, archived: false, htmlUrl: ssh ? null : url.replace(/\.git$/, ''), cloneUrl: ssh ? null : url, sshUrl: ssh ? url : null }];
      }
      default:
        return [];
    }
  }
}
