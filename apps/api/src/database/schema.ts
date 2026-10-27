import { sql } from 'drizzle-orm';
import { AnyPgColumn, bigint, boolean, customType, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const scopeTypeEnum = pgEnum('scope_type', ['ORGANIZATION', 'WORKSPACE', 'TEAM', 'PROJECT', 'SERVICE', 'ENVIRONMENT']);

export const roleEnum = pgEnum('role', [
  'ORG_ADMIN',
  'SECURITY_ADMIN',
  'COMPLIANCE_OFFICER',
  'CISO',
  'CTO',
  'TEAM_LEAD',
  'PRODUCT_SECURITY_ENGINEER',
  'DEVELOPER',
  'AUDITOR',
  'EXTERNAL_CONSULTANT',
  'READ_ONLY',
]);

export const criticalityEnum = pgEnum('criticality', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const actorTypeEnum = pgEnum('actor_type', ['USER', 'SYSTEM', 'AI_AGENT']);

/** Cell-level (instance) role, GitLab-style: admins see and can do everything; users only where they are members. */
export const platformRoleEnum = pgEnum('platform_role', ['user', 'admin']);

export const serviceKindEnum = pgEnum('service_kind', ['api', 'worker', 'web', 'library', 'firmware', 'infrastructure', 'other']);
export const environmentKindEnum = pgEnum('environment_kind', ['development', 'testing', 'staging', 'production']);
export const integrationProviderEnum = pgEnum('integration_provider', ['github', 'github_token', 'gitlab', 'git', 'registry', 'jira', 'bitbucket', 'matelot']);
export const integrationAuthTypeEnum = pgEnum('integration_auth_type', ['app', 'token', 'basic', 'ssh', 'none', 'aws', 'azure', 'gcp', 'gcp_wif', 'aws_wif', 'azure_wif']);
export const integrationStatusEnum = pgEnum('integration_status', ['pending', 'connected', 'error', 'disconnected']);
export const repositoryRoleEnum = pgEnum('repository_role', ['primary', 'secondary']);
export const webhookStatusEnum = pgEnum('webhook_status', ['received', 'processed', 'failed', 'ignored']);

export type ScopeType = (typeof scopeTypeEnum.enumValues)[number];
export type Role = (typeof roleEnum.enumValues)[number];
export type Criticality = (typeof criticalityEnum.enumValues)[number];
export type ActorType = (typeof actorTypeEnum.enumValues)[number];
export type PlatformRole = (typeof platformRoleEnum.enumValues)[number];
export type ServiceKind = (typeof serviceKindEnum.enumValues)[number];
export type EnvironmentKind = (typeof environmentKindEnum.enumValues)[number];
export type IntegrationProvider = (typeof integrationProviderEnum.enumValues)[number];
export type IntegrationStatus = (typeof integrationStatusEnum.enumValues)[number];
export type IntegrationAuthType = (typeof integrationAuthTypeEnum.enumValues)[number];

// ---------------------------------------------------------------------------
// Shared column sets
// ---------------------------------------------------------------------------

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------------------
// Hierarchy: Organization -> Workspace -> Team -> Project
// (Service and Environment are added in the integration step.)
// ---------------------------------------------------------------------------

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** Parent company -> subsidiary, or MSSP -> customer. Permissions inherit downwards. */
    parentId: uuid('parent_id').references((): AnyPgColumn => organizations.id, { onDelete: 'restrict' }),
    /** The Overview's "Get started" checklist was hidden by an administrator (shown again on restore). */
    onboardingDismissedAt: timestamp('onboarding_dismissed_at', { withTimezone: true }),
    /** First time every required setup step was done: from then on the checklist never shows again by itself. */
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
    ...timestamps,
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('organizations_slug_key').on(t.slug), index('organizations_parent_idx').on(t.parentId)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ...timestamps,
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('workspaces_org_slug_key').on(t.organizationId, t.slug)],
);

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ...timestamps,
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('teams_workspace_slug_key').on(t.workspaceId, t.slug)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Business criticality: an input to the risk engine (same CVE, different risk per project). */
    criticality: criticalityEnum('criticality').notNull().default('MEDIUM'),
    /** { automation: { pipelineOnPush: 'default_branch' | 'all' | 'off', template: 'security' } } */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('projects_team_slug_key').on(t.teamId, t.slug)],
);

// ---------------------------------------------------------------------------
// Software catalog: Service -> Environment (step 02)
// ---------------------------------------------------------------------------

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    kind: serviceKindEnum('kind').notNull().default('other'),
    /** Null = inherit the project's criticality. */
    criticality: criticalityEnum('criticality'),
    ...timestamps,
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('services_project_slug_key').on(t.projectId, t.slug)],
);

export const environments = pgTable(
  'environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: environmentKindEnum('kind').notNull(),
    /** Reachable from the internet: a risk-engine input (step 05). */
    internetFacing: boolean('internet_facing').notNull().default(false),
    /** Where it runs: { kubernetesNamespace?, kubernetesContext?, runnerTag? } */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('environments_service_slug_key').on(t.serviceId, t.slug)],
);

// ---------------------------------------------------------------------------
// Integrations & connected resources (step 02)
// ---------------------------------------------------------------------------

/** A connection to an external system, owned by an organization. Credentials never leave the cell. */
export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Level the connection lives at; usable by everything below it. Defaults to the organization. */
    scopeType: scopeTypeEnum('scope_type').notNull().default('ORGANIZATION'),
    scopeId: uuid('scope_id'),
    provider: integrationProviderEnum('provider').notNull(),
    authType: integrationAuthTypeEnum('auth_type').notNull().default('app'),
    name: text('name').notNull(),
    status: integrationStatusEnum('status').notNull().default('pending'),
    /** Provider-side account/installation id (GitHub App installation id). */
    externalAccountId: text('external_account_id'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    credentialsEncrypted: bytea('credentials_encrypted'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('integrations_org_idx').on(t.organizationId), index('integrations_scope_idx').on(t.scopeType, t.scopeId), uniqueIndex('integrations_provider_account_key').on(t.provider, t.externalAccountId)],
);

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch'),
    visibility: text('visibility'),
    archived: boolean('archived').notNull().default(false),
    languages: jsonb('languages').$type<Record<string, number>>(),
    htmlUrl: text('html_url'),
    /** How a runner fetches the code: HTTPS clone URL and/or SSH URL. */
    cloneUrl: text('clone_url'),
    sshUrl: text('ssh_url'),
    /** Snapshot of default-branch protection: the first piece of compliance evidence. */
    branchProtection: jsonb('branch_protection').$type<Record<string, unknown>>(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('repositories_integration_external_key').on(t.integrationId, t.externalId), index('repositories_full_name_idx').on(t.fullName)],
);

export const serviceRepositories = pgTable(
  'service_repositories',
  {
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    role: repositoryRoleEnum('role').notNull().default('primary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('service_repositories_key').on(t.serviceId, t.repositoryId)],
);

/** Every inbound webhook, stored before processing so deliveries are idempotent and replayable. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id').references(() => integrations.id, { onDelete: 'set null' }),
    provider: integrationProviderEnum('provider').notNull(),
    providerDeliveryId: text('provider_delivery_id').notNull(),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    status: webhookStatusEnum('status').notNull().default('received'),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('webhook_deliveries_provider_delivery_key').on(t.provider, t.providerDeliveryId)],
);

// ---------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Keycloak subject. Null until the user's first login (invited-by-email users). */
    externalId: text('external_id'),
    email: text('email').notNull(),
    displayName: text('display_name'),
    platformRole: platformRoleEnum('platform_role').notNull().default('user'),
    /** Blocked users keep their memberships but cannot sign in until re-enabled. */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** human = a person (Keycloak login); service_account = a bot owned by a scope: no password, no browser login,
     *  authenticates only with its personal access tokens (source 'service_account'). */
    kind: text('kind').notNull().default('human'),
    /** Service accounts: the scope that owns them; they can hold memberships only there and below. */
    ownerScopeType: scopeTypeEnum('owner_scope_type'),
    ownerScopeId: uuid('owner_scope_id'),
    description: text('description'),
    createdById: uuid('created_by_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_key').on(t.email), uniqueIndex('users_external_id_key').on(t.externalId), index('users_owner_scope_idx').on(t.ownerScopeType, t.ownerScopeId)],
);

/**
 * A role granted to a user at one scope. Permissions flow down the hierarchy:
 * ORG_ADMIN on the organization implies every permission on all of its workspaces,
 * teams and projects. A DEVELOPER on one project sees only that project.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopeType: scopeTypeEnum('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    role: roleEnum('role').notNull(),
    grantedById: uuid('granted_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Optional end of the membership (GitLab "access expiration date"): ignored by authorization from then on. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memberships_user_scope_role_key').on(t.userId, t.scopeType, t.scopeId, t.role),
    index('memberships_scope_idx').on(t.scopeType, t.scopeId),
  ],
);

/**
 * One-time links that let a person set their password (invites without SMTP, password resets): the API keeps only the
 * SHA-256 of the token; using it sets the Keycloak password and marks the row used. Expire after 7 days by default.
 */
export const userInvites = pgTable(
  'user_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** invite | reset */
    purpose: text('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('user_invites_token_hash_key').on(t.tokenHash), index('user_invites_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Audit trail: who / what / when / where / why / before / after
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    /** Human-readable actor (email, agent name) so the trail stays legible if the actor is deleted. */
    actorLabel: text('actor_label'),
    /** Dotted verb, e.g. "project.created", "membership.granted". */
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    reason: text('reason'),
    requestId: text('request_id'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_org_created_idx').on(t.organizationId, t.createdAt),
    index('audit_events_resource_idx').on(t.resourceType, t.resourceId),
  ],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type Organization = typeof organizations.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Environment = typeof environments.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Execution plane: runner pools, runners, jobs (step 03)
// ---------------------------------------------------------------------------

export const runnerStatusEnum = pgEnum('runner_status', ['online', 'busy', 'offline', 'draining']);
export const jobStatusEnum = pgEnum('job_status', ['queued', 'assigned', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'pending', 'skipped']);
export const pipelineStatusEnum = pgEnum('pipeline_status', ['created', 'running', 'succeeded', 'failed', 'cancelled']);
export const pipelineTriggerEnum = pgEnum('pipeline_trigger', ['manual', 'push', 'schedule', 'api', 'retry']);
export const jobTypeEnum = pgEnum('job_type', ['repository_check', 'sbom', 'sca', 'sast', 'secrets', 'iac', 'container_scan', 'kubernetes_check', 'config_analysis', 'license_check', 'artifact_scan', 'policy_eval', 'custom', 'kubernetes_inventory']);

export type RunnerStatus = (typeof runnerStatusEnum.enumValues)[number];
export type JobStatus = (typeof jobStatusEnum.enumValues)[number];
export type JobType = (typeof jobTypeEnum.enumValues)[number];
export type PipelineStatus = (typeof pipelineStatusEnum.enumValues)[number];

/** A pool lives at a level (organization … project) and serves everything below it. */
export const runnerPools = pgTable(
  'runner_pools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    scopeType: scopeTypeEnum('scope_type').notNull().default('ORGANIZATION'),
    scopeId: uuid('scope_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Tags every runner in the pool advertises in addition to its own. */
    tags: text('tags').array().notNull().default([]),
    /** The cell's own runners (Helm chart): one per cell, serves every organization, created and fed by the platform. */
    managed: boolean('managed').notNull().default(false),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('runner_pools_scope_slug_key').on(t.scopeType, t.scopeId, t.slug), index('runner_pools_org_idx').on(t.organizationId), uniqueIndex('runner_pools_one_managed').on(t.managed).where(sql`${t.managed}`)],
);

export const runnerRegistrationTokens = pgTable('runner_registration_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  poolId: uuid('pool_id').notNull().references(() => runnerPools.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const runners = pgTable(
  'runners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: uuid('pool_id').notNull().references(() => runnerPools.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tags: text('tags').array().notNull().default([]),
    version: text('version'),
    status: runnerStatusEnum('status').notNull().default('offline'),
    tokenHash: text('token_hash').notNull().unique(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    currentJobId: uuid('current_job_id'),
    /** os, arch, docker availability, hostname … reported by the agent. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('runners_pool_idx').on(t.poolId)],
);

/** A pipeline: one run on a service made of ordered stages of jobs (GitLab model). */
export const pipelines = pgTable(
  'pipelines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    /** Per-project sequence number, like GitLab's #123. */
    number: integer('number').notNull(),
    name: text('name').notNull(),
    ref: text('ref'),
    /** The commit the pipeline ran on: given at creation (--commit) or resolved by its checkout job. */
    commitSha: text('commit_sha'),
    /** W3C traceparent of the pipeline's root span: one trace per pipeline (telemetry/pipeline-telemetry.ts). */
    traceParent: text('trace_parent'),
    status: pipelineStatusEnum('status').notNull().default('created'),
    trigger: pipelineTriggerEnum('trigger').notNull().default('manual'),
    /** The definition it ran: [{ name, jobs: [{ name, type, payload? }] }] */
    stages: jsonb('stages').$type<{ name: string; jobs: { name: string; type: string; payload?: Record<string, unknown> }[] }[]>().notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('pipelines_project_idx').on(t.projectId, t.createdAt), uniqueIndex('pipelines_project_number_key').on(t.projectId, t.number)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    pipelineId: uuid('pipeline_id').references(() => pipelines.id, { onDelete: 'cascade' }),
    stage: text('stage'),
    stageOrder: integer('stage_order').notNull().default(0),
    name: text('name'),
    type: jobTypeEnum('type').notNull(),
    status: jobStatusEnum('status').notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    requiredTags: text('required_tags').array().notNull().default([]),
    /** The pool the job ran in (set when claimed; usage, UI). Not a constraint — see requestedPoolId. */
    poolId: uuid('pool_id').references(() => runnerPools.id, { onDelete: 'set null' }),
    /** The pool asked for at creation (pipeline / job --pool); null = any eligible pool. The only claim constraint. */
    requestedPoolId: uuid('requested_pool_id').references(() => runnerPools.id, { onDelete: 'set null' }),
    runnerId: uuid('runner_id').references(() => runners.id, { onDelete: 'set null' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    exitCode: integer('exit_code'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(2),
    /** W3C traceparent of this job's span in the pipeline's trace; handed to the runner with the claim. */
    traceParent: text('trace_parent'),
    timeoutSeconds: integer('timeout_seconds').notNull().default(1800),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdByActor: actorTypeEnum('created_by_actor').notNull().default('USER'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** when the job last became claimable: creation for the first stage, the stage opening for later ones, a retry
     *  or a lost lease afterwards — the queue wait and the claim span start here, never at creation */
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  },
  (t) => [index('jobs_status_idx').on(t.status, t.priority, t.createdAt), index('jobs_project_idx').on(t.projectId), index('jobs_runner_idx').on(t.runnerId), index('jobs_pipeline_idx').on(t.pipelineId)],
);

export const jobLogChunks = pgTable(
  'job_log_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    stream: text('stream').notNull().default('stdout'),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('job_log_chunks_job_seq_key').on(t.jobId, t.seq)],
);

export type RunnerPool = typeof runnerPools.$inferSelect;
export type Runner = typeof runners.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Pipeline = typeof pipelines.$inferSelect;

// ---------------------------------------------------------------------------
// Product inventory: releases, container images, deployments (v1 M4)
// ---------------------------------------------------------------------------

export const releaseSourceEnum = pgEnum('release_source', ['git_tag', 'github_release', 'gitlab_release', 'manual', 'api']);
export const deploymentSourceEnum = pgEnum('deployment_source', ['api', 'cli', 'manual', 'kubernetes', 'registry']);

/** A version of a service: what gets an SBOM, what gets deployed. */
export const releases = pgTable(
  'releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    version: text('version').notNull(),
    tag: text('tag'),
    commitSha: text('commit_sha'),
    source: releaseSourceEnum('source').notNull().default('manual'),
    notes: text('notes'),
    htmlUrl: text('html_url'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('releases_service_version_key').on(t.serviceId, t.version), index('releases_service_idx').on(t.serviceId, t.releasedAt)],
);

/** A container image repository (e.g. ghcr.io/acme/payment-api) that builds of a service publish to. */
export const containerImages = pgTable(
  'container_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
    /** Registry connection (provider registry); null for public images pulled anonymously. */
    integrationId: uuid('integration_id').references(() => integrations.id, { onDelete: 'set null' }),
    /** Full name without tag: host/path */
    name: text('name').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('container_images_service_name_key').on(t.serviceId, t.name)],
);

export const imageTags = pgTable(
  'image_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    imageId: uuid('image_id').notNull().references(() => containerImages.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    digest: text('digest'),
    /** Matched release (tag == version or v-prefixed). */
    releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the image was built (from its config); null until read. Ordering uses built_at, then first_seen_at. */
    builtAt: timestamp('built_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('image_tags_image_tag_key').on(t.imageId, t.tag), index('image_tags_digest_idx').on(t.digest)],
);

/** "Version X of service S runs in environment E" — the fact the risk engine, policies and gates reason about. */
export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
    releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
    imageTagId: uuid('image_tag_id').references(() => imageTags.id, { onDelete: 'set null' }),
    version: text('version'),
    /** name:tag or name@sha256:… as observed */
    imageRef: text('image_ref'),
    source: deploymentSourceEnum('source').notNull().default('api'),
    /** kubernetes: { namespace, workload, kind, replicas } … */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    deployedAt: timestamp('deployed_at', { withTimezone: true }).notNull().defaultNow(),
    deployedById: uuid('deployed_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Set when a newer deployment to the same environment replaced this one. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (t) => [index('deployments_env_idx').on(t.environmentId, t.deployedAt), index('deployments_service_idx').on(t.serviceId)],
);

export type Release = typeof releases.$inferSelect;
export type ContainerImage = typeof containerImages.$inferSelect;
export type ImageTag = typeof imageTags.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;

// ---------------------------------------------------------------------------
// Machine credentials for CI/CD: HMAC-signed API tokens (no bearer secrets on the wire)
// ---------------------------------------------------------------------------

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    scopeType: scopeTypeEnum('scope_type').notNull().default('PROJECT'),
    scopeId: uuid('scope_id').notNull(),
    name: text('name').notNull(),
    /** Public identifier sent in the signature header. */
    keyId: text('key_id').notNull().unique(),
    /** Signing secret, encrypted with the cell key (HMAC verification needs the raw secret). */
    secretEncrypted: bytea('secret_encrypted').notNull(),
    /** Subset of CI_TOKEN_PERMISSIONS. */
    permissions: text('permissions').array().notNull().default([]),
    /** Environment slugs this token may deploy to (push/promote into protected environments). */
    environments: text('environments').array().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedFrom: text('last_used_from'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_tokens_scope_idx').on(t.scopeType, t.scopeId)],
);

export type ApiToken = typeof apiTokens.$inferSelect;

// ---------------------------------------------------------------------------
// SBOM (v1 M5): documents, normalized components, per-SBOM component rows
// ---------------------------------------------------------------------------

export const sbomSourceEnum = pgEnum('sbom_source', ['runner', 'ci_upload', 'manual']);
export const sbomTargetEnum = pgEnum('sbom_target', ['source', 'image', 'artifact']);
export const sbomFormatEnum = pgEnum('sbom_format', ['cyclonedx', 'spdx']);

export const sboms = pgTable(
  'sboms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
    releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
    imageTagId: uuid('image_tag_id').references(() => imageTags.id, { onDelete: 'set null' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    source: sbomSourceEnum('source').notNull(),
    target: sbomTargetEnum('target').notNull(),
    /** repo@ref, image ref, or file name */
    targetRef: text('target_ref').notNull(),
    format: sbomFormatEnum('format').notNull(),
    specVersion: text('spec_version'),
    tool: text('tool'),
    componentCount: integer('component_count').notNull().default(0),
    /** sha256 of the raw document: identical uploads deduplicate. */
    digest: text('digest').notNull(),
    /** Image SBOMs: the image digest (sha256:…) the document describes. Tags move, digests do not: every "what runs" view keys on this. */
    imageDigest: text('image_digest'),
    /** pending → done once findings are linked (finding_sboms) by a correlation run; failed with the error. Gates never pass on pending/failed. */
    correlationStatus: text('correlation_status').$type<'pending' | 'done' | 'failed'>().notNull().default('pending'),
    correlatedAt: timestamp('correlated_at', { withTimezone: true }),
    correlationError: text('correlation_error'),
    /** Failed runs are retried automatically with backoff (1, 2, 4 … 60 min); a gate on a failed SBOM retries at once. */
    correlationAttempts: integer('correlation_attempts').notNull().default(0),
    correlationNextRetryAt: timestamp('correlation_next_retry_at', { withTimezone: true }),
    /** gzip of the raw document (CycloneDX/SPDX JSON) */
    rawGz: bytea('raw_gz').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sboms_image_digest_idx').on(t.serviceId, t.imageDigest), index('sboms_service_idx').on(t.serviceId, t.createdAt), index('sboms_release_idx').on(t.releaseId), uniqueIndex('sboms_service_digest_key').on(t.serviceId, t.digest)],
);

/** Cell-wide component catalog keyed by package URL. */
export const components = pgTable(
  'components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purl: text('purl').notNull().unique(),
    type: text('type').notNull(),
    namespace: text('namespace'),
    name: text('name').notNull(),
    version: text('version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('components_name_idx').on(t.name), index('components_type_name_idx').on(t.type, t.name)],
);

export const sbomComponents = pgTable(
  'sbom_components',
  {
    sbomId: uuid('sbom_id').notNull().references(() => sboms.id, { onDelete: 'cascade' }),
    componentId: uuid('component_id').notNull().references(() => components.id, { onDelete: 'cascade' }),
    /** Declared directly by the root component (vs. transitive). Null when the document has no dependency graph. */
    direct: boolean('direct'),
    licenses: text('licenses').array().notNull().default([]),
    /** Where it was found (file paths / layers), truncated. */
    locations: text('locations').array().notNull().default([]),
  },
  (t) => [uniqueIndex('sbom_components_key').on(t.sbomId, t.componentId), index('sbom_components_component_idx').on(t.componentId)],
);

export type Sbom = typeof sboms.$inferSelect;
export type Component = typeof components.$inferSelect;

// ---------------------------------------------------------------------------
// Vulnerabilities (v1 M6): advisory cache, findings per service × component × advisory
// ---------------------------------------------------------------------------

export const severityEnum = pgEnum('severity', ['critical', 'high', 'medium', 'low', 'unknown']);
export const findingStatusEnum = pgEnum('finding_status', ['open', 'fixed', 'accepted', 'false_positive', 'not_affected']);

/** Cell-wide advisory cache (OSV/GHSA/CVE), enriched with KEV and EPSS. */
export const advisories = pgTable(
  'advisories',
  {
    id: text('id').primaryKey(), // OSV id: GHSA-…, CVE-…, PYSEC-…, ALSA-…
    aliases: text('aliases').array().notNull().default([]),
    summary: text('summary'),
    details: text('details'),
    severity: severityEnum('severity').notNull().default('unknown'),
    /** distro | cvss | database | alias | unknown — why `severity` is what it is (a CVSS 9.8 can be low when Debian rates it unimportant). */
    severitySource: text('severity_source').$type<'distro' | 'cvss' | 'database' | 'alias' | 'unknown'>(),
    /** The rating text behind it, e.g. "Debian: unimportant · disputed · no fix planned". */
    severityNote: text('severity_note'),
    /** The CVE this record is about (lowest alias), else the id: GHSA-…, PYSEC-… and DEBIAN-CVE-… of one CVE share it. One finding per (component, canonical). */
    canonicalId: text('canonical_id'),
    cvssScore: doublePrecision('cvss_score'),
    cvssVector: text('cvss_vector'),
    epssScore: doublePrecision('epss_score'),
    epssPercentile: doublePrecision('epss_percentile'),
    kev: boolean('kev').notNull().default(false),
    kevDueDate: timestamp('kev_due_date', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    modifiedAt: timestamp('modified_at', { withTimezone: true }),
    references: jsonb('references').$type<{ type: string; url: string }[]>().notNull().default([]),
    /** OSV `affected` entries (package, ranges, versions) used to compute fixed versions. */
    affected: jsonb('affected').$type<unknown[]>().notNull().default([]),
    /** CVSS of an alias record (CVE from NVD, or GHSA) when this record has none; never preferred over a distribution rating. */
    aliasCvssScore: doublePrecision('alias_cvss_score'),
    aliasSource: text('alias_source').$type<'nvd' | 'ghsa'>(),
    /** Alias record text (summary/details), e.g. to see "** DISPUTED **" from NVD. */
    aliasText: text('alias_text'),
    /** When alias / NVD CVSS was last looked up (background enrichment; null = not yet). */
    aliasCheckedAt: timestamp('alias_checked_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('advisories_severity_idx').on(t.severity), index('advisories_modified_idx').on(t.modifiedAt)],
);

/** When a component was last checked against the advisory source (daily re-check surfaces new advisories). */
export const componentChecks = pgTable('component_checks', {
  componentId: uuid('component_id').primaryKey().references(() => components.id, { onDelete: 'cascade' }),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  advisoryIds: text('advisory_ids').array().notNull().default([]),
  error: text('error'),
});

export const findings = pgTable(
  'findings',
  {
    /** Where the severity came from (debian / ubuntu / redhat / osv / nvd / ghsa) and a note ("Debian: unimportant · disputed · no fix planned"). */
    severitySource: text('severity_source'),
    severityNote: text('severity_note'),
    /** "one advisory per source package": libc6 and libc-bin are both Debian/glibc. Counts use (advisory, package_key). */
    packageKey: text('package_key'),
    /** False when no SBOM that any current deployment runs contains this finding (old image still in a registry). Stays open, but is excluded from the default totals, the map and risk. Recomputed by every correlation run. */
    running: boolean('running').notNull().default(true),
    /** advisories.canonical_id of the finding's advisory; all unique counts key on (canonical, package_key). */
    canonicalId: text('canonical_id'),
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
    componentId: uuid('component_id').notNull().references(() => components.id, { onDelete: 'cascade' }),
    advisoryId: text('advisory_id').notNull().references(() => advisories.id, { onDelete: 'cascade' }),
    severity: severityEnum('severity').notNull().default('unknown'),
    status: findingStatusEnum('status').notNull().default('open'),
    /** First version that fixes it for this component's range, when known. */
    fixedVersion: text('fixed_version'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    statusChangedById: uuid('status_changed_by_id').references(() => users.id, { onDelete: 'set null' }),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    note: text('note'),
  },
  (t) => [uniqueIndex('findings_key').on(t.serviceId, t.componentId, t.advisoryId), index('findings_org_status_idx').on(t.organizationId, t.status, t.severity), index('findings_service_idx').on(t.serviceId, t.status), index('findings_running_idx').on(t.serviceId, t.status, t.running), index('findings_canonical_idx').on(t.serviceId, t.canonicalId)],
);

/** Which SBOMs (releases / images) contain the finding. */
export const findingSboms = pgTable(
  'finding_sboms',
  {
    findingId: uuid('finding_id').notNull().references(() => findings.id, { onDelete: 'cascade' }),
    sbomId: uuid('sbom_id').notNull().references(() => sboms.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('finding_sboms_key').on(t.findingId, t.sbomId), index('finding_sboms_sbom_idx').on(t.sbomId)],
);

export type Advisory = typeof advisories.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type Severity = (typeof severityEnum.enumValues)[number];
export type FindingStatus = (typeof findingStatusEnum.enumValues)[number];

/** Daily open-findings snapshot per environment (what ran there that day) — feeds the trend charts. */
export const environmentFindingSnapshots = pgTable(
  'environment_finding_snapshots',
  {
    environmentId: uuid('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
    day: timestamp('day', { withTimezone: true }).notNull(),
    version: text('version'),
    imageRef: text('image_ref'),
    sbomId: uuid('sbom_id').references(() => sboms.id, { onDelete: 'set null' }),
    critical: integer('critical').notNull().default(0),
    high: integer('high').notNull().default(0),
    medium: integer('medium').notNull().default(0),
    low: integer('low').notNull().default(0),
    kev: integer('kev').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('env_finding_snapshots_key').on(t.environmentId, t.day)],
);

/** Risk score per service (latest + daily history), with the factors that explain it. */
export const riskScores = pgTable(
  'risk_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
    day: timestamp('day', { withTimezone: true }).notNull(),
    score: integer('score').notNull(),
    grade: text('grade').notNull(), // A–F
    factors: jsonb('factors').$type<Record<string, unknown>>().notNull().default({}),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('risk_scores_key').on(t.serviceId, t.day), index('risk_scores_service_idx').on(t.serviceId)],
);

export type RiskScore = typeof riskScores.$inferSelect;

export const codeFindingKindEnum = pgEnum('code_finding_kind', ['secret', 'iac', 'sast']);

/** Findings on the code itself (secrets, IaC misconfigurations, later SAST), per service repository. */
export const codeFindings = pgTable(
  'code_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    kind: codeFindingKindEnum('kind').notNull(),
    ruleId: text('rule_id').notNull(),
    title: text('title').notNull(),
    severity: severityEnum('severity').notNull().default('unknown'),
    category: text('category'),
    file: text('file').notNull(),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    /** Redacted for secrets; the misconfiguration message for IaC. Never a secret in clear. */
    evidence: text('evidence'),
    resolution: text('resolution'),
    references: text('references').array().notNull().default([]),
    fingerprint: text('fingerprint').notNull(),
    status: findingStatusEnum('status').notNull().default('open'),
    ref: text('ref'),
    lastJobId: uuid('last_job_id'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    statusChangedById: uuid('status_changed_by_id').references(() => users.id, { onDelete: 'set null' }),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    note: text('note'),
  },
  (t) => [uniqueIndex('code_findings_key').on(t.serviceId, t.kind, t.fingerprint), index('code_findings_org_idx').on(t.organizationId, t.status, t.severity)],
);

export type CodeFinding = typeof codeFindings.$inferSelect;

/** Personal access tokens: act as their user (API + CLI). Only the SHA-256 of the secret is stored. */
export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** read = GET only · write = full API within memberships · sudo = the user's full rights incl. admin (admins only) */
    scope: text('scope').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** First characters, shown in lists (spt_ab12…). */
    prefix: text('prefix').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    /** ui (Account → Access tokens) | oauth (consent flow, named after the client) | cli */
    source: text('source').notNull().default('ui'),
    oauthClientId: text('oauth_client_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('personal_access_tokens_hash_key').on(t.tokenHash), index('personal_access_tokens_user_idx').on(t.userId)],
);
export type PersonalAccessToken = typeof personalAccessTokens.$inferSelect;

// ---------------------------------------------------------------------------
// Policies & gates (v1 M8)
// ---------------------------------------------------------------------------

export const policyActionEnum = pgEnum('policy_action', ['block', 'warn']);
export const gateResultEnum = pgEnum('gate_result', ['pass', 'warn', 'fail']);

export interface PolicyRules {
  /** Highest open severity tolerated (findings above it violate). null = no limit. */
  maxSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
  /** No open finding listed in CISA KEV. */
  blockKev: boolean;
  /** No open secret in the repository. */
  blockSecrets: boolean;
  /** IaC misconfigurations at or above this severity violate. null = ignore. */
  maxIacSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
  /** Code (SAST) findings at or above this severity block/warn; null = not checked. */
  maxSastSeverity?: 'critical' | 'high' | 'medium' | 'low' | null;
  /** The subject (image / release) must have an SBOM. */
  requireSbom: boolean;
  /** Findings with status accepted / false_positive / not_affected do not count. */
  honourDecisions: boolean;
}

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    scopeType: scopeTypeEnum('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),
    /** Environment kinds the policy applies to (empty = all). */
    environmentKinds: text('environment_kinds').array().notNull().default([]),
    rules: jsonb('rules').$type<PolicyRules>().notNull(),
    action: policyActionEnum('action').notNull().default('block'),
    /** Also reject deployments (secops deploy / promote) to matching environments when the gate fails. */
    enforceOnDeploy: boolean('enforce_on_deploy').notNull().default(false),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('policies_org_idx').on(t.organizationId), index('policies_scope_idx').on(t.scopeType, t.scopeId)],
);

export const gateEvaluations = pgTable(
  'gate_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
    /** What was evaluated: image reference / digest / version / commit. */
    subject: jsonb('subject').$type<{ imageRef?: string; digest?: string; version?: string | null; ref?: string; commitSha?: string | null; pipelineId?: string; sbomId?: string; sbomSource?: string; evaluatedDigest?: string | null; sbomDigest?: string | null }>().notNull(),
    result: gateResultEnum('result').notNull(),
    violations: jsonb('violations').$type<{ policyId: string; policyName: string; action: 'block' | 'warn'; rule: string; message: string; count?: number }[]>().notNull().default([]),
    policyIds: text('policy_ids').array().notNull().default([]),
    jobId: uuid('job_id'),
    deploymentId: uuid('deployment_id'),
    actor: text('actor'),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('gate_evaluations_env_idx').on(t.environmentId, t.evaluatedAt), index('gate_evaluations_service_idx').on(t.serviceId, t.evaluatedAt)],
);

export type Policy = typeof policies.$inferSelect;
export type GateEvaluation = typeof gateEvaluations.$inferSelect;

// ---------------------------------------------------------------------------
// Exceptions (v1 M8 slice 2): time-boxed, approved acceptance of a vulnerability or a code rule
// ---------------------------------------------------------------------------

export const exceptionKindEnum = pgEnum('exception_kind', ['vulnerability', 'code']);

export const exceptions = pgTable(
  'exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    scopeType: scopeTypeEnum('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    kind: exceptionKindEnum('kind').notNull(),
    /** vulnerability: advisory id (CVE-…/GHSA-…); code: rule id (e.g. DS-0026, github-pat) */
    matchId: text('match_id').notNull(),
    /** optional narrowing: component name (vulnerability) or file path prefix (code) */
    matchComponent: text('match_component'),
    /** the resulting finding status while the exception is active */
    status: findingStatusEnum('status').notNull().default('accepted'),
    reason: text('reason').notNull(),
    ticketUrl: text('ticket_url'),
    requestedById: uuid('requested_by_id').references(() => users.id, { onDelete: 'set null' }),
    approvedById: uuid('approved_by_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    /** findings this exception currently holds in its status (reverted on expiry / revocation) */
    appliedFindingIds: text('applied_finding_ids').array().notNull().default([]),
    appliedCodeFindingIds: text('applied_code_finding_ids').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('exceptions_org_idx').on(t.organizationId, t.expiresAt), index('exceptions_scope_idx').on(t.scopeType, t.scopeId)],
);
export type Exception = typeof exceptions.$inferSelect;

// ---------------------------------------------------------------------------
// Remediation (v1 M9): SLAs, fix-first queue, tracked remediations, external issues
// ---------------------------------------------------------------------------

export const remediationStatusEnum = pgEnum('remediation_status', ['open', 'in_progress', 'done', 'wont_fix']);

/** Days allowed to remediate, by severity (organization setting). */
export interface SlaDays { critical: number; high: number; medium: number; low: number }
export const DEFAULT_SLA: SlaDays = { critical: 7, high: 30, medium: 90, low: 180 };

export const issueProviderEnum = ['github', 'gitlab', 'bitbucket', 'jira'] as const;
export type IssueProvider = (typeof issueProviderEnum)[number];

/** Remediation settings per scope; a project's effective settings are resolved project → team → workspace → organization. */
export const remediationSettings = pgTable('remediation_settings', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  scopeType: scopeTypeEnum('scope_type').notNull().default('ORGANIZATION'),
  scopeId: uuid('scope_id').notNull(),
  /** null on non-organization scopes = inherit. */
  slaDays: jsonb('sla_days').$type<SlaDays>(),
  /** Where "create issue" goes by default: github / gitlab / bitbucket (the service repository's host) or jira; null = inherit / infer from the repository. */
  issueProvider: text('issue_provider').$type<IssueProvider>(),
  /** Board to add created issues to: a GitHub Projects (v2) URL for now. */
  issueBoard: text('issue_board'),
  /** Default integration used for "create issue" (jira or github); null = the service repository's GitHub. */
  defaultIssueIntegrationId: uuid('default_issue_integration_id').references(() => integrations.id, { onDelete: 'set null' }),
  /** Jira project key used when creating issues (e.g. SEC). */
  jiraProjectKey: text('jira_project_key'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.scopeType, t.scopeId] }), index('remediation_settings_org_idx').on(t.organizationId)]);

export const remediations = pgTable(
  'remediations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
    kind: exceptionKindEnum('kind').notNull(),
    /** vulnerability: advisory id; code: rule id */
    matchId: text('match_id').notNull(),
    componentName: text('component_name'),
    title: text('title').notNull(),
    severity: severityEnum('severity').notNull(),
    status: remediationStatusEnum('status').notNull().default('open'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    /** findings tracked by this remediation */
    findingIds: text('finding_ids').array().notNull().default([]),
    codeFindingIds: text('code_finding_ids').array().notNull().default([]),
    /** external issue (Jira / GitHub) */
    issueProvider: text('issue_provider'),
    issueKey: text('issue_key'),
    issueUrl: text('issue_url'),
    notes: text('notes'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('remediations_service_idx').on(t.serviceId, t.status), index('remediations_org_idx').on(t.organizationId, t.status), uniqueIndex('remediations_open_key').on(t.serviceId, t.kind, t.matchId, t.componentName).where(sql`status in ('open','in_progress')`)],
);
export type Remediation = typeof remediations.$inferSelect;

// ---------------------------------------------------------------------------
// Notifications: Slack / webhook channels per organization
// ---------------------------------------------------------------------------

export const NOTIFICATION_EVENTS = ['gate.fail', 'deployment.production', 'deployment.rejected', 'sla.overdue', 'kev.production', 'exception.expiring', 'secret.detected'] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // slack | webhook
    /** Slack incoming-webhook URL or any HTTPS endpoint receiving JSON (encrypted at rest). */
    urlEncrypted: text('url_encrypted').notNull(),
    events: text('events').array().notNull().default([]),
    /** optional narrowing to one project (legacy; scopeType/scopeId is the general form) */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** where the channel lives: ORGANIZATION (everything) / WORKSPACE / TEAM / PROJECT (only events under it) */
    scopeType: scopeTypeEnum('scope_type').notNull().default('ORGANIZATION'),
    scopeId: uuid('scope_id'),
    enabled: boolean('enabled').notNull().default(true),
    /** dedupe state: event key → last sent ISO time */
    state: jsonb('state').$type<Record<string, string>>().notNull().default({}),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_channels_org_idx').on(t.organizationId)],
);
export type NotificationChannel = typeof notificationChannels.$inferSelect;

// ---------------------------------------------------------------- OAuth 2.1 (MCP connectors in claude.ai, `matelot login`)
/** Registered OAuth clients (dynamic client registration, RFC 7591). Public clients with PKCE only. */
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: text('redirect_uris').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});
export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  resource: text('resource'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});
/** Refresh tokens rotate; the access token behind each is a personal access token (same RBAC, audit, revocation). */
export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(),
  personalTokenId: uuid('personal_token_id').references(() => personalAccessTokens.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Liveness of background loops (the platform worker's job loop) so the UI can say "waiting for the platform worker (last seen 3 min ago)". */
export const platformHeartbeats = pgTable('platform_heartbeats', {
  name: text('name').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
});

/** One row per cell backup run, reported by the backup job (POST /internal/backup-reports): the matelot_backup_*
 *  metrics come from here, so the Helm CronJob and the Compose backup service produce the same gauges. */
export const backupStatusEnum = pgEnum('backup_status', ['succeeded', 'failed']);
export const backupReports = pgTable(
  'backup_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: backupStatusEnum('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
    /** archive file name (`<cell>-<stamp>.tar.gz`), never a path with credentials */
    archive: text('archive'),
    bytes: bigint('bytes', { mode: 'number' }),
    /** where it went: pvc | s3 | compose (a bucket / prefix, never credentials) */
    destination: text('destination'),
    error: text('error'),
    /** the step that reported: dump | upload */
    step: text('step'),
  },
  (t) => [index('backup_reports_finished_idx').on(t.status, t.finishedAt)],
);
export type BackupReport = typeof backupReports.$inferSelect;

/** Keys the cell signs with. Purpose `identity`: OIDC tokens for workload identity federation. Private key encrypted with the cell key. */
export const signingKeys = pgTable('signing_keys', {
  kid: text('kid').primaryKey(),
  purpose: text('purpose').notNull(),
  publicPem: text('public_pem').notNull(),
  privatePemEncrypted: bytea('private_pem_encrypted').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
});

/** People who used the cell in a month (UTC, "YYYY-MM"): one row per user per month, written on their first request. */
export const usageActiveUsers = pgTable('usage_active_users', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  month: text('month').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.month] }), index('usage_active_users_month_idx').on(t.month)]);

/** Monthly usage per organization, kept so history survives job / pipeline pruning. `final` once the month is over. */
export const usageSnapshots = pgTable('usage_snapshots', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  month: text('month').notNull(),
  metrics: jsonb('metrics').$type<UsageMetrics>().notNull(),
  final: boolean('final').notNull().default(false),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.month] })]);

export interface UsageMetrics {
  /** active is null for a month that ended before this cell started tracking seats (no figure, rather than 0). */
  seats: { active: number | null; members: number };
  projects: number;
  services: number;
  environments: number;
  pipelines: number;
  jobs: number;
  runnerMinutes: number;
  /** Part of runnerMinutes run by the cell's managed runners (absent in snapshots older than managed runners). */
  runnerMinutesManaged?: number;
  runnerMinutesByType: Record<string, number>;
  sboms: number;
}
