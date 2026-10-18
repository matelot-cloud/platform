/**
 * Declarative resource commands: `secops <resource> <verb> [flags]`.
 * Each entry maps to one API call; output is a table (or --json). `secops request` remains for anything else.
 */
export interface ResourceCommand {
  resource: string;
  verb: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path with :param placeholders taken from flags (e.g. --org, --project, --service, --env, --id). */
  path: string;
  summary: string;
  /** Flags copied into the query string (GET) or body (POST/PATCH). */
  fields?: string[];
  /** Columns shown in table mode (dot paths allowed). */
  columns?: string[];
  /** Fixed body values merged into the request. */
  body?: Record<string, unknown>;
  /** Exit code 2 when the response has this field with this value (gate). */
  failWhen?: { field: string; equals: string };
}

const sev = ['severity', 'status', 'kev', 'q', 'limit'];

export const RESOURCES: ResourceCommand[] = [
  // ---- parity with the web app: every UI action has a command (nested bodies via --body '{...}')
  { resource: 'admin', verb: 'update-user', method: 'PATCH', path: '/api/v1/admin/users/:id', summary: "Platform admin: change a user's role / enable (--platform-role admin|user --enabled true --reason ...)", fields: ['platformRole', 'enabled', 'reason'] },
  { resource: 'team', verb: 'create', method: 'POST', path: '/api/v1/workspaces/:workspace/teams', summary: "Create a team (--workspace ID --slug --name)", fields: ['slug', 'name', 'description'] },
  { resource: 'team', verb: 'update', method: 'PATCH', path: '/api/v1/teams/:id', summary: "Rename / describe a team", fields: ['name', 'description'] },
  { resource: 'team', verb: 'delete', method: 'DELETE', path: '/api/v1/teams/:id', summary: "Archive a team" },
  { resource: 'project', verb: 'create', method: 'POST', path: '/api/v1/teams/:team/projects', summary: "Create a project (--team ID --slug --name [--criticality])", fields: ['slug', 'name', 'description', 'criticality'] },
  { resource: 'project', verb: 'update', method: 'PATCH', path: '/api/v1/projects/:project', summary: "Update a project", fields: ['name', 'description', 'criticality'] },
  { resource: 'project', verb: 'delete', method: 'DELETE', path: '/api/v1/projects/:project', summary: "Archive a project" },
  { resource: 'service', verb: 'create', method: 'POST', path: '/api/v1/projects/:project/services', summary: "Create a service", fields: ['slug', 'name', 'description', 'kind', 'criticality'] },
  { resource: 'service', verb: 'update', method: 'PATCH', path: '/api/v1/services/:service', summary: "Update a service (name, kind, criticality)", fields: ['name', 'description', 'kind', 'criticality'] },
  { resource: 'service', verb: 'archive', method: 'DELETE', path: '/api/v1/services/:service', summary: "Archive a service (history kept)" },
  { resource: 'risk', verb: 'recompute-project', method: 'POST', path: '/api/v1/projects/:project/risk/recompute', summary: "Recompute the risk scores of a project now" },
  { resource: 'findings', verb: 'snapshot', method: 'POST', path: '/api/v1/organizations/:org/findings/snapshots', summary: "Take today's findings snapshot now (trend charts)" },
  { resource: 'workspace', verb: 'create', method: 'POST', path: '/api/v1/organizations/:org/workspaces', summary: "Create a workspace", fields: ['slug', 'name', 'description'] },
  { resource: 'workspace', verb: 'update', method: 'PATCH', path: '/api/v1/workspaces/:workspace', summary: "Rename / describe a workspace", fields: ['name', 'description'] },
  { resource: 'workspace', verb: 'delete', method: 'DELETE', path: '/api/v1/workspaces/:workspace', summary: "Archive a workspace" },
  { resource: 'policy', verb: 'from-template-workspace', method: 'POST', path: '/api/v1/workspaces/:workspace/policies/from-template', summary: "Policy from a template at a workspace", fields: ['template', 'name'] },
  { resource: 'policy', verb: 'from-template-team', method: 'POST', path: '/api/v1/teams/:team/policies/from-template', summary: "Policy from a template at a team", fields: ['template', 'name'] },
  { resource: 'policy', verb: 'create-workspace', method: 'POST', path: '/api/v1/workspaces/:workspace/policies', summary: "Create a policy at a workspace", fields: ['name', 'description', 'environmentKinds', 'rules', 'action', 'enforceOnDeploy'] },
  { resource: 'policy', verb: 'create-team', method: 'POST', path: '/api/v1/teams/:team/policies', summary: "Create a policy at a team", fields: ['name', 'description', 'environmentKinds', 'rules', 'action', 'enforceOnDeploy'] },
  { resource: 'connection', verb: 'create', method: 'POST', path: '/api/v1/organizations/:org/integrations', summary: "Create a connection (--body with the JSON the web app sends: provider, scopeType, scopeId, name, baseUrl, auth)", fields: ['scopeType', 'scopeId', 'provider', 'name', 'baseUrl', 'owner', 'repositoryUrl', 'auth'] },
  { resource: 'connection', verb: 'test', method: 'POST', path: '/api/v1/organizations/:org/integrations/test', summary: "Test connection settings without saving (--body JSON)", fields: ['scopeType', 'scopeId', 'provider', 'name', 'baseUrl', 'owner', 'repositoryUrl', 'auth'] },
  { resource: 'connection', verb: 'verify', method: 'POST', path: '/api/v1/integrations/:id/verify', summary: "Verify a git or registry connection with its stored identity: after adding a deploy key, or — for keyless GAR/ECR/ACR — after configuring the cloud trust for integration:<id> (see connection identity)" },
  { resource: 'connection', verb: 'link-installation', method: 'POST', path: '/api/v1/integrations/:id/link-installation', summary: "GitHub App: bind an existing installation / re-read permissions" },
  { resource: 'connection', verb: 'create-ecr-repository', method: 'POST', path: '/api/v1/integrations/:id/ecr/repositories', summary: "Create an ECR repository through the connection", fields: ['name', 'scanOnPush', 'immutableTags'] },
  { resource: 'connection', verb: 'sync', method: 'POST', path: '/api/v1/integrations/:id/sync', summary: "Read the source now (repositories / tags)" },
  { resource: 'connection', verb: 'identity', method: 'GET', path: '/api/v1/integrations/:id/identity', summary: "Keyless (workload identity) setup: issuer, subject, audience and the steps for GCP / AWS / Azure" },
  { resource: 'connection', verb: 'delete', method: 'DELETE', path: '/api/v1/integrations/:id', summary: "Delete a connection, its repositories and their service links (409 lists images that pull through it; --force detaches them)", fields: ['force'] },
  { resource: 'connection', verb: 'disconnect', method: 'POST', path: '/api/v1/integrations/:id/disconnect', summary: "Disconnect: keep the connection and its repositories, forget the credentials" },
  { resource: 'repository', verb: 'attach', method: 'POST', path: '/api/v1/services/:service/repositories', summary: "Attach a repository to a service (--repository-id ID [--role primary])", fields: ['repositoryId', 'role'] },
  { resource: 'repository', verb: 'detach', method: 'DELETE', path: '/api/v1/services/:service/repositories/:id', summary: "Detach a repository from a service" },
  { resource: 'releases', verb: 'sync', method: 'POST', path: '/api/v1/services/:service/releases/sync', summary: "Read releases / tags from the source now" },
  { resource: 'image', verb: 'delete', method: 'DELETE', path: '/api/v1/services/:service/images/:id', summary: "Stop tracking an image" },
  { resource: 'env', verb: 'settings', method: 'PATCH', path: '/api/v1/environments/:env/settings', summary: "Environment settings (--protected true, --kubernetes-namespace ...)", fields: ['kubernetesNamespace', 'kubernetesContext', 'runnerTag', 'protected'] },
  { resource: 'env', verb: 'kubernetes-sync', method: 'POST', path: '/api/v1/environments/:env/kubernetes-sync', summary: "Read what the cluster runs now" },
  { resource: 'membership', verb: 'revoke', method: 'DELETE', path: '/api/v1/memberships/:id', summary: "Revoke a membership" },
  { resource: 'organization', verb: 'create', method: 'POST', path: '/api/v1/organizations', summary: "Create an organization (platform admin)", fields: ['parentId', 'slug', 'name'] },
  { resource: 'organization', verb: 'update', method: 'PATCH', path: '/api/v1/organizations/:org', summary: "Rename an organization", fields: ['name'] },
  { resource: 'env', verb: 'create', method: 'POST', path: '/api/v1/services/:service/environments', summary: "Create an environment (--kind development|testing|staging|production)", fields: ['slug', 'name', 'kind', 'internetFacing'] },
  { resource: 'env', verb: 'update', method: 'PATCH', path: '/api/v1/environments/:env', summary: "Update an environment", fields: ['name', 'kind', 'internetFacing'] },
  { resource: 'env', verb: 'delete', method: 'DELETE', path: '/api/v1/environments/:env', summary: "Archive an environment" },
  { resource: 'runner-pool', verb: 'create', method: 'POST', path: '/api/v1/organizations/:org/runner-pools', summary: "Create a runner pool", fields: ['scopeType', 'scopeId', 'slug', 'name', 'description', 'tags'] },
  { resource: 'pipeline', verb: 'cancel', method: 'POST', path: '/api/v1/pipelines/:id/cancel', summary: "Cancel a pipeline" },
  { resource: 'job', verb: 'retry', method: 'POST', path: '/api/v1/jobs/:id/retry', summary: "Retry a job" },
  { resource: 'job', verb: 'cancel', method: 'POST', path: '/api/v1/jobs/:id/cancel', summary: "Cancel a job" },
  { resource: 'runner-pool', verb: 'delete', method: 'DELETE', path: '/api/v1/runner-pools/:id', summary: 'Delete a runner pool' },
  { resource: 'runner', verb: 'delete', method: 'DELETE', path: '/api/v1/runners/:id', summary: 'Remove a runner' },
  { resource: 'runner-pool', verb: 'registration-token', method: 'POST', path: '/api/v1/runner-pools/:id/registration-tokens', summary: 'New registration token for a pool' },
  // ---- identity & organisation
  { resource: 'remediations', verb: 'sync-trackers', method: 'POST', path: '/api/v1/organizations/:org/remediations/sync-trackers', summary: 'Run the inbound tracker sync now: issues closed in Jira/GitHub/GitLab → remediation done, reopened → open (otherwise hourly)' },
  { resource: 'me', verb: 'show', method: 'GET', path: '/api/v1/me', summary: 'Who am I (user + memberships)' },
  { resource: 'orgs', verb: 'list', method: 'GET', path: '/api/v1/organizations', summary: 'Organizations I belong to', columns: ['id', 'slug', 'name'] },
  { resource: 'org', verb: 'overview', method: 'GET', path: '/api/v1/organizations/:org/overview', summary: 'Organization overview (counts, production, risk)' },
  { resource: 'workspaces', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/workspaces', summary: 'Workspaces', columns: ['id', 'slug', 'name'] },
  { resource: 'teams', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/teams', summary: 'Teams', columns: ['id', 'slug', 'name', 'workspaceId'] },
  { resource: 'projects', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/projects', summary: 'Projects', columns: ['id', 'slug', 'name', 'teamId'] },
  { resource: 'project', verb: 'show', method: 'GET', path: '/api/v1/projects/:project', summary: 'Project details' },
  { resource: 'project', verb: 'overview', method: 'GET', path: '/api/v1/projects/:project/overview', summary: 'Project overview' },
  { resource: 'services', verb: 'list', method: 'GET', path: '/api/v1/projects/:project/services', summary: 'Services of a project', columns: ['id', 'slug', 'name', 'criticality'] },
  { resource: 'services', verb: 'list-org', method: 'GET', path: '/api/v1/organizations/:org/services', summary: 'Services of the organization', columns: ['id', 'slug', 'name', 'projectId'] },
  { resource: 'service', verb: 'show', method: 'GET', path: '/api/v1/services/:service/summary', summary: 'The service with its latest pipeline (jobs), open findings by severity (+ KEV), open code findings and newest SBOM — one call for CI scripts (--json)' },
  { resource: 'envs', verb: 'list', method: 'GET', path: '/api/v1/services/:service/environments', summary: 'Environments of a service', columns: ['id', 'slug', 'name', 'kind', 'internetFacing'] },
  { resource: 'env', verb: 'show', method: 'GET', path: '/api/v1/environments/:env', summary: 'Environment details' },
  { resource: 'env', verb: 'registry', method: 'GET', path: '/api/v1/environments/:env/registry', summary: 'Environment repository in the built-in registry' },
  { resource: 'env', verb: 'lineage', method: 'GET', path: '/api/v1/environments/:env/lineage', summary: 'Released vs running lanes, drift, history' },
  { resource: 'env', verb: 'gate', method: 'GET', path: '/api/v1/environments/:env/gate', summary: 'Latest gate evaluation of the environment' },
  // ---- delivery
  { resource: 'releases', verb: 'list', method: 'GET', path: '/api/v1/services/:service/releases', summary: 'Releases of a service', columns: ['id', 'version', 'commitSha', 'source', 'createdAt'] },
  { resource: 'release', verb: 'create', method: 'POST', path: '/api/v1/services/:service/releases', summary: 'Record a release', fields: ['version', 'tag', 'commitSha', 'notes'] },
  { resource: 'images', verb: 'list', method: 'GET', path: '/api/v1/services/:service/images', summary: 'Container images (registries) of a service', columns: ['id', 'name', 'lastSyncedAt', 'lastError'] },
  { resource: 'image', verb: 'add', method: 'POST', path: '/api/v1/services/:service/images', summary: 'Register an image (name, optional integrationId)', fields: ['name', 'integrationId'] },
  { resource: 'image', verb: 'sync', method: 'POST', path: '/api/v1/services/:service/images/:id/sync', summary: 'Read the registry now (tags, digests): --service ID --id IMAGE' },
  { resource: 'inventory', verb: 'show', method: 'GET', path: '/api/v1/services/:service/inventory', summary: 'Releases, images and environments joined' },
  { resource: 'deployments', verb: 'list', method: 'GET', path: '/api/v1/services/:service/deployments', summary: 'Current deployment per environment + history' },
  { resource: 'deployments', verb: 'list-org', method: 'GET', path: '/api/v1/organizations/:org/deployments', summary: 'Current production deployments of the organization', columns: ['environmentName', 'serviceName', 'version', 'deployedAt'] },
  // ---- SBOM
  { resource: 'sboms', verb: 'list', method: 'GET', path: '/api/v1/services/:service/sboms', summary: 'SBOMs of a service', columns: ['id', 'target', 'targetRef', 'componentCount', 'createdAt'] },
  { resource: 'sbom', verb: 'show', method: 'GET', path: '/api/v1/sboms/:id', summary: 'SBOM with components' },
  { resource: 'sbom', verb: 'findings', method: 'GET', path: '/api/v1/sboms/:id/findings', summary: 'Findings of one SBOM', columns: ['id', 'severity', 'status', 'advisory.id', 'component.name', 'component.version'] },
  { resource: 'sbom', verb: 'diff', method: 'GET', path: '/api/v1/sboms/:from/diff/:to', summary: 'Diff two SBOMs (--from, --to)' },
  { resource: 'components', verb: 'search', method: 'GET', path: '/api/v1/organizations/:org/components', summary: 'Where a component is used (--q)', fields: ['q'], columns: ['name', 'version', 'purl', 'services'] },
  // ---- vulnerabilities
  { resource: 'findings', verb: 'list', method: 'GET', path: '/api/v1/projects/:project/findings', summary: 'Dependency findings (--severity --status --kev --q)', fields: sev, columns: ['id', 'severity', 'status', 'advisory.id', 'component.name', 'component.version', 'advisory.kev'] },
  { resource: 'findings', verb: 'list-org', method: 'GET', path: '/api/v1/organizations/:org/findings', summary: 'Findings across the organization', fields: sev, columns: ['id', 'severity', 'status', 'advisory.id', 'component.name', 'serviceId'] },
  { resource: 'findings', verb: 'summary', method: 'GET', path: '/api/v1/projects/:project/findings/summary', summary: 'Open / KEV / production counts' },
  { resource: 'findings', verb: 'environments', method: 'GET', path: '/api/v1/projects/:project/findings/environments', summary: 'What runs in each environment, with counts', columns: ['name', 'kind', 'serviceName', 'current.version', 'current.tag', 'findings.critical', 'findings.high', 'findings.medium'] },
  { resource: 'findings', verb: 'trend', method: 'GET', path: '/api/v1/projects/:project/findings/trend', summary: 'Daily trend per environment (--days)', fields: ['days'] },
  { resource: 'finding', verb: 'show', method: 'GET', path: '/api/v1/findings/:id', summary: 'One finding with where it runs' },
  { resource: 'finding', verb: 'set', method: 'PATCH', path: '/api/v1/findings/:id', summary: 'Decision: --status open|accepted|false_positive|not_affected --note', fields: ['status', 'note'] },
  { resource: 'code-findings', verb: 'list', method: 'GET', path: '/api/v1/projects/:project/code-findings', summary: 'Secrets / IaC / SAST findings (--kind --severity --status)', fields: ['kind', 'severity', 'status'], columns: ['id', 'kind', 'severity', 'status', 'ruleId', 'file', 'line'] },
  { resource: 'code-findings', verb: 'summary', method: 'GET', path: '/api/v1/projects/:project/code-findings/summary', summary: 'Code findings counts' },
  { resource: 'code-finding', verb: 'set', method: 'PATCH', path: '/api/v1/code-findings/:id', summary: 'Decision on a code finding (--status --note)', fields: ['status', 'note'] },
  // ---- risk & graph
  { resource: 'risk', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/risk', summary: 'Risk score per service', columns: ['serviceName', 'score', 'grade', 'computedAt'] },
  { resource: 'risk', verb: 'project', method: 'GET', path: '/api/v1/projects/:project/risk', summary: 'Risk of a project', columns: ['serviceName', 'score', 'grade'] },
  { resource: 'risk', verb: 'recompute', method: 'POST', path: '/api/v1/organizations/:org/risk/recompute', summary: 'Recompute risk now' },
  { resource: 'graph', verb: 'show', method: 'GET', path: '/api/v1/projects/:project/graph', summary: 'Product map (nodes + edges)' },
  // ---- policies & gate
  { resource: 'policies', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/policies', summary: 'Policies of the organization', columns: ['id', 'name', 'scopeType', 'environmentKinds', 'rules', 'action', 'enforceOnDeploy', 'enabled'] },
  { resource: 'policies', verb: 'in-force', method: 'GET', path: '/api/v1/projects/:project/policies', summary: 'Policies in force on a project (own + inherited)', columns: ['id', 'name', 'scopeType', 'rules', 'action', 'inherited'] },
  { resource: 'policy', verb: 'create', method: 'POST', path: '/api/v1/organizations/:org/policies', summary: 'Create at the organization (--name --environments prod,staging --max-severity high --block-kev --block-secrets --require-sbom --max-iac SEV --max-sast SEV --action block|warn --enforce; every rule is explicit: a block rule is off unless given, --no-block-secrets etc. turn one off)', fields: ['name', 'description', 'environmentKinds', 'rules', 'action', 'enforceOnDeploy'] },
  { resource: 'policy', verb: 'create-project', method: 'POST', path: '/api/v1/projects/:project/policies', summary: 'Create at a project (same flags)', fields: ['name', 'description', 'environmentKinds', 'rules', 'action', 'enforceOnDeploy'] },
  { resource: 'policy', verb: 'update', method: 'PATCH', path: '/api/v1/policies/:id', summary: 'Update (--enabled true|false, --action, --enforce, rule flags)', fields: ['name', 'description', 'enabled', 'environmentKinds', 'rules', 'action', 'enforceOnDeploy'] },
  { resource: 'policy', verb: 'delete', method: 'DELETE', path: '/api/v1/policies/:id', summary: 'Delete a policy' },
  { resource: 'gate', verb: 'evaluations', method: 'GET', path: '/api/v1/services/:service/gate-evaluations', summary: 'Gate evaluations of a service', columns: ['id', 'result', 'environmentId', 'subject.version', 'actor', 'evaluatedAt'] },
  // ---- policy templates & exceptions
  { resource: 'policy', verb: 'templates', method: 'GET', path: '/api/v1/policy-templates', summary: 'Ready-made policies (cra-baseline, production-baseline, staging-gate, dev-advisory, no-secrets-anywhere)', columns: ['id', 'name', 'action', 'environmentKinds'] },
  { resource: 'policy', verb: 'from-template', method: 'POST', path: '/api/v1/organizations/:org/policies/from-template', summary: 'Create a policy from a template at the organization (--template cra-baseline [--name])', fields: ['template', 'name'] },
  { resource: 'policy', verb: 'from-template-project', method: 'POST', path: '/api/v1/projects/:project/policies/from-template', summary: 'Create from a template at a project', fields: ['template', 'name'] },
  { resource: 'exceptions', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/exceptions', summary: 'Exceptions (--active true|false) — state: pending (awaiting an approver: exception approve --id …) | active | expired | revoked', fields: ['active'], columns: ['id', 'kind', 'matchId', 'matchComponent', 'scopeType', 'status', 'expiresAt', 'state', 'applied'] },
  { resource: 'exception', verb: 'create', method: 'POST', path: '/api/v1/services/:service/exceptions', summary: 'Time-boxed acceptance in a service (--kind vulnerability|code --match CVE-… --component X --status accepted --reason … --until 2026-12-31 --ticket URL)', fields: ['kind', 'matchId', 'matchComponent', 'status', 'reason', 'ticketUrl', 'expiresAt'] },
  { resource: 'exception', verb: 'create-project', method: 'POST', path: '/api/v1/projects/:project/exceptions', summary: 'Same, at a project', fields: ['kind', 'matchId', 'matchComponent', 'status', 'reason', 'ticketUrl', 'expiresAt'] },
  { resource: 'exception', verb: 'create-org', method: 'POST', path: '/api/v1/organizations/:org/exceptions', summary: 'Same, organization-wide', fields: ['kind', 'matchId', 'matchComponent', 'status', 'reason', 'ticketUrl', 'expiresAt'] },
  { resource: 'exception', verb: 'approve', method: 'POST', path: '/api/v1/exceptions/:id/approve', summary: 'Approve a pending exception' },
  { resource: 'exception', verb: 'revoke', method: 'DELETE', path: '/api/v1/exceptions/:id', summary: 'Revoke (findings reopen immediately)' },
  // ---- remediation (M9)
  { resource: 'remediation', verb: 'queue', method: 'GET', path: '/api/v1/projects/:project/remediation/queue', summary: 'Fix-first queue of a project: open findings grouped by advisory × service, ranked by exposure, severity, KEV, SLA', columns: ['score', 'severity', 'matchId', 'componentName', 'serviceName', 'runsIn', 'dueAt', 'daysLeft', 'remediation.status'] },
  { resource: 'remediation', verb: 'queue-org', method: 'GET', path: '/api/v1/organizations/:org/remediation/queue', summary: 'Fix-first queue of the organization', columns: ['score', 'severity', 'matchId', 'componentName', 'serviceName', 'runsIn', 'dueAt', 'daysLeft'] },
  { resource: 'remediations', verb: 'list', method: 'GET', path: '/api/v1/projects/:project/remediations', summary: 'Tracked remediations of a project (--status open,in_progress)', fields: ['status'], columns: ['id', 'title', 'severity', 'status', 'ownerName', 'dueAt', 'overdue', 'issueKey'] },
  { resource: 'remediations', verb: 'list-org', method: 'GET', path: '/api/v1/organizations/:org/remediations', summary: 'Tracked remediations of the organization', fields: ['status', 'owner'], columns: ['id', 'title', 'severity', 'status', 'ownerName', 'dueAt', 'overdue', 'issueKey'] },
  { resource: 'remediation', verb: 'create', method: 'POST', path: '/api/v1/services/:service/remediations', summary: 'Track an advisory/rule in a service as work (--kind vulnerability|code --match CVE-… [--component X] [--owner-email a@b] [--due 2026-12-31] [--notes …]) — 409 if an active remediation for the same advisory/component exists (--force to create another)', fields: ['kind', 'matchId', 'componentName', 'ownerEmail', 'ownerId', 'dueAt', 'notes', 'title', 'force'] },
  { resource: 'remediation', verb: 'show', method: 'GET', path: '/api/v1/remediations/:id', summary: 'One remediation' },
  { resource: 'remediation', verb: 'update', method: 'PATCH', path: '/api/v1/remediations/:id', summary: 'Update (--status open|in_progress|done|wont_fix --owner-email … --due … --notes …)', fields: ['status', 'ownerEmail', 'ownerId', 'dueAt', 'notes', 'title'] },
  { resource: 'remediation', verb: 'issue', method: 'POST', path: '/api/v1/remediations/:id/issue', summary: 'Open an issue: github | gitlab | bitbucket (service repository) or jira (--provider … [--project-key SEC] [--integration ID]); default = scope setting, else the repository host, else Jira', fields: ['provider', 'integrationId', 'projectKey'] },
  { resource: 'sla', verb: 'show', method: 'GET', path: '/api/v1/organizations/:org/remediation/settings', summary: 'SLA days by severity and the default issue tracker' },
  { resource: 'sla', verb: 'set', method: 'PATCH', path: '/api/v1/organizations/:org/remediation/settings', summary: 'Set SLAs (--critical 7 --high 30 --medium 90 --low 180) and issue defaults (--jira-project-key SEC --issue-integration ID)', fields: ['slaDays', 'jiraProjectKey', 'defaultIssueIntegrationId', 'issueProvider', 'issueBoard'] },
  { resource: 'sla', verb: 'show-scope', method: 'GET', path: '/api/v1/:scope/remediation/settings', summary: 'Overrides stored at a scope (--scope workspaces/ID | teams/ID | projects/ID); null = inherited' },
  { resource: 'sla', verb: 'set-scope', method: 'PATCH', path: '/api/v1/:scope/remediation/settings', summary: 'Override at a scope: --scope projects/ID [--critical 3 …] [--issue-provider github|gitlab|bitbucket|jira] [--jira-project-key PAY] [--issue-board https://github.com/orgs/acme/projects/5] [--issue-integration ID]', fields: ['slaDays', 'jiraProjectKey', 'defaultIssueIntegrationId', 'issueProvider', 'issueBoard'] },
  { resource: 'sla', verb: 'effective', method: 'GET', path: '/api/v1/projects/:project/remediation/settings/effective', summary: 'What applies to a project (SLA, issue provider, Jira key) and which scope each value comes from' },
  // ---- CRA evidence (M10)
  { resource: 'evidence', verb: 'summary', method: 'GET', path: '/api/v1/releases/:id/evidence', summary: 'Evidence summary of a release (JSON): images, SBOMs, findings + decisions, gate, deployments, policies, risk' },
  { resource: 'cra', verb: 'readiness', method: 'GET', path: '/api/v1/services/:service/cra/readiness', summary: 'CRA readiness checks of a service (SBOM shipped, no KEV in prod, policy, SLAs, gate evidence, secrets, IaC, traceability, monitoring)' },
  { resource: 'cra', verb: 'readiness-project', method: 'GET', path: '/api/v1/projects/:project/cra/readiness', summary: 'CRA readiness of every service in a project', columns: ['serviceName', 'score', 'grade'] },
  // ---- notifications & VEX
  { resource: 'evidence', verb: 'vex', method: 'GET', path: '/api/v1/releases/:id/vex', summary: 'OpenVEX document of a release (decisions per vulnerability and shipped image)' },
  { resource: 'channels', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/notification-channels', summary: 'Notification channels (Slack / webhook)', columns: ['id', 'name', 'kind', 'url', 'events', 'enabled', 'lastSentAt', 'lastError'] },
  { resource: 'channels', verb: 'events', method: 'GET', path: '/api/v1/notification-events', summary: 'Events a channel can subscribe to', columns: ['id', 'description'] },
  { resource: 'channel', verb: 'create', method: 'POST', path: '/api/v1/organizations/:org/notification-channels', summary: 'Add a channel (--name ops --kind slack|webhook --url https://… [--events gate.fail,sla.overdue] [--project ID])', fields: ['name', 'kind', 'url', 'events', 'projectId'] },
  { resource: 'channel', verb: 'update', method: 'PATCH', path: '/api/v1/notification-channels/:id', summary: 'Update (--name --url --events --enabled true|false)', fields: ['name', 'url', 'events', 'enabled', 'projectId'] },
  { resource: 'channel', verb: 'test', method: 'POST', path: '/api/v1/notification-channels/:id/test', summary: 'Send a test message' },
  { resource: 'channel', verb: 'delete', method: 'DELETE', path: '/api/v1/notification-channels/:id', summary: 'Remove a channel' },
  // ---- workspace / team scope (security data lives inside workspaces, teams and projects)
  { resource: 'findings', verb: 'list-workspace', method: 'GET', path: '/api/v1/workspaces/:id/findings', summary: 'Findings of a workspace (--id WORKSPACE [--team ID] --severity --status --kev --q)', fields: [...sev, 'team'], columns: ['id', 'severity', 'status', 'advisory.id', 'component.name', 'serviceName'] },
  { resource: 'findings', verb: 'list-team', method: 'GET', path: '/api/v1/teams/:id/findings', summary: 'Findings of a team (--id TEAM)', fields: sev, columns: ['id', 'severity', 'status', 'advisory.id', 'component.name', 'serviceName'] },
  { resource: 'findings', verb: 'summary-workspace', method: 'GET', path: '/api/v1/workspaces/:id/findings/summary', summary: 'Counts for a workspace (--id, [--team])', fields: ['team'] },
  { resource: 'findings', verb: 'environments-workspace', method: 'GET', path: '/api/v1/workspaces/:id/findings/environments', summary: 'What runs where, in a workspace', fields: ['team'], columns: ['name', 'kind', 'serviceName', 'current.version', 'findings.critical', 'findings.high'] },
  { resource: 'code-findings', verb: 'list-workspace', method: 'GET', path: '/api/v1/workspaces/:id/code-findings', summary: 'Code findings of a workspace (--id, [--team])', fields: ['kind', 'severity', 'status', 'team'], columns: ['id', 'kind', 'severity', 'status', 'ruleId', 'file'] },
  { resource: 'risk', verb: 'workspace', method: 'GET', path: '/api/v1/workspaces/:id/risk', summary: 'Risk per service in a workspace (--id, [--team])', fields: ['team'], columns: ['serviceName', 'score', 'grade'] },
  { resource: 'risk', verb: 'team', method: 'GET', path: '/api/v1/teams/:id/risk', summary: 'Risk per service in a team', columns: ['serviceName', 'score', 'grade'] },
  { resource: 'components', verb: 'search-workspace', method: 'GET', path: '/api/v1/workspaces/:id/components', summary: 'Component search in a workspace (--id --q [--team])', fields: ['q', 'team'], columns: ['name', 'version', 'purl', 'services'] },
  { resource: 'components', verb: 'search-project', method: 'GET', path: '/api/v1/projects/:project/components', summary: 'Component search in a project (--q)', fields: ['q'], columns: ['name', 'version', 'purl', 'services'] },
  { resource: 'remediation', verb: 'queue-workspace', method: 'GET', path: '/api/v1/workspaces/:id/remediation/queue', summary: 'Fix-first queue of a workspace (--id, [--team])', fields: ['team', 'limit'], columns: ['score', 'severity', 'matchId', 'componentName', 'serviceName', 'runsIn', 'dueAt', 'daysLeft'] },
  { resource: 'cra', verb: 'readiness-workspace', method: 'GET', path: '/api/v1/workspaces/:id/cra/readiness', summary: 'CRA readiness of every service in a workspace (--id, [--team])', fields: ['team'], columns: ['serviceName', 'score', 'grade'] },
  { resource: 'channels', verb: 'list-scope', method: 'GET', path: '/api/v1/:scope/notification-channels', summary: 'Channels in force at a scope (--scope workspaces/ID | teams/ID | projects/ID)', columns: ['id', 'name', 'kind', 'scopeType', 'inherited', 'events', 'enabled'] },
  { resource: 'channel', verb: 'create-scope', method: 'POST', path: '/api/v1/:scope/notification-channels', summary: 'Add a channel at a scope (--scope projects/ID --name --kind --url [--events])', fields: ['name', 'kind', 'url', 'events'] },
  // ---- pipelines, jobs, runners
  { resource: 'pipelines', verb: 'list', method: 'GET', path: '/api/v1/projects/:project/pipelines', summary: 'Pipelines of a project', columns: ['id', 'status', 'ref', 'serviceId', 'createdAt'] },
  { resource: 'pipeline', verb: 'show', method: 'GET', path: '/api/v1/pipelines/:id', summary: 'Pipeline with its jobs' },
  { resource: 'pipeline', verb: 'templates', method: 'GET', path: '/api/v1/pipeline-templates', summary: 'Pipeline templates' },
  { resource: 'jobs', verb: 'list', method: 'GET', path: '/api/v1/projects/:project/jobs', summary: 'Jobs of a project', columns: ['id', 'type', 'status', 'name', 'createdAt'] },
  { resource: 'jobs', verb: 'active', method: 'GET', path: '/api/v1/organizations/:org/jobs/active', summary: 'Queued / running jobs', columns: ['id', 'type', 'status', 'serviceName'] },
  { resource: 'job', verb: 'show', method: 'GET', path: '/api/v1/jobs/:id', summary: 'Job details' },
  { resource: 'job', verb: 'logs', method: 'GET', path: '/api/v1/jobs/:id/logs', summary: 'Job log lines', columns: ['at', 'stream', 'content'] },
  { resource: 'job', verb: 'create', method: 'POST', path: '/api/v1/services/:service/jobs', summary: 'Queue a job (--type sbom|secrets|iac|repository_check … --ref)', fields: ['type', 'ref', 'imageRef', 'target'] },
  { resource: 'runners', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/runner-pools', summary: 'Runner pools and runners (the managed pool is the cell\'s own runners)', columns: ['name', 'slug', 'managed', 'scopeType', 'id'] },
  { resource: 'runner', verb: 'agent', method: 'GET', path: '/api/v1/runner-agent', summary: 'Latest runner version + image' },
  // ---- integrations, registry
  { resource: 'integrations', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/integrations', summary: 'Connections (git, registries, k8s)', columns: ['id', 'name', 'provider', 'authType', 'status'] },
  { resource: 'integrations', verb: 'providers', method: 'GET', path: '/api/v1/integrations/providers', summary: 'Available providers' },
  { resource: 'repositories', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/repositories', summary: 'Repositories', columns: ['id', 'fullName', 'defaultBranch', 'integrationId'] },
  { resource: 'registry', verb: 'info', method: 'GET', path: '/api/v1/registry/info', summary: 'Built-in registry info' },
  { resource: 'registry', verb: 'reconcile', method: 'POST', path: '/api/v1/organizations/:org/registry/reconcile', summary: 'Read the built-in registry now' },
  { resource: 'registries', verb: 'list', method: 'GET', path: '/api/v1/services/:service/registries', summary: 'Registry connections usable by a service', columns: ['id', 'name', 'host', 'kind'] },
  // ---- tokens, audit, admin
  { resource: 'tokens', verb: 'list', method: 'GET', path: '/api/v1/me/tokens', summary: 'My personal access tokens', columns: ['id', 'name', 'scope', 'prefix', 'expiresAt', 'lastUsedAt', 'revokedAt'] },
  { resource: 'token', verb: 'create', method: 'POST', path: '/api/v1/me/tokens', summary: 'New personal token (--name --scope read|write|sudo --days N) — web session only', fields: ['name', 'scope', 'expiresInDays'] },
  { resource: 'token', verb: 'revoke', method: 'DELETE', path: '/api/v1/me/tokens/:id', summary: 'Revoke a personal token' },
  { resource: 'ci-tokens', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/api-tokens', summary: 'CI tokens', columns: ['id', 'name', 'scopeType', 'preset', 'lastUsedAt', 'revokedAt'] },
  { resource: 'ci-token', verb: 'create', method: 'POST', path: '/api/v1/organizations/:org/api-tokens', summary: 'Create a CI token (--name --scope-type PROJECT --scope-id ID --preset full|pipeline|deploy|registry --environments id,id)', fields: ['name', 'scopeType', 'scopeId', 'preset', 'environments'] },
  { resource: 'ci-token', verb: 'revoke', method: 'DELETE', path: '/api/v1/api-tokens/:id', summary: 'Revoke a CI token' },
  { resource: 'onboarding', verb: 'show', method: 'GET', path: '/api/v1/organizations/:org/onboarding', summary: 'Setup checklist of the organization: what is done, what is next, and the command for each step' },
  { resource: 'onboarding', verb: 'dismiss', method: 'POST', path: '/api/v1/organizations/:org/onboarding/dismiss', summary: 'Hide the setup checklist on the Overview (for everyone)' },
  { resource: 'onboarding', verb: 'restore', method: 'POST', path: '/api/v1/organizations/:org/onboarding/restore', summary: 'Show the setup checklist on the Overview again' },
  { resource: 'coverage', verb: 'show', method: 'GET', path: '/api/v1/organizations/:org/coverage', summary: 'Service coverage across the organization: per check how many services have it (repository, security pipeline in the last --days, SBOM, policy, deployment) and the services with gaps (--gap repository|pipeline|sbom|policy|deployment, --uncovered: only the gaps with the commands to fix them)', fields: ['days', 'gap', 'limit', 'uncovered'] },
  { resource: 'coverage', verb: 'project', method: 'GET', path: '/api/v1/projects/:project/coverage', summary: 'Service coverage of a project: one row per service, ok / gap per check, with the commands to close the gaps (same flags)', fields: ['days', 'gap', 'uncovered'] },
  { resource: 'usage', verb: 'show', method: 'GET', path: '/api/v1/organizations/:org/usage', summary: 'Usage of the organization for a month: active seats, runner minutes, pipelines, jobs, SBOMs, inventory, with 12 months of history (--month YYYY-MM, --format csv)', fields: ['month', 'format'] },
  { resource: 'audit', verb: 'list', method: 'GET', path: '/api/v1/organizations/:org/audit-events', summary: 'Audit trail (--limit)', fields: ['limit'], columns: ['createdAt', 'action', 'actorLabel', 'resourceType'] },
  // ---- members at every level (GitLab-style), user administration, service accounts (docs/roles.md, docs/access-tokens.md)
  { resource: 'members', verb: 'list', method: 'GET', path: '/api/v1/members', summary: 'Members of a scope, direct and inherited (--scope organizations/ID | workspaces/ID | teams/ID | projects/ID)', fields: ['scopeType', 'scopeId'], columns: ['membershipId', 'user.email', 'user.kind', 'roleLabel', 'source', 'inheritedFrom.name', 'expiresAt', 'canEdit'] },
  { resource: 'members', verb: 'roles', method: 'GET', path: '/api/v1/members/roles', summary: 'Roles offered at a scope, with the GitLab equivalent and whether you may grant each (--scope projects/ID)', fields: ['scopeType', 'scopeId'], columns: ['role', 'label', 'gitlab', 'grantable', 'description'] },
  { resource: 'members', verb: 'candidates', method: 'GET', path: '/api/v1/members/candidates', summary: 'People (and this scope\'s service accounts) you can add (--scope projects/ID --q jane)', fields: ['scopeType', 'scopeId', 'q'], columns: ['id', 'email', 'displayName', 'kind'] },
  { resource: 'members', verb: 'add', method: 'POST', path: '/api/v1/members', summary: 'Add or invite people (--scope projects/ID --role DEVELOPER --email a@x,b@x | --users ID,ID [--expires 2027-03-31] [--reason …]); unknown e-mails are invited (setup link printed when there is no SMTP)', fields: ['scopeType', 'scopeId', 'role', 'emails', 'userIds', 'expiresAt', 'reason'] },
  { resource: 'members', verb: 'update', method: 'PATCH', path: '/api/v1/members/:id', summary: 'Change a direct membership (--id MEMBERSHIP [--role TEAM_LEAD] [--expires 2027-03-31 | none])', fields: ['role', 'expiresAt', 'reason'] },
  { resource: 'members', verb: 'remove', method: 'DELETE', path: '/api/v1/members/:id', summary: 'Remove a direct membership (--id MEMBERSHIP [--reason …])', fields: ['reason'] },
  { resource: 'users', verb: 'list', method: 'GET', path: '/api/v1/admin/users', summary: 'Users of the cell (cell admins and root-organization admins; --kind human|service_account)', fields: ['kind'], columns: ['id', 'email', 'displayName', 'kind', 'platformRole', 'membershipCount', 'lastLoginAt', 'disabledAt'] },
  { resource: 'users', verb: 'capabilities', method: 'GET', path: '/api/v1/admin/users/capabilities', summary: 'What user administration can do on this cell (Keycloak admin API, e-mail)' },
  { resource: 'users', verb: 'show', method: 'GET', path: '/api/v1/admin/users/:id', summary: "A user's roles across scopes and tokens (--id USER)" },
  { resource: 'users', verb: 'create', method: 'POST', path: '/api/v1/admin/users', summary: 'Create a user (--email [--first-name --last-name] [--temporary-password …]); without a password a one-time setup link is issued (e-mailed, or printed when there is no SMTP)', fields: ['email', 'firstName', 'lastName', 'temporaryPassword', 'reason'] },
  { resource: 'users', verb: 'disable', method: 'PATCH', path: '/api/v1/admin/users/:id', summary: 'Disable a user: roles kept, sign-in and tokens refused, sessions ended (--id USER)', fields: ['reason'], body: { enabled: false } },
  { resource: 'users', verb: 'enable', method: 'PATCH', path: '/api/v1/admin/users/:id', summary: 'Enable a user again (--id USER)', fields: ['reason'], body: { enabled: true } },
  { resource: 'users', verb: 'reset-password', method: 'POST', path: '/api/v1/admin/users/:id/reset-password', summary: 'Reset a password (--id USER [--temporary-password …]); without one a one-time reset link is issued', fields: ['temporaryPassword', 'reason'] },
  { resource: 'users', verb: 'delete', method: 'DELETE', path: '/api/v1/admin/users/:id', summary: 'Delete a user with their roles and tokens (--id USER [--reason …]); a sole organization admin is refused', fields: ['reason'] },
  { resource: 'service-accounts', verb: 'list', method: 'GET', path: '/api/v1/service-accounts', summary: 'Service accounts owned by a scope (--scope projects/ID)', fields: ['scopeType', 'scopeId'], columns: ['id', 'name', 'username', 'activeTokens', 'disabled'] },
  { resource: 'service-accounts', verb: 'create', method: 'POST', path: '/api/v1/service-accounts', summary: 'Create a bot owned by a scope (--scope projects/ID --name "Jira sync" [--role DEVELOPER] [--description …])', fields: ['scopeType', 'scopeId', 'name', 'description', 'role', 'expiresAt'] },
  { resource: 'service-accounts', verb: 'disable', method: 'PATCH', path: '/api/v1/service-accounts/:id', summary: 'Disable a service account (its tokens stop working)', body: { disabled: true } },
  { resource: 'service-accounts', verb: 'enable', method: 'PATCH', path: '/api/v1/service-accounts/:id', summary: 'Enable a service account', body: { disabled: false } },
  { resource: 'service-accounts', verb: 'delete', method: 'DELETE', path: '/api/v1/service-accounts/:id', summary: 'Delete a service account with its roles and tokens (--id SA)' },
  { resource: 'service-accounts', verb: 'tokens', method: 'GET', path: '/api/v1/service-accounts/:id/tokens', summary: 'Tokens of a service account (--id SA)', columns: ['id', 'name', 'scope', 'prefix', 'expiresAt', 'lastUsedAt', 'revokedAt'] },
  { resource: 'service-accounts', verb: 'token-create', method: 'POST', path: '/api/v1/service-accounts/:id/tokens', summary: 'New token for a service account (--id SA --name ci --token-scope read|write --days 90); printed once', fields: ['name', 'scope', 'expiresInDays'] },
  { resource: 'service-accounts', verb: 'token-rotate', method: 'POST', path: '/api/v1/service-accounts/:id/tokens/:tokenId/rotate', summary: 'Rotate a token: a new one with the same name, scope and lifetime; the old one stops now (--id SA --token-id T)' },
  { resource: 'service-accounts', verb: 'token-revoke', method: 'DELETE', path: '/api/v1/service-accounts/:id/tokens/:tokenId', summary: 'Revoke a service-account token (--id SA --token-id T)' },
  { resource: 'access-token', verb: 'create', method: 'POST', path: '/api/v1/scope-access-tokens', summary: 'Scope access token (GitLab "project access token"): a bot member + its token in one step (--scope projects/ID --name Renovate --role DEVELOPER --token-scope read|write --days 90)', fields: ['scopeType', 'scopeId', 'name', 'role', 'scope', 'expiresInDays'] },
  { resource: 'invite', verb: 'show', method: 'GET', path: '/api/v1/invites/:inviteToken', summary: 'What a one-time setup link is for (--link https://…/invite/TOKEN)' },
  { resource: 'invite', verb: 'accept', method: 'POST', path: '/api/v1/invites/:inviteToken', summary: 'Set the password through a one-time setup link (--link … --password …) — no sign-in needed', fields: ['password'] },
  { resource: 'memberships', verb: 'list', method: 'GET', path: '/api/v1/memberships', summary: 'Memberships of a scope (--scope-type PROJECT --scope-id ID)', fields: ['scopeType', 'scopeId'], columns: ['id', 'role', 'userId', 'scopeType'] },
  { resource: 'membership', verb: 'grant', method: 'POST', path: '/api/v1/memberships', summary: 'Grant a role (--email --role DEVELOPER --scope-type PROJECT --scope-id ID) — roles: ORG_ADMIN, SECURITY_ADMIN, COMPLIANCE_OFFICER, CISO, CTO, TEAM_LEAD, PRODUCT_SECURITY_ENGINEER, DEVELOPER, AUDITOR, EXTERNAL_CONSULTANT, READ_ONLY (see docs/roles.md)', fields: ['email', 'userId', 'role', 'scopeType', 'scopeId', 'expiresAt', 'reason'] },
  { resource: 'meta', verb: 'show', method: 'GET', path: '/api/v1/meta', summary: 'Platform metadata (version, roles)' },
];

/** Flag → path/param name mapping. */
export const PARAM_FLAGS: Record<string, string> = { org: 'org', project: 'project', service: 'service', env: 'env', workspace: 'workspace', team: 'team', id: 'id', from: 'from', to: 'to', scope: 'scope', 'token-id': 'tokenId', link: 'inviteToken' };
/** Flag → body/query field mapping (kebab flags to camel fields). */
export const FIELD_FLAGS: Record<string, string> = { 'owner-email': 'ownerEmail', 'owner': 'ownerId', 'due': 'dueAt', 'project-key': 'projectKey', 'jira-project-key': 'jiraProjectKey', 'issue-integration': 'defaultIssueIntegrationId', 'issue-provider': 'issueProvider', 'repository-id': 'repositoryId', 'parent-id': 'parentId', 'platform-role': 'platformRole', 'kubernetes-namespace': 'kubernetesNamespace', 'kubernetes-context': 'kubernetesContext', 'runner-tag': 'runnerTag', 'internet-facing': 'internetFacing', 'enforce-on-deploy': 'enforceOnDeploy', 'environment-kinds': 'environmentKinds', 'environments': 'environmentKinds', 'enforce': 'enforceOnDeploy', 'scan-on-push': 'scanOnPush', 'immutable-tags': 'immutableTags', 'base-url': 'baseUrl', 'repository-url': 'repositoryUrl', 'issue-board': 'issueBoard', 'match': 'matchId', 'component': 'matchComponent', 'until': 'expiresAt', 'ticket': 'ticketUrl', 'scope-type': 'scopeType', 'scope-id': 'scopeId', 'commit': 'commitSha', 'days': 'expiresInDays', 'image': 'imageRef', 'integration': 'integrationId', 'user': 'userId', 'users': 'userIds', 'email': 'emails', 'expires': 'expiresAt', 'first-name': 'firstName', 'last-name': 'lastName', 'temporary-password': 'temporaryPassword', 'token-scope': 'scope' };

/** `--scope projects/ID` (also organizations/ID, workspaces/ID, teams/ID, or `org` for the default organization) → scopeType + scopeId. */
export const SCOPE_SEGMENTS: Record<string, 'ORGANIZATION' | 'WORKSPACE' | 'TEAM' | 'PROJECT'> = { organizations: 'ORGANIZATION', orgs: 'ORGANIZATION', workspaces: 'WORKSPACE', teams: 'TEAM', projects: 'PROJECT' };

/**
 * The `rules` object for policy commands from flags. Booleans: `--block-secrets` on, `--no-block-secrets` (or
 * `--block-secrets false`) off. `create` sends every rule explicitly — a block rule is OFF unless asked for (the API
 * would otherwise fill blockKev / blockSecrets / requireSbom with true, and the operator who typed only
 * `--max-severity high --block-kev` got a secrets violation), `--honour-decisions` defaults to on; `update` sends only
 * the flags given (a PATCH must not overwrite the other rules).
 */
export function policyRulesFromFlags(f: Record<string, string | boolean>, mode: 'create' | 'update' = 'update'): Record<string, unknown> | undefined {
  const given = (k: string) => k in f || `no-${k}` in f;
  if (mode === 'update' && !RULE_FLAGS.some(given)) return undefined;
  const bool = (k: string, d: boolean) => (`no-${k}` in f ? false : k in f ? f[k] !== 'false' && f[k] !== false : d);
  const sev = (k: string) => (typeof f[k] === 'string' && f[k] !== 'none' ? f[k] : null);
  const out: Record<string, unknown> = {};
  const put = (k: string, field: string, v: unknown) => { if (mode === 'create' || given(k)) out[field] = v; };
  put('max-severity', 'maxSeverity', sev('max-severity'));
  put('block-kev', 'blockKev', bool('block-kev', false));
  put('block-secrets', 'blockSecrets', bool('block-secrets', false));
  put('require-sbom', 'requireSbom', bool('require-sbom', false));
  put('honour-decisions', 'honourDecisions', bool('honour-decisions', true));
  put('max-iac', 'maxIacSeverity', sev('max-iac'));
  put('max-sast', 'maxSastSeverity', sev('max-sast'));
  return out;
}

/** One line for a policy's rules, as `policies list` shows them: "max critical · kev · secrets · sbom · iac high · decisions off". */
export function rulesSummary(r: Record<string, unknown> | null | undefined): string {
  if (!r) return '(defaults)';
  const parts: string[] = [];
  if (r.maxSeverity) parts.push(`max ${r.maxSeverity}`);
  if (r.blockKev !== false) parts.push('kev');
  if (r.blockSecrets !== false) parts.push('secrets');
  if (r.requireSbom !== false) parts.push('sbom');
  if (r.maxIacSeverity) parts.push(`iac ${r.maxIacSeverity}`);
  if (r.maxSastSeverity) parts.push(`sast ${r.maxSastSeverity}`);
  if (r.honourDecisions === false) parts.push('decisions off');
  return parts.length ? parts.join(' · ') : 'no rule';
}

/** Build the `slaDays` object for `sla set` from --critical/--high/--medium/--low. */
export function slaDaysFromFlags(f: Record<string, string | boolean>): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const k of ['critical', 'high', 'medium', 'low']) if (typeof f[k] === 'string') out[k] = Number(f[k]);
  return Object.keys(out).length ? out : undefined;
}

/**
 * Commands implemented by hand in index.ts (not via RESOURCES), declared here so the parity guard
 * (apps/api/src/parity.spec.ts) can prove every mutating API route has a CLI command. `:scope` stands for
 * organizations/:id | workspaces/:id | teams/:id | projects/:id (| services/:id where the API has it).
 */
export const CUSTOM_COMMANDS: { cmd: string; method: string; path: string }[] = [
  { cmd: 'matelot login', method: 'POST', path: '/api/v1/oauth/token' },
  { cmd: 'matelot logout', method: 'POST', path: '/api/v1/oauth/revoke' },
  { cmd: 'matelot deploy', method: 'POST', path: '/api/v1/environments/:env/deployments' },
  { cmd: 'matelot gate', method: 'POST', path: '/api/v1/environments/:env/gate' },
  { cmd: 'matelot promote', method: 'POST', path: '/api/v1/environments/:env/promote' },
  { cmd: 'matelot pipeline', method: 'POST', path: '/api/v1/services/:service/pipelines' },
  { cmd: 'matelot sbom', method: 'POST', path: '/api/v1/services/:service/sboms' },
  { cmd: 'matelot release create', method: 'POST', path: '/api/v1/services/:service/releases' },
  { cmd: 'matelot registry login', method: 'POST', path: '/api/v1/services/:service/registries/:id/credentials' },
  { cmd: 'matelot registry path --create', method: 'POST', path: '/api/v1/services/:service/registries/:id/repositories' },
  { cmd: 'matelot apply --scope', method: 'POST', path: '/api/v1/:scope/config/apply' },
  { cmd: 'matelot vulnerabilities recorrelate', method: 'POST', path: '/api/v1/organizations/:org/findings/recorrelate' },
  { cmd: 'matelot vulnerabilities recorrelate --service', method: 'POST', path: '/api/v1/services/:service/findings/recorrelate' },
  { cmd: 'matelot evidence verify', method: 'POST', path: '/api/v1/evidence/verify' },
];

/** Rule flags accepted by policy commands (also used to reject unknown flags). */
export const RULE_FLAGS = ['max-severity', 'block-kev', 'block-secrets', 'require-sbom', 'max-iac', 'max-sast', 'honour-decisions'];
/** The `--no-…` forms of the boolean rule flags. */
export const RULE_NO_FLAGS = RULE_FLAGS.filter((k) => !k.startsWith('max-')).map((k) => `no-${k}`);
