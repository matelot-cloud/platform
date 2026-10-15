export type ScopeType = 'ORGANIZATION' | 'WORKSPACE' | 'TEAM' | 'PROJECT' | 'SERVICE' | 'ENVIRONMENT';
export type Criticality = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Meta {
  version: string;
  rootOrganizationSlug: string | null;
  roles: string[];
  serviceKinds?: ServiceKind[];
  environmentKinds?: EnvironmentKind[];
  scopeTypes: ScopeType[];
  criticalities: Criticality[];
  permissions: string[];
  rolePermissions: Record<string, string[]>;
  /** Roles in display order: label, one-line description, closest GitLab role, scopes where they are offered. */
  roleCatalog?: RoleInfo[];
  /** Named capabilities (on/off); M13 licensing maps them to tiers. */
  features?: Partial<Record<FeatureName, boolean>>;
}

export type FeatureName = "inherited_members" | "member_expiry" | "bulk_invite" | "invite_links" | "user_admin" | "service_accounts" | "scope_access_tokens" | "custom_roles";
export type MemberScopeType = "ORGANIZATION" | "WORKSPACE" | "TEAM" | "PROJECT";
export interface MemberScopeRef { type: MemberScopeType; id: string; name: string }

export interface RoleInfo {
  role: string;
  label: string;
  description: string;
  gitlab: "Guest" | "Reporter" | "Developer" | "Maintainer" | "Owner";
  scopes: MemberScopeType[];
  /** Only from GET /members/roles: the caller may grant it at that scope. */
  grantable?: boolean;
}

export interface MemberScopeSummary { type: MemberScopeType; id: string; slug: string; name: string }

export interface MemberRow {
  membershipId: string;
  user: { id: string; email: string; displayName: string | null; kind: "human" | "service_account" | string; lastLoginAt: string | null; disabled: boolean };
  role: string;
  roleLabel: string;
  source: "direct" | "inherited";
  inheritedFrom: MemberScopeSummary | null;
  grantedBy: { id: string; email: string } | null;
  grantedAt: string;
  expiresAt: string | null;
  expired: boolean;
  canEdit: boolean;
}
export interface MembersResponse { scope: MemberScopeSummary; canManage: boolean; members: MemberRow[] }
export interface MemberCandidate { id: string; email: string; displayName: string | null; kind: string }
export interface AddMembersResult {
  added: { membershipId: string; email: string; role: string; updated: boolean }[];
  skipped: { email: string; reason: string }[];
  invited: { email: string; setupLink: string | null; emailed: boolean; viaIdentityProvider: boolean }[];
}

export interface ServiceAccount {
  id: string;
  name: string | null;
  username: string;
  description: string | null;
  ownerScopeType: MemberScopeType;
  ownerScopeId: string;
  disabled: boolean;
  createdAt: string;
  activeTokens?: number;
  memberships?: { role: string; scopeType: MemberScopeType; scopeId: string; expiresAt: string | null }[];
  membershipId?: string | null;
}
export interface TokenRow {
  id: string;
  name: string;
  scope: "read" | "write" | "sudo";
  prefix: string;
  expiresAt: string;
  expired: boolean;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  source: string;
  createdAt: string;
}
export interface CreatedToken extends TokenRow { token: string }

export interface AdminCapabilities { keycloak: boolean; email: boolean; canChangeCellRole: boolean }
export interface IssuedLink { setupLink: string | null; emailed: boolean; expiresAt?: string; temporaryPassword: boolean }
export interface AdminUserDetail {
  user: AdminUser & { ownerScopeType: MemberScopeType | null; ownerScopeId: string | null; description: string | null };
  memberships: { id: string; role: string; scopeType: MemberScopeType; scopeId: string; scope: MemberScopeSummary | null; expiresAt: string | null; expired: boolean; grantedAt: string }[];
  tokens: TokenRow[];
}
export interface InviteInfo { email: string; purpose: "invite" | "reset"; expiresAt: string; minLength: number }

export interface Organization {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Workspace {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  criticality: Criticality;
  createdAt: string;
  updatedAt: string;
  teamId: string;
  teamSlug: string;
  teamName: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  settings?: { automation?: { pipelineOnPush?: 'default_branch' | 'all' | 'off'; template?: string } } & Record<string, unknown>;
}

export interface ScopeSummary {
  type: ScopeType;
  id: string;
  slug: string;
  name: string;
}

export interface MembershipSummary {
  id: string;
  role: string;
  scopeType: ScopeType;
  scopeId: string;
  scope: ScopeSummary | null;
}

export type PlatformRole = 'user' | 'admin';

export interface Me {
  user: { id: string; email: string; displayName: string | null; lastLoginAt: string | null; platformRole: PlatformRole };
  memberships: MembershipSummary[];
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  kind?: "human" | "service_account" | string;
  signInReady?: boolean;
  platformRole: PlatformRole;
  disabledAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  membershipCount: number;
}

export interface MembershipRow {
  id: string;
  role: string;
  scopeType: ScopeType;
  scopeId: string;
  createdAt: string;
  user: { id: string; email: string; displayName: string | null; lastLoginAt: string | null };
}

export interface AuditEvent {
  id: string;
  organizationId: string | null;
  actorType: 'USER' | 'SYSTEM' | 'AI_AGENT';
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  requestId: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export type ServiceKind = 'api' | 'worker' | 'web' | 'library' | 'firmware' | 'infrastructure' | 'other';
export type EnvironmentKind = 'development' | 'testing' | 'staging' | 'production';

export interface Service {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description: string | null;
  kind: ServiceKind;
  criticality: Criticality | null;
  createdAt: string;
  updatedAt: string;
}

export interface Environment {
  id: string;
  serviceId: string;
  slug: string;
  name: string;
  kind: EnvironmentKind;
  internetFacing: boolean;
  settings: { kubernetesNamespace?: string; kubernetesContext?: string; runnerTag?: string } & Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type IntegrationStatus = 'pending' | 'connected' | 'error' | 'disconnected';

export type IntegrationProvider = 'github' | 'github_token' | 'gitlab' | 'git' | 'registry' | 'jira' | 'bitbucket' | 'matelot';
export type IntegrationAuthType = 'app' | 'token' | 'basic' | 'ssh' | 'none' | 'aws' | 'azure' | 'gcp' | 'gcp_wif' | 'aws_wif' | 'azure_wif';

export interface Integration {
  id: string;
  organizationId: string;
  provider: IntegrationProvider;
  authType: IntegrationAuthType;
  name: string;
  status: IntegrationStatus;
  /** Level the connection lives at; usable by everything below it. */
  scope: { type: ScopeType; id: string; name: string };
  /** Set on project listings: connection comes from a level above the project. */
  inherited?: boolean;
  settings?: Record<string, unknown>;
  externalAccountId: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  installUrl?: string;
  warnings?: string[];
  missingPermissions?: { key: string; level: string; why: string }[];
}

export interface Provider {
  provider: IntegrationProvider;
  label: string;
  authTypes: IntegrationAuthType[];
  inventory: boolean;
  available: boolean;
  installable: boolean;
  /** GitHub: a platform-wide App exists (one-click install). */
  platformApp?: boolean;
}

export interface CreateIntegrationInput {
  scopeType?: ScopeType;
  scopeId?: string;
  provider: IntegrationProvider;
  name: string;
  baseUrl?: string;
  owner?: string;
  repositoryUrl?: string;
  auth: { type: IntegrationAuthType; provider?: string; serviceAccount?: string; roleArn?: string; token?: string; username?: string; password?: string; privateKey?: string; generateKey?: boolean; appId?: string; slug?: string; webhookSecret?: string; accessKeyId?: string; secretAccessKey?: string; region?: string; tenantId?: string; clientId?: string; clientSecret?: string; serviceAccountJson?: string };
}

export interface IntegrationCreated extends Integration {
  /** For a team-registered GitHub App: where to install it. */
  installUrl?: string;
  /** For a platform-generated deploy key: the public half to add on the git host. */
  publicKey?: string;
  fingerprint?: string;
  /** Keyless registry connections are created unverified: configure the trust for `identity.subject`, then verify. */
  keyless?: boolean;
  verified?: boolean;
  identity?: ConnectionIdentity;
}

export interface Repository {
  id: string;
  integrationId: string;
  externalId: string;
  fullName: string;
  defaultBranch: string | null;
  visibility: string | null;
  archived: boolean;
  languages: Record<string, number> | null;
  htmlUrl: string | null;
  cloneUrl: string | null;
  sshUrl: string | null;
  branchProtection: Record<string, unknown> | null;
  lastSyncedAt: string | null;
}

export interface RepositoryWithServices extends Repository {
  integrationName: string;
  integrationStatus: IntegrationStatus;
  integrationScope: { type: ScopeType; id: string; name: string } | null;
  services: { repositoryId: string; role: 'primary' | 'secondary'; serviceId: string; serviceName: string; projectId: string; projectName: string }[];
}

export interface ServiceRepository {
  role: 'primary' | 'secondary';
  attachedAt: string;
  repository: Repository;
}

export type RunnerStatus = 'online' | 'busy' | 'offline' | 'draining';
export type JobStatus = 'queued' | 'assigned' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'pending' | 'skipped';
export type PipelineStatus = 'created' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobType = 'repository_check' | 'sbom' | 'sca' | 'sast' | 'secrets' | 'iac' | 'container_scan' | 'kubernetes_check' | 'config_analysis' | 'license_check' | 'artifact_scan' | 'policy_eval' | 'custom';

export interface Runner {
  id: string;
  poolId: string;
  name: string;
  tags: string[];
  version: string | null;
  status: RunnerStatus;
  lastHeartbeatAt: string | null;
  currentJobId: string | null;
  metadata: Record<string, unknown>;
  registeredAt: string;
}

export interface RunnerPool {
  id: string;
  organizationId: string;
  scopeType: ScopeType;
  scopeId: string;
  slug: string;
  name: string;
  description: string | null;
  tags: string[];
  /** The cell's own runners (Helm chart): serve every organization, read-only here. */
  managed?: boolean;
  createdAt: string;
  scope: { type: ScopeType; id: string; name: string };
  runners: Runner[];
}

export interface RegistrationToken {
  token: string;
  expiresAt: string;
  docker: string;
  compose: string;
  local: string;
  kubernetes: string;
}

export interface Job { platformWorkerSeenAt?: string | null;
  id: string;
  organizationId: string;
  projectId: string;
  serviceId: string | null;
  repositoryId: string | null;
  pipelineId: string | null;
  stage: string | null;
  stageOrder: number;
  name: string | null;
  type: JobType;
  status: JobStatus;
  priority: number;
  requiredTags: string[];
  poolId: string | null;
  runnerId: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  exitCode: number | null;
  attempts: number;
  maxAttempts: number;
  timeoutSeconds: number;
  createdAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  serviceName?: string | null;
  repositoryName?: string | null;
  runnerName?: string | null;
}

export interface JobLogChunk {
  seq: number;
  stream: 'stdout' | 'stderr' | 'system';
  content: string;
  at: string;
}

export interface StageDefinition {
  name: string;
  jobs: { name: string; type: JobType; payload?: Record<string, unknown> }[];
}

export interface PipelineTemplate {
  key: string;
  name: string;
  description: string;
  stages: StageDefinition[];
}

export interface PipelineJobSummary {
  id: string;
  pipelineId: string;
  stage: string | null;
  stageOrder: number;
  name: string | null;
  type: JobType;
  status: JobStatus;
}

export interface Pipeline { platformWorkerSeenAt?: string | null;
  id: string;
  organizationId: string;
  projectId: string;
  serviceId: string | null;
  repositoryId: string | null;
  number: number;
  name: string;
  ref: string | null;
  status: PipelineStatus;
  trigger: 'manual' | 'push' | 'schedule' | 'api' | 'retry';
  stages: StageDefinition[];
  createdById: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  serviceName?: string | null;
  repositoryName?: string | null;
  jobs: (PipelineJobSummary | Job)[];
}

export interface Release {
  id: string;
  serviceId: string;
  repositoryId: string | null;
  version: string;
  tag: string | null;
  commitSha: string | null;
  source: 'git_tag' | 'github_release' | 'gitlab_release' | 'manual' | 'api';
  notes: string | null;
  htmlUrl: string | null;
  releasedAt: string | null;
  createdAt: string;
}

export interface ImageTagRow {
  id: string;
  imageId: string;
  tag: string;
  digest: string | null;
  releaseId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Present when returned by the joined inventory endpoint. */
  releaseVersion?: string | null;
  environments?: { id: string; name: string; kind: EnvironmentKind }[];
  image?: string | null;
  sbom?: { id: string; componentCount: number; target: string; findings?: Record<Severity, number> } | null;
  builtAt?: string | null;
  alsoRunningIn?: { id: string; name: string; kind: string; imageRef: string | null }[];
  digestSbom?: { id: string; componentCount: number; shared: boolean; from?: string | null } | null;
  warnings?: { code: 'unaccepted_tag' | 'rebuilt_commit'; message: string }[];
}

export interface ContainerImage {
  id: string;
  serviceId: string;
  integrationId: string | null;
  name: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  tags: ImageTagRow[];
}

export interface Deployment {
  id: string;
  serviceId: string;
  environmentId: string;
  releaseId: string | null;
  imageTagId: string | null;
  version: string | null;
  imageRef: string | null;
  source: 'api' | 'cli' | 'manual' | 'kubernetes';
  metadata: Record<string, unknown>;
  deployedAt: string;
  supersededAt: string | null;
  releaseVersion?: string | null;
  environmentName?: string;
  environmentKind?: EnvironmentKind;
}

export interface ServiceDeployments {
  environments: (Environment & { current: Deployment | null })[];
  history: Deployment[];
}

export interface ApiToken {
  id: string;
  organizationId: string;
  scopeType: ScopeType;
  scopeId: string;
  name: string;
  keyId: string;
  permissions: string[];
  environments: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedFrom: string | null;
  revokedAt: string | null;
  createdAt: string;
  scope: { type: ScopeType; id: string; name: string };
  /** Only on creation. */
  secret?: string;
}

export interface TokenPresets {
  presets: Record<string, { label: string; description: string; permissions: string[] }>;
  permissions: string[];
}

export interface SbomRow {
  id: string;
  serviceId: string;
  releaseId: string | null;
  imageTagId: string | null;
  jobId: string | null;
  source: 'runner' | 'ci_upload' | 'manual';
  target: 'source' | 'image' | 'artifact';
  targetRef: string;
  format: 'cyclonedx' | 'spdx';
  specVersion: string | null;
  tool: string | null;
  componentCount: number;
  generatedAt: string | null;
  createdAt: string;
  releaseVersion?: string | null;
}

export interface SbomComponentRow {
  id: string;
  purl: string;
  type: string;
  namespace: string | null;
  name: string;
  version: string | null;
  direct: boolean | null;
  licenses: string[];
  locations: string[];
}

export interface SbomDetail extends SbomRow {
  components: SbomComponentRow[];
}

export interface SbomDiff {
  from: { id: string; targetRef: string };
  to: { id: string; targetRef: string };
  added: SbomComponentRow[];
  removed: SbomComponentRow[];
  changed: (SbomComponentRow & { previousVersion: string | null })[];
  unchanged: number;
}

export interface ComponentHit extends SbomComponentRow {
  sbomId: string;
  target: string;
  targetRef: string;
  serviceId: string;
  serviceName: string;
  projectId: string;
  projectName: string;
  releaseVersion: string | null;
}

export interface InventoryTag {
  id: string;
  tag: string;
  digest: string | null;
  image: string | null;
  releaseId: string | null;
  releaseVersion: string | null;
  lastSeenAt: string;
  firstSeenAt?: string;
  builtAt?: string | null;
  sbom: { id: string; componentCount: number; target: string; findings?: Record<Severity, number> } | null;
  environments?: { id: string; name: string; kind: EnvironmentKind }[];
  alsoRunningIn?: { id: string; name: string; kind: string; imageRef: string | null }[];
  digestSbom?: { id: string; componentCount: number; shared: boolean; from?: string | null } | null;
  warnings?: { code: 'unaccepted_tag' | 'rebuilt_commit'; message: string }[];
}

export interface ServiceInventory {
  environments: (Environment & {
    current: { deploymentId: string; version: string | null; releaseId: string | null; commitSha: string | null; imageRef: string | null; imageTag: InventoryTag | null; source: string; deployedAt: string; sbom: { id: string; componentCount: number; target: string; findings?: Record<Severity, number> } | null } | null;
  })[];
  releases: (Release & { images: InventoryTag[]; environments: { id: string; name: string; kind: EnvironmentKind }[]; sbom: { id: string; componentCount: number; findings?: Record<Severity, number> } | null })[];
  images: (ContainerImage & { tags: InventoryTag[] })[];
}

export interface OrganizationOverview {
  counts: { workspaces: number; teams: number; projects: number; services: number; releases7d: number; environments: number; productionEnvironments: number; internetFacing: number };
  pipelines24h: { total: number; succeeded: number; failed: number; running: number };
  runners: { online: number; offline: number; total: number };
  sbom: { services: number; documents: number; coverage: number };
  production: { deploymentId: string; projectId: string; projectName: string; projectCriticality: Criticality; serviceId: string; serviceName: string; environmentId: string; environmentName: string; internetFacing: boolean; version: string | null; imageRef: string | null; source: string; deployedAt: string; hasSbom: boolean }[];
  recentPipelines: { id: string; number: number; status: PipelineStatus; name: string; ref: string | null; trigger: string; createdAt: string; serviceName: string; projectId: string; projectName: string }[];
}

export interface ProjectOverview {
  services: { id: string; name: string; slug: string; kind: string }[];
  environments: { id: string; serviceId: string; name: string; slug: string; kind: EnvironmentKind; internetFacing: boolean; protected: boolean; current: { version: string | null; commit: string | null; tag: string | null; digest: string | null; imageRef: string | null; source: string; deployedAt: string; hasSbom: boolean } | null }[];
  pipelines: { id: string; number: number; status: PipelineStatus; name: string; ref: string | null; trigger: string; createdAt: string; finishedAt: string | null; serviceName: string }[];
  stats: { services: number; environments: number; internetFacing: number; releases: number; images: number; sboms: number; pipelines: { total: number; succeeded: number; failed: number } };
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';
export type FindingStatus = 'open' | 'fixed' | 'accepted' | 'false_positive' | 'not_affected';

export interface FindingRow {
  id: string;
  status: FindingStatus;
  severity: Severity;
  fixedVersion: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  note: string | null;
  advisory: { id: string; aliases: string[]; summary: string | null; cvssScore: number | null; cvssVector: string | null; epssScore: number | null; epssPercentile: number | null; kev: boolean; kevDueDate: string | null; publishedAt: string | null };
  component: { id: string; purl: string; type: string; namespace: string | null; name: string; version: string | null };
  serviceId: string;
  serviceName: string;
  projectId: string;
  projectName: string;
  projectCriticality: Criticality;
  environments: { id: string; name: string; kind: EnvironmentKind; internetFacing: boolean }[];
  sources: { sbomId: string; target: 'source' | 'image' | 'artifact'; targetRef: string; releaseVersion: string | null; image: string | null; tag: string | null; createdAt: string }[];
  severitySource?: string | null;
  severityNote?: string | null;
}

export interface FindingDetail extends Omit<FindingRow, 'advisory' | 'projectCriticality'> {
  advisory: FindingRow['advisory'] & { details: string | null; references: { type: string; url: string }[] };
  affected: { sbomId: string; target: string; targetRef: string; releaseVersion: string | null; createdAt: string }[];
}

export interface FindingSummary {
  open: Record<Severity, number>;
  kev: number;
  total: number;
  fixed: number;
  production: Record<Severity, number>;
  notRunning?: Record<Severity, number>;
  packageFindings?: number;
}

export interface FindingEnvironment {
  id: string;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  internetFacing: boolean;
  protected: boolean;
  serviceId: string;
  serviceName: string;
  projectId: string;
  projectName: string;
  current: { version: string | null; image: string | null; tag: string | null; digest: string | null; deployedAt: string; source: string } | null;
  sbomId: string | null;
  sbomTarget: string | null;
  findings: Record<Severity, number>;
}

export interface FindingTrendSeries {
  environmentId: string;
  name: string;
  kind: EnvironmentKind;
  serviceName: string;
  projectId: string;
  projectName: string;
  points: { day: string; version: string | null; critical: number; high: number; medium: number; low: number; kev: number }[];
}

export type RiskGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export interface RiskFactors {
  findingsPressure: number;
  exposureMultiplier: number;
  criticalityMultiplier: number;
  hygienePenalty: number;
  counts: { critical: number; high: number; medium: number; low: number; kev: number; fixable: number; inProduction: number; internetFacing: number; stale: number };
  notes: string[];
}
export interface RiskRow {
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  serviceCriticality: Criticality | null;
  projectId: string;
  projectName: string;
  projectCriticality: Criticality;
  teamName: string;
  workspaceName: string;
  score: number | null;
  grade: RiskGrade | null;
  factors: RiskFactors | null;
  computedAt: string | null;
  delta7d: number | null;
}
export interface RiskDetail {
  latest: { score: number; grade: RiskGrade; factors: RiskFactors; day: string; computedAt: string } | null;
  history: { day: string; score: number; grade: RiskGrade }[];
}
export interface GraphNode { id: string; type: 'project' | 'service' | 'repository' | 'release' | 'image' | 'environment' | 'sbom'; label: string; sub?: string; data: Record<string, unknown> }
export interface GraphEdge { from: string; to: string; kind: string }
export interface ProjectGraph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface CodeFindingRow {
  id: string;
  serviceId: string;
  kind: 'secret' | 'iac' | 'sast';
  ruleId: string;
  title: string;
  severity: Severity;
  category: string | null;
  file: string;
  startLine: number | null;
  endLine: number | null;
  evidence: string | null;
  resolution: string | null;
  references: string[];
  status: FindingStatus;
  ref: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  note: string | null;
  serviceName: string;
  projectId: string;
  projectName: string;
  repository: string | null;
  fileUrl: string | null;
}
export type CodeFindingSummary = Record<'secret' | 'iac' | 'sast', Record<Severity, number>>;

export interface LineageRegistry { image: string; host: string; repository: string; tags: string[]; digest: string | null; builtAt?: string | null; deployedFrom?: boolean; sbom: { id: string; componentCount: number; findings: Record<Severity, number> | null } | null; lastSyncedAt: string | null; lastError: string | null }
export interface EnvironmentLineage {
  environment: { id: string; name: string; slug: string; kind: EnvironmentKind; internetFacing: boolean; protected: boolean };
  service: { id: string; name: string; slug: string; criticality: Criticality | null };
  repository: { id: string; fullName: string; htmlUrl: string | null; defaultBranch: string | null } | null;
  /** true when the deployment declared the release version; false for a build of a commit that merely shares it */
  declared: boolean;
  release: { id: string; version: string; tag: string | null; commitSha: string | null; htmlUrl: string | null; releasedAt: string | null; source: string; sbom: { id: string; componentCount: number; findings: Record<Severity, number> | null } | null; registries: LineageRegistry[] } | null;
  running: { version: string | null; deployedAt: string; source: string; imageRef: string | null; digest: string | null; inferred?: boolean; commitSha: string | null; builtAt: string | null; tags: string[]; registries: LineageRegistry[]; sbom: { id: string; componentCount: number; findings: Record<Severity, number> | null } | null } | null;
  drift: { level: 'error' | 'warning' | 'info'; code: string; message: string }[];
  history: { id: string; version: string | null; imageRef: string | null; source: string; deployedAt: string; supersededAt: string | null }[];
}

export interface PolicyRules { maxSeverity: 'critical' | 'high' | 'medium' | 'low' | null; blockKev: boolean; blockSecrets: boolean; maxIacSeverity: 'critical' | 'high' | 'medium' | 'low' | null; maxSastSeverity?: 'critical' | 'high' | 'medium' | 'low' | null; requireSbom: boolean; honourDecisions: boolean }
export interface Policy { id: string; organizationId: string; scopeType: ScopeType; scopeId: string; name: string; description: string | null; enabled: boolean; environmentKinds: string[]; rules: PolicyRules; action: 'block' | 'warn'; enforceOnDeploy: boolean; createdAt: string; updatedAt: string }
export interface GateViolation { policyId: string; policyName: string; action: 'block' | 'warn'; rule: string; message: string; count?: number }
export interface GateEvaluation { id: string; environmentId: string | null; subject: { imageRef?: string; digest?: string; version?: string; ref?: string; sbomId?: string }; result: 'pass' | 'warn' | 'fail'; violations: GateViolation[]; policyIds: string[]; actor: string | null; evaluatedAt: string; facts?: { sbomId: string | null; findings: Record<Severity, number>; kevOpen: number; secretsOpen: number }; policies?: { id: string; name: string; action: string }[] }

export interface PolicyTemplate { id: string; name: string; description: string; environmentKinds: string[]; rules: PolicyRules; action: 'block' | 'warn'; enforceOnDeploy: boolean }
export interface SecurityException { id: string; organizationId: string; scopeType: ScopeType; scopeId: string; kind: 'vulnerability' | 'code'; matchId: string; matchComponent: string | null; status: FindingStatus; reason: string; ticketUrl: string | null; requestedById: string | null; approvedById: string | null; approvedAt: string | null; expiresAt: string; revokedAt: string | null; expiredAt: string | null; appliedFindingIds: string[]; appliedCodeFindingIds: string[]; createdAt: string; state: 'active' | 'pending' | 'expired' | 'revoked'; applied: number }

export interface SlaDays { critical: number; high: number; medium: number; low: number }
export type IssueProvider = 'github' | 'gitlab' | 'bitbucket' | 'jira';
export interface RemediationSettings { organizationId: string; scopeType: ScopeType; scopeId: string; slaDays: SlaDays | null; issueProvider: IssueProvider | null; issueBoard: string | null; defaultIssueIntegrationId: string | null; jiraProjectKey: string | null; updatedAt: string | null }
export interface EffectiveRemediationSettings { organizationId: string; projectId: string; slaDays: SlaDays; issueProvider: IssueProvider | null; issueBoard: string | null; defaultIssueIntegrationId: string | null; jiraProjectKey: string | null; sources: Record<'slaDays' | 'issueProvider' | 'issueBoard' | 'defaultIssueIntegrationId' | 'jiraProjectKey', { scopeType: ScopeType; scopeId: string; name: string } | null>; chain: { scopeType: ScopeType; scopeId: string; name: string }[] }
export interface QueueItem { key: string; kind: 'vulnerability' | 'code'; serviceId: string; serviceName: string; matchId: string; componentName: string | null; componentVersion: string | null; severity: Severity; kev: boolean; epss: number | null; fixVersion: string | null; findingIds: string[]; runsIn: string[]; internetFacing: boolean; firstSeenAt: string; dueAt: string; overdue: boolean; daysLeft: number; score: number; remediation: { id: string; status: string; ownerId: string | null; ownerName: string | null; issueKey: string | null; issueUrl: string | null; dueAt: string | null } | null }
export interface Remediation { id: string; stillPresent?: boolean; organizationId: string; serviceId: string; serviceName?: string; kind: 'vulnerability' | 'code'; matchId: string; componentName: string | null; title: string; severity: Severity; status: 'open' | 'in_progress' | 'done' | 'wont_fix'; ownerId: string | null; ownerName?: string | null; dueAt: string | null; findingIds: string[]; codeFindingIds: string[]; issueProvider: string | null; issueKey: string | null; issueUrl: string | null; notes: string | null; createdAt: string; updatedAt: string; closedAt: string | null; overdue?: boolean }

export interface ReadinessCheck { id: string; title: string; requirement: string; status: 'pass' | 'warn' | 'fail' | 'na'; detail: string; fix?: string }
export interface Readiness { serviceId: string; serviceName: string; score: number; grade: 'ready' | 'almost' | 'not_ready'; checks: ReadinessCheck[]; computedAt: string }

export interface NotificationChannel { id: string; organizationId: string; name: string; kind: 'slack' | 'webhook' | 'teams' | 'email'; url: string; events: string[]; projectId: string | null; enabled: boolean; lastSentAt: string | null; lastError: string | null; createdAt: string }
export interface NotificationEventInfo { id: string; description: string }

/** Keyless (workload identity) setup for a registry connection. */
export interface ConnectionIdentity { issuer: string; subject: string; authType: string; keyless: boolean; status: string; disconnected: boolean; params: Record<string, string> | null; verified: boolean; verifiedAt: string | null; lastError: string | null; jwksUri: string; openidConfiguration: string; warning: string | null; gcp: { audience: string; principal: string; steps: string[] }; aws: { audience: string; providerArn: string; trustPolicy: Record<string, unknown>; steps: string[] }; azure: { audience: string; steps: string[] } }

/** Usage metering (GET /organizations/:id/usage). */
export interface UsageMetrics { seats: { active: number | null; members: number }; projects: number; services: number; environments: number; pipelines: number; jobs: number; runnerMinutes: number; runnerMinutesManaged?: number; runnerMinutesByType: Record<string, number>; sboms: number }
export interface UsageReport { organizationId: string; month: string; live: boolean; computedAt: string; metrics: UsageMetrics; history: { month: string; final: boolean; computedAt: string; metrics: UsageMetrics }[] }

/** "Get started" checklist (GET /organizations/:id/onboarding): computed from what exists. */
export interface OnboardingStep { id: string; title: string; description: string; done: boolean; href: string; cli: string | null; detail: string | null; optional?: boolean }
export interface Onboarding { organizationId: string; canManage: boolean; steps: OnboardingStep[]; completed: number; total: number; requiredRemaining: number; complete: boolean; completedAt: string | null; dismissedAt: string | null; visible: boolean; next: OnboardingStep | null }

export type CoverageCheckId = "repository" | "pipeline" | "sbom" | "policy" | "deployment";
export type CoverageState = "ok" | "stale" | "missing";
export interface CoverageCheck { id: CoverageCheckId; title: string; state: CoverageState; detail: string; href: string | null; cli: string | null }
export interface ServiceCoverage { serviceId: string; serviceName: string; serviceSlug: string; projectId: string; projectName: string; workspaceId: string; covered: boolean; gaps: CoverageCheckId[]; checks: CoverageCheck[] }
export interface CoverageSummary { days: number; services: number; covered: number; checks: Record<CoverageCheckId, { title: string; ok: number; stale: number; missing: number }> }
export interface ProjectCoverage { projectId: string; days: number; summary: CoverageSummary; services: ServiceCoverage[] }
export interface OrganizationCoverage { organizationId: string; days: number; gap: CoverageCheckId | null; summary: CoverageSummary; uncoveredTotal: number; uncovered: ServiceCoverage[] }
