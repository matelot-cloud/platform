import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CryptoService } from '../common/crypto.service';
import { AppConfig } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { containerImages, Integration, integrations, projects, repositories, ScopeType, serviceRepositories, services, teams, workspaces } from '../database/schema';
import { QueueService } from '../jobs/queue.service';
import { QUEUES } from '../jobs/queues';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import type { Permission } from '../rbac/permissions';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeChain, scopeParamsFor } from '../rbac/scope.types';
import { PROVIDER_INFO, type IntegrationCredentials } from './credentials';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { AttachRepositoryDto } from './dto/integrations.dto';
import { repositoryNameFromUrl } from './git/git-remote';
import { generateDeployKey } from './git/ssh-keys';
import { SourceSyncService } from './source-sync.service';
import { dockerCredentialsFor } from './registry-auth';
import { ecrCreateRepository, ecrListRepositories } from './ecr-api';
import { GithubAppClient, githubAppConfigFrom } from './github/github-app.client';
import { GithubSyncService } from './github/github-sync.service';

export interface InstallState extends Record<string, unknown> {
  organizationId: string;
  userId: string;
  scopeType: ScopeType;
  scopeId: string;
  /** Set when installing a team-registered App: the connection to complete. */
  integrationId?: string;
}

const publicView = (i: Integration) => {
  const { credentialsEncrypted: _credentials, ...rest } = i;
  return rest;
};

export const isKeylessAuth = (t: string): t is 'gcp_wif' | 'aws_wif' | 'azure_wif' => t === 'gcp_wif' || t === 'aws_wif' || t === 'azure_wif';

/** Non-secret parameters of a keyless connection, kept in settings so they stay visible after disconnect. */
export function keylessParams(c: IntegrationCredentials): Record<string, string> | null {
  if (c.type === 'gcp_wif') return { provider: c.provider, serviceAccount: c.serviceAccount };
  if (c.type === 'aws_wif') return { roleArn: c.roleArn, region: c.region };
  if (c.type === 'azure_wif') return { tenantId: c.tenantId, clientId: c.clientId };
  return null;
}

@Injectable()
export class IntegrationsService {
  private readonly webBaseUrl: string;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ConfigService) config: AppConfig,
    private readonly github: GithubAppClient,
    private readonly crypto: CryptoService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
    private readonly sourceSync: SourceSyncService,
    private readonly githubSync: GithubSyncService,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    this.registryHost = config.get('REGISTRY_HOST', { infer: true }) ?? null;
  }

  private readonly registryHost: string | null;

  webUrl(path: string): string {
    return `${this.webBaseUrl}${path}`;
  }

  providers() {
    return (Object.keys(PROVIDER_INFO) as (keyof typeof PROVIDER_INFO)[]).map((provider) => ({
      provider,
      label: PROVIDER_INFO[provider].label,
      authTypes: PROVIDER_INFO[provider].authTypes,
      inventory: PROVIDER_INFO[provider].inventory,
      available: provider === 'github' ? this.github.available || this.crypto.available : provider === 'matelot' ? !!this.registryHost : this.crypto.available,
      /** GitHub: the platform-wide App can be installed with one click; without it teams register their own. */
      installable: provider === 'github' ? this.github.available && !!this.github.config?.slug : this.crypto.available,
      platformApp: provider === 'github' ? this.github.available && !!this.github.config?.slug : undefined,
    }));
  }

  /** Token / password / SSH based connections. Credentials are verified, then stored encrypted. */
  /** Verifies credentials without saving anything (the wizard's "Test connection"). */
  async test(user: AuthenticatedUser, orgChain: ScopeChain, dto: CreateIntegrationDto): Promise<{ ok: true; account: string }> {
    await this.targetChain(user, orgChain, dto.scopeType, dto.scopeId);
    if (isKeylessAuth(dto.auth.type)) {
      throw new BadRequestException('Keyless connections cannot be tested before they exist: the cloud trusts the subject integration:<connection id>, which is assigned when you connect. Connect, configure the trust shown under Identity, then Verify.');
    }
    try {
      return { ok: true, account: await this.probe(dto) };
    } catch (error) {
      throw new BadRequestException(`Connection check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async probe(dto: CreateIntegrationDto): Promise<string> {
    if (dto.provider === 'github') {
      const a = dto.auth;
      if (a.type !== 'app' || !a.appId || !a.privateKey) throw new Error('A GitHub App needs an App ID and a private key');
      const cfg = githubAppConfigFrom({ appId: a.appId, slug: a.slug, apiUrl: dto.baseUrl, webUrl: dto.baseUrl ? dto.baseUrl.replace(/\/api\/v3$/, '') : undefined }, a.privateKey, a.webhookSecret);
      const app = await this.github.probeApp(cfg);
      return app.slug ? `${app.name} (${app.slug})` : app.name;
    }
    const credentials = this.toCredentials(dto);
    return this.sourceSync.probe(dto.provider, { baseUrl: dto.baseUrl ?? null, owner: dto.owner ?? null, repositoryUrl: dto.repositoryUrl ?? null }, credentials);
  }

  /** Permissions an App installation needs for everything Matelot does; missing ones are reported, not fatal. */
  static readonly APP_PERMISSIONS: { key: string; level: string; why: string }[] = [
    { key: 'metadata', level: 'read', why: 'list repositories' },
    { key: 'contents', level: 'read', why: 'clone and scan' },
    { key: 'administration', level: 'read', why: 'repository settings' },
    { key: 'issues', level: 'write', why: 'remediation issues' },
    { key: 'organization_projects', level: 'write', why: 'add issues to Projects boards' },
  ];

  missingPermissions(granted: Record<string, string> | null | undefined): { key: string; level: string; why: string }[] {
    if (!granted) return [];
    const rank = (v: string | undefined) => (v === 'admin' ? 3 : v === 'write' ? 2 : v === 'read' ? 1 : 0);
    return IntegrationsService.APP_PERMISSIONS.filter((p) => rank(granted[p.key]) < rank(p.level));
  }

  /**
   * A team registers its own GitHub App. GitHub is the source of truth for slug and name (the user-entered slug is a hint).
   * A pending record for the same App at the same scope is reused, never duplicated. If the App is already installed
   * somewhere, the installation is bound immediately (no browser round-trip); otherwise the connection stays pending
   * until the install callback arrives.
   */
  private async createOwnGithubApp(user: AuthenticatedUser, orgChain: ScopeChain, target: ScopeChain, dto: CreateIntegrationDto) {
    const a = dto.auth;
    if (a.type !== 'app' || !a.appId || !a.privateKey) throw new BadRequestException('A GitHub App needs an App ID and a private key');
    const cfg = githubAppConfigFrom({ appId: a.appId, slug: a.slug, apiUrl: dto.baseUrl }, a.privateKey, a.webhookSecret);
    let app;
    try {
      app = await this.github.probeApp(cfg);
    } catch (error) {
      throw new BadRequestException(`Connection check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const warnings: string[] = [];
    if (a.slug && a.slug !== app.slug) warnings.push(`The App slug on GitHub is "${app.slug}", not "${a.slug}"; using GitHub's value.`);
    const settings = { appId: a.appId, slug: app.slug, app: app.name, appUrl: app.htmlUrl, apiUrl: dto.baseUrl ?? null, webUrl: dto.baseUrl ? dto.baseUrl.replace(/\/api\/v3$/, '') : null, ownApp: true, pendingReason: 'waiting for the GitHub installation callback' as string | null, permissions: null as Record<string, string> | null, targetType: null as string | null };
    const credentialsEncrypted = this.crypto.encrypt(JSON.stringify({ type: 'app', privateKey: a.privateKey, webhookSecret: a.webhookSecret } satisfies IntegrationCredentials));
    // reuse a pending record of the same App at the same scope (every retry used to create another one)
    const [existing] = await this.db.select().from(integrations).where(and(eq(integrations.organizationId, orgChain.organizationId), eq(integrations.provider, 'github'), eq(integrations.authType, 'app'), eq(integrations.scopeType, target.target.type), eq(integrations.scopeId, target.target.id), sql`${integrations.settings}->>'appId' = ${a.appId}`)).limit(1);
    let integration: Integration;
    if (existing && (existing.status === 'pending' || !existing.externalAccountId)) {
      [integration] = await this.db.update(integrations).set({ name: dto.name || existing.name, settings: { ...existing.settings, ...settings }, credentialsEncrypted, lastError: null, status: 'pending' }).where(eq(integrations.id, existing.id)).returning();
      warnings.push('Updated the existing pending connection for this App instead of creating another one.');
    } else if (existing) {
      throw new BadRequestException(`This App is already connected here as "${existing.name}". Use it, or disconnect it first.`);
    } else {
      [integration] = await this.db.insert(integrations).values({ organizationId: orgChain.organizationId, scopeType: target.target.type, scopeId: target.target.id, provider: 'github', authType: 'app', name: dto.name || `GitHub App · ${app.name}`, status: 'pending', externalAccountId: null, settings, credentialsEncrypted, createdById: user.id }).returning();
    }
    await this.audit.record({ organizationId: orgChain.organizationId, actor: userActor(user), action: 'integration.registered', resourceType: 'integration', resourceId: integration.id, after: publicView(integration), reason: 'own GitHub App registered' });
    // already installed on GitHub? bind without the browser round-trip
    const bound = await this.linkExistingInstallation(user, integration.id, { quiet: true }).catch((e) => { warnings.push(`Could not list installations: ${e instanceof Error ? e.message : String(e)}`); return null; });
    const current = bound ?? { ...publicView(integration), scope: await this.describeScope(integration) };
    return { ...current, installUrl: (await this.installUrlFor(user, integration.id)).url, warnings, missingPermissions: this.missingPermissions((bound?.settings as Record<string, unknown> | undefined)?.permissions as Record<string, string> | null) };
  }

  /**
   * "Link existing installation" / "Check again": looks at the App's installations on GitHub and binds the one that fits
   * (the only one, or the one whose account matches the connection name). Also refreshes granted permissions.
   */
  async linkExistingInstallation(user: AuthenticatedUser, integrationId: string, opts: { quiet?: boolean } = {}) {
    const integration = await this.get(integrationId);
    await this.assertOn(user, integration, 'integration:connect');
    const cfg = this.githubSync.appConfigFor(integration);
    if (!cfg) throw new BadRequestException('This connection has no App credentials');
    if (integration.externalAccountId) {
      const info = await this.github.installationPermissions(integration.externalAccountId, cfg).catch((e: Error) => { throw new BadRequestException(`GitHub did not answer for installation ${integration.externalAccountId}: ${e.message}${/exp.*future|iat/.test(e.message) ? ' — the API host clock is ahead of GitHub; check NTP / WSL clock (wsl --shutdown or hwclock -s)' : ''}`); });
      if (!info) throw new BadRequestException('The installation no longer exists on GitHub; reinstall the App');
      const [row] = await this.db.update(integrations).set({ settings: { ...integration.settings, permissions: info.permissions, targetType: info.targetType, account: info.account, pendingReason: null }, lastError: null }).where(eq(integrations.id, integration.id)).returning();
      return { ...publicView(row), scope: await this.describeScope(row), missingPermissions: this.missingPermissions(info.permissions) };
    }
    const list = await this.github.listInstallations(cfg).catch((e: Error) => { throw new BadRequestException(`GitHub did not list installations: ${e.message}`); });
    if (list.length === 0) {
      if (opts.quiet) return null;
      throw new BadRequestException('The App is not installed anywhere yet: use the Install button');
    }
    const wanted = String(integration.settings.account && typeof integration.settings.account === 'object' ? (integration.settings.account as { login?: string }).login ?? '' : '').toLowerCase();
    const pick = list.length === 1 ? list[0]! : list.find((i) => i.account.login.toLowerCase() === wanted) ?? null;
    if (!pick) {
      if (opts.quiet) return null;
      throw new BadRequestException(`The App is installed on ${list.map((i) => i.account.login).join(', ')}; install it on the account you want from the Install button, or name the connection after that account and try again`);
    }
    const [row] = await this.db.update(integrations).set({ externalAccountId: String(pick.id), status: 'pending', lastError: null, name: `GitHub · ${pick.account.login}`, settings: { ...integration.settings, account: pick.account, permissions: pick.permissions, targetType: pick.targetType, pendingReason: null } }).where(eq(integrations.id, integration.id)).returning();
    await this.audit.record({ organizationId: row.organizationId, actor: userActor(user), action: 'integration.connected', resourceType: 'integration', resourceId: row.id, after: publicView(row), reason: `bound existing installation ${pick.id}` });
    await this.queue.enqueue(QUEUES.githubSync, { integrationId: row.id });
    return { ...publicView(row), scope: await this.describeScope(row), missingPermissions: this.missingPermissions(pick.permissions) };
  }

  /** Namespace of the built-in registry for a scope: <workspace>[/<team>[/<project>]]. */
  private async registryNamespace(scopeType: ScopeType, scopeId: string): Promise<string | null> {
    if (scopeType === 'PROJECT') {
      const [p] = await this.db.select({ ws: workspaces.slug, team: teams.slug, project: projects.slug }).from(projects).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(eq(projects.id, scopeId)).limit(1);
      return p ? `${p.ws}/${p.team}/${p.project}` : null;
    }
    if (scopeType === 'TEAM') {
      const [t] = await this.db.select({ ws: workspaces.slug, team: teams.slug }).from(teams).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(eq(teams.id, scopeId)).limit(1);
      return t ? `${t.ws}/${t.team}` : null;
    }
    if (scopeType === 'WORKSPACE') {
      const [w] = await this.db.select({ ws: workspaces.slug }).from(workspaces).where(eq(workspaces.id, scopeId)).limit(1);
      return w?.ws ?? null;
    }
    return null;
  }

  /**
   * The cell's built-in registry, made visible at a workspace, team or project: images of every service below live
   * under <host>/<namespace>/…/<service>, are scanned on push and promoted per environment. No credentials are stored:
   * CI logs in with its CI token (`matelot registry login`), people with a personal token.
   */
  private async createMatelotRegistry(user: AuthenticatedUser, orgChain: ScopeChain, target: ScopeChain, dto: CreateIntegrationDto) {
    if (!this.registryHost) throw new BadRequestException('This Matelot cell has no built-in registry (REGISTRY_HOST is not set)');
    if (!['WORKSPACE', 'TEAM', 'PROJECT'].includes(target.target.type)) throw new BadRequestException('Create the Matelot registry at a workspace, team or project: its images are namespaced by that level');
    const namespace = await this.registryNamespace(target.target.type, target.target.id);
    if (!namespace) throw new BadRequestException('Level not found');
    const [existing] = await this.db.select().from(integrations).where(and(eq(integrations.provider, 'matelot'), eq(integrations.scopeType, target.target.type), eq(integrations.scopeId, target.target.id))).limit(1);
    if (existing) return { ...publicView(existing), scope: await this.describeScope(existing) };
    const [integration] = await this.db.insert(integrations).values({
      organizationId: orgChain.organizationId, scopeType: target.target.type, scopeId: target.target.id, provider: 'matelot', authType: 'none',
      name: dto.name || `Matelot registry · ${namespace}`, status: 'connected', externalAccountId: `matelot:${target.target.id}`,
      settings: { baseUrl: this.registryHost, namespace, builtin: true }, credentialsEncrypted: null, createdById: user.id,
    }).returning();
    await this.audit.record({ organizationId: orgChain.organizationId, actor: userActor(user), action: 'integration.connected', resourceType: 'integration', resourceId: integration.id, after: publicView(integration), reason: `built-in registry namespace ${namespace}` });
    return { ...publicView(integration), scope: await this.describeScope(integration) };
  }

  /** Repositories of a Matelot registry connection: one per service below its level, plus one per environment. */
  async matelotRepositories(user: AuthenticatedUser, integrationId: string) {
    const integration = await this.get(integrationId);
    await this.assertOn(user, integration, 'repository:read');
    if (integration.provider !== 'matelot') throw new BadRequestException('Not a Matelot registry connection');
    const cond = integration.scopeType === 'PROJECT' ? eq(projects.id, integration.scopeId!) : integration.scopeType === 'TEAM' ? eq(teams.id, integration.scopeId!) : eq(workspaces.id, integration.scopeId!);
    const rows = await this.db.select({ id: services.id, name: services.name, service: services.slug, project: projects.slug, projectName: projects.name, team: teams.slug, ws: workspaces.slug })
      .from(services).innerJoin(projects, eq(services.projectId, projects.id)).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .where(and(cond, sql`${services.archivedAt} is null`));
    return { host: this.registryHost, namespace: String(integration.settings.namespace ?? ''), repositories: rows.map((r) => ({ serviceId: r.id, service: r.name, project: r.projectName, repository: `${r.ws}/${r.team}/${r.project}/${r.service}` })) };
  }

  /** Install link for a connection that has its own App (or the platform App): completes the connection. */
  async installUrlFor(user: AuthenticatedUser, integrationId: string): Promise<{ url: string }> {
    const integration = await this.get(integrationId);
    await this.assertOn(user, integration, 'integration:connect');
    const cfg = this.githubSync.appConfigFor(integration);
    const state = this.crypto.signState({ organizationId: integration.organizationId, userId: user.id, scopeType: integration.scopeType, scopeId: integration.scopeId ?? integration.organizationId, integrationId: integration.id } satisfies InstallState, 15 * 60);
    return { url: this.github.installUrl(state, cfg) };
  }

  /**
   * Deploy-key flow: the platform generates the key pair and stores the private half encrypted.
   * The connection stays pending (unverified) until the team has added the public key on the host
   * and calls verify.
   */
  private async createWithGeneratedKey(user: AuthenticatedUser, orgChain: ScopeChain, target: ScopeChain, dto: CreateIntegrationDto) {
    if (dto.provider !== 'git' || !dto.repositoryUrl) throw new BadRequestException('A generated deploy key needs provider git and a repositoryUrl');
    const key = generateDeployKey(`secops-platform ${target.target.type.toLowerCase()}`);
    await this.replaceDisconnected('git', `${target.target.id}:${dto.repositoryUrl}`);
    const [integration] = await this.db
      .insert(integrations)
      .values({
        organizationId: orgChain.organizationId,
        scopeType: target.target.type,
        scopeId: target.target.id,
        provider: 'git',
        authType: 'ssh',
        name: dto.name || repositoryNameFromUrl(dto.repositoryUrl),
        status: 'pending',
        externalAccountId: `${target.target.id}:${dto.repositoryUrl}`,
        settings: { repositoryUrl: dto.repositoryUrl, publicKey: key.publicKeyOpenSsh, fingerprint: key.fingerprint, verified: false },
        credentialsEncrypted: this.crypto.encrypt(JSON.stringify({ type: 'ssh', privateKey: key.privateKeyPem } satisfies IntegrationCredentials)),
        createdById: user.id,
      })
      .returning();
    await this.audit.record({ organizationId: orgChain.organizationId, actor: userActor(user), action: 'integration.key_generated', resourceType: 'integration', resourceId: integration.id, after: { repositoryUrl: dto.repositoryUrl, fingerprint: key.fingerprint } });
    return { ...publicView(integration), scope: await this.describeScope(integration), publicKey: key.publicKeyOpenSsh, fingerprint: key.fingerprint };
  }

  /** Re-runs the connection check with the stored credentials; on success the connection goes live. */
  /** Keyless connections: what to configure on the cloud side (issuer, subject, audience, steps) for this connection. */
  async identityFor(user: AuthenticatedUser, integrationId: string, issuer: string) {
    const integration = await this.get(integrationId);
    await this.assertOn(user, integration, 'repository:read');
    const subject = `integration:${integration.id}`;
    const url = new URL(issuer);
    // AWS condition keys are the issuer without scheme (host + path), e.g. matelot.example.com:sub
    const awsKey = `${url.host}${url.pathname.replace(/\/$/, '')}`;
    const publicIssuer = /^https:\/\//.test(issuer) && !/^https:\/\/(localhost|127\.|10\.|192\.168\.)/.test(issuer);
    const keyless = isKeylessAuth(String(integration.authType));
    // Fill in the concrete values from the stored (non-secret) keyless settings where we have them.
    let creds: IntegrationCredentials | null = null;
    if (keyless) { try { creds = this.sourceSync.credentialsOf(integration); } catch { creds = null; } }
    // disconnected: credentials are gone, the non-secret parameters live on in settings
    if (keyless && (!creds || creds.type === 'none')) {
      const p = (integration.settings.keylessParams ?? {}) as Record<string, string>;
      const t = String(integration.authType);
      creds = t === 'gcp_wif' && p.provider ? { type: 'gcp_wif', integrationId: integration.id, provider: p.provider, serviceAccount: p.serviceAccount ?? '' }
        : t === 'aws_wif' && p.roleArn ? { type: 'aws_wif', integrationId: integration.id, roleArn: p.roleArn, region: p.region ?? '' }
        : t === 'azure_wif' && p.clientId ? { type: 'azure_wif', integrationId: integration.id, tenantId: p.tenantId ?? '', clientId: p.clientId }
        : null;
    }
    const gcpProvider = creds?.type === 'gcp_wif' ? creds.provider : 'projects/NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER';
    const gcpPool = gcpProvider.replace(/\/providers\/[^/]+$/, '');
    const gcpPrincipal = `principal://iam.googleapis.com/${gcpPool}/subject/${subject}`;
    const gcpSa = creds?.type === 'gcp_wif' ? creds.serviceAccount : 'NAME@PROJECT.iam.gserviceaccount.com';
    const awsAccount = creds?.type === 'aws_wif' ? (creds.roleArn.split(':')[4] || 'ACCOUNT') : 'ACCOUNT';
    const awsProviderArn = `arn:aws:iam::${awsAccount}:oidc-provider/${awsKey}`;
    const awsTrustPolicy = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Federated: awsProviderArn }, Action: 'sts:AssumeRoleWithWebIdentity', Condition: { StringEquals: { [`${awsKey}:aud`]: 'sts.amazonaws.com', [`${awsKey}:sub`]: subject } } }],
    };
    const azureClient = creds?.type === 'azure_wif' ? creds.clientId : 'CLIENT_ID';
    const verifyStep = `Verify the connection (Manage → Identity → Verify, or: matelot connection verify --id ${integration.id})`;
    return {
      issuer, subject, authType: integration.authType, keyless, status: integration.status, disconnected: integration.status === 'disconnected',
      params: keyless && creds ? keylessParams(creds) : null,
      verified: integration.settings.verified === true, verifiedAt: (integration.settings.verifiedAt as string | undefined) ?? null, lastError: integration.lastError,
      jwksUri: `${issuer}/.well-known/jwks.json`, openidConfiguration: `${issuer}/.well-known/openid-configuration`,
      warning: publicIssuer ? null : 'The issuer is not a public HTTPS URL: clouds must fetch its JWKS. Set API_PUBLIC_URL to the public HTTPS address of this cell (a tunnel works for testing).',
      gcp: { audience: `https://iam.googleapis.com/${gcpProvider}`, principal: gcpPrincipal, steps: [
        `IAM → Workload Identity Federation → create a pool, then an OIDC provider: issuer ${issuer}, audience "Default audience", attribute mapping google.subject = assertion.sub`,
        `Service account ${gcpSa} → Permissions → grant roles/iam.workloadIdentityUser to ${gcpPrincipal}`,
        `  gcloud iam service-accounts add-iam-policy-binding ${gcpSa} --role=roles/iam.workloadIdentityUser --member="${gcpPrincipal}"`,
        'Give that service account Artifact Registry Reader (pull) or Writer (push) on the repository',
        verifyStep,
      ] },
      aws: { audience: 'sts.amazonaws.com', providerArn: awsProviderArn, trustPolicy: awsTrustPolicy, steps: [
        `IAM → Identity providers → add OpenID Connect: provider URL ${issuer}, audience sts.amazonaws.com`,
        `IAM role trust policy (exact subject ${subject}): ${JSON.stringify(awsTrustPolicy)}`,
        'Attach AmazonEC2ContainerRegistryReadOnly (pull) or a policy with push rights',
        verifyStep,
      ] },
      azure: { audience: 'api://AzureADTokenExchange', steps: [
        `App registration ${azureClient} → Certificates & secrets → Federated credentials → Add → "Other issuer": issuer ${issuer}, subject identifier ${subject} (exact match), audience api://AzureADTokenExchange`,
        `  az ad app federated-credential create --id ${azureClient} --parameters '${JSON.stringify({ name: `matelot-${integration.id.slice(0, 8)}`, issuer, subject, audiences: ['api://AzureADTokenExchange'] })}'`,
        'Container registry → Access control (IAM): AcrPull (or AcrPush) for that app registration',
        verifyStep,
      ] },
    };
  }

  /**
   * Re-checks a stored connection with its real identity: git deploy keys (after the key was added on the host) and
   * registries — in particular keyless ones, which can only be checked once the connection id (the OIDC subject) exists.
   */
  async verify(user: AuthenticatedUser, integrationId: string) {
    const integration = await this.get(integrationId);
    await this.assertOn(user, integration, 'integration:write');
    if (integration.provider !== 'git' && integration.provider !== 'registry') {
      throw new BadRequestException(`${integration.provider} connections are checked when they are created or synced; verify applies to git and registry connections`);
    }
    if (integration.status === 'disconnected') throw new BadRequestException('The connection is disconnected; create it again');
    const credentials = this.sourceSync.credentialsOf(integration);
    let account: string;
    try {
      account = await this.sourceSync.probe(integration.provider, integration.settings, credentials);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.update(integrations).set({ lastError: message, settings: { ...integration.settings, verified: false } }).where(eq(integrations.id, integration.id));
      await this.audit.record({ organizationId: integration.organizationId, actor: userActor(user), action: 'integration.verify_failed', resourceType: 'integration', resourceId: integration.id, after: { error: message } });
      throw new BadRequestException(`Connection check failed: ${message}`);
    }
    const { pendingReason: _cleared, ...kept } = integration.settings as Record<string, unknown>;
    const params = keylessParams(credentials);
    const [after] = await this.db.update(integrations)
      .set({ status: integration.status === 'connected' ? 'connected' : 'pending', lastError: null, settings: { ...kept, ...(params ? { keylessParams: params } : {}), verified: true, verifiedAt: new Date().toISOString(), account } })
      .where(eq(integrations.id, integration.id)).returning();
    await this.audit.record({ organizationId: integration.organizationId, actor: userActor(user), action: 'integration.verified', resourceType: 'integration', resourceId: integration.id, after: { account } });
    await this.queue.enqueue(QUEUES.githubSync, { integrationId: integration.id }, { jobId: `sync-${integration.id}-${Date.now()}` });
    return { ...publicView(after), scope: await this.describeScope(after), account, verified: true };
  }

  async create(user: AuthenticatedUser, orgChain: ScopeChain, dto: CreateIntegrationDto) {
    const target = await this.targetChain(user, orgChain, dto.scopeType, dto.scopeId);
    if (dto.provider === 'github') return this.createOwnGithubApp(user, orgChain, target, dto);
    if (dto.provider === 'matelot') return this.createMatelotRegistry(user, orgChain, target, dto);
    if (dto.auth.type === 'ssh' && dto.auth.generateKey) return this.createWithGeneratedKey(user, orgChain, target, dto);
    const credentials = this.toCredentials(dto);
    const settings: Record<string, unknown> = { baseUrl: dto.baseUrl ?? null, owner: dto.owner ?? null, repositoryUrl: dto.repositoryUrl ?? null };
    if (isKeylessAuth(credentials.type)) return this.createKeyless(user, orgChain, target, dto, credentials, settings);
    let account: string;
    try {
      account = await this.sourceSync.probe(dto.provider, settings, credentials);
    } catch (error) {
      throw new BadRequestException(`Connection check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (dto.provider !== 'registry') await this.replaceDisconnected(dto.provider, dto.provider === 'git' ? `${target.target.id}:${dto.repositoryUrl}` : `${dto.baseUrl ?? dto.provider}:${account}:${target.target.id}`);
    const [integration] = await this.db
      .insert(integrations)
      .values({
        organizationId: orgChain.organizationId,
        scopeType: target.target.type,
        scopeId: target.target.id,
        provider: dto.provider,
        authType: credentials.type,
        name: dto.name,
        status: 'pending',
        externalAccountId: dto.provider === 'git' ? `${target.target.id}:${dto.repositoryUrl}` : dto.provider === 'registry' ? `registry:${account}:${target.target.id}:${Date.now()}` : `${dto.baseUrl ?? dto.provider}:${account}:${target.target.id}`,
        settings: { ...settings, account },
        credentialsEncrypted: credentials.type === 'none' ? null : this.crypto.encrypt(JSON.stringify(credentials)),
        createdById: user.id,
      })
      .returning();
    await this.audit.record({ organizationId: orgChain.organizationId, actor: userActor(user), action: 'integration.connected', resourceType: 'integration', resourceId: integration.id, after: publicView(integration) });
    await this.queue.enqueue(QUEUES.githubSync, { integrationId: integration.id });
    return { ...publicView(integration), scope: await this.describeScope(integration) };
  }

  /**
   * Keyless (workload identity) registry: the cloud trusts the subject integration:<connection id>, so the row must
   * exist before anything can be checked. Stored unverified with no probe and no sync; the caller gets the identity
   * setup and checks it with POST /integrations/:id/verify once the trust is configured in the cloud.
   */
  private async createKeyless(user: AuthenticatedUser, orgChain: ScopeChain, target: ScopeChain, dto: CreateIntegrationDto, credentials: IntegrationCredentials, settings: Record<string, unknown>) {
    if (dto.provider !== 'registry') throw new BadRequestException('Keyless auth is only available for registry connections (GAR, ECR, ACR)');
    if (!dto.baseUrl) throw new BadRequestException('Registry host is required');
    const host = dto.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const [integration] = await this.db
      .insert(integrations)
      .values({
        organizationId: orgChain.organizationId,
        scopeType: target.target.type,
        scopeId: target.target.id,
        provider: 'registry',
        authType: credentials.type,
        name: dto.name,
        status: 'pending',
        externalAccountId: `registry:${host}:${target.target.id}:${Date.now()}`,
        settings: { ...settings, keyless: true, verified: false, account: null, keylessParams: keylessParams(credentials), pendingReason: 'configure the cloud trust for this connection (Manage → Identity), then Verify' },
        // integrationId is derived from the row at read time (SourceSyncService.credentialsOf); never persisted as 'pending'
        credentialsEncrypted: this.crypto.encrypt(JSON.stringify({ ...credentials, integrationId: undefined })),
        createdById: user.id,
      })
      .returning();
    await this.audit.record({ organizationId: orgChain.organizationId, actor: userActor(user), action: 'integration.connected', resourceType: 'integration', resourceId: integration.id, after: { ...publicView(integration), keyless: true, verified: false } });
    return { ...publicView(integration), scope: await this.describeScope(integration), keyless: true, verified: false };
  }

  private toCredentials(dto: CreateIntegrationDto): IntegrationCredentials {
    const a = dto.auth;
    switch (a.type) {
      case 'app':
        throw new BadRequestException('App credentials are only valid for provider github');
      case 'token':
        if (!a.token) throw new BadRequestException('auth.token is required');
        return { type: 'token', token: a.token, username: a.username };
      case 'basic':
        if (!a.username || !a.password) throw new BadRequestException('auth.username and auth.password are required');
        return { type: 'basic', username: a.username, password: a.password };
      case 'ssh':
        if (!a.privateKey) throw new BadRequestException('auth.privateKey is required');
        return { type: 'ssh', privateKey: a.privateKey };
      case 'aws':
        if (!a.accessKeyId || !a.secretAccessKey || !a.region) throw new BadRequestException('auth.accessKeyId, auth.secretAccessKey and auth.region are required');
        return { type: 'aws', accessKeyId: a.accessKeyId, secretAccessKey: a.secretAccessKey, region: a.region };
      case 'azure':
        if (!a.tenantId || !a.clientId || !a.clientSecret) throw new BadRequestException('auth.tenantId, auth.clientId and auth.clientSecret are required');
        return { type: 'azure', tenantId: a.tenantId, clientId: a.clientId, clientSecret: a.clientSecret };
      // Keyless (workload identity federation): nothing secret stored; the connection id becomes the OIDC subject.
      case 'gcp_wif':
        if (!a.provider || !a.serviceAccount) throw new BadRequestException('auth.provider (projects/NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER) and auth.serviceAccount are required');
        return { type: 'gcp_wif', integrationId: '', provider: a.provider, serviceAccount: a.serviceAccount };
      case 'aws_wif':
        if (!a.roleArn || !a.region) throw new BadRequestException('auth.roleArn and auth.region are required');
        return { type: 'aws_wif', integrationId: '', roleArn: a.roleArn, region: a.region };
      case 'azure_wif':
        if (!a.tenantId || !a.clientId) throw new BadRequestException('auth.tenantId and auth.clientId are required');
        return { type: 'azure_wif', integrationId: '', tenantId: a.tenantId, clientId: a.clientId };
      case 'gcp': {
        if (!a.serviceAccountJson) throw new BadRequestException('auth.serviceAccountJson (the service-account key file) is required');
        let key: { client_email?: string; private_key?: string; project_id?: string };
        try { key = JSON.parse(a.serviceAccountJson); } catch { throw new BadRequestException('auth.serviceAccountJson is not valid JSON'); }
        if (!key.client_email || !key.private_key) throw new BadRequestException('The service-account key needs client_email and private_key');
        return { type: 'gcp', clientEmail: key.client_email, privateKey: key.private_key, projectId: key.project_id };
      }
      default:
        return { type: 'none' };
    }
  }

  /** Integrations of the organization the user may read (each checked at its own level), with scope names. */
  async listForOrganization(user: AuthenticatedUser, orgChain: ScopeChain) {
    const rows = await this.db.select().from(integrations).where(eq(integrations.organizationId, orgChain.organizationId)).orderBy(asc(integrations.createdAt));
    const ctx = await this.access.forUser(user.id);
    const out = [];
    for (const row of rows) {
      const chain = await this.chainOf(row);
      if (!chain || !this.authz.can(ctx, 'integration:read', chain)) continue;
      out.push({ ...publicView(row), scope: await this.describeScope(row) });
    }
    return out;
  }

  /** Integrations that apply to a project: its own plus those inherited from team, workspace and organization. */
  async listForChain(user: AuthenticatedUser, chain: ScopeChain) {
    const ctx = await this.access.forUser(user.id);
    if (!this.authz.can(ctx, 'integration:read', chain)) return [];
    const rows = await this.db.select().from(integrations).where(eq(integrations.organizationId, chain.organizationId));
    const refs = new Set(chain.refs.map((r) => `${r.type}:${r.id}`));
    const applicable = rows.filter((r) => refs.has(`${r.scopeType}:${r.scopeId ?? r.organizationId}`));
    const out = [];
    for (const row of applicable) out.push({ ...publicView(row), scope: await this.describeScope(row), inherited: `${row.scopeType}:${row.scopeId ?? row.organizationId}` !== `${chain.target.type}:${chain.target.id}` });
    return out;
  }

  private chainOf(integration: Integration): Promise<ScopeChain | null> {
    return this.resolver.resolveChain(scopeParamsFor(integration.scopeType, integration.scopeId ?? integration.organizationId)).catch(() => null);
  }

  private async describeScope(integration: Integration): Promise<{ type: ScopeType; id: string; name: string }> {
    const id = integration.scopeId ?? integration.organizationId;
    const table = { ORGANIZATION: null, WORKSPACE: workspaces, TEAM: teams, PROJECT: projects, SERVICE: services, ENVIRONMENT: null }[integration.scopeType];
    if (!table) {
      const { organizations } = await import('../database/schema');
      const [org] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, id)).limit(1);
      return { type: 'ORGANIZATION', id, name: org?.name ?? 'organization' };
    }
    const [row] = await this.db.select({ name: table.name }).from(table).where(eq(table.id, id)).limit(1);
    return { type: integration.scopeType, id, name: row?.name ?? integration.scopeType.toLowerCase() };
  }

  /** Resolves and authorizes the level a new connection is created at. */
  private async targetChain(user: AuthenticatedUser, orgChain: ScopeChain, scopeType?: ScopeType, scopeId?: string): Promise<ScopeChain> {
    let chain = orgChain;
    if (scopeType && scopeType !== 'ORGANIZATION') {
      if (!scopeId) throw new BadRequestException('scopeId is required for a non-organization scope');
      chain = await this.resolver.resolveChain(scopeParamsFor(scopeType, scopeId));
      if (chain.organizationId !== orgChain.organizationId) throw new BadRequestException('Scope belongs to another organization');
    }
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, 'integration:connect', chain);
    // an organization-wide connection is inherited by every project: only an organization owner (ORG_ADMIN — sudo or
    // the web session) creates one; below the organization a write token of a developer / team lead is enough
    if (!scopeType || scopeType === 'ORGANIZATION') this.authz.assert(ctx, 'organization:write', orgChain);
    return chain;
  }

  async get(integrationId: string): Promise<Integration> {
    const [integration] = await this.db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
    if (!integration) throw new NotFoundException('Integration not found');
    return integration;
  }

  /** Where to send the browser to install the GitHub App for this organization. */
  async githubInstallUrl(user: AuthenticatedUser, orgChain: ScopeChain, scopeType?: ScopeType, scopeId?: string): Promise<{ url: string }> {
    const target = await this.targetChain(user, orgChain, scopeType, scopeId);
    const state = this.crypto.signState({ organizationId: orgChain.organizationId, userId: user.id, scopeType: target.target.type, scopeId: target.target.id } satisfies InstallState, 15 * 60);
    return { url: this.github.installUrl(state) };
  }

  /** GitHub sends the browser back here after installation; the signed state ties it to an org + user. */
  async githubCallback(installationId: string, state: string | undefined, setupAction?: string): Promise<string> {
    const parsed = state ? this.crypto.verifyState<InstallState>(state) : null;
    if (!parsed) return `${this.webBaseUrl}/connections?error=${state ? 'expired_state' : 'invalid_state'}&installation=${encodeURIComponent(installationId)}`;

    if (parsed.integrationId) {
      // Team-registered App: attach the installation to the pending connection.
      const [pending] = await this.db.select().from(integrations).where(eq(integrations.id, parsed.integrationId)).limit(1);
      if (!pending) return `${this.webBaseUrl}/integrations?error=unknown_connection`;
      const cfg = this.githubSync.appConfigFor(pending);
      const info = await this.github.installationPermissions(installationId, cfg).catch(() => null);
      const [done] = await this.db
        .update(integrations)
        .set({ externalAccountId: installationId, status: 'pending', lastError: null, name: info ? `GitHub · ${info.account.login}` : pending.name, settings: { ...pending.settings, account: info?.account ?? null, permissions: info?.permissions ?? null, targetType: info?.targetType ?? null, pendingReason: null } })
        .where(eq(integrations.id, pending.id))
        .returning();
      await this.audit.record({ organizationId: pending.organizationId, actor: { type: 'USER', id: parsed.userId }, action: 'integration.connected', resourceType: 'integration', resourceId: done.id, after: publicView(done) });
      await this.queue.enqueue(QUEUES.githubSync, { integrationId: done.id });
      return this.returnUrl(done, parsed);
    }

    const info = await this.github.installation(installationId).catch(() => null);
    const name = info ? `GitHub · ${info.account.login}` : `GitHub installation ${installationId}`;

    const [existing] = await this.db.select().from(integrations).where(and(eq(integrations.provider, 'github'), eq(integrations.externalAccountId, installationId))).limit(1);
    let integration: Integration;
    if (existing) {
      [integration] = await this.db.update(integrations).set({ status: 'pending', name, lastError: null, organizationId: parsed.organizationId, scopeType: parsed.scopeType ?? 'ORGANIZATION', scopeId: parsed.scopeId ?? parsed.organizationId }).where(eq(integrations.id, existing.id)).returning();
    } else {
      [integration] = await this.db
        .insert(integrations)
        .values({ organizationId: parsed.organizationId, scopeType: parsed.scopeType ?? 'ORGANIZATION', scopeId: parsed.scopeId ?? parsed.organizationId, provider: 'github', name, status: 'pending', externalAccountId: installationId, createdById: parsed.userId, settings: { account: info?.account ?? null, setupAction: setupAction ?? null } })
        .returning();
    }
    await this.audit.record({
      organizationId: parsed.organizationId,
      actor: { type: 'USER', id: parsed.userId },
      action: existing ? 'integration.reconnected' : 'integration.connected',
      resourceType: 'integration',
      resourceId: integration.id,
      after: publicView(integration),
    });
    await this.queue.enqueue(QUEUES.githubSync, { integrationId: integration.id });
    return this.returnUrl(integration, parsed);
  }

  /** Back to where the team started: the project page for project-level connections, else Integrations. */
  private returnUrl(integration: Integration, state: InstallState): string {
    if (state.scopeType === 'PROJECT' && state.scopeId) return `${this.webBaseUrl}/projects/${state.scopeId}?connected=${integration.id}`;
    return `${this.webBaseUrl}/integrations?connected=${integration.id}`;
  }

  async requestSync(user: AuthenticatedUser, integrationId: string): Promise<{ queued: true }> {
    const integration = await this.get(integrationId);
    await this.assertOn(user, integration, 'integration:write');
    await this.queue.enqueue(QUEUES.githubSync, { integrationId: integration.id }, { jobId: `sync-${integration.id}-${Date.now()}` });
    await this.audit.record({ organizationId: integration.organizationId, actor: userActor(user), action: 'integration.sync_requested', resourceType: 'integration', resourceId: integration.id });
    return { queued: true };
  }

  /** A previous, disconnected connection to the same account/repository is replaced; a live one is reported. */
  private async replaceDisconnected(provider: Integration['provider'], externalAccountId: string): Promise<void> {
    const [existing] = await this.db.select().from(integrations).where(and(eq(integrations.provider, provider), eq(integrations.externalAccountId, externalAccountId))).limit(1);
    if (!existing) return;
    if (existing.status !== 'disconnected') throw new BadRequestException(`This repository or account is already connected as "${existing.name}". Delete that connection first, or attach its repositories.`);
    await this.db.delete(integrations).where(eq(integrations.id, existing.id));
  }

  /**
   * Permanent removal: the connection, its repositories and their service links (cascade). Container images that pull
   * through it would silently lose their credentials, so they are listed in a 409 unless `force` detaches them
   * (integrationId → null; their next sync looks for another connection to the same host).
   */
  async remove(user: AuthenticatedUser, integrationId: string, opts: { force?: boolean } = {}) {
    const integration = await this.get(integrationId);
    await this.assertOn(user, integration, 'integration:connect');
    const images = await this.db.select({ id: containerImages.id, name: containerImages.name }).from(containerImages).where(eq(containerImages.integrationId, integration.id));
    if (images.length && !opts.force) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `${images.length} container image(s) pull through "${integration.name}": ${images.slice(0, 10).map((i) => i.name).join(', ')}${images.length > 10 ? ', …' : ''}. Delete with force to detach them (their next sync looks for another connection to the same registry), or disconnect instead.`,
        images: images.map((i) => i.name),
      });
    }
    const repos = await this.db.select({ id: repositories.id }).from(repositories).where(eq(repositories.integrationId, integration.id));
    await this.db.transaction(async (tx) => {
      if (images.length) await tx.update(containerImages).set({ integrationId: null }).where(eq(containerImages.integrationId, integration.id));
      await tx.delete(integrations).where(eq(integrations.id, integration.id));
    });
    await this.audit.record({ organizationId: integration.organizationId, actor: userActor(user), action: 'integration.deleted', resourceType: 'integration', resourceId: integration.id, before: publicView(integration), after: { repositories: repos.length, imagesDetached: images.map((i) => i.name) } });
    return { deleted: true as const, id: integration.id, name: integration.name, repositories: repos.length, imagesDetached: images.map((i) => i.name) };
  }

  /** Keeps the row (and its repositories) but forgets the credentials; keyless parameters stay visible in settings. */
  async disconnect(user: AuthenticatedUser, integrationId: string) {
    const integration = await this.get(integrationId);
    await this.assertOn(user, integration, 'integration:write');
    if (integration.status === 'disconnected') return publicView(integration);
    let params: Record<string, string> | null = null;
    try { params = keylessParams(this.sourceSync.credentialsOf(integration)); } catch { params = null; }
    const { pendingReason: _p, ...kept } = integration.settings as Record<string, unknown>;
    const [after] = await this.db.update(integrations).set({ status: 'disconnected', credentialsEncrypted: null, settings: { ...kept, ...(params ? { keylessParams: params } : {}) } }).where(eq(integrations.id, integration.id)).returning();
    await this.audit.record({ organizationId: integration.organizationId, actor: userActor(user), action: 'integration.disconnected', resourceType: 'integration', resourceId: integration.id, before: publicView(integration), after: publicView(after) });
    return publicView(after);
  }

  async repositoriesOfIntegration(user: AuthenticatedUser, integrationId: string) {
    const integration = await this.get(integrationId);
    await this.assertOn(user, integration, 'repository:read');
    return this.db.select().from(repositories).where(eq(repositories.integrationId, integration.id)).orderBy(asc(repositories.fullName));
  }

  /** Repository inventory of the organization (integrations the user may read), with the services each repository is attached to. */
  async repositoriesOfOrganization(user: AuthenticatedUser, orgChain: ScopeChain) {
    const visible = await this.listForOrganization(user, orgChain);
    return this.repositoriesOf(visible.map((i) => ({ id: i.id, scope: i.scope })));
  }

  /** Registry connections on a scope's path (for pipelines: which registries a service can use). */
  async registriesForChain(chain: ScopeChain) {
    const rows = await this.db.select().from(integrations).where(and(eq(integrations.organizationId, chain.organizationId), eq(integrations.provider, 'registry')));
    const refs = new Set(chain.refs.map((r) => `${r.type}:${r.id}`));
    return rows
      .filter((r) => refs.has(`${r.scopeType}:${r.scopeId ?? r.organizationId}`) && r.status !== 'disconnected')
      .map((r) => ({ id: r.id, name: r.name, host: String(r.settings.baseUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, ''), type: r.authType === 'aws' ? 'ecr' : r.authType === 'azure' ? 'acr' : 'registry', authType: r.authType, level: r.scopeType.toLowerCase() }));
  }

  /** Short-lived Docker credentials for a registry connection on the caller's path (CI tokens: registry:pull). ECR/ACR secrets never leave the platform. */
  async dockerCredentials(user: AuthenticatedUser, chain: ScopeChain, integrationId: string) {
    const [row] = await this.db.select().from(integrations).where(and(eq(integrations.id, integrationId), eq(integrations.provider, 'registry'))).limit(1);
    if (!row) throw new NotFoundException('Registry connection not found');
    const refs = new Set(chain.refs.map((r) => `${r.type}:${r.id}`));
    if (!refs.has(`${row.scopeType}:${row.scopeId ?? row.organizationId}`)) throw new ForbiddenException('This registry connection is not available on your path');
    if (row.status === 'disconnected') throw new BadRequestException('Connection is disconnected');
    const host = String(row.settings.baseUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const creds = this.sourceSync.credentialsOf(row);
    if (creds.type !== 'aws' && creds.type !== 'azure' && creds.type !== 'gcp' && creds.type !== 'token' && creds.type !== 'basic') throw new BadRequestException('This connection has no credentials to hand out');
    const docker = await dockerCredentialsFor(host, creds, `integration:${row.id}`);
    if (!docker) throw new BadRequestException('Could not obtain registry credentials');
    await this.audit.record({ organizationId: row.organizationId, actor: userActor(user), action: 'registry.credentials_issued', resourceType: 'integration', resourceId: row.id, after: { host, type: creds.type, expiresAt: docker.expiresAt } });
    // Static tokens are handed out as-is only to CI tokens explicitly allowed to pull; short-lived ones are the norm.
    return { host, username: docker.username, password: docker.password, expiresAt: docker.expiresAt, type: creds.type === 'aws' ? 'ecr' : creds.type === 'azure' ? 'acr' : 'registry' };
  }

  private async ecrCredsOf(user: AuthenticatedUser, integrationId: string, permission: Permission) {
    const [row] = await this.db.select().from(integrations).where(and(eq(integrations.id, integrationId), eq(integrations.provider, 'registry'))).limit(1);
    if (!row) throw new NotFoundException('Registry connection not found');
    const chain = await this.resolver.resolveChain(scopeParamsFor(row.scopeType, row.scopeId ?? row.organizationId));
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, permission, chain);
    const creds = this.sourceSync.credentialsOf(row);
    if (creds.type !== 'aws') throw new BadRequestException('Only AWS ECR connections can list or create repositories here');
    return { row, creds };
  }

  /** ECR: repositories of the connected account/region. */
  async ecrRepositories(user: AuthenticatedUser, integrationId: string) {
    const { creds } = await this.ecrCredsOf(user, integrationId, 'integration:read');
    return ecrListRepositories(creds);
  }

  /** ECR: create a repository with the connection's key (needs ecr:CreateRepository). */
  async ecrCreateRepository(user: AuthenticatedUser, integrationId: string, name: string, options: { scanOnPush?: boolean; immutableTags?: boolean }) {
    const { row, creds } = await this.ecrCredsOf(user, integrationId, 'integration:write');
    if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)) throw new BadRequestException('Repository names are lowercase, e.g. team/app or app');
    const repo = await ecrCreateRepository(creds, name, options);
    await this.audit.record({ organizationId: row.organizationId, actor: userActor(user), action: 'registry.repository_created', resourceType: 'integration', resourceId: row.id, after: { repository: repo.repositoryUri, scanOnPush: options.scanOnPush ?? true, immutableTags: !!options.immutableTags } });
    return repo;
  }

  /** CI path: create-if-missing on a connection that sits on the service's path (authorisation = registry:push on the service, checked by the guard). */
  async ecrEnsureRepository(user: AuthenticatedUser, chain: ScopeChain, integrationId: string, name: string, options: { scanOnPush?: boolean; immutableTags?: boolean }) {
    const [row] = await this.db.select().from(integrations).where(and(eq(integrations.id, integrationId), eq(integrations.provider, 'registry'))).limit(1);
    if (!row) throw new NotFoundException('Registry connection not found');
    const refs = new Set(chain.refs.map((r) => `${r.type}:${r.id}`));
    if (!refs.has(`${row.scopeType}:${row.scopeId ?? row.organizationId}`)) throw new ForbiddenException('This registry connection is not available on your path');
    const creds = this.sourceSync.credentialsOf(row);
    if (creds.type !== 'aws') throw new BadRequestException('Only AWS ECR needs repositories created; other registries create them on first push');
    if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)) throw new BadRequestException('Repository names are lowercase, e.g. team/app or app');
    const repo = await ecrCreateRepository(creds, name, options);
    await this.audit.record({ organizationId: row.organizationId, actor: userActor(user), action: 'registry.repository_created', resourceType: 'integration', resourceId: row.id, after: { repository: repo.repositoryUri, scanOnPush: options.scanOnPush ?? true, immutableTags: !!options.immutableTags, from: 'ci' } });
    return repo;
  }

  /** Repositories available to a project: from its own connections and the inherited ones. */
  async repositoriesOfChain(user: AuthenticatedUser, chain: ScopeChain) {
    const applicable = await this.listForChain(user, chain);
    return this.repositoriesOf(applicable.map((i) => ({ id: i.id, scope: i.scope })));
  }

  private async repositoriesOf(list: { id: string; scope: { type: ScopeType; id: string; name: string } }[]) {
    if (!list.length) return [];
    const scopeById = new Map(list.map((i) => [i.id, i.scope]));
    const rows = await this.db
      .select({ repository: repositories, integrationName: integrations.name, integrationStatus: integrations.status })
      .from(repositories)
      .innerJoin(integrations, eq(repositories.integrationId, integrations.id))
      .where(inArray(integrations.id, list.map((i) => i.id)))
      .orderBy(asc(repositories.fullName));
    const ids = rows.map((r) => r.repository.id);
    const links = ids.length
      ? await this.db
          .select({ repositoryId: serviceRepositories.repositoryId, role: serviceRepositories.role, serviceId: services.id, serviceName: services.name, projectId: projects.id, projectName: projects.name })
          .from(serviceRepositories)
          .innerJoin(services, eq(serviceRepositories.serviceId, services.id))
          .innerJoin(projects, eq(services.projectId, projects.id))
          .where(inArray(serviceRepositories.repositoryId, ids))
      : [];
    return rows.map((r) => ({ ...r.repository, integrationName: r.integrationName, integrationStatus: r.integrationStatus, integrationScope: scopeById.get(r.repository.integrationId) ?? null, services: links.filter((l) => l.repositoryId === r.repository.id) }));
  }

  async attachRepository(user: AuthenticatedUser, serviceChain: ScopeChain, dto: AttachRepositoryDto) {
    const [repo] = await this.db
      .select({ id: repositories.id, fullName: repositories.fullName, organizationId: integrations.organizationId, scopeType: integrations.scopeType, scopeId: integrations.scopeId })
      .from(repositories)
      .innerJoin(integrations, eq(repositories.integrationId, integrations.id))
      .where(eq(repositories.id, dto.repositoryId))
      .limit(1);
    const onPath = repo && serviceChain.refs.some((r) => r.type === repo.scopeType && r.id === (repo.scopeId ?? repo.organizationId));
    if (!repo || !onPath) throw new BadRequestException('Repository comes from a connection that does not apply to this service (connect it at the project, team, workspace or organization level)');
    const [link] = await this.db
      .insert(serviceRepositories)
      .values({ serviceId: serviceChain.serviceId!, repositoryId: repo.id, role: dto.role ?? 'primary' })
      .onConflictDoUpdate({ target: [serviceRepositories.serviceId, serviceRepositories.repositoryId], set: { role: dto.role ?? 'primary' } })
      .returning();
    await this.audit.record({ organizationId: serviceChain.organizationId, actor: userActor(user), action: 'service.repository_attached', resourceType: 'service', resourceId: serviceChain.serviceId!, after: { repository: repo.fullName, role: link.role } });
    return link;
  }

  async detachRepository(user: AuthenticatedUser, serviceChain: ScopeChain, repositoryId: string): Promise<void> {
    const deleted = await this.db.delete(serviceRepositories).where(and(eq(serviceRepositories.serviceId, serviceChain.serviceId!), eq(serviceRepositories.repositoryId, repositoryId))).returning();
    if (!deleted.length) throw new NotFoundException('Repository is not attached to this service');
    await this.audit.record({ organizationId: serviceChain.organizationId, actor: userActor(user), action: 'service.repository_detached', resourceType: 'service', resourceId: serviceChain.serviceId!, before: { repositoryId } });
  }

  async serviceRepositories(serviceChain: ScopeChain) {
    return this.db
      .select({ role: serviceRepositories.role, attachedAt: serviceRepositories.createdAt, repository: repositories })
      .from(serviceRepositories)
      .innerJoin(repositories, eq(serviceRepositories.repositoryId, repositories.id))
      .where(eq(serviceRepositories.serviceId, serviceChain.serviceId!))
      .orderBy(asc(repositories.fullName));
  }

  private async assertOn(user: AuthenticatedUser, integration: Integration, permission: 'integration:write' | 'integration:connect' | 'repository:read') {
    const chain = (await this.chainOf(integration)) ?? (await this.resolver.resolveChain({ organizationId: integration.organizationId }));
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, permission, chain);
  }

  /** Helper for listings that need the chain of a service's organization workspace. */
  async organizationChainOfService(serviceId: string) {
    const [row] = await this.db.select({ organizationId: workspaces.organizationId }).from(services).innerJoin(projects, eq(services.projectId, projects.id)).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(eq(services.id, serviceId)).limit(1);
    return row?.organizationId;
  }
}
