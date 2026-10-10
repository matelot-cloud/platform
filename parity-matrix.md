# UI ⇄ API ⇄ CLI ⇄ MCP parity matrix

Generated from the sources (`apps/api/src/**/*.controller.ts`, `apps/web/src`, `apps/cli/src/resources.ts`). UI = the web app calls this route; API = documented in OpenAPI; CLI = a `matelot` command covers it; MCP = exposed as an MCP tool (generated from OpenAPI, so MCP = API). Routes that are not user actions (runner protocol, webhooks, MCP transport, registry event sink, OAuth) are omitted. GET routes count as covered by the generic `matelot <resource> list|show` commands where present.

## Before (as audited)

234 user-facing routes · 44 mutating routes without a CLI command · UI calls outside the documented API: 0 (asserted by apps/api/src/parity.spec.ts)

### Users, roles & memberships

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /admin/users` | — | ✅ | ✅ `matelot users list` | ✅ |  |
| `PATCH /admin/users/{x}` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /me` | — | ✅ | ✅ `matelot me show` | ✅ |  |
| `GET /memberships` | ✅ | ✅ | ✅ `matelot memberships list` | ✅ |  |
| `POST /memberships` | — | ✅ | ✅ `matelot membership grant` | ✅ |  |
| `DELETE /memberships/{x}` | ✅ | ✅ | ❌ | ✅ |  |

### Tokens & runners

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /api-tokens/presets` | — | ✅ | ❌ | ✅ |  |
| `GET /api-tokens/whoami` | — | ✅ | ❌ | ✅ |  |
| `DELETE /api-tokens/{x}` | ✅ | ✅ | ✅ `matelot ci-token revoke` | ✅ |  |
| `GET /me/tokens` | — | ✅ | ✅ `matelot tokens list` | ✅ |  |
| `POST /me/tokens` | — | ✅ | ✅ `matelot token create` | ✅ |  |
| `DELETE /me/tokens/{x}` | ✅ | ✅ | ✅ `matelot token revoke` | ✅ |  |
| `GET /organizations/{x}/api-tokens` | ✅ | ✅ | ✅ `matelot ci-tokens list` | ✅ | organization:read |
| `POST /organizations/{x}/api-tokens` | ✅ | ✅ | ✅ `matelot ci-token create` | ✅ | organization:read |
| `GET /organizations/{x}/runner-pools` | ✅ | ✅ | ✅ `matelot runners list` | ✅ | organization:read |
| `POST /organizations/{x}/runner-pools` | ✅ | ✅ | ❌ | ✅ | organization:read |
| `GET /projects/{x}/runner-pools` | — | ✅ | ❌ | ✅ | project:read |

### Vulnerabilities & decisions

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `PATCH /code-findings/{x}` | ✅ | ✅ | ✅ `matelot code-finding set` | ✅ |  |
| `GET /findings/{x}` | ✅ | ✅ | ✅ `matelot finding show` | ✅ |  |
| `PATCH /findings/{x}` | ✅ | ✅ | ✅ `matelot finding set` | ✅ |  |
| `GET /organizations/{x}/code-findings` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /organizations/{x}/code-findings/summary` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /organizations/{x}/components` | — | ✅ | ✅ `matelot components search` | ✅ | sbom:read |
| `GET /organizations/{x}/findings` | — | ✅ | ✅ `matelot findings list-org` | ✅ | vulnerability:read |
| `POST /organizations/{x}/findings/recorrelate` | ✅ | ✅ | ❌ | ✅ | vulnerability:write |
| `POST /organizations/{x}/findings/snapshots` | ✅ | ✅ | ❌ | ✅ | vulnerability:write |
| `GET /organizations/{x}/findings/summary` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /organizations/{x}/findings/trend` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /organizations/{x}/risk` | — | ✅ | ✅ `matelot risk list` | ✅ | risk:read |
| `POST /organizations/{x}/risk/recompute` | — | ✅ | ✅ `matelot risk recompute` | ✅ | risk:read |
| `GET /projects/{x}/code-findings` | — | ✅ | ✅ `matelot code-findings list` | ✅ | vulnerability:read |
| `GET /projects/{x}/code-findings/summary` | — | ✅ | ✅ `matelot code-findings summary` | ✅ | vulnerability:read |
| `GET /projects/{x}/components` | — | ✅ | ✅ `matelot components search-project` | ✅ | sbom:read |
| `GET /projects/{x}/findings` | — | ✅ | ✅ `matelot findings list` | ✅ | vulnerability:read |
| `GET /projects/{x}/findings/summary` | — | ✅ | ✅ `matelot findings summary` | ✅ | vulnerability:read |
| `GET /projects/{x}/findings/trend` | — | ✅ | ✅ `matelot findings trend` | ✅ | vulnerability:read |
| `GET /projects/{x}/risk` | — | ✅ | ✅ `matelot risk project` | ✅ | risk:read |
| `POST /projects/{x}/risk/recompute` | — | ✅ | ❌ | ✅ | risk:read |
| `GET /teams/{x}/code-findings` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /teams/{x}/code-findings/summary` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /teams/{x}/components` | — | ✅ | ❌ | ✅ | sbom:read |
| `GET /teams/{x}/findings` | — | ✅ | ✅ `matelot findings list-team` | ✅ | vulnerability:read |
| `GET /teams/{x}/findings/summary` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /teams/{x}/findings/trend` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /teams/{x}/risk` | — | ✅ | ✅ `matelot risk team` | ✅ | service:read |
| `GET /workspaces/{x}/code-findings` | — | ✅ | ✅ `matelot code-findings list-workspace` | ✅ | vulnerability:read |
| `GET /workspaces/{x}/code-findings/summary` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /workspaces/{x}/components` | — | ✅ | ✅ `matelot components search-workspace` | ✅ | sbom:read |
| `GET /workspaces/{x}/findings` | — | ✅ | ✅ `matelot findings list-workspace` | ✅ | vulnerability:read |
| `GET /workspaces/{x}/findings/summary` | — | ✅ | ✅ `matelot findings summary-workspace` | ✅ | vulnerability:read |
| `GET /workspaces/{x}/findings/trend` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /workspaces/{x}/risk` | — | ✅ | ✅ `matelot risk workspace` | ✅ | service:read |

### Services & environments

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `DELETE /environments/{x}` | ✅ | ✅ | ❌ | ✅ | environment:write |
| `GET /environments/{x}` | — | ✅ | ✅ `matelot env show` | ✅ | environment:read |
| `PATCH /environments/{x}` | — | ✅ | ❌ | ✅ | environment:write |
| `POST /environments/{x}/deployments` | ✅ | ✅ | ✅ `matelot deploy` | ✅ | deployment:write |
| `GET /environments/{x}/gate` | ✅ | ✅ | ✅ `matelot env gate` | ✅ | policy:read |
| `POST /environments/{x}/gate` | ✅ | ✅ | ✅ `matelot gate` | ✅ | gate:evaluate |
| `POST /environments/{x}/kubernetes-sync` | ✅ | ✅ | ❌ | ✅ | deployment:write |
| `GET /environments/{x}/lineage` | ✅ | ✅ | ✅ `matelot env lineage` | ✅ | service:read |
| `POST /environments/{x}/promote` | ✅ | ✅ | ✅ `matelot promote` | ✅ | deployment:write |
| `PATCH /environments/{x}/settings` | ✅ | ✅ | ❌ | ✅ | environment:write |
| `GET /organizations/{x}/findings/environments` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /projects/{x}/findings/environments` | — | ✅ | ✅ `matelot findings environments` | ✅ | vulnerability:read |
| `GET /projects/{x}/services` | ✅ | ✅ | ✅ `matelot services list` | ✅ | project:read |
| `POST /projects/{x}/services` | ✅ | ✅ | ❌ | ✅ | service:write |
| `DELETE /services/{x}` | ✅ | ✅ | ❌ | ✅ | service:write |
| `GET /services/{x}` | — | ✅ | ✅ `matelot service show` | ✅ | service:read |
| `PATCH /services/{x}` | ✅ | ✅ | ❌ | ✅ | service:write |
| `GET /services/{x}/correlation/jobs/{x}` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /services/{x}/deployments` | ✅ | ✅ | ✅ `matelot deployments list` | ✅ | service:read |
| `GET /services/{x}/environments` | ✅ | ✅ | ✅ `matelot envs list` | ✅ | service:read |
| `POST /services/{x}/environments` | ✅ | ✅ | ❌ | ✅ | environment:write |
| `POST /services/{x}/exceptions` | — | ✅ | ✅ `matelot exception create` | ✅ | policy:write |
| `GET /services/{x}/findings` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `POST /services/{x}/findings/recorrelate` | — | ✅ | ❌ | ✅ | vulnerability:write |
| `GET /services/{x}/gate-evaluations` | — | ✅ | ✅ `matelot gate evaluations` | ✅ | policy:read |
| `GET /services/{x}/inventory` | ✅ | ✅ | ✅ `matelot inventory show` | ✅ | service:read |
| `POST /services/{x}/jobs` | ✅ | ✅ | ✅ `matelot job create` | ✅ | job:create |
| `POST /services/{x}/pipelines` | ✅ | ✅ | ✅ `matelot pipeline` | ✅ | job:create |
| `GET /services/{x}/releases` | ✅ | ✅ | ✅ `matelot releases list` | ✅ | service:read |
| `POST /services/{x}/releases` | ✅ | ✅ | ✅ `matelot release create` | ✅ | release:write |
| `POST /services/{x}/releases/sync` | ✅ | ✅ | ❌ | ✅ | release:write |
| `GET /services/{x}/remediation/queue` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `POST /services/{x}/remediations` | ✅ | ✅ | ✅ `matelot remediation create` | ✅ | vulnerability:write |
| `GET /services/{x}/repositories` | ✅ | ✅ | ❌ | ✅ | service:read |
| `POST /services/{x}/repositories` | ✅ | ✅ | ❌ | ✅ | service:write |
| `DELETE /services/{x}/repositories/{x}` | ✅ | ✅ | ❌ | ✅ | service:write |
| `GET /services/{x}/risk` | ✅ | ✅ | ❌ | ✅ | risk:read |
| `GET /services/{x}/sboms` | ✅ | ✅ | ✅ `matelot sboms list` | ✅ | sbom:read |
| `POST /services/{x}/sboms` | — | ✅ | ✅ `matelot sbom` | ✅ | sbom:write |
| `GET /teams/{x}/findings/environments` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /workspaces/{x}/findings/environments` | — | ✅ | ✅ `matelot findings environments-workspace` | ✅ | vulnerability:read |

### Connections & registries

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /environments/{x}/registry` | ✅ | ✅ | ✅ `matelot env registry` | ✅ | environment:read |
| `GET /integrations/providers` | — | ✅ | ✅ `matelot integrations providers` | ✅ |  |
| `DELETE /integrations/{x}` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /integrations/{x}/ecr/repositories` | ✅ | ✅ | ❌ | ✅ |  |
| `POST /integrations/{x}/ecr/repositories` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /integrations/{x}/install-url` | ✅ | ✅ | ❌ | ✅ |  |
| `POST /integrations/{x}/link-installation` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /integrations/{x}/matelot-repositories` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /integrations/{x}/repositories` | — | ✅ | ❌ | ✅ |  |
| `POST /integrations/{x}/sync` | ✅ | ✅ | ❌ | ✅ |  |
| `POST /integrations/{x}/verify` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /organizations/{x}/integrations` | ✅ | ✅ | ✅ `matelot integrations list` | ✅ | organization:read |
| `POST /organizations/{x}/integrations` | ✅ | ✅ | ❌ | ✅ | organization:read |
| `GET /organizations/{x}/integrations/github/install-url` | — | ✅ | ❌ | ✅ | organization:read |
| `POST /organizations/{x}/integrations/test` | ✅ | ✅ | ❌ | ✅ | organization:read |
| `POST /organizations/{x}/registry/reconcile` | — | ✅ | ✅ `matelot registry reconcile` | ✅ | integration:write |
| `GET /projects/{x}/integrations` | ✅ | ✅ | ❌ | ✅ | project:read |
| `GET /registry/info` | — | ✅ | ✅ `matelot registry info` | ✅ |  |
| `GET /registry/token` | — | ✅ | ❌ | ✅ |  |
| `GET /services/{x}/images` | ✅ | ✅ | ✅ `matelot images list` | ✅ | service:read |
| `POST /services/{x}/images` | ✅ | ✅ | ✅ `matelot image add` | ✅ | service:write |
| `DELETE /services/{x}/images/{x}` | ✅ | ✅ | ❌ | ✅ | service:write |
| `POST /services/{x}/images/{x}/sync` | ✅ | ✅ | ✅ `matelot image sync` | ✅ | service:write |
| `GET /services/{x}/registries` | — | ✅ | ✅ `matelot registries list` | ✅ | service:read |
| `POST /services/{x}/registries/{x}/credentials` | — | ✅ | ✅ `matelot registry login` | ✅ | registry:pull |
| `POST /services/{x}/registries/{x}/repositories` | — | ✅ | ✅ `matelot registry path --create` | ✅ | registry:push |
| `GET /services/{x}/registry` | ✅ | ✅ | ❌ | ✅ | service:read |

### CRA / evidence / VEX

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `POST /evidence/verify` | — | ✅ | ✅ `matelot evidence verify` | ✅ |  |
| `GET /projects/{x}/cra/readiness` | — | ✅ | ✅ `matelot cra readiness-project` | ✅ | service:read |
| `GET /releases/{x}/evidence` | — | ✅ | ✅ `matelot evidence summary` | ✅ |  |
| `GET /releases/{x}/evidence.zip` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /releases/{x}/vex` | — | ✅ | ✅ `matelot evidence vex` | ✅ |  |
| `GET /services/{x}/cra/readiness` | — | ✅ | ✅ `matelot cra readiness` | ✅ | service:read |
| `GET /teams/{x}/cra/readiness` | — | ✅ | ❌ | ✅ | service:read |
| `GET /workspaces/{x}/cra/readiness` | — | ✅ | ✅ `matelot cra readiness-workspace` | ✅ | service:read |

### Exceptions

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `DELETE /exceptions/{x}` | ✅ | ✅ | ✅ `matelot exception revoke` | ✅ |  |
| `POST /exceptions/{x}/approve` | — | ✅ | ✅ `matelot exception approve` | ✅ |  |
| `GET /organizations/{x}/exceptions` | — | ✅ | ✅ `matelot exceptions list` | ✅ | policy:read |
| `POST /organizations/{x}/exceptions` | — | ✅ | ✅ `matelot exception create-org` | ✅ | policy:write |
| `POST /projects/{x}/exceptions` | — | ✅ | ✅ `matelot exception create-project` | ✅ | policy:write |

### Other

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /health/live` | — | ✅ | ❌ | ✅ |  |
| `GET /health/ready` | — | ✅ | ❌ | ✅ |  |
| `GET /meta` | — | ✅ | ✅ `matelot meta show` | ✅ |  |
| `GET /organizations/{x}/audit-events` | ✅ | ✅ | ✅ `matelot audit list` | ✅ | audit:read |
| `GET /organizations/{x}/overview` | ✅ | ✅ | ✅ `matelot org overview` | ✅ | organization:read |
| `GET /organizations/{x}/projects` | ✅ | ✅ | ✅ `matelot projects list` | ✅ | organization:read |
| `GET /organizations/{x}/repositories` | ✅ | ✅ | ✅ `matelot repositories list` | ✅ | organization:read |
| `GET /organizations/{x}/services` | — | ✅ | ✅ `matelot services list-org` | ✅ | organization:read |
| `GET /organizations/{x}/teams` | ✅ | ✅ | ✅ `matelot teams list` | ✅ | organization:read |
| `GET /organizations/{x}/workspaces` | ✅ | ✅ | ✅ `matelot workspaces list` | ✅ | organization:read |
| `POST /organizations/{x}/workspaces` | ✅ | ✅ | ❌ | ✅ | workspace:write |
| `GET /pipeline-templates` | — | ✅ | ✅ `matelot pipeline templates` | ✅ |  |
| `GET /projects/{x}/graph` | ✅ | ✅ | ✅ `matelot graph show` | ✅ | risk:read |
| `GET /projects/{x}/inventory` | ✅ | ✅ | ❌ | ✅ | project:read |
| `GET /projects/{x}/overview` | ✅ | ✅ | ✅ `matelot project overview` | ✅ | project:read |
| `GET /projects/{x}/repositories` | ✅ | ✅ | ❌ | ✅ | project:read |
| `GET /teams/{x}/projects` | — | ✅ | ❌ | ✅ | team:read |
| `POST /teams/{x}/projects` | ✅ | ✅ | ❌ | ✅ | project:write |
| `GET /workspaces/{x}/teams` | — | ✅ | ❌ | ✅ | workspace:read |
| `POST /workspaces/{x}/teams` | ✅ | ✅ | ❌ | ✅ | team:write |

### Images & SBOMs

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /jobs/{x}` | ✅ | ✅ | ✅ `matelot job show` | ✅ |  |
| `POST /jobs/{x}/cancel` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /jobs/{x}/logs` | ✅ | ✅ | ✅ `matelot job logs` | ✅ |  |
| `POST /jobs/{x}/retry` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /organizations/{x}/correlation/jobs/{x}` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /organizations/{x}/jobs/active` | ✅ | ✅ | ✅ `matelot jobs active` | ✅ | job:read |
| `GET /pipelines/{x}` | ✅ | ✅ | ✅ `matelot pipeline show` | ✅ |  |
| `POST /pipelines/{x}/cancel` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /projects/{x}/jobs` | ✅ | ✅ | ✅ `matelot jobs list` | ✅ | job:read |
| `GET /projects/{x}/pipelines` | ✅ | ✅ | ✅ `matelot pipelines list` | ✅ | job:read |
| `GET /projects/{x}/sbom-summary` | — | ✅ | ❌ | ✅ | project:read |
| `GET /sboms/{x}` | — | ✅ | ✅ `matelot sbom show` | ✅ |  |
| `GET /sboms/{x}/diff/{x}` | ✅ | ✅ | ✅ `matelot sbom diff` | ✅ |  |
| `GET /sboms/{x}/download` | — | ✅ | ❌ | ✅ |  |
| `GET /sboms/{x}/findings` | ✅ | ✅ | ✅ `matelot sbom findings` | ✅ |  |

### Notifications

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /notification-capabilities` | — | ✅ | ❌ | ✅ |  |
| `DELETE /notification-channels/{x}` | ✅ | ✅ | ✅ `matelot channel delete` | ✅ |  |
| `PATCH /notification-channels/{x}` | ✅ | ✅ | ✅ `matelot channel update` | ✅ |  |
| `POST /notification-channels/{x}/test` | ✅ | ✅ | ✅ `matelot channel test` | ✅ |  |
| `GET /notification-events` | — | ✅ | ✅ `matelot channels events` | ✅ |  |
| `GET /organizations/{x}/notification-channels` | — | ✅ | ✅ `matelot channels list-scope` | ✅ | project:read |
| `POST /organizations/{x}/notification-channels` | — | ✅ | ✅ `matelot channel create` | ✅ | project:write |
| `GET /projects/{x}/notification-channels` | — | ✅ | ✅ `matelot channels list-scope` | ✅ | project:read |
| `POST /projects/{x}/notification-channels` | — | ✅ | ✅ `matelot channel create-scope` | ✅ | project:write |
| `GET /teams/{x}/notification-channels` | — | ✅ | ✅ `matelot channels list-scope` | ✅ | project:read |
| `POST /teams/{x}/notification-channels` | — | ✅ | ✅ `matelot channel create-scope` | ✅ | project:write |
| `GET /workspaces/{x}/notification-channels` | — | ✅ | ✅ `matelot channels list-scope` | ✅ | project:read |
| `POST /workspaces/{x}/notification-channels` | — | ✅ | ✅ `matelot channel create-scope` | ✅ | project:write |

### Org / workspace / team / project settings

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /organizations` | — | ✅ | ✅ `matelot orgs list` | ✅ |  |
| `POST /organizations` | — | ✅ | ❌ | ✅ |  |
| `GET /organizations/{x}` | — | ✅ | ❌ | ✅ | organization:read |
| `PATCH /organizations/{x}` | — | ✅ | ❌ | ✅ | organization:write |
| `POST /organizations/{x}/config/apply` | — | ✅ | ✅ `matelot apply --scope` | ✅ | policy:write |
| `DELETE /projects/{x}` | ✅ | ✅ | ❌ | ✅ | project:write |
| `GET /projects/{x}` | — | ✅ | ✅ `matelot project show` | ✅ | project:read |
| `PATCH /projects/{x}` | ✅ | ✅ | ❌ | ✅ | project:write |
| `POST /projects/{x}/config/apply` | — | ✅ | ✅ `matelot apply --scope` | ✅ | policy:write |
| `DELETE /teams/{x}` | — | ✅ | ❌ | ✅ | team:write |
| `GET /teams/{x}` | — | ✅ | ❌ | ✅ | team:read |
| `PATCH /teams/{x}` | — | ✅ | ❌ | ✅ | team:write |
| `POST /teams/{x}/config/apply` | — | ✅ | ✅ `matelot apply --scope` | ✅ | policy:write |
| `DELETE /workspaces/{x}` | ✅ | ✅ | ❌ | ✅ | workspace:write |
| `GET /workspaces/{x}` | — | ✅ | ❌ | ✅ | workspace:read |
| `PATCH /workspaces/{x}` | ✅ | ✅ | ❌ | ✅ | workspace:write |
| `POST /workspaces/{x}/config/apply` | — | ✅ | ✅ `matelot apply --scope` | ✅ | policy:write |

### Deployments & releases

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /organizations/{x}/deployments` | — | ✅ | ✅ `matelot deployments list-org` | ✅ | deployment:read |

### Policies & gates

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /organizations/{x}/policies` | ✅ | ✅ | ✅ `matelot policies list` | ✅ | policy:read |
| `POST /organizations/{x}/policies` | — | ✅ | ✅ `matelot policy create` | ✅ | policy:write |
| `POST /organizations/{x}/policies/from-template` | — | ✅ | ✅ `matelot policy from-template` | ✅ | policy:write |
| `DELETE /policies/{x}` | ✅ | ✅ | ✅ `matelot policy delete` | ✅ |  |
| `PATCH /policies/{x}` | ✅ | ✅ | ✅ `matelot policy update` | ✅ |  |
| `GET /policy-templates` | — | ✅ | ✅ `matelot policy templates` | ✅ |  |
| `GET /projects/{x}/policies` | — | ✅ | ✅ `matelot policies in-force` | ✅ | policy:read |
| `POST /projects/{x}/policies` | — | ✅ | ✅ `matelot policy create-project` | ✅ | policy:write |
| `POST /projects/{x}/policies/from-template` | — | ✅ | ✅ `matelot policy from-template-project` | ✅ | policy:write |
| `GET /teams/{x}/policies` | — | ✅ | ❌ | ✅ | policy:read |
| `POST /teams/{x}/policies` | — | ✅ | ❌ | ✅ | policy:write |
| `POST /teams/{x}/policies/from-template` | — | ✅ | ❌ | ✅ | policy:write |
| `GET /workspaces/{x}/policies` | — | ✅ | ❌ | ✅ | policy:read |
| `POST /workspaces/{x}/policies` | — | ✅ | ❌ | ✅ | policy:write |
| `POST /workspaces/{x}/policies/from-template` | — | ✅ | ❌ | ✅ | policy:write |

### Remediation & issues

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /organizations/{x}/remediation/queue` | — | ✅ | ✅ `matelot remediation queue-org` | ✅ | vulnerability:read |
| `GET /organizations/{x}/remediations` | — | ✅ | ✅ `matelot remediations list-org` | ✅ | vulnerability:read |
| `GET /projects/{x}/remediation/queue` | — | ✅ | ✅ `matelot remediation queue` | ✅ | vulnerability:read |
| `GET /projects/{x}/remediations` | — | ✅ | ✅ `matelot remediations list` | ✅ | vulnerability:read |
| `GET /remediations/{x}` | — | ✅ | ✅ `matelot remediation show` | ✅ |  |
| `PATCH /remediations/{x}` | ✅ | ✅ | ✅ `matelot remediation update` | ✅ |  |
| `POST /remediations/{x}/issue` | ✅ | ✅ | ✅ `matelot remediation issue` | ✅ |  |
| `GET /teams/{x}/remediation/queue` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /teams/{x}/remediations` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /workspaces/{x}/remediation/queue` | — | ✅ | ✅ `matelot remediation queue-workspace` | ✅ | vulnerability:read |
| `GET /workspaces/{x}/remediations` | — | ✅ | ❌ | ✅ | vulnerability:read |

### SLAs

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /organizations/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla show` | ✅ | vulnerability:read |
| `PATCH /organizations/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla set` | ✅ | policy:write |
| `GET /projects/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla show-scope` | ✅ | vulnerability:read |
| `PATCH /projects/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla set-scope` | ✅ | policy:write |
| `GET /projects/{x}/remediation/settings/effective` | ✅ | ✅ | ✅ `matelot sla effective` | ✅ | vulnerability:read |
| `GET /teams/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla show-scope` | ✅ | vulnerability:read |
| `PATCH /teams/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla set-scope` | ✅ | policy:write |
| `GET /workspaces/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla show-scope` | ✅ | vulnerability:read |
| `PATCH /workspaces/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla set-scope` | ✅ | policy:write |

## After the fixes

234 user-facing routes · 0 mutating routes without a CLI command · UI calls outside the documented API: 0 (asserted by apps/api/src/parity.spec.ts)

### Users, roles & memberships

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /admin/users` | — | ✅ | ✅ `matelot users list` | ✅ |  |
| `PATCH /admin/users/{x}` | ✅ | ✅ | ✅ `matelot admin update-user` | ✅ |  |
| `GET /me` | — | ✅ | ✅ `matelot me show` | ✅ |  |
| `GET /memberships` | ✅ | ✅ | ✅ `matelot memberships list` | ✅ |  |
| `POST /memberships` | — | ✅ | ✅ `matelot membership grant` | ✅ |  |
| `DELETE /memberships/{x}` | ✅ | ✅ | ✅ `matelot membership revoke` | ✅ |  |

### Tokens & runners

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /api-tokens/presets` | — | ✅ | ❌ | ✅ |  |
| `GET /api-tokens/whoami` | — | ✅ | ❌ | ✅ |  |
| `DELETE /api-tokens/{x}` | ✅ | ✅ | ✅ `matelot ci-token revoke` | ✅ |  |
| `GET /me/tokens` | — | ✅ | ✅ `matelot tokens list` | ✅ |  |
| `POST /me/tokens` | — | ✅ | ✅ `matelot token create` | ✅ |  |
| `DELETE /me/tokens/{x}` | ✅ | ✅ | ✅ `matelot token revoke` | ✅ |  |
| `GET /organizations/{x}/api-tokens` | ✅ | ✅ | ✅ `matelot ci-tokens list` | ✅ | organization:read |
| `POST /organizations/{x}/api-tokens` | ✅ | ✅ | ✅ `matelot ci-token create` | ✅ | organization:read |
| `GET /organizations/{x}/runner-pools` | ✅ | ✅ | ✅ `matelot runners list` | ✅ | organization:read |
| `POST /organizations/{x}/runner-pools` | ✅ | ✅ | ✅ `matelot runner-pool create` | ✅ | organization:read |
| `GET /projects/{x}/runner-pools` | — | ✅ | ❌ | ✅ | project:read |

### Vulnerabilities & decisions

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `PATCH /code-findings/{x}` | ✅ | ✅ | ✅ `matelot code-finding set` | ✅ |  |
| `GET /findings/{x}` | ✅ | ✅ | ✅ `matelot finding show` | ✅ |  |
| `PATCH /findings/{x}` | ✅ | ✅ | ✅ `matelot finding set` | ✅ |  |
| `GET /organizations/{x}/code-findings` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /organizations/{x}/code-findings/summary` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /organizations/{x}/components` | — | ✅ | ✅ `matelot components search` | ✅ | sbom:read |
| `GET /organizations/{x}/findings` | — | ✅ | ✅ `matelot findings list-org` | ✅ | vulnerability:read |
| `POST /organizations/{x}/findings/recorrelate` | ✅ | ✅ | ✅ `matelot vulnerabilities recorrelate` | ✅ | vulnerability:write |
| `POST /organizations/{x}/findings/snapshots` | ✅ | ✅ | ✅ `matelot findings snapshot` | ✅ | vulnerability:write |
| `GET /organizations/{x}/findings/summary` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /organizations/{x}/findings/trend` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /organizations/{x}/risk` | — | ✅ | ✅ `matelot risk list` | ✅ | risk:read |
| `POST /organizations/{x}/risk/recompute` | — | ✅ | ✅ `matelot risk recompute` | ✅ | risk:read |
| `GET /projects/{x}/code-findings` | — | ✅ | ✅ `matelot code-findings list` | ✅ | vulnerability:read |
| `GET /projects/{x}/code-findings/summary` | — | ✅ | ✅ `matelot code-findings summary` | ✅ | vulnerability:read |
| `GET /projects/{x}/components` | — | ✅ | ✅ `matelot components search-project` | ✅ | sbom:read |
| `GET /projects/{x}/findings` | — | ✅ | ✅ `matelot findings list` | ✅ | vulnerability:read |
| `GET /projects/{x}/findings/summary` | — | ✅ | ✅ `matelot findings summary` | ✅ | vulnerability:read |
| `GET /projects/{x}/findings/trend` | — | ✅ | ✅ `matelot findings trend` | ✅ | vulnerability:read |
| `GET /projects/{x}/risk` | — | ✅ | ✅ `matelot risk project` | ✅ | risk:read |
| `POST /projects/{x}/risk/recompute` | — | ✅ | ✅ `matelot risk recompute-project` | ✅ | risk:read |
| `GET /teams/{x}/code-findings` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /teams/{x}/code-findings/summary` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /teams/{x}/components` | — | ✅ | ❌ | ✅ | sbom:read |
| `GET /teams/{x}/findings` | — | ✅ | ✅ `matelot findings list-team` | ✅ | vulnerability:read |
| `GET /teams/{x}/findings/summary` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /teams/{x}/findings/trend` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /teams/{x}/risk` | — | ✅ | ✅ `matelot risk team` | ✅ | service:read |
| `GET /workspaces/{x}/code-findings` | — | ✅ | ✅ `matelot code-findings list-workspace` | ✅ | vulnerability:read |
| `GET /workspaces/{x}/code-findings/summary` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /workspaces/{x}/components` | — | ✅ | ✅ `matelot components search-workspace` | ✅ | sbom:read |
| `GET /workspaces/{x}/findings` | — | ✅ | ✅ `matelot findings list-workspace` | ✅ | vulnerability:read |
| `GET /workspaces/{x}/findings/summary` | — | ✅ | ✅ `matelot findings summary-workspace` | ✅ | vulnerability:read |
| `GET /workspaces/{x}/findings/trend` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /workspaces/{x}/risk` | — | ✅ | ✅ `matelot risk workspace` | ✅ | service:read |

### Services & environments

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `DELETE /environments/{x}` | ✅ | ✅ | ✅ `matelot env delete` | ✅ | environment:write |
| `GET /environments/{x}` | — | ✅ | ✅ `matelot env show` | ✅ | environment:read |
| `PATCH /environments/{x}` | — | ✅ | ✅ `matelot env update` | ✅ | environment:write |
| `POST /environments/{x}/deployments` | ✅ | ✅ | ✅ `matelot deploy` | ✅ | deployment:write |
| `GET /environments/{x}/gate` | ✅ | ✅ | ✅ `matelot env gate` | ✅ | policy:read |
| `POST /environments/{x}/gate` | ✅ | ✅ | ✅ `matelot gate` | ✅ | gate:evaluate |
| `POST /environments/{x}/kubernetes-sync` | ✅ | ✅ | ✅ `matelot env kubernetes-sync` | ✅ | deployment:write |
| `GET /environments/{x}/lineage` | ✅ | ✅ | ✅ `matelot env lineage` | ✅ | service:read |
| `POST /environments/{x}/promote` | ✅ | ✅ | ✅ `matelot promote` | ✅ | deployment:write |
| `PATCH /environments/{x}/settings` | ✅ | ✅ | ✅ `matelot env settings` | ✅ | environment:write |
| `GET /organizations/{x}/findings/environments` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /projects/{x}/findings/environments` | — | ✅ | ✅ `matelot findings environments` | ✅ | vulnerability:read |
| `GET /projects/{x}/services` | ✅ | ✅ | ✅ `matelot services list` | ✅ | project:read |
| `POST /projects/{x}/services` | ✅ | ✅ | ✅ `matelot service create` | ✅ | service:write |
| `DELETE /services/{x}` | ✅ | ✅ | ✅ `matelot service archive` | ✅ | service:write |
| `GET /services/{x}` | — | ✅ | ✅ `matelot service show` | ✅ | service:read |
| `PATCH /services/{x}` | ✅ | ✅ | ✅ `matelot service update` | ✅ | service:write |
| `GET /services/{x}/correlation/jobs/{x}` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /services/{x}/deployments` | ✅ | ✅ | ✅ `matelot deployments list` | ✅ | service:read |
| `GET /services/{x}/environments` | ✅ | ✅ | ✅ `matelot envs list` | ✅ | service:read |
| `POST /services/{x}/environments` | ✅ | ✅ | ✅ `matelot env create` | ✅ | environment:write |
| `POST /services/{x}/exceptions` | — | ✅ | ✅ `matelot exception create` | ✅ | policy:write |
| `GET /services/{x}/findings` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `POST /services/{x}/findings/recorrelate` | — | ✅ | ✅ `matelot vulnerabilities recorrelate --service` | ✅ | vulnerability:write |
| `GET /services/{x}/gate-evaluations` | — | ✅ | ✅ `matelot gate evaluations` | ✅ | policy:read |
| `GET /services/{x}/inventory` | ✅ | ✅ | ✅ `matelot inventory show` | ✅ | service:read |
| `POST /services/{x}/jobs` | ✅ | ✅ | ✅ `matelot job create` | ✅ | job:create |
| `POST /services/{x}/pipelines` | ✅ | ✅ | ✅ `matelot pipeline` | ✅ | job:create |
| `GET /services/{x}/releases` | ✅ | ✅ | ✅ `matelot releases list` | ✅ | service:read |
| `POST /services/{x}/releases` | ✅ | ✅ | ✅ `matelot release create` | ✅ | release:write |
| `POST /services/{x}/releases/sync` | ✅ | ✅ | ✅ `matelot releases sync` | ✅ | release:write |
| `GET /services/{x}/remediation/queue` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `POST /services/{x}/remediations` | ✅ | ✅ | ✅ `matelot remediation create` | ✅ | vulnerability:write |
| `GET /services/{x}/repositories` | ✅ | ✅ | ❌ | ✅ | service:read |
| `POST /services/{x}/repositories` | ✅ | ✅ | ✅ `matelot repository attach` | ✅ | service:write |
| `DELETE /services/{x}/repositories/{x}` | ✅ | ✅ | ✅ `matelot repository detach` | ✅ | service:write |
| `GET /services/{x}/risk` | ✅ | ✅ | ❌ | ✅ | risk:read |
| `GET /services/{x}/sboms` | ✅ | ✅ | ✅ `matelot sboms list` | ✅ | sbom:read |
| `POST /services/{x}/sboms` | — | ✅ | ✅ `matelot sbom` | ✅ | sbom:write |
| `GET /teams/{x}/findings/environments` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /workspaces/{x}/findings/environments` | — | ✅ | ✅ `matelot findings environments-workspace` | ✅ | vulnerability:read |

### Connections & registries

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /environments/{x}/registry` | ✅ | ✅ | ✅ `matelot env registry` | ✅ | environment:read |
| `GET /integrations/providers` | — | ✅ | ✅ `matelot integrations providers` | ✅ |  |
| `DELETE /integrations/{x}` | ✅ | ✅ | ✅ `matelot connection delete` | ✅ |  |
| `GET /integrations/{x}/ecr/repositories` | ✅ | ✅ | ❌ | ✅ |  |
| `POST /integrations/{x}/ecr/repositories` | ✅ | ✅ | ✅ `matelot connection create-ecr-repository` | ✅ |  |
| `GET /integrations/{x}/install-url` | ✅ | ✅ | ❌ | ✅ |  |
| `POST /integrations/{x}/link-installation` | ✅ | ✅ | ✅ `matelot connection link-installation` | ✅ |  |
| `GET /integrations/{x}/matelot-repositories` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /integrations/{x}/repositories` | — | ✅ | ❌ | ✅ |  |
| `POST /integrations/{x}/sync` | ✅ | ✅ | ✅ `matelot connection sync` | ✅ |  |
| `POST /integrations/{x}/verify` | ✅ | ✅ | ✅ `matelot connection verify` | ✅ |  |
| `GET /organizations/{x}/integrations` | ✅ | ✅ | ✅ `matelot integrations list` | ✅ | organization:read |
| `POST /organizations/{x}/integrations` | ✅ | ✅ | ✅ `matelot connection create` | ✅ | organization:read |
| `GET /organizations/{x}/integrations/github/install-url` | — | ✅ | ❌ | ✅ | organization:read |
| `POST /organizations/{x}/integrations/test` | ✅ | ✅ | ✅ `matelot connection test` | ✅ | organization:read |
| `POST /organizations/{x}/registry/reconcile` | — | ✅ | ✅ `matelot registry reconcile` | ✅ | integration:write |
| `GET /projects/{x}/integrations` | ✅ | ✅ | ❌ | ✅ | project:read |
| `GET /registry/info` | — | ✅ | ✅ `matelot registry info` | ✅ |  |
| `GET /registry/token` | — | ✅ | ❌ | ✅ |  |
| `GET /services/{x}/images` | ✅ | ✅ | ✅ `matelot images list` | ✅ | service:read |
| `POST /services/{x}/images` | ✅ | ✅ | ✅ `matelot image add` | ✅ | service:write |
| `DELETE /services/{x}/images/{x}` | ✅ | ✅ | ✅ `matelot image delete` | ✅ | service:write |
| `POST /services/{x}/images/{x}/sync` | ✅ | ✅ | ✅ `matelot image sync` | ✅ | service:write |
| `GET /services/{x}/registries` | — | ✅ | ✅ `matelot registries list` | ✅ | service:read |
| `POST /services/{x}/registries/{x}/credentials` | — | ✅ | ✅ `matelot registry login` | ✅ | registry:pull |
| `POST /services/{x}/registries/{x}/repositories` | — | ✅ | ✅ `matelot registry path --create` | ✅ | registry:push |
| `GET /services/{x}/registry` | ✅ | ✅ | ❌ | ✅ | service:read |

### CRA / evidence / VEX

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `POST /evidence/verify` | — | ✅ | ✅ `matelot evidence verify` | ✅ |  |
| `GET /projects/{x}/cra/readiness` | — | ✅ | ✅ `matelot cra readiness-project` | ✅ | service:read |
| `GET /releases/{x}/evidence` | — | ✅ | ✅ `matelot evidence summary` | ✅ |  |
| `GET /releases/{x}/evidence.zip` | ✅ | ✅ | ❌ | ✅ |  |
| `GET /releases/{x}/vex` | — | ✅ | ✅ `matelot evidence vex` | ✅ |  |
| `GET /services/{x}/cra/readiness` | — | ✅ | ✅ `matelot cra readiness` | ✅ | service:read |
| `GET /teams/{x}/cra/readiness` | — | ✅ | ❌ | ✅ | service:read |
| `GET /workspaces/{x}/cra/readiness` | — | ✅ | ✅ `matelot cra readiness-workspace` | ✅ | service:read |

### Exceptions

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `DELETE /exceptions/{x}` | ✅ | ✅ | ✅ `matelot exception revoke` | ✅ |  |
| `POST /exceptions/{x}/approve` | — | ✅ | ✅ `matelot exception approve` | ✅ |  |
| `GET /organizations/{x}/exceptions` | — | ✅ | ✅ `matelot exceptions list` | ✅ | policy:read |
| `POST /organizations/{x}/exceptions` | — | ✅ | ✅ `matelot exception create-org` | ✅ | policy:write |
| `POST /projects/{x}/exceptions` | — | ✅ | ✅ `matelot exception create-project` | ✅ | policy:write |

### Other

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /health/live` | — | ✅ | ❌ | ✅ |  |
| `GET /health/ready` | — | ✅ | ❌ | ✅ |  |
| `GET /meta` | — | ✅ | ✅ `matelot meta show` | ✅ |  |
| `GET /organizations/{x}/audit-events` | ✅ | ✅ | ✅ `matelot audit list` | ✅ | audit:read |
| `GET /organizations/{x}/overview` | ✅ | ✅ | ✅ `matelot org overview` | ✅ | organization:read |
| `GET /organizations/{x}/projects` | ✅ | ✅ | ✅ `matelot projects list` | ✅ | organization:read |
| `GET /organizations/{x}/repositories` | ✅ | ✅ | ✅ `matelot repositories list` | ✅ | organization:read |
| `GET /organizations/{x}/services` | — | ✅ | ✅ `matelot services list-org` | ✅ | organization:read |
| `GET /organizations/{x}/teams` | ✅ | ✅ | ✅ `matelot teams list` | ✅ | organization:read |
| `GET /organizations/{x}/workspaces` | ✅ | ✅ | ✅ `matelot workspaces list` | ✅ | organization:read |
| `POST /organizations/{x}/workspaces` | ✅ | ✅ | ✅ `matelot workspace create` | ✅ | workspace:write |
| `GET /pipeline-templates` | — | ✅ | ✅ `matelot pipeline templates` | ✅ |  |
| `GET /projects/{x}/graph` | ✅ | ✅ | ✅ `matelot graph show` | ✅ | risk:read |
| `GET /projects/{x}/inventory` | ✅ | ✅ | ❌ | ✅ | project:read |
| `GET /projects/{x}/overview` | ✅ | ✅ | ✅ `matelot project overview` | ✅ | project:read |
| `GET /projects/{x}/repositories` | ✅ | ✅ | ❌ | ✅ | project:read |
| `GET /teams/{x}/projects` | — | ✅ | ❌ | ✅ | team:read |
| `POST /teams/{x}/projects` | ✅ | ✅ | ✅ `matelot project create` | ✅ | project:write |
| `GET /workspaces/{x}/teams` | — | ✅ | ❌ | ✅ | workspace:read |
| `POST /workspaces/{x}/teams` | ✅ | ✅ | ✅ `matelot team create` | ✅ | team:write |

### Images & SBOMs

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /jobs/{x}` | ✅ | ✅ | ✅ `matelot job show` | ✅ |  |
| `POST /jobs/{x}/cancel` | ✅ | ✅ | ✅ `matelot job cancel` | ✅ |  |
| `GET /jobs/{x}/logs` | ✅ | ✅ | ✅ `matelot job logs` | ✅ |  |
| `POST /jobs/{x}/retry` | ✅ | ✅ | ✅ `matelot job retry` | ✅ |  |
| `GET /organizations/{x}/correlation/jobs/{x}` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /organizations/{x}/jobs/active` | ✅ | ✅ | ✅ `matelot jobs active` | ✅ | job:read |
| `GET /pipelines/{x}` | ✅ | ✅ | ✅ `matelot pipeline show` | ✅ |  |
| `POST /pipelines/{x}/cancel` | ✅ | ✅ | ✅ `matelot pipeline cancel` | ✅ |  |
| `GET /projects/{x}/jobs` | ✅ | ✅ | ✅ `matelot jobs list` | ✅ | job:read |
| `GET /projects/{x}/pipelines` | ✅ | ✅ | ✅ `matelot pipelines list` | ✅ | job:read |
| `GET /projects/{x}/sbom-summary` | — | ✅ | ❌ | ✅ | project:read |
| `GET /sboms/{x}` | — | ✅ | ✅ `matelot sbom show` | ✅ |  |
| `GET /sboms/{x}/diff/{x}` | ✅ | ✅ | ✅ `matelot sbom diff` | ✅ |  |
| `GET /sboms/{x}/download` | — | ✅ | ❌ | ✅ |  |
| `GET /sboms/{x}/findings` | ✅ | ✅ | ✅ `matelot sbom findings` | ✅ |  |

### Notifications

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /notification-capabilities` | — | ✅ | ❌ | ✅ |  |
| `DELETE /notification-channels/{x}` | ✅ | ✅ | ✅ `matelot channel delete` | ✅ |  |
| `PATCH /notification-channels/{x}` | ✅ | ✅ | ✅ `matelot channel update` | ✅ |  |
| `POST /notification-channels/{x}/test` | ✅ | ✅ | ✅ `matelot channel test` | ✅ |  |
| `GET /notification-events` | — | ✅ | ✅ `matelot channels events` | ✅ |  |
| `GET /organizations/{x}/notification-channels` | — | ✅ | ✅ `matelot channels list-scope` | ✅ | project:read |
| `POST /organizations/{x}/notification-channels` | — | ✅ | ✅ `matelot channel create` | ✅ | project:write |
| `GET /projects/{x}/notification-channels` | — | ✅ | ✅ `matelot channels list-scope` | ✅ | project:read |
| `POST /projects/{x}/notification-channels` | — | ✅ | ✅ `matelot channel create-scope` | ✅ | project:write |
| `GET /teams/{x}/notification-channels` | — | ✅ | ✅ `matelot channels list-scope` | ✅ | project:read |
| `POST /teams/{x}/notification-channels` | — | ✅ | ✅ `matelot channel create-scope` | ✅ | project:write |
| `GET /workspaces/{x}/notification-channels` | — | ✅ | ✅ `matelot channels list-scope` | ✅ | project:read |
| `POST /workspaces/{x}/notification-channels` | — | ✅ | ✅ `matelot channel create-scope` | ✅ | project:write |

### Org / workspace / team / project settings

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /organizations` | — | ✅ | ✅ `matelot orgs list` | ✅ |  |
| `POST /organizations` | — | ✅ | ✅ `matelot organization create` | ✅ |  |
| `GET /organizations/{x}` | — | ✅ | ❌ | ✅ | organization:read |
| `PATCH /organizations/{x}` | — | ✅ | ✅ `matelot organization update` | ✅ | organization:write |
| `POST /organizations/{x}/config/apply` | — | ✅ | ✅ `matelot apply --scope` | ✅ | policy:write |
| `DELETE /projects/{x}` | ✅ | ✅ | ✅ `matelot project delete` | ✅ | project:write |
| `GET /projects/{x}` | — | ✅ | ✅ `matelot project show` | ✅ | project:read |
| `PATCH /projects/{x}` | ✅ | ✅ | ✅ `matelot project update` | ✅ | project:write |
| `POST /projects/{x}/config/apply` | — | ✅ | ✅ `matelot apply --scope` | ✅ | policy:write |
| `DELETE /teams/{x}` | — | ✅ | ✅ `matelot team delete` | ✅ | team:write |
| `GET /teams/{x}` | — | ✅ | ❌ | ✅ | team:read |
| `PATCH /teams/{x}` | — | ✅ | ✅ `matelot team update` | ✅ | team:write |
| `POST /teams/{x}/config/apply` | — | ✅ | ✅ `matelot apply --scope` | ✅ | policy:write |
| `DELETE /workspaces/{x}` | ✅ | ✅ | ✅ `matelot workspace delete` | ✅ | workspace:write |
| `GET /workspaces/{x}` | — | ✅ | ❌ | ✅ | workspace:read |
| `PATCH /workspaces/{x}` | ✅ | ✅ | ✅ `matelot workspace update` | ✅ | workspace:write |
| `POST /workspaces/{x}/config/apply` | — | ✅ | ✅ `matelot apply --scope` | ✅ | policy:write |

### Deployments & releases

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /organizations/{x}/deployments` | — | ✅ | ✅ `matelot deployments list-org` | ✅ | deployment:read |

### Policies & gates

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /organizations/{x}/policies` | ✅ | ✅ | ✅ `matelot policies list` | ✅ | policy:read |
| `POST /organizations/{x}/policies` | — | ✅ | ✅ `matelot policy create` | ✅ | policy:write |
| `POST /organizations/{x}/policies/from-template` | — | ✅ | ✅ `matelot policy from-template` | ✅ | policy:write |
| `DELETE /policies/{x}` | ✅ | ✅ | ✅ `matelot policy delete` | ✅ |  |
| `PATCH /policies/{x}` | ✅ | ✅ | ✅ `matelot policy update` | ✅ |  |
| `GET /policy-templates` | — | ✅ | ✅ `matelot policy templates` | ✅ |  |
| `GET /projects/{x}/policies` | — | ✅ | ✅ `matelot policies in-force` | ✅ | policy:read |
| `POST /projects/{x}/policies` | — | ✅ | ✅ `matelot policy create-project` | ✅ | policy:write |
| `POST /projects/{x}/policies/from-template` | — | ✅ | ✅ `matelot policy from-template-project` | ✅ | policy:write |
| `GET /teams/{x}/policies` | — | ✅ | ❌ | ✅ | policy:read |
| `POST /teams/{x}/policies` | — | ✅ | ✅ `matelot policy create-team` | ✅ | policy:write |
| `POST /teams/{x}/policies/from-template` | — | ✅ | ✅ `matelot policy from-template-team` | ✅ | policy:write |
| `GET /workspaces/{x}/policies` | — | ✅ | ❌ | ✅ | policy:read |
| `POST /workspaces/{x}/policies` | — | ✅ | ✅ `matelot policy create-workspace` | ✅ | policy:write |
| `POST /workspaces/{x}/policies/from-template` | — | ✅ | ✅ `matelot policy from-template-workspace` | ✅ | policy:write |

### Remediation & issues

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /organizations/{x}/remediation/queue` | — | ✅ | ✅ `matelot remediation queue-org` | ✅ | vulnerability:read |
| `GET /organizations/{x}/remediations` | — | ✅ | ✅ `matelot remediations list-org` | ✅ | vulnerability:read |
| `GET /projects/{x}/remediation/queue` | — | ✅ | ✅ `matelot remediation queue` | ✅ | vulnerability:read |
| `GET /projects/{x}/remediations` | — | ✅ | ✅ `matelot remediations list` | ✅ | vulnerability:read |
| `GET /remediations/{x}` | — | ✅ | ✅ `matelot remediation show` | ✅ |  |
| `PATCH /remediations/{x}` | ✅ | ✅ | ✅ `matelot remediation update` | ✅ |  |
| `POST /remediations/{x}/issue` | ✅ | ✅ | ✅ `matelot remediation issue` | ✅ |  |
| `GET /teams/{x}/remediation/queue` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /teams/{x}/remediations` | — | ✅ | ❌ | ✅ | vulnerability:read |
| `GET /workspaces/{x}/remediation/queue` | — | ✅ | ✅ `matelot remediation queue-workspace` | ✅ | vulnerability:read |
| `GET /workspaces/{x}/remediations` | — | ✅ | ❌ | ✅ | vulnerability:read |

### SLAs

| Action (route) | UI | API | CLI | MCP | permission |
|---|---|---|---|---|---|
| `GET /organizations/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla show` | ✅ | vulnerability:read |
| `PATCH /organizations/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla set` | ✅ | policy:write |
| `GET /projects/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla show-scope` | ✅ | vulnerability:read |
| `PATCH /projects/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla set-scope` | ✅ | policy:write |
| `GET /projects/{x}/remediation/settings/effective` | ✅ | ✅ | ✅ `matelot sla effective` | ✅ | vulnerability:read |
| `GET /teams/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla show-scope` | ✅ | vulnerability:read |
| `PATCH /teams/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla set-scope` | ✅ | policy:write |
| `GET /workspaces/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla show-scope` | ✅ | vulnerability:read |
| `PATCH /workspaces/{x}/remediation/settings` | ✅ | ✅ | ✅ `matelot sla set-scope` | ✅ | policy:write |

## Intentionally not in the CLI

| Route | Why |
|---|---|
| `POST /runner/*`, `POST /webhooks/github/*`, `POST /registry/events` | machine protocols (runner, GitHub, registry) |
| `POST /mcp`, `DELETE /mcp` | MCP transport |
| `GET /auth/*`, `/oauth/*`, GitHub App callback | browser login / OAuth round trips |

## Reverse gaps (API/CLI without a UI button)

`recorrelate`, `evidence verify`, `findings snapshot`, `risk recompute`, `apply` (configuration as code), `evidence export` (zip download exists in the UI as a link), `mcp`. These are automation entry points; the UI has no need for them.
