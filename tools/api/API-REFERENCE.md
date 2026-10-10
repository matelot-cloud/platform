# API reference

Generated from the running platform (`/api/docs-json`); interactive version at `<SECOPS_URL>/api/docs`. Authenticate with `Authorization: Bearer spt_…` (personal token) or a CI token. 158 operations.

## admin

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/admin/users` |  |  |
| `PATCH` | `/admin/users/{userId}` |  | platformRole, enabled, reason |

## api-tokens

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/api-tokens/presets` |  |  |
| `GET` | `/api-tokens/whoami` |  |  |
| `DELETE` | `/api-tokens/{tokenId}` |  |  |
| `GET` | `/organizations/{organizationId}/api-tokens` |  |  |
| `POST` | `/organizations/{organizationId}/api-tokens` |  | name, scopeType, scopeId, preset, permissions, expiresInDays, environments |

## audit

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/organizations/{organizationId}/audit-events` |  | ?limit, ?before |

## environments

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/environments/{environmentId}` |  |  |
| `PATCH` | `/environments/{environmentId}` |  | name, kind, internetFacing |
| `DELETE` | `/environments/{environmentId}` |  |  |
| `GET` | `/services/{serviceId}/environments` |  |  |
| `POST` | `/services/{serviceId}/environments` |  | slug, name, kind, internetFacing |

## execution

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/jobs/{jobId}` |  |  |
| `POST` | `/jobs/{jobId}/cancel` |  |  |
| `GET` | `/jobs/{jobId}/logs` |  | ?after |
| `POST` | `/jobs/{jobId}/retry` |  |  |
| `GET` | `/organizations/{organizationId}/jobs/active` |  |  |
| `GET` | `/organizations/{organizationId}/runner-pools` |  |  |
| `POST` | `/organizations/{organizationId}/runner-pools` |  | scopeType, scopeId, slug, name, tags, description |
| `GET` | `/pipeline-templates` |  |  |
| `GET` | `/pipelines/{pipelineId}` |  |  |
| `POST` | `/pipelines/{pipelineId}/cancel` |  |  |
| `GET` | `/projects/{projectId}/jobs` |  | ?limit |
| `GET` | `/projects/{projectId}/pipelines` |  | ?limit |
| `GET` | `/projects/{projectId}/runner-pools` |  |  |
| `GET` | `/runner-agent` |  |  |
| `DELETE` | `/runner-pools/{poolId}` |  |  |
| `POST` | `/runner-pools/{poolId}/registration-tokens` |  |  |
| `DELETE` | `/runners/{runnerId}` |  |  |
| `POST` | `/services/{serviceId}/jobs` |  | type, repositoryId, requiredTags, poolId, payload, timeoutSeconds |
| `POST` | `/services/{serviceId}/pipelines` |  | template, repositoryId, ref, requiredTags, poolId |

## health

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/health/live` |  |  |
| `GET` | `/health/ready` |  |  |

## iam

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/me` |  |  |
| `GET` | `/memberships` |  | ?scopeType, ?scopeId |
| `POST` | `/memberships` |  | email, role, scopeType, scopeId, reason |
| `DELETE` | `/memberships/{membershipId}` |  |  |

## integrations

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/integrations/providers` |  |  |
| `DELETE` | `/integrations/{integrationId}` |  | ?permanent |
| `GET` | `/integrations/{integrationId}/ecr/repositories` |  |  |
| `POST` | `/integrations/{integrationId}/ecr/repositories` |  |  |
| `GET` | `/integrations/{integrationId}/install-url` |  |  |
| `GET` | `/integrations/{integrationId}/repositories` |  |  |
| `POST` | `/integrations/{integrationId}/sync` |  |  |
| `POST` | `/integrations/{integrationId}/verify` |  |  |
| `GET` | `/organizations/{organizationId}/integrations` |  |  |
| `POST` | `/organizations/{organizationId}/integrations` |  | scopeType, scopeId, provider, name, baseUrl, owner, repositoryUrl, auth |
| `GET` | `/organizations/{organizationId}/integrations/github/install-url` |  | ?scopeType, ?scopeId |
| `POST` | `/organizations/{organizationId}/integrations/test` |  | scopeType, scopeId, provider, name, baseUrl, owner, repositoryUrl, auth |
| `GET` | `/organizations/{organizationId}/repositories` |  |  |
| `GET` | `/projects/{projectId}/integrations` |  |  |
| `GET` | `/projects/{projectId}/repositories` |  |  |
| `GET` | `/services/{serviceId}/registries` |  |  |
| `POST` | `/services/{serviceId}/registries/{integrationId}/credentials` |  |  |
| `POST` | `/services/{serviceId}/registries/{integrationId}/repositories` |  |  |
| `GET` | `/services/{serviceId}/repositories` |  |  |
| `POST` | `/services/{serviceId}/repositories` |  | repositoryId, role |
| `DELETE` | `/services/{serviceId}/repositories/{repositoryId}` |  |  |

## inventory

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `POST` | `/environments/{environmentId}/deployments` |  | version, releaseId, imageRef, source, deployedAt, commitSha, metadata |
| `POST` | `/environments/{environmentId}/kubernetes-sync` |  |  |
| `PATCH` | `/environments/{environmentId}/settings` |  | kubernetesNamespace, kubernetesContext, runnerTag, protected |
| `GET` | `/organizations/{organizationId}/deployments` |  |  |
| `GET` | `/projects/{projectId}/inventory` |  |  |
| `GET` | `/services/{serviceId}/deployments` |  |  |
| `GET` | `/services/{serviceId}/images` |  |  |
| `POST` | `/services/{serviceId}/images` |  | name, integrationId, insecure |
| `DELETE` | `/services/{serviceId}/images/{imageId}` |  |  |
| `POST` | `/services/{serviceId}/images/{imageId}/sync` |  |  |
| `GET` | `/services/{serviceId}/inventory` |  |  |
| `GET` | `/services/{serviceId}/releases` |  |  |
| `POST` | `/services/{serviceId}/releases` |  | version, tag, commitSha, notes, repositoryId, releasedAt |
| `POST` | `/services/{serviceId}/releases/sync` |  |  |

## me

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/me/tokens` |  |  |
| `POST` | `/me/tokens` |  | name, scope, expiresInDays |
| `DELETE` | `/me/tokens/{id}` |  |  |

## meta

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/meta` |  |  |

## organizations

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/organizations` |  |  |
| `POST` | `/organizations` |  | parentId, slug, name |
| `GET` | `/organizations/{organizationId}` |  |  |
| `PATCH` | `/organizations/{organizationId}` |  | name |

## overview

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/organizations/{organizationId}/overview` |  |  |
| `GET` | `/projects/{projectId}/overview` |  |  |

## policies

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/environments/{environmentId}/gate` |  |  |
| `POST` | `/environments/{environmentId}/gate` |  | imageRef, digest, version, ref |
| `GET` | `/organizations/{organizationId}/policies` |  |  |
| `POST` | `/organizations/{organizationId}/policies` |  | name, description, environmentKinds, rules, action, enforceOnDeploy |
| `PATCH` | `/policies/{policyId}` |  | name, description, enabled, environmentKinds, rules, action, enforceOnDeploy |
| `DELETE` | `/policies/{policyId}` |  |  |
| `GET` | `/projects/{projectId}/policies` |  |  |
| `POST` | `/projects/{projectId}/policies` |  | name, description, environmentKinds, rules, action, enforceOnDeploy |
| `GET` | `/services/{serviceId}/gate-evaluations` |  |  |
| `GET` | `/teams/{teamId}/policies` |  |  |
| `POST` | `/teams/{teamId}/policies` |  | name, description, environmentKinds, rules, action, enforceOnDeploy |
| `GET` | `/workspaces/{workspaceId}/policies` |  |  |
| `POST` | `/workspaces/{workspaceId}/policies` |  | name, description, environmentKinds, rules, action, enforceOnDeploy |

## projects

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/organizations/{organizationId}/projects` |  |  |
| `GET` | `/projects/{projectId}` |  |  |
| `PATCH` | `/projects/{projectId}` |  | name, description, criticality, automation |
| `DELETE` | `/projects/{projectId}` |  |  |
| `GET` | `/teams/{teamId}/projects` |  |  |
| `POST` | `/teams/{teamId}/projects` |  | slug, name, description, criticality |

## registry

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `POST` | `/environments/{environmentId}/promote` |  | tag |
| `GET` | `/environments/{environmentId}/registry` |  |  |
| `POST` | `/organizations/{organizationId}/registry/reconcile` |  |  |
| `GET` | `/registry/info` |  |  |
| `GET` | `/services/{serviceId}/registry` |  |  |

## risk

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/environments/{environmentId}/lineage` |  |  |
| `GET` | `/organizations/{organizationId}/risk` |  |  |
| `POST` | `/organizations/{organizationId}/risk/recompute` |  |  |
| `GET` | `/projects/{projectId}/graph` |  |  |
| `GET` | `/projects/{projectId}/risk` |  |  |
| `POST` | `/projects/{projectId}/risk/recompute` |  |  |
| `GET` | `/services/{serviceId}/risk` |  |  |

## sbom

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/organizations/{organizationId}/components` |  |  |
| `GET` | `/projects/{projectId}/sbom-summary` |  |  |
| `GET` | `/sboms/{from}/diff/{to}` |  |  |
| `GET` | `/sboms/{sbomId}` |  | ?q |
| `GET` | `/sboms/{sbomId}/download` |  |  |
| `GET` | `/services/{serviceId}/sboms` |  |  |
| `POST` | `/services/{serviceId}/sboms` |  | target, targetRef, version, imageRef, document |

## services

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/organizations/{organizationId}/services` |  |  |
| `GET` | `/projects/{projectId}/services` |  |  |
| `POST` | `/projects/{projectId}/services` |  | slug, name, description, kind, criticality |
| `GET` | `/services/{serviceId}` |  |  |
| `PATCH` | `/services/{serviceId}` |  | name, description, kind, criticality |
| `DELETE` | `/services/{serviceId}` |  |  |

## teams

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/organizations/{organizationId}/teams` |  |  |
| `GET` | `/teams/{teamId}` |  |  |
| `PATCH` | `/teams/{teamId}` |  | name, description |
| `DELETE` | `/teams/{teamId}` |  |  |
| `GET` | `/workspaces/{workspaceId}/teams` |  |  |
| `POST` | `/workspaces/{workspaceId}/teams` |  | slug, name, description |

## vulnerabilities

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `PATCH` | `/code-findings/{id}` |  | status, note |
| `GET` | `/findings/{findingId}` |  |  |
| `PATCH` | `/findings/{findingId}` |  | status, note |
| `GET` | `/organizations/{organizationId}/code-findings` |  | ?kind, ?severity, ?status, ?q |
| `GET` | `/organizations/{organizationId}/code-findings/summary` |  |  |
| `GET` | `/organizations/{organizationId}/findings` |  | ?severity, ?status, ?kev, ?q, ?projectId, ?running |
| `GET` | `/organizations/{organizationId}/findings/environments` |  |  |
| `POST` | `/organizations/{organizationId}/findings/recorrelate` |  |  |
| `POST` | `/organizations/{organizationId}/findings/snapshots` |  | ?backfillDays |
| `GET` | `/organizations/{organizationId}/findings/summary` |  |  |
| `GET` | `/organizations/{organizationId}/findings/trend` |  | ?days |
| `GET` | `/projects/{projectId}/code-findings` |  | ?kind, ?severity, ?status, ?q |
| `GET` | `/projects/{projectId}/code-findings/summary` |  |  |
| `GET` | `/projects/{projectId}/findings` |  | ?severity, ?status, ?kev, ?q |
| `GET` | `/projects/{projectId}/findings/environments` |  |  |
| `GET` | `/projects/{projectId}/findings/summary` |  |  |
| `GET` | `/projects/{projectId}/findings/trend` |  | ?days |
| `GET` | `/sboms/{sbomId}/findings` |  | ?status |
| `GET` | `/services/{serviceId}/findings` |  | ?status |
| `POST` | `/services/{serviceId}/findings/recorrelate` |  |  |

## workspaces

| Method | Path | Summary | Query / body fields |
|---|---|---|---|
| `GET` | `/organizations/{organizationId}/workspaces` |  |  |
| `POST` | `/organizations/{organizationId}/workspaces` |  | slug, name, description |
| `GET` | `/workspaces/{workspaceId}` |  |  |
| `PATCH` | `/workspaces/{workspaceId}` |  | name, description |
| `DELETE` | `/workspaces/{workspaceId}` |  |  |
