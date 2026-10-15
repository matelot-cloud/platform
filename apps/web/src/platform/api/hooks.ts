import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDashboard } from '../state/DashboardContext';
import { ApiError, useApi } from './client';
import type {
  MemberScopeType, MembersResponse, RoleInfo, MemberCandidate, AddMembersResult, ServiceAccount, TokenRow, CreatedToken, AdminCapabilities, AdminUserDetail, IssuedLink, InviteInfo,
  CoverageCheckId,
  OrganizationCoverage,
  ProjectCoverage,
  ConnectionIdentity,
  Onboarding,
  UsageReport,
  AdminUser,
  ApiToken,
  AuditEvent,
  ComponentHit,
  CodeFindingRow,
  CodeFindingSummary,
  EnvironmentLineage,
  FindingDetail,
  FindingEnvironment,
  GateEvaluation,
  Policy,
  PolicyRules,
  PolicyTemplate,
  NotificationChannel,
  NotificationEventInfo,
  QueueItem,
  Readiness,
  Remediation,
  RemediationSettings, EffectiveRemediationSettings, IssueProvider,
  SecurityException,
  SlaDays,
  FindingRow,
  FindingTrendSeries,
  FindingStatus,
  FindingSummary,
  OrganizationOverview,
  ProjectGraph,
  ProjectOverview,
  RiskDetail,
  RiskRow,
  SbomDetail,
  SbomDiff,
  SbomRow,
  ServiceInventory,
  TokenPresets,
  ContainerImage,
  Deployment,
  Release,
  ServiceDeployments,
  CreateIntegrationInput,
  Environment,
  IntegrationCreated,
  Job,
  JobLogChunk,
  JobType,
  Pipeline,
  PipelineTemplate,
  RegistrationToken,
  RunnerPool,
  EnvironmentKind,
  Integration,
  Provider,
  Repository,
  RepositoryWithServices,
  Service,
  ServiceKind,
  ServiceRepository,
  Criticality,
  Me,
  MembershipRow,
  Meta,
  Organization,
  PlatformRole,
  ProjectRow,
  ScopeType,
  TeamRow,
  Workspace,
} from './types';

/** 4xx means "not for you" rather than "try again". */
const retry = (count: number, error: unknown) => !(error instanceof ApiError && error.status < 500) && count < 2;

function useRefetchInterval(): number | false {
  const { refreshSeconds } = useDashboard();
  return refreshSeconds > 0 ? refreshSeconds * 1000 : false;
}

export function useMeta() {
  const api = useApi();
  return useQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/meta'), staleTime: Infinity });
}

export function useMe() {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), refetchInterval });
}

export function useOrganizations() {
  const api = useApi();
  return useQuery({ queryKey: ['organizations'], queryFn: () => api<Organization[]>('/organizations') });
}

export function useWorkspaces(organizationId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({
    queryKey: ['organizations', organizationId, 'workspaces'],
    queryFn: () => api<Workspace[]>(`/organizations/${organizationId}/workspaces`),
    enabled: !!organizationId,
    refetchInterval,
  });
}

export function useTeams(organizationId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({
    queryKey: ['organizations', organizationId, 'teams'],
    queryFn: () => api<TeamRow[]>(`/organizations/${organizationId}/teams`),
    enabled: !!organizationId,
    refetchInterval,
  });
}

export function useProjects(organizationId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({
    queryKey: ['organizations', organizationId, 'projects'],
    queryFn: () => api<ProjectRow[]>(`/organizations/${organizationId}/projects`),
    enabled: !!organizationId,
    refetchInterval,
  });
}

export function useMemberships(scopeType: ScopeType | undefined, scopeId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({
    queryKey: ['memberships', scopeType, scopeId],
    queryFn: () => api<MembershipRow[]>(`/memberships?scopeType=${scopeType}&scopeId=${scopeId}`),
    enabled: !!scopeType && !!scopeId,
    retry,
    refetchInterval,
  });
}

export function useAuditEvents(organizationId: string | undefined, limit = 50, before?: string) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set('before', before);
  return useQuery({
    queryKey: ['organizations', organizationId, 'audit', limit, before ?? null],
    queryFn: () => api<AuditEvent[]>(`/organizations/${organizationId}/audit-events?${query}`),
    enabled: !!organizationId,
    retry,
    refetchInterval: before ? false : refetchInterval,
  });
}

function useInvalidateOrganization() {
  const queryClient = useQueryClient();
  return (organizationId: string) => {
    void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId] });
    void queryClient.invalidateQueries({ queryKey: ['memberships'] });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  };
}

export interface NamedNodeInput {
  slug: string;
  name: string;
  description?: string;
}

export function useCreateWorkspace(organizationId: string) {
  const api = useApi();
  const invalidate = useInvalidateOrganization();
  return useMutation({
    mutationFn: (input: NamedNodeInput) =>
      api<Workspace>(`/organizations/${organizationId}/workspaces`, { method: 'POST', json: input }),
    onSuccess: () => invalidate(organizationId),
  });
}

export function useCreateTeam(organizationId: string) {
  const api = useApi();
  const invalidate = useInvalidateOrganization();
  return useMutation({
    mutationFn: ({ workspaceId, ...input }: NamedNodeInput & { workspaceId: string }) =>
      api<TeamRow>(`/workspaces/${workspaceId}/teams`, { method: 'POST', json: input }),
    onSuccess: () => invalidate(organizationId),
  });
}

export function useCreateProject(organizationId: string) {
  const api = useApi();
  const invalidate = useInvalidateOrganization();
  return useMutation({
    mutationFn: ({ teamId, ...input }: NamedNodeInput & { teamId: string; criticality: Criticality }) =>
      api<ProjectRow>(`/teams/${teamId}/projects`, { method: 'POST', json: input }),
    onSuccess: () => invalidate(organizationId),
  });
}

export function useArchiveProject(organizationId: string) {
  const api = useApi();
  const invalidate = useInvalidateOrganization();
  return useMutation({
    mutationFn: (projectId: string) => api<ProjectRow>(`/projects/${projectId}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(organizationId),
  });
}

export interface GrantInput {
  email: string;
  role: string;
  scopeType: ScopeType;
  scopeId: string;
  reason?: string;
}

export function useGrantMembership(organizationId: string) {
  const api = useApi();
  const invalidate = useInvalidateOrganization();
  return useMutation({
    mutationFn: (input: GrantInput) => api<MembershipRow>('/memberships', { method: 'POST', json: input }),
    onSuccess: () => invalidate(organizationId),
  });
}

export function useRevokeMembership(organizationId: string) {
  const api = useApi();
  const invalidate = useInvalidateOrganization();
  return useMutation({
    mutationFn: (membershipId: string) => api<void>(`/memberships/${membershipId}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(organizationId),
  });
}

export function useAdminUsers(enabled: boolean) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<AdminUser[]>('/admin/users'), enabled, retry, refetchInterval });
}

export function useUpdateAdminUser() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, ...body }: { userId: string; platformRole?: PlatformRole; enabled?: boolean; reason?: string }) =>
      api<AdminUser>(`/admin/users/${userId}`, { method: 'PATCH', json: body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// ---------------- services & environments ----------------

export function useServices(projectId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['projects', projectId, 'services'], queryFn: () => api<Service[]>(`/projects/${projectId}/services`), enabled: !!projectId, retry, refetchInterval });
}

export function useCreateService(organizationId: string, projectId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NamedNodeInput & { kind?: ServiceKind; criticality?: Criticality }) => api<Service>(`/projects/${projectId}/services`, { method: 'POST', json: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId] });
    },
  });
}

export function useUpdateService(projectId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; description?: string | null; kind?: ServiceKind; criticality?: Criticality | null }) => api<Service>(`/services/${id}`, { method: 'PATCH', json: body }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['projects', projectId] }); void queryClient.invalidateQueries({ queryKey: ['services'] }); },
  });
}
export function useServiceRegistry(serviceId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['services', serviceId, 'registry'], queryFn: () => api<{ host: string; repository: string; environments: { id: string; slug: string; name: string; repository: string; protected: boolean }[] } | null>(`/services/${serviceId}/registry`), enabled: !!serviceId, retry: false });
}

export function useArchiveService(projectId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) => api<Service>(`/services/${serviceId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['projects', projectId] }),
  });
}

export function useEnvironments(serviceId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['services', serviceId, 'environments'], queryFn: () => api<Environment[]>(`/services/${serviceId}/environments`), enabled: !!serviceId, retry, refetchInterval });
}

export function useCreateEnvironment(serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { slug: string; name: string; kind: EnvironmentKind; internetFacing: boolean }) => api<Environment>(`/services/${serviceId}/environments`, { method: 'POST', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['services', serviceId] }),
  });
}

export function useArchiveEnvironment(serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (environmentId: string) => api<Environment>(`/environments/${environmentId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['services', serviceId] }),
  });
}

// ---------------- integrations & repositories ----------------

export function useProviders() {
  const api = useApi();
  return useQuery({ queryKey: ['integrations', 'providers'], queryFn: () => api<Provider[]>('/integrations/providers'), staleTime: Infinity });
}

export function useIntegrations(organizationId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['organizations', organizationId, 'integrations'], queryFn: () => api<Integration[]>(`/organizations/${organizationId}/integrations`), enabled: !!organizationId, retry, refetchInterval });
}

export function useGithubInstallUrl() {
  const api = useApi();
  return useMutation({
    mutationFn: ({ organizationId, scopeType, scopeId }: { organizationId: string; scopeType?: ScopeType; scopeId?: string }) => {
      const query = scopeType && scopeId ? `?scopeType=${scopeType}&scopeId=${scopeId}` : '';
      return api<{ url: string }>(`/organizations/${organizationId}/integrations/github/install-url${query}`);
    },
  });
}

export function useProjectIntegrations(projectId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['projects', projectId, 'integrations'], queryFn: () => api<Integration[]>(`/projects/${projectId}/integrations`), enabled: !!projectId, retry, refetchInterval });
}

export function useProjectRepositories(projectId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['projects', projectId, 'repositories'], queryFn: () => api<RepositoryWithServices[]>(`/projects/${projectId}/repositories`), enabled: !!projectId, retry, refetchInterval });
}

export function useSyncIntegration(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (integrationId: string) => api<{ queued: true }>(`/integrations/${integrationId}/sync`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useDisconnectIntegration(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (integrationId: string) => api<Integration>(`/integrations/${integrationId}/disconnect`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useOrganizationRepositories(organizationId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['organizations', organizationId, 'repositories'], queryFn: () => api<RepositoryWithServices[]>(`/organizations/${organizationId}/repositories`), enabled: !!organizationId, retry, refetchInterval });
}

export function useServiceRepositories(serviceId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['services', serviceId, 'repositories'], queryFn: () => api<ServiceRepository[]>(`/services/${serviceId}/repositories`), enabled: !!serviceId, retry, refetchInterval });
}

export function useAttachRepository(organizationId: string, serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { repositoryId: string; role?: 'primary' | 'secondary' }) => api<Repository>(`/services/${serviceId}/repositories`, { method: 'POST', json: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['services', serviceId] });
      void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useDetachRepository(organizationId: string, serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repositoryId: string) => api<void>(`/services/${serviceId}/repositories/${repositoryId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['services', serviceId] });
      void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useCreateIntegration(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIntegrationInput) => api<IntegrationCreated>(`/organizations/${organizationId}/integrations`, { method: 'POST', json: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useTestIntegration(organizationId: string) {
  const api = useApi();
  return useMutation({ mutationFn: (input: CreateIntegrationInput) => api<{ ok: true; account: string }>(`/organizations/${organizationId}/integrations/test`, { method: 'POST', json: input }) });
}

export type { ConnectionIdentity } from './types';
/** Keyless (workload identity) setup for a registry connection: issuer, subject and the steps per cloud. */
export function useConnectionIdentity(integrationId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['integrations', integrationId, 'identity'], queryFn: () => api<ConnectionIdentity>(`/integrations/${integrationId}/identity`), enabled });
}

export function useMatelotRepositories(integrationId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['matelot-repositories', integrationId], queryFn: () => api<{ host: string; namespace: string; repositories: { serviceId: string; service: string; project: string; repository: string }[] }>(`/integrations/${integrationId}/matelot-repositories`), enabled, retry });
}
export function useLinkInstallation(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (integrationId: string) => api<Integration & { missingPermissions?: { key: string; level: string; why: string }[] }>(`/integrations/${integrationId}/link-installation`, { method: 'POST' }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'integrations'] }); } });
}
export function useIntegrationInstallUrl() {
  const api = useApi();
  return useMutation({ mutationFn: (integrationId: string) => api<{ url: string }>(`/integrations/${integrationId}/install-url`) });
}

export function useVerifyIntegration(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (integrationId: string) => api<IntegrationCreated & { account: string; verified?: boolean }>(`/integrations/${integrationId}/verify`, { method: 'POST' }),
    // success and failure both change the stored state (verified / lastError)
    onSettled: (_d, _e, integrationId) => {
      void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['integrations', integrationId, 'identity'] });
    },
  });
}

export function useUpdateWorkspace(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, ...input }: { workspaceId: string; name?: string; description?: string }) => api<Workspace>(`/workspaces/${workspaceId}`, { method: 'PATCH', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId] }),
  });
}

export function useArchiveWorkspace(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => api<Workspace>(`/workspaces/${workspaceId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId] }),
  });
}

export function useUpdateProject(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ...input }: { projectId: string; name?: string; description?: string; criticality?: Criticality; automation?: { pipelineOnPush?: 'default_branch' | 'all' | 'off'; template?: string } }) => api<ProjectRow>(`/projects/${projectId}`, { method: 'PATCH', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId] }),
  });
}

export function useDeleteIntegration(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    // 409 when container images pull through the connection (message lists them); force detaches them
    mutationFn: (input: string | { id: string; force?: boolean }) => { const { id, force } = typeof input === 'string' ? { id: input, force: false } : input; return api<{ deleted: true; repositories: number; imagesDetached: string[] }>(`/integrations/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }); },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['services'] });
    },
  });
}

// ---------------- execution plane ----------------

export function useRunnerPools(organizationId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['organizations', organizationId, 'runner-pools'], queryFn: () => api<RunnerPool[]>(`/organizations/${organizationId}/runner-pools`), enabled: !!organizationId, retry, refetchInterval: refetchInterval || 15_000 });
}

export function useCreateRunnerPool(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { scopeType?: ScopeType; scopeId?: string; slug: string; name: string; description?: string; tags?: string[] }) => api<RunnerPool>(`/organizations/${organizationId}/runner-pools`, { method: 'POST', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'runner-pools'] }),
  });
}

export function useDeleteRunnerPool(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (poolId: string) => api<void>(`/runner-pools/${poolId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'runner-pools'] }),
  });
}

export function useRemoveRunner(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runnerId: string) => api<void>(`/runners/${runnerId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'runner-pools'] }),
  });
}

export function useRegistrationToken() {
  const api = useApi();
  return useMutation({ mutationFn: (poolId: string) => api<RegistrationToken>(`/runner-pools/${poolId}/registration-tokens`, { method: 'POST' }) });
}

export function useProjectJobs(projectId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['projects', projectId, 'jobs'], queryFn: () => api<Job[]>(`/projects/${projectId}/jobs`), enabled: !!projectId, retry, refetchInterval: 5_000 });
}

export function useJob(jobId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ['jobs', jobId],
    queryFn: () => api<Job>(`/jobs/${jobId}`),
    enabled: !!jobId,
    retry,
    refetchInterval: (query) => (query.state.data && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(query.state.data.status) ? false : 2_000),
  });
}

export function useJobLogs(jobId: string | undefined, live: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['jobs', jobId, 'logs'], queryFn: () => api<JobLogChunk[]>(`/jobs/${jobId}/logs`), enabled: !!jobId, retry, refetchInterval: live ? 2_000 : false });
}

export function useCreateJob(projectId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serviceId, ...input }: { serviceId: string; type: JobType; repositoryId?: string; requiredTags?: string[]; poolId?: string; payload?: Record<string, unknown>; timeoutSeconds?: number }) => api<Job>(`/services/${serviceId}/jobs`, { method: 'POST', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'jobs'] }),
  });
}

export function useCancelJob(projectId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api<Job>(`/jobs/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

// ---------------- pipelines ----------------

export function usePipelineTemplates() {
  const api = useApi();
  return useQuery({ queryKey: ['pipeline-templates'], queryFn: () => api<PipelineTemplate[]>('/pipeline-templates'), staleTime: Infinity });
}

export function useProjectPipelines(projectId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['projects', projectId, 'pipelines'], queryFn: () => api<Pipeline[]>(`/projects/${projectId}/pipelines`), enabled: !!projectId, retry, refetchInterval: 5_000 });
}

export function usePipeline(pipelineId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ['pipelines', pipelineId],
    queryFn: () => api<Pipeline>(`/pipelines/${pipelineId}`),
    enabled: !!pipelineId,
    retry,
    refetchInterval: (query) => (query.state.data && ['succeeded', 'failed', 'cancelled'].includes(query.state.data.status) ? false : 2_000),
  });
}

export function useCreatePipeline(projectId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serviceId, ...input }: { serviceId: string; template?: string; repositoryId?: string; ref?: string; requiredTags?: string[]; poolId?: string }) => api<Pipeline>(`/services/${serviceId}/pipelines`, { method: 'POST', json: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'pipelines'] });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'jobs'] });
    },
  });
}

export function useCancelPipeline(projectId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pipelineId: string) => api<Pipeline>(`/pipelines/${pipelineId}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useRetryJob(projectId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api<Job>(`/jobs/${jobId}/retry`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

// ---------------- inventory ----------------

export function useReleases(serviceId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['services', serviceId, 'releases'], queryFn: () => api<Release[]>(`/services/${serviceId}/releases`), enabled: !!serviceId, retry, refetchInterval });
}

export function useCreateRelease(serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { version: string; tag?: string; commitSha?: string; notes?: string }) => api<Release>(`/services/${serviceId}/releases`, { method: 'POST', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['services', serviceId] }),
  });
}

export function useSyncReleases(serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ created: number; seen: number; errors: string[] }>(`/services/${serviceId}/releases/sync`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['services', serviceId] }),
  });
}

export function useImages(serviceId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['services', serviceId, 'images'], queryFn: () => api<ContainerImage[]>(`/services/${serviceId}/images`), enabled: !!serviceId, retry, refetchInterval });
}

export function useAddImage(serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; integrationId?: string; insecure?: boolean }) => api<ContainerImage>(`/services/${serviceId}/images`, { method: 'POST', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['services', serviceId] }),
  });
}

export function useSyncImage(serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (imageId: string) => api<{ tags: number }>(`/services/${serviceId}/images/${imageId}/sync`, { method: 'POST' }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['services', serviceId] }),
  });
}

export function useRemoveImage(serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (imageId: string) => api<void>(`/services/${serviceId}/images/${imageId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['services', serviceId] }),
  });
}

export function useServiceDeployments(serviceId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['services', serviceId, 'deployments'], queryFn: () => api<ServiceDeployments>(`/services/${serviceId}/deployments`), enabled: !!serviceId, retry, refetchInterval: 10_000 });
}

export function useRecordDeployment(serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ environmentId, ...input }: { environmentId: string; version?: string; releaseId?: string; imageRef?: string }) => api<Deployment>(`/environments/${environmentId}/deployments`, { method: 'POST', json: { ...input, source: 'manual' } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['services', serviceId] }),
  });
}

export function useEnvironmentSettings(serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ environmentId, ...input }: { environmentId: string; kubernetesNamespace?: string; kubernetesContext?: string; runnerTag?: string; protected?: boolean }) => api<Environment>(`/environments/${environmentId}/settings`, { method: 'PATCH', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['services', serviceId] }),
  });
}

export function useKubernetesSync(projectId: string, serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (environmentId: string) => api<Job>(`/environments/${environmentId}/kubernetes-sync`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['services', serviceId] });
    },
  });
}

export function useProjectInventory(projectId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['projects', projectId, 'inventory'], queryFn: () => api<{ releases: number; images: number; deployments: number }>(`/projects/${projectId}/inventory`), enabled: !!projectId, retry, refetchInterval: 15_000 });
}

// ---------------- CI tokens ----------------

export function useTokenPresets() {
  const api = useApi();
  return useQuery({ queryKey: ['api-tokens', 'presets'], queryFn: () => api<TokenPresets>('/api-tokens/presets'), staleTime: Infinity });
}

export function useApiTokens(organizationId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['organizations', organizationId, 'api-tokens'], queryFn: () => api<ApiToken[]>(`/organizations/${organizationId}/api-tokens`), enabled: !!organizationId, retry });
}

export function useCreateApiToken(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; scopeType?: ScopeType; scopeId?: string; preset?: string; expiresInDays?: number; environments?: string[] }) => api<ApiToken>(`/organizations/${organizationId}/api-tokens`, { method: 'POST', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'api-tokens'] }),
  });
}

export function useRevokeApiToken(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => api<ApiToken>(`/api-tokens/${tokenId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'api-tokens'] }),
  });
}

// ---------------- SBOM ----------------

export function useSboms(serviceId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['services', serviceId, 'sboms'], queryFn: () => api<SbomRow[]>(`/services/${serviceId}/sboms`), enabled: !!serviceId, retry, refetchInterval: 10_000 });
}

export function useSbom(sbomId: string | undefined, q?: string) {
  const api = useApi();
  return useQuery({ queryKey: ['sboms', sbomId, q ?? ''], queryFn: () => api<SbomDetail>(`/sboms/${sbomId}${q ? `?q=${encodeURIComponent(q)}` : ''}`), enabled: !!sbomId, retry });
}

export function useSbomDiff(from: string | undefined, to: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['sboms', from, 'diff', to], queryFn: () => api<SbomDiff>(`/sboms/${from}/diff/${to}`), enabled: !!from && !!to && from !== to, retry });
}

export function useComponentSearch(organizationId: string | undefined, q: string, scope?: SecurityScope) {
  const api = useApi();
  return useQuery({ queryKey: [...scopeKey(organizationId, scope), 'components', q], queryFn: () => api<ComponentHit[]>(scopeUrl(organizationId, scope, '/components', `q=${encodeURIComponent(q)}`)), enabled: !!organizationId && q.trim().length >= 2, retry });
}

export function useRegistryInfo() {
  const api = useApi();
  return useQuery({ queryKey: ['registry', 'info'], queryFn: () => api<{ available: boolean; host: string | null; convention: string; login: string | null }>('/registry/info'), staleTime: Infinity });
}

export function useEnvironmentRegistry(environmentId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['environments', environmentId, 'registry'], queryFn: () => api<{ available: boolean; host?: string; repository?: string; build?: string; protected?: boolean; pull?: string; push?: string }>(`/environments/${environmentId}/registry`), enabled: !!environmentId, staleTime: 60_000 });
}

export function usePromoteImage(serviceId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ environmentId, tag }: { environmentId: string; tag: string }) => api<{ from: string; to: string; digest: string | null }>(`/environments/${environmentId}/promote`, { method: 'POST', json: { tag } }),
    onSuccess: () => setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['services', serviceId] }), 2500),
  });
}

/** Environments of several services, keyed by service id (small N: one query per service). */
export function useServiceEnvironmentsMap(serviceIds: string[]): Record<string, Environment[]> {
  const api = useApi();
  const results = useQueries({
    queries: serviceIds.map((id) => ({ queryKey: ['services', id, 'environments'], queryFn: () => api<Environment[]>(`/services/${id}/environments`), retry })),
  });
  const map: Record<string, Environment[]> = {};
  results.forEach((r, i) => { if (r.data) map[serviceIds[i]] = r.data; });
  return map;
}

export function useServiceInventory(serviceId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['services', serviceId, 'inventory'], queryFn: () => api<ServiceInventory>(`/services/${serviceId}/inventory`), enabled: !!serviceId, retry, refetchInterval: 15_000 });
}

export function useOrganizationOverview(organizationId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['organizations', organizationId, 'overview'], queryFn: () => api<OrganizationOverview>(`/organizations/${organizationId}/overview`), enabled: !!organizationId, retry, refetchInterval: 30_000 });
}

export function useProjectOverview(projectId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['projects', projectId, 'overview'], queryFn: () => api<ProjectOverview>(`/projects/${projectId}/overview`), enabled: !!projectId, retry, refetchInterval: 20_000 });
}

// ---------------- ECR repositories (through an ECR connection) ----------------

export interface EcrRepository { repositoryName: string; repositoryUri: string; createdAt?: number; imageTagMutability?: 'MUTABLE' | 'IMMUTABLE'; scanOnPush?: boolean }

export function useEcrRepositories(integrationId: string | undefined, enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['integrations', integrationId, 'ecr-repositories'], queryFn: () => api<EcrRepository[]>(`/integrations/${integrationId}/ecr/repositories`), enabled: !!integrationId && enabled, retry });
}

export function useCreateEcrRepository(integrationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; scanOnPush?: boolean; immutableTags?: boolean }) => api<EcrRepository>(`/integrations/${integrationId}/ecr/repositories`, { method: 'POST', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['integrations', integrationId, 'ecr-repositories'] }),
  });
}

export function useRunnerAgent() {
  const api = useApi();
  return useQuery({ queryKey: ['runner-agent'], queryFn: () => api<{ latestVersion: string; image: string }>('/runner-agent'), staleTime: Infinity });
}

// ---------------- Vulnerabilities ----------------

export interface FindingQuery { severity?: string[]; status?: string[]; kev?: boolean; q?: string; running?: boolean }
const findingQs = (f: FindingQuery) => { const p = new URLSearchParams(); if (f.severity?.length) p.set('severity', f.severity.join(',')); if (f.status?.length) p.set('status', f.status.join(',')); if (f.kev) p.set('kev', 'true'); if (f.q) p.set('q', f.q); if (f.running) p.set('running', 'true'); const s = p.toString(); return s ? `?${s}` : ''; };

export function useOrganizationFindings(organizationId: string | undefined, query: FindingQuery, scope?: SecurityScope) {
  const api = useApi();
  return useQuery({ queryKey: [...scopeKey(organizationId, scope), 'findings', query], queryFn: () => api<FindingRow[]>(scopeUrl(organizationId, scope, '/findings', findingQs(query))), enabled: !!organizationId, retry, refetchInterval: 60_000 });
}

export function useProjectFindings(projectId: string | undefined, query: FindingQuery) {
  const api = useApi();
  return useQuery({ queryKey: ['projects', projectId, 'findings', query], queryFn: () => api<FindingRow[]>(`/projects/${projectId}/findings${findingQs(query)}`), enabled: !!projectId, retry, refetchInterval: 60_000 });
}

export function useFindingSummary(organizationId: string | undefined, projectId?: string) {
  const api = useApi();
  return useQuery({ queryKey: [...scopeKey(organizationId, projectId), 'findings', 'summary'], queryFn: () => api<FindingSummary>(scopeUrl(organizationId, projectId, '/findings/summary')), enabled: !!(projectId ?? organizationId), retry, refetchInterval: 60_000 });
}

export function useFinding(findingId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['findings', findingId], queryFn: () => api<FindingDetail>(`/findings/${findingId}`), enabled: !!findingId, retry });
}

export function useSetFindingStatus() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ findingId, status, note }: { findingId: string; status: FindingStatus; note?: string }) => api<FindingRow>(`/findings/${findingId}`, { method: 'PATCH', json: { status, note } }),
    onSuccess: (_d, v) => { void queryClient.invalidateQueries({ queryKey: ['findings', v.findingId] }); void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('findings') }); },
  });
}

export function useRecorrelate(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ checked: number; newAdvisories: number; findingsOpened: number; findingsFixed: number }>(`/organizations/${organizationId}/findings/recorrelate`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('findings') }),
  });
}

export function useSbomFindings(sbomId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['sboms', sbomId, 'findings'], queryFn: () => api<FindingRow[]>(`/sboms/${sbomId}/findings`), enabled: !!sbomId, retry });
}

export function useFindingEnvironments(organizationId: string | undefined, projectId?: string) {
  const api = useApi();
  return useQuery({ queryKey: [...scopeKey(organizationId, projectId), 'findings', 'environments'], queryFn: () => api<FindingEnvironment[]>(scopeUrl(organizationId, projectId, '/findings/environments')), enabled: !!(projectId ?? organizationId), retry, refetchInterval: 60_000 });
}

export function useFindingTrend(organizationId: string | undefined, days: number, projectId?: string) {
  const api = useApi();
  return useQuery({ queryKey: [...scopeKey(organizationId, projectId), 'findings', 'trend', days], queryFn: () => api<FindingTrendSeries[]>(scopeUrl(organizationId, projectId, '/findings/trend', `days=${days}`)), enabled: !!(projectId ?? organizationId), retry, refetchInterval: 300_000 });
}

export function useSnapshotNow(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: () => api<{ today: number; backfilled: number }>(`/organizations/${organizationId}/findings/snapshots?backfillDays=90`, { method: 'POST' }), onSuccess: () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('trend') }) });
}

// ---------------- Risk ----------------

export function useRiskRanking(organizationId: string | undefined, projectId?: string) {
  const api = useApi();
  return useQuery({ queryKey: [...scopeKey(organizationId, projectId), 'risk'], queryFn: () => api<RiskRow[]>(scopeUrl(organizationId, projectId, '/risk')), enabled: !!(projectId ?? organizationId), retry, refetchInterval: 60_000 });
}

export function useServiceRisk(serviceId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['services', serviceId, 'risk'], queryFn: () => api<RiskDetail>(`/services/${serviceId}/risk`), enabled: !!serviceId, retry });
}

export function useProjectGraph(projectId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['projects', projectId, 'graph'], queryFn: () => api<ProjectGraph>(`/projects/${projectId}/graph`), enabled: !!projectId, retry, refetchInterval: 60_000 });
}

export function useRecomputeRisk(organizationId: string, projectId?: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: () => api<{ services: number }>(projectId ? `/projects/${projectId}/risk/recompute` : `/organizations/${organizationId}/risk/recompute`, { method: 'POST' }), onSuccess: () => { void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('risk') || q.queryKey.includes('graph') }); } });
}

// ---------------- Code findings (secrets, IaC) ----------------

export interface CodeFindingQuery { kind?: string[]; severity?: string[]; status?: string[]; q?: string }
const codeQs = (f: CodeFindingQuery) => { const p = new URLSearchParams(); if (f.kind?.length) p.set('kind', f.kind.join(',')); if (f.severity?.length) p.set('severity', f.severity.join(',')); if (f.status?.length) p.set('status', f.status.join(',')); if (f.q) p.set('q', f.q); const s = p.toString(); return s ? `?${s}` : ''; };

export function useCodeFindings(organizationId: string | undefined, query: CodeFindingQuery, projectId?: string) {
  const api = useApi();
  return useQuery({ queryKey: [...scopeKey(organizationId, projectId), 'code-findings', query], queryFn: () => api<CodeFindingRow[]>(scopeUrl(organizationId, projectId, '/code-findings', codeQs(query))), enabled: !!(projectId ?? organizationId), retry, refetchInterval: 60_000 });
}

export function useCodeFindingSummary(organizationId: string | undefined, projectId?: string) {
  const api = useApi();
  return useQuery({ queryKey: [projectId ? 'projects' : 'organizations', projectId ?? organizationId, 'code-findings', 'summary'], queryFn: () => api<CodeFindingSummary>(`${projectId ? `/projects/${projectId}` : `/organizations/${organizationId}`}/code-findings/summary`), enabled: !!(projectId ?? organizationId), retry, refetchInterval: 60_000 });
}

export function useSetCodeFindingStatus() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: FindingStatus; note?: string }) => api<CodeFindingRow>(`/code-findings/${id}`, { method: 'PATCH', json: { status, note } }),
    onSuccess: () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('code-findings') }),
  });
}


// ---------------- scope helpers ----------------
// A "scope" is either a project id (legacy) or a path prefix such as `workspaces/<id>`, `teams/<id>`, `projects/<id>`,
// optionally followed by `?team=<id>` to narrow a workspace to one team.
export type SecurityScope = string | undefined;
export const scopeBase = (organizationId: string | undefined, scope?: SecurityScope): string => {
  if (!scope) return `/organizations/${organizationId}`;
  const [path] = scope.split('?');
  return path.includes('/') ? `/${path}` : `/projects/${path}`;
};
export const scopeQs = (scope?: SecurityScope): string => (scope && scope.includes('?') ? scope.slice(scope.indexOf('?') + 1) : '');
/** joins a base + suffix with a query string that may already exist */
export const scopeUrl = (organizationId: string | undefined, scope: SecurityScope, suffix: string, qs = ''): string => {
  const extra = [scopeQs(scope), qs.replace(/^\?/, '')].filter(Boolean).join('&');
  return `${scopeBase(organizationId, scope)}${suffix}${extra ? `?${extra}` : ''}`;
};
export const scopeKey = (organizationId: string | undefined, scope?: SecurityScope) => (scope ? ['scope', scope] : ['organizations', organizationId]);

// ---------------- Background activity ----------------

export interface ActiveJob { id: string; type: string; status: 'queued' | 'assigned' | 'running'; name: string | null; stage: string | null; projectId: string | null; serviceId: string | null; pipelineId: string | null; payload: Record<string, unknown>; createdAt: string; startedAt: string | null; serviceName: string | null }

/** Queued/running jobs of the organization; when one finishes, every query refreshes so results appear without a reload. */
export function useActiveJobs(organizationId: string | undefined) {
  const api = useApi();
  const queryClient = useQueryClient();
  const seen = useRef<Set<string>>(new Set());
  const query = useQuery({ queryKey: ['organizations', organizationId, 'jobs', 'active'], queryFn: () => api<ActiveJob[]>(`/organizations/${organizationId}/jobs/active`), enabled: !!organizationId, refetchInterval: 4000, retry });
  useEffect(() => {
    if (!query.data) return;
    const now = new Set(query.data.map((j) => j.id));
    const finished = [...seen.current].some((id) => !now.has(id));
    seen.current = now;
    if (finished) void queryClient.invalidateQueries({ predicate: (q) => !(q.queryKey.includes('active')) });
  }, [query.data, queryClient]);
  return query;
}

/** Image refs / release versions with an SBOM job in progress (for inline "Generating…" states). */
export function usePendingSboms(organizationId: string | undefined) {
  const active = useActiveJobs(organizationId);
  return useMemo(() => {
    const images = new Set<string>();
    const versions = new Set<string>();
    for (const j of active.data ?? []) {
      if (j.type !== 'sbom') continue;
      if (typeof j.payload.imageRef === 'string') images.add(j.payload.imageRef);
      if (j.payload.target === 'source' && typeof j.payload.version === 'string') versions.add(j.payload.version);
      if (j.payload.target === 'source' && typeof j.payload.ref === 'string') versions.add(j.payload.ref);
    }
    return { images, versions };
  }, [active.data]);
}

// ---------------- Personal access tokens ----------------

export interface PersonalToken { id: string; name: string; scope: 'read' | 'write' | 'sudo'; source?: 'ui' | 'oauth' | 'cli'; oauthClientId?: string | null; prefix: string; expiresAt: string; lastUsedAt: string | null; lastUsedIp: string | null; revokedAt: string | null; createdAt: string; expired: boolean }

export function usePersonalTokens() {
  const api = useApi();
  return useQuery({ queryKey: ['me', 'tokens'], queryFn: () => api<{ tokens: PersonalToken[]; canCreateSudo: boolean }>('/me/tokens'), retry });
}

export function useCreatePersonalToken() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: { name: string; scope: PersonalToken['scope']; expiresInDays: number }) => api<PersonalToken & { token: string }>('/me/tokens', { method: 'POST', json: input }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me', 'tokens'] }) });
}

export function useRevokePersonalToken() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api<{ revoked: boolean }>(`/me/tokens/${id}`, { method: 'DELETE' }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me', 'tokens'] }) });
}

export function useEnvironmentLineage(environmentId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['environments', environmentId, 'lineage'], queryFn: () => api<EnvironmentLineage>(`/environments/${environmentId}/lineage`), enabled: !!environmentId, retry, refetchInterval: 30_000 });
}

// ---------------- Policies & gates ----------------

export function usePolicies(organizationId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['organizations', organizationId, 'policies'], queryFn: () => api<Policy[]>(`/organizations/${organizationId}/policies`), enabled: !!organizationId, retry });
}
export function useScopePolicies(scope: { type: 'organization' | 'workspace' | 'team' | 'project'; id: string }) {
  const api = useApi();
  const path = scope.type === 'organization' ? `/organizations/${scope.id}/policies` : `/${scope.type}s/${scope.id}/policies`;
  return useQuery({ queryKey: ['policies', scope.type, scope.id], queryFn: () => api<(Policy & { inherited?: boolean })[]>(path), retry });
}
export function useProjectPolicies(projectId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['projects', projectId, 'policies'], queryFn: () => api<(Policy & { id: string })[]>(`/projects/${projectId}/policies`), enabled: !!projectId, retry });
}
export function useSavePolicy(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; scope?: { type: 'organization' | 'workspace' | 'team' | 'project'; id: string }; name: string; description?: string; environmentKinds: string[]; rules: PolicyRules; action: 'block' | 'warn'; enforceOnDeploy: boolean; enabled?: boolean }) => {
      const { id, scope, ...body } = input;
      const path = !scope || scope.type === 'organization' ? `/organizations/${organizationId}/policies` : `/${scope.type}s/${scope.id}/policies`;
      return id ? api<Policy>(`/policies/${id}`, { method: 'PATCH', json: body }) : api<Policy>(path, { method: 'POST', json: body });
    },
    onSuccess: () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('policies') }),
  });
}
export function useDeletePolicy() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api<{ deleted: boolean }>(`/policies/${id}`, { method: 'DELETE' }), onSuccess: () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('policies') }) });
}
export function useLatestGate(environmentId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['environments', environmentId, 'gate'], queryFn: () => api<GateEvaluation | null>(`/environments/${environmentId}/gate`), enabled: !!environmentId, retry, refetchInterval: 30_000 });
}
export function useEvaluateGate() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ environmentId, ...subject }: { environmentId: string; imageRef?: string; version?: string; ref?: string; digest?: string }) => api<GateEvaluation>(`/environments/${environmentId}/gate`, { method: 'POST', json: subject }), onSuccess: (_d, v) => void queryClient.invalidateQueries({ queryKey: ['environments', v.environmentId, 'gate'] }) });
}

export function usePolicyTemplates() {
  const api = useApi();
  return useQuery({ queryKey: ['policy-templates'], queryFn: () => api<PolicyTemplate[]>('/policy-templates'), retry, staleTime: 3_600_000 });
}
export function useCreatePolicyFromTemplate() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: { scope: { type: 'organization' | 'workspace' | 'team' | 'project'; id: string }; template: string; name?: string }) => api<Policy>(`/${input.scope.type}s/${input.scope.id}/policies/from-template`, { method: 'POST', json: { template: input.template, name: input.name } }), onSuccess: () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('policies') }) });
}
export function useExceptions(organizationId: string | undefined, active?: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['organizations', organizationId, 'exceptions', active], queryFn: () => api<SecurityException[]>(`/organizations/${organizationId}/exceptions${active === undefined ? '' : `?active=${active}`}`), enabled: !!organizationId, retry });
}
export function useCreateException() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: { scope: { type: 'organization' | 'project' | 'service'; id: string }; kind: 'vulnerability' | 'code'; matchId: string; matchComponent?: string; status?: FindingStatus; reason: string; ticketUrl?: string; expiresAt: string }) => { const { scope, ...body } = input; return api<SecurityException>(`/${scope.type}s/${scope.id}/exceptions`, { method: 'POST', json: body }); }, onSuccess: () => void queryClient.invalidateQueries() });
}
export function useRevokeException() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api<{ revoked: boolean }>(`/exceptions/${id}`, { method: 'DELETE' }), onSuccess: () => void queryClient.invalidateQueries() });
}

export function useApproveException() {
  const api = useApi(); const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api(`/exceptions/${id}/approve`, { method: 'POST' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['exceptions'] }); void qc.invalidateQueries({ queryKey: ['findings'] }); } });
}

// ---------------- Remediation ----------------

export function useRemediationQueue(projectId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: [...scopeKey(undefined, projectId), 'remediation', 'queue'], queryFn: () => api<QueueItem[]>(scopeUrl(undefined, projectId, '/remediation/queue')), enabled: !!projectId, retry, refetchInterval });
}
export function useRemediations(projectId: string | undefined, status?: string) {
  const api = useApi();
  return useQuery({ queryKey: [...scopeKey(undefined, projectId), 'remediations', status], queryFn: () => api<Remediation[]>(scopeUrl(undefined, projectId, '/remediations', status ? `status=${status}` : '')), enabled: !!projectId, retry });
}
/** scope = "organizations/ID" | "workspaces/ID" | "teams/ID" | "projects/ID" (each scope stores only its overrides). */
export function useRemediationSettings(scope: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['remediation-settings', scope], queryFn: () => api<RemediationSettings>(`/${scope}/remediation/settings`), enabled: !!scope, retry });
}
export function useEffectiveRemediationSettings(projectId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['remediation-settings', 'effective', projectId], queryFn: () => api<EffectiveRemediationSettings>(`/projects/${projectId}/remediation/settings/effective`), enabled: !!projectId, retry });
}
export function useUpdateRemediationSettings(scope: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: { slaDays?: Partial<SlaDays> | null; issueProvider?: IssueProvider | null; issueBoard?: string | null; jiraProjectKey?: string | null; defaultIssueIntegrationId?: string | null }) => api<RemediationSettings>(`/${scope}/remediation/settings`, { method: 'PATCH', json: input }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['remediation-settings'] }); void queryClient.invalidateQueries({ queryKey: ['remediation'] }); } });
}
export function useCreateRemediation() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: { serviceId: string; kind: 'vulnerability' | 'code'; matchId: string; componentName?: string | null; ownerEmail?: string; dueAt?: string; notes?: string }) => { const { serviceId, ...body } = input; return api<Remediation>(`/services/${serviceId}/remediations`, { method: 'POST', json: body }); }, onSuccess: () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('remediation') || q.queryKey.includes('remediations') }) });
}
export function useUpdateRemediation() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...body }: { id: string; status?: Remediation['status']; ownerEmail?: string; ownerId?: string | null; dueAt?: string | null; notes?: string | null }) => api<Remediation>(`/remediations/${id}`, { method: 'PATCH', json: body }), onSuccess: () => void queryClient.invalidateQueries() });
}
export function useCreateIssue() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...body }: { id: string; provider?: IssueProvider; projectKey?: string }) => api<Remediation>(`/remediations/${id}/issue`, { method: 'POST', json: body }), onSuccess: () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('remediation') || q.queryKey.includes('remediations') }) });
}

// ---------------- CRA ----------------

export function useProjectReadiness(projectId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: [...scopeKey(undefined, projectId), 'cra', 'readiness'], queryFn: () => api<Readiness[]>(scopeUrl(undefined, projectId, '/cra/readiness')), enabled: !!projectId, retry, refetchInterval: 60_000 });
}
/** Downloads the signed evidence bundle of a release through the authenticated API client. */
export function useEvidenceDownload() {
  const api = useApi();
  return async (releaseId: string, filename: string) => {
    const blob = await api<Blob>(`/releases/${releaseId}/evidence.zip`, { raw: true });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
  };
}

// ---------------- Notifications ----------------

export function useNotificationCapabilities() {
  const api = useApi();
  return useQuery({ queryKey: ['notification-capabilities'], queryFn: () => api<{ slack: boolean; teams: boolean; webhook: boolean; email: boolean }>('/notification-capabilities'), retry, staleTime: 3_600_000 });
}
export function useNotificationEvents() {
  const api = useApi();
  return useQuery({ queryKey: ['notification-events'], queryFn: () => api<NotificationEventInfo[]>('/notification-events'), retry, staleTime: 3_600_000 });
}
export function useNotificationChannels(organizationId: string | undefined, scope?: SecurityScope) {
  const api = useApi();
  return useQuery({ queryKey: [...scopeKey(organizationId, scope), 'notification-channels'], queryFn: () => api<NotificationChannel[]>(scopeUrl(organizationId, scope, '/notification-channels')), enabled: !!organizationId, retry });
}
export function useSaveChannel(organizationId: string, scope?: SecurityScope) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: { id?: string; name: string; kind?: 'slack' | 'webhook' | 'teams' | 'email'; url?: string; events: string[]; enabled?: boolean; projectId?: string | null }) => { const { id, ...body } = input; return id ? api<NotificationChannel>(`/notification-channels/${id}`, { method: 'PATCH', json: body }) : api<NotificationChannel>(scopeUrl(organizationId, scope, '/notification-channels'), { method: 'POST', json: body }); }, onSuccess: () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('notification-channels') }) });
}
export function useChannelAction(_organizationId?: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ id, action }: { id: string; action: 'test' | 'delete' }): Promise<{ sent?: boolean; deleted?: boolean }> => (action === 'test' ? api(`/notification-channels/${id}/test`, { method: 'POST' }) : api(`/notification-channels/${id}`, { method: 'DELETE' })), onSuccess: () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('notification-channels') }) });
}

/** Usage of the organization for a month (default: current, live) with up to 12 months of history. */
export function useUsage(organizationId: string | undefined, month?: string) {
  const api = useApi();
  return useQuery({ queryKey: ['organizations', organizationId, 'usage', month ?? 'current'], queryFn: () => { const q = month ? `?month=${encodeURIComponent(month)}` : ''; return api<UsageReport>(`/organizations/${organizationId}/usage${q}`); }, enabled: !!organizationId, retry });
}
export function useUsageCsv(organizationId: string) {
  const api = useApi();
  return useMutation({ mutationFn: (month: string) => api<Blob>(`/organizations/${organizationId}/usage?month=${month}&format=csv`, { raw: true }) });
}

/** The organization's "Get started" checklist; refreshed with the dashboard. */
export function useOnboarding(organizationId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['organizations', organizationId, 'onboarding'], queryFn: () => api<Onboarding>(`/organizations/${organizationId}/onboarding`), enabled: !!organizationId, retry, refetchInterval });
}
export function useSetOnboardingDismissed(organizationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dismissed: boolean) => (dismissed ? api<Onboarding>(`/organizations/${organizationId}/onboarding/dismiss`, { method: 'POST' }) : api<Onboarding>(`/organizations/${organizationId}/onboarding/restore`, { method: 'POST' })),
    onSuccess: (data) => { queryClient.setQueryData(['organizations', organizationId, 'onboarding'], data); },
  });
}

/** Service coverage of a project: every service with its five checks (permanent, not a checklist). */
export function useProjectCoverage(projectId: string | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['projects', projectId, 'coverage'], queryFn: () => api<ProjectCoverage>(`/projects/${projectId}/coverage`), enabled: !!projectId, retry, refetchInterval });
}
/** Organization-wide coverage over the projects the user can read; `gap` narrows the uncovered list (never the summary). */
export function useOrganizationCoverage(organizationId: string | undefined, gap?: CoverageCheckId | null) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['organizations', organizationId, 'coverage', gap ?? 'all'], queryFn: () => { const q = gap ? `?gap=${encodeURIComponent(gap)}` : ''; return api<OrganizationCoverage>(`/organizations/${organizationId}/coverage${q}`); }, enabled: !!organizationId, retry, refetchInterval });
}


// ---- members (GitLab-style, every level), service accounts, user administration, setup links ----------------------
const memberScopeQs = (scope: { type: string; id: string }) => `scopeType=${scope.type}&scopeId=${scope.id}`;
function useInvalidateMembers() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ['members', 'member-candidates', 'service-accounts', 'memberships', 'me', 'admin']) void queryClient.invalidateQueries({ queryKey: [key] });
  };
}

export function useMembers(scope: { type: MemberScopeType; id: string } | undefined) {
  const api = useApi();
  const refetchInterval = useRefetchInterval();
  return useQuery({ queryKey: ['members', scope?.type, scope?.id], queryFn: () => api<MembersResponse>(`/members?${memberScopeQs(scope!)}`), enabled: !!scope, retry, refetchInterval });
}

export function useMemberRoles(scope: { type: MemberScopeType; id: string } | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['members', 'roles', scope?.type, scope?.id], queryFn: () => api<RoleInfo[]>(`/members/roles?${memberScopeQs(scope!)}`), enabled: !!scope, retry, staleTime: 60_000 });
}

export function useMemberCandidates(scope: { type: MemberScopeType; id: string }, q: string, enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['member-candidates', scope.type, scope.id, q], queryFn: () => api<MemberCandidate[]>(`/members/candidates?${memberScopeQs(scope)}&q=${encodeURIComponent(q)}`), enabled: enabled && q.trim().length >= 1, retry, staleTime: 10_000 });
}

export function useAddMembers() {
  const api = useApi();
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: (input: { scopeType: MemberScopeType; scopeId: string; role: string; userIds?: string[]; emails?: string[]; expiresAt?: string; reason?: string }) => api<AddMembersResult>('/members', { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateMember() {
  const api = useApi();
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: ({ membershipId, ...body }: { membershipId: string; role?: string; expiresAt?: string | null; reason?: string }) => api<unknown>(`/members/${membershipId}`, { method: 'PATCH', json: body }),
    onSuccess: invalidate,
  });
}

export function useRemoveMember() {
  const api = useApi();
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: (membershipId: string) => api<void>(`/members/${membershipId}`, { method: 'DELETE' }), onSuccess: invalidate });
}

export function useServiceAccounts(scope: { type: MemberScopeType; id: string }, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: ['service-accounts', scope.type, scope.id], queryFn: () => api<ServiceAccount[]>(`/service-accounts?${memberScopeQs(scope)}`), enabled, retry });
}

export function useCreateServiceAccount() {
  const api = useApi();
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: (input: { scopeType: MemberScopeType; scopeId: string; name: string; description?: string; role?: string }) => api<ServiceAccount>('/service-accounts', { method: 'POST', json: input }), onSuccess: invalidate });
}

export function useDeleteServiceAccount() {
  const api = useApi();
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: (id: string) => api<{ deleted: boolean; memberships: number; tokens: number }>(`/service-accounts/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
}

export function useToggleServiceAccount() {
  const api = useApi();
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => api<ServiceAccount>(`/service-accounts/${id}`, { method: 'PATCH', json: { disabled } }), onSuccess: invalidate });
}

export function useServiceAccountTokens(id: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['service-accounts', 'tokens', id], queryFn: () => api<TokenRow[]>(`/service-accounts/${id}/tokens`), enabled: !!id, retry });
}

export function useServiceAccountTokenActions(id: string) {
  const api = useApi();
  const invalidate = useInvalidateMembers();
  const create = useMutation({ mutationFn: (input: { name: string; scope: 'read' | 'write'; expiresInDays?: number }) => api<CreatedToken>(`/service-accounts/${id}/tokens`, { method: 'POST', json: input }), onSuccess: invalidate });
  const rotate = useMutation({ mutationFn: (tokenId: string) => api<CreatedToken>(`/service-accounts/${id}/tokens/${tokenId}/rotate`, { method: 'POST' }), onSuccess: invalidate });
  const revoke = useMutation({ mutationFn: (tokenId: string) => api<unknown>(`/service-accounts/${id}/tokens/${tokenId}`, { method: 'DELETE' }), onSuccess: invalidate });
  return { create, rotate, revoke };
}

export function useCreateScopeAccessToken() {
  const api = useApi();
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: (input: { scopeType: MemberScopeType; scopeId: string; name: string; role: string; scope: 'read' | 'write'; expiresInDays?: number }) => api<{ serviceAccount: ServiceAccount; token: CreatedToken }>('/scope-access-tokens', { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

export function useAdminCapabilities(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['admin', 'capabilities'], queryFn: () => api<AdminCapabilities>('/admin/users/capabilities'), enabled, retry, staleTime: 60_000 });
}

export function useAdminUser(id: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ['admin', 'users', id], queryFn: () => api<AdminUserDetail>(`/admin/users/${id}`), enabled: !!id, retry });
}

export function useAdminUserActions() {
  const api = useApi();
  const invalidate = useInvalidateMembers();
  const create = useMutation({ mutationFn: (input: { email: string; firstName?: string; lastName?: string; temporaryPassword?: string; reason?: string }) => api<{ user: AdminUser } & IssuedLink>('/admin/users', { method: 'POST', json: input }), onSuccess: invalidate });
  const reset = useMutation({ mutationFn: ({ id, ...body }: { id: string; temporaryPassword?: string; reason?: string }) => api<IssuedLink>(`/admin/users/${id}/reset-password`, { method: 'POST', json: body }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api<{ deleted: boolean; memberships: number; tokens: number; activeTokens: number }>(`/admin/users/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
  return { create, reset, remove };
}

export function useInvite(token: string) {
  const api = useApi();
  return useQuery({ queryKey: ['invite', token], queryFn: () => api<InviteInfo>(`/invites/${encodeURIComponent(token)}`), retry: false });
}

export function useCompleteInvite(token: string) {
  const api = useApi();
  return useMutation({ mutationFn: (password: string) => api<{ email: string; signInUrl: string }>(`/invites/${encodeURIComponent(token)}`, { method: 'POST', json: { password } }) });
}
