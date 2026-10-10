# matelot command reference

Generated from `apps/cli/src/resources.ts` (`CUSTOM_COMMANDS` + `RESOURCES`). Every command accepts `--json`; resource commands accept `--body '{...}'` to pass a raw JSON body (merged last) and the path flags `--org --workspace --team --project --service --env --id --scope`. Exit codes: 0 ok · 1 error · 2 policy violation · 3 not evaluated (SBOM pending/failed) · 4 authentication.

## Commands implemented by hand

| Command | Route |
|---|---|
| `matelot deploy` | `POST /api/v1/environments/:env/deployments` |
| `matelot gate` | `POST /api/v1/environments/:env/gate` |
| `matelot promote` | `POST /api/v1/environments/:env/promote` |
| `matelot pipeline` | `POST /api/v1/services/:service/pipelines` |
| `matelot sbom` | `POST /api/v1/services/:service/sboms` |
| `matelot release create` | `POST /api/v1/services/:service/releases` |
| `matelot registry login` | `POST /api/v1/services/:service/registries/:id/credentials` |
| `matelot registry path --create` | `POST /api/v1/services/:service/registries/:id/repositories` |
| `matelot apply --scope` | `POST /api/v1/:scope/config/apply` |
| `matelot vulnerabilities recorrelate` | `POST /api/v1/organizations/:org/findings/recorrelate` |
| `matelot vulnerabilities recorrelate --service` | `POST /api/v1/services/:service/findings/recorrelate` |
| `matelot evidence verify` | `POST /api/v1/evidence/verify` |

## Resource commands

### `matelot admin …`

| Verb | Route | Does |
|---|---|---|
| `update-user` | `PATCH /admin/users/:id` | Platform admin: change a user's role / enable (--platform-role admin|user --enabled true --reason ...) |

### `matelot audit …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/audit-events` | Audit trail (--limit) |

### `matelot channel …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /organizations/:org/notification-channels` | Add a channel (--name ops --kind slack|webhook --url https://… [--events gate.fail,sla.overdue] [--project ID]) |
| `update` | `PATCH /notification-channels/:id` | Update (--name --url --events --enabled true|false) |
| `test` | `POST /notification-channels/:id/test` | Send a test message |
| `delete` | `DELETE /notification-channels/:id` | Remove a channel |
| `create-scope` | `POST /:scope/notification-channels` | Add a channel at a scope (--scope projects/ID --name --kind --url [--events]) |

### `matelot channels …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/notification-channels` | Notification channels (Slack / webhook) |
| `events` | `GET /notification-events` | Events a channel can subscribe to |
| `list-scope` | `GET /:scope/notification-channels` | Channels in force at a scope (--scope workspaces/ID | teams/ID | projects/ID) |

### `matelot ci-token …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /organizations/:org/api-tokens` | Create a CI token (--name --scope-type PROJECT --scope-id ID --preset full|pipeline|deploy|registry --environments id,id) |
| `revoke` | `DELETE /api-tokens/:id` | Revoke a CI token |

### `matelot ci-tokens …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/api-tokens` | CI tokens |

### `matelot code-finding …`

| Verb | Route | Does |
|---|---|---|
| `set` | `PATCH /code-findings/:id` | Decision on a code finding (--status --note) |

### `matelot code-findings …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /projects/:project/code-findings` | Secrets / IaC / SAST findings (--kind --severity --status) |
| `summary` | `GET /projects/:project/code-findings/summary` | Code findings counts |
| `list-workspace` | `GET /workspaces/:id/code-findings` | Code findings of a workspace (--id, [--team]) |

### `matelot components …`

| Verb | Route | Does |
|---|---|---|
| `search` | `GET /organizations/:org/components` | Where a component is used (--q) |
| `search-workspace` | `GET /workspaces/:id/components` | Component search in a workspace (--id --q [--team]) |
| `search-project` | `GET /projects/:project/components` | Component search in a project (--q) |

### `matelot connection …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /organizations/:org/integrations` | Create a connection (--body with the JSON the web app sends: provider, scopeType, scopeId, name, baseUrl, auth) |
| `test` | `POST /organizations/:org/integrations/test` | Test connection settings without saving (--body JSON) |
| `verify` | `POST /integrations/:id/verify` | Verify a connection (deploy key / credentials) |
| `link-installation` | `POST /integrations/:id/link-installation` | GitHub App: bind an existing installation / re-read permissions |
| `create-ecr-repository` | `POST /integrations/:id/ecr/repositories` | Create an ECR repository through the connection |
| `sync` | `POST /integrations/:id/sync` | Read the source now (repositories / tags) |
| `delete` | `DELETE /integrations/:id` | Delete a connection |

### `matelot cra …`

| Verb | Route | Does |
|---|---|---|
| `readiness` | `GET /services/:service/cra/readiness` | CRA readiness checks of a service (SBOM shipped, no KEV in prod, policy, SLAs, gate evidence, secrets, IaC, traceability, monitoring) |
| `readiness-project` | `GET /projects/:project/cra/readiness` | CRA readiness of every service in a project |
| `readiness-workspace` | `GET /workspaces/:id/cra/readiness` | CRA readiness of every service in a workspace (--id, [--team]) |

### `matelot deployments …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /services/:service/deployments` | Current deployment per environment + history |
| `list-org` | `GET /organizations/:org/deployments` | Current production deployments of the organization |

### `matelot env …`

| Verb | Route | Does |
|---|---|---|
| `settings` | `PATCH /environments/:env/settings` | Environment settings (--protected true, --kubernetes-namespace ...) |
| `kubernetes-sync` | `POST /environments/:env/kubernetes-sync` | Read what the cluster runs now |
| `create` | `POST /services/:service/environments` | Create an environment (--kind development|testing|staging|production) |
| `update` | `PATCH /environments/:env` | Update an environment |
| `delete` | `DELETE /environments/:env` | Archive an environment |
| `show` | `GET /environments/:env` | Environment details |
| `registry` | `GET /environments/:env/registry` | Environment repository in the built-in registry |
| `lineage` | `GET /environments/:env/lineage` | Released vs running lanes, drift, history |
| `gate` | `GET /environments/:env/gate` | Latest gate evaluation of the environment |

### `matelot envs …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /services/:service/environments` | Environments of a service |

### `matelot evidence …`

| Verb | Route | Does |
|---|---|---|
| `summary` | `GET /releases/:id/evidence` | Evidence summary of a release (JSON): images, SBOMs, findings + decisions, gate, deployments, policies, risk |
| `vex` | `GET /releases/:id/vex` | OpenVEX document of a release (decisions per vulnerability and shipped image) |

### `matelot exception …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /services/:service/exceptions` | Time-boxed acceptance in a service (--kind vulnerability|code --match CVE-… --component X --status accepted --reason … --until 2026-12-31 --ticket URL) |
| `create-project` | `POST /projects/:project/exceptions` | Same, at a project |
| `create-org` | `POST /organizations/:org/exceptions` | Same, organization-wide |
| `approve` | `POST /exceptions/:id/approve` | Approve a pending exception |
| `revoke` | `DELETE /exceptions/:id` | Revoke (findings reopen immediately) |

### `matelot exceptions …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/exceptions` | Exceptions (--active true|false) |

### `matelot finding …`

| Verb | Route | Does |
|---|---|---|
| `show` | `GET /findings/:id` | One finding with where it runs |
| `set` | `PATCH /findings/:id` | Decision: --status open|accepted|false_positive|not_affected --note |

### `matelot findings …`

| Verb | Route | Does |
|---|---|---|
| `snapshot` | `POST /organizations/:org/findings/snapshots` | Take today's findings snapshot now (trend charts) |
| `list` | `GET /projects/:project/findings` | Dependency findings (--severity --status --kev --q) |
| `list-org` | `GET /organizations/:org/findings` | Findings across the organization |
| `summary` | `GET /projects/:project/findings/summary` | Open / KEV / production counts |
| `environments` | `GET /projects/:project/findings/environments` | What runs in each environment, with counts |
| `trend` | `GET /projects/:project/findings/trend` | Daily trend per environment (--days) |
| `list-workspace` | `GET /workspaces/:id/findings` | Findings of a workspace (--id WORKSPACE [--team ID] --severity --status --kev --q) |
| `list-team` | `GET /teams/:id/findings` | Findings of a team (--id TEAM) |
| `summary-workspace` | `GET /workspaces/:id/findings/summary` | Counts for a workspace (--id, [--team]) |
| `environments-workspace` | `GET /workspaces/:id/findings/environments` | What runs where, in a workspace |

### `matelot gate …`

| Verb | Route | Does |
|---|---|---|
| `evaluations` | `GET /services/:service/gate-evaluations` | Gate evaluations of a service |

### `matelot graph …`

| Verb | Route | Does |
|---|---|---|
| `show` | `GET /projects/:project/graph` | Product map (nodes + edges) |

### `matelot image …`

| Verb | Route | Does |
|---|---|---|
| `delete` | `DELETE /services/:service/images/:id` | Stop tracking an image |
| `add` | `POST /services/:service/images` | Register an image (name, optional integrationId) |
| `sync` | `POST /services/:service/images/:id/sync` | Read the registry now (tags, digests): --service ID --id IMAGE |

### `matelot images …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /services/:service/images` | Container images (registries) of a service |

### `matelot integrations …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/integrations` | Connections (git, registries, k8s) |
| `providers` | `GET /integrations/providers` | Available providers |

### `matelot inventory …`

| Verb | Route | Does |
|---|---|---|
| `show` | `GET /services/:service/inventory` | Releases, images and environments joined |

### `matelot job …`

| Verb | Route | Does |
|---|---|---|
| `retry` | `POST /jobs/:id/retry` | Retry a job |
| `cancel` | `POST /jobs/:id/cancel` | Cancel a job |
| `show` | `GET /jobs/:id` | Job details |
| `logs` | `GET /jobs/:id/logs` | Job log lines |
| `create` | `POST /services/:service/jobs` | Queue a job (--type sbom|secrets|iac|repository_check … --ref) |

### `matelot jobs …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /projects/:project/jobs` | Jobs of a project |
| `active` | `GET /organizations/:org/jobs/active` | Queued / running jobs |

### `matelot me …`

| Verb | Route | Does |
|---|---|---|
| `show` | `GET /me` | Who am I (user + memberships) |

### `matelot membership …`

| Verb | Route | Does |
|---|---|---|
| `revoke` | `DELETE /memberships/:id` | Revoke a membership |
| `grant` | `POST /memberships` | Grant a role (--email --role DEVELOPER --scope-type PROJECT --scope-id ID) |

### `matelot memberships …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /memberships` | Memberships of a scope (--scope-type PROJECT --scope-id ID) |

### `matelot meta …`

| Verb | Route | Does |
|---|---|---|
| `show` | `GET /meta` | Platform metadata (version, roles) |

### `matelot org …`

| Verb | Route | Does |
|---|---|---|
| `overview` | `GET /organizations/:org/overview` | Organization overview (counts, production, risk) |

### `matelot organization …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /organizations` | Create an organization (platform admin) |
| `update` | `PATCH /organizations/:org` | Rename an organization |

### `matelot orgs …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations` | Organizations I belong to |

### `matelot pipeline …`

| Verb | Route | Does |
|---|---|---|
| `cancel` | `POST /pipelines/:id/cancel` | Cancel a pipeline |
| `show` | `GET /pipelines/:id` | Pipeline with its jobs |
| `templates` | `GET /pipeline-templates` | Pipeline templates |

### `matelot pipelines …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /projects/:project/pipelines` | Pipelines of a project |

### `matelot policies …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/policies` | Policies of the organization |
| `in-force` | `GET /projects/:project/policies` | Policies in force on a project (own + inherited) |

### `matelot policy …`

| Verb | Route | Does |
|---|---|---|
| `from-template-workspace` | `POST /workspaces/:workspace/policies/from-template` | Policy from a template at a workspace |
| `from-template-team` | `POST /teams/:team/policies/from-template` | Policy from a template at a team |
| `create-workspace` | `POST /workspaces/:workspace/policies` | Create a policy at a workspace |
| `create-team` | `POST /teams/:team/policies` | Create a policy at a team |
| `create` | `POST /organizations/:org/policies` | Create at the organization (--name --environments prod,staging --max-severity high --block-kev --block-secrets --require-sbom --max-iac high --action block|warn --enforce) |
| `create-project` | `POST /projects/:project/policies` | Create at a project (same flags) |
| `update` | `PATCH /policies/:id` | Update (--enabled true|false, --action, --enforce, rule flags) |
| `delete` | `DELETE /policies/:id` | Delete a policy |
| `templates` | `GET /policy-templates` | Ready-made policies (cra-baseline, production-baseline, staging-gate, dev-advisory, no-secrets-anywhere) |
| `from-template` | `POST /organizations/:org/policies/from-template` | Create a policy from a template at the organization (--template cra-baseline [--name]) |
| `from-template-project` | `POST /projects/:project/policies/from-template` | Create from a template at a project |

### `matelot project …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /teams/:team/projects` | Create a project (--team ID --slug --name [--criticality]) |
| `update` | `PATCH /projects/:project` | Update a project |
| `delete` | `DELETE /projects/:project` | Archive a project |
| `show` | `GET /projects/:project` | Project details |
| `overview` | `GET /projects/:project/overview` | Project overview |

### `matelot projects …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/projects` | Projects |

### `matelot registries …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /services/:service/registries` | Registry connections usable by a service |

### `matelot registry …`

| Verb | Route | Does |
|---|---|---|
| `info` | `GET /registry/info` | Built-in registry info |
| `reconcile` | `POST /organizations/:org/registry/reconcile` | Read the built-in registry now |

### `matelot release …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /services/:service/releases` | Record a release |

### `matelot releases …`

| Verb | Route | Does |
|---|---|---|
| `sync` | `POST /services/:service/releases/sync` | Read releases / tags from the source now |
| `list` | `GET /services/:service/releases` | Releases of a service |

### `matelot remediation …`

| Verb | Route | Does |
|---|---|---|
| `queue` | `GET /projects/:project/remediation/queue` | Fix-first queue of a project: open findings grouped by advisory × service, ranked by exposure, severity, KEV, SLA |
| `queue-org` | `GET /organizations/:org/remediation/queue` | Fix-first queue of the organization |
| `create` | `POST /services/:service/remediations` | Track an advisory/rule in a service as work (--kind vulnerability|code --match CVE-… [--component X] [--owner-email a@b] [--due 2026-12-31] [--notes …]) |
| `show` | `GET /remediations/:id` | One remediation |
| `update` | `PATCH /remediations/:id` | Update (--status open|in_progress|done|wont_fix --owner-email … --due … --notes …) |
| `issue` | `POST /remediations/:id/issue` | Open an issue: github | gitlab | bitbucket (service repository) or jira (--provider … [--project-key SEC] [--integration ID]); default = scope setting, else the repository host, else Jira |
| `queue-workspace` | `GET /workspaces/:id/remediation/queue` | Fix-first queue of a workspace (--id, [--team]) |

### `matelot remediations …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /projects/:project/remediations` | Tracked remediations of a project (--status open,in_progress) |
| `list-org` | `GET /organizations/:org/remediations` | Tracked remediations of the organization |

### `matelot repositories …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/repositories` | Repositories |

### `matelot repository …`

| Verb | Route | Does |
|---|---|---|
| `attach` | `POST /services/:service/repositories` | Attach a repository to a service (--repository-id ID [--role primary]) |
| `detach` | `DELETE /services/:service/repositories/:id` | Detach a repository from a service |

### `matelot risk …`

| Verb | Route | Does |
|---|---|---|
| `recompute-project` | `POST /projects/:project/risk/recompute` | Recompute the risk scores of a project now |
| `list` | `GET /organizations/:org/risk` | Risk score per service |
| `project` | `GET /projects/:project/risk` | Risk of a project |
| `recompute` | `POST /organizations/:org/risk/recompute` | Recompute risk now |
| `workspace` | `GET /workspaces/:id/risk` | Risk per service in a workspace (--id, [--team]) |
| `team` | `GET /teams/:id/risk` | Risk per service in a team |

### `matelot runner …`

| Verb | Route | Does |
|---|---|---|
| `delete` | `DELETE /runners/:id` | Remove a runner |
| `agent` | `GET /runner-agent` | Latest runner version + image |

### `matelot runner-pool …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /organizations/:org/runner-pools` | Create a runner pool |
| `delete` | `DELETE /runner-pools/:id` | Delete a runner pool |
| `registration-token` | `POST /runner-pools/:id/registration-tokens` | New registration token for a pool |

### `matelot runners …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/runner-pools` | Runner pools and runners |

### `matelot sbom …`

| Verb | Route | Does |
|---|---|---|
| `show` | `GET /sboms/:id` | SBOM with components |
| `findings` | `GET /sboms/:id/findings` | Findings of one SBOM |
| `diff` | `GET /sboms/:from/diff/:to` | Diff two SBOMs (--from, --to) |

### `matelot sboms …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /services/:service/sboms` | SBOMs of a service |

### `matelot service …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /projects/:project/services` | Create a service |
| `update` | `PATCH /services/:service` | Update a service (name, kind, criticality) |
| `archive` | `DELETE /services/:service` | Archive a service (history kept) |
| `show` | `GET /services/:service` | Service details |

### `matelot services …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /projects/:project/services` | Services of a project |
| `list-org` | `GET /organizations/:org/services` | Services of the organization |

### `matelot sla …`

| Verb | Route | Does |
|---|---|---|
| `show` | `GET /organizations/:org/remediation/settings` | SLA days by severity and the default issue tracker |
| `set` | `PATCH /organizations/:org/remediation/settings` | Set SLAs (--critical 7 --high 30 --medium 90 --low 180) and issue defaults (--jira-project-key SEC --issue-integration ID) |
| `show-scope` | `GET /:scope/remediation/settings` | Overrides stored at a scope (--scope workspaces/ID | teams/ID | projects/ID); null = inherited |
| `set-scope` | `PATCH /:scope/remediation/settings` | Override at a scope: --scope projects/ID [--critical 3 …] [--issue-provider github|gitlab|bitbucket|jira] [--jira-project-key PAY] [--issue-board https://github.com/orgs/acme/projects/5] [--issue-integration ID] |
| `effective` | `GET /projects/:project/remediation/settings/effective` | What applies to a project (SLA, issue provider, Jira key) and which scope each value comes from |

### `matelot team …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /workspaces/:workspace/teams` | Create a team (--workspace ID --slug --name) |
| `update` | `PATCH /teams/:id` | Rename / describe a team |
| `delete` | `DELETE /teams/:id` | Archive a team |

### `matelot teams …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/teams` | Teams |

### `matelot token …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /me/tokens` | New personal token (--name --scope read|write|sudo --days N) — web session only |
| `revoke` | `DELETE /me/tokens/:id` | Revoke a personal token |

### `matelot tokens …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /me/tokens` | My personal access tokens |

### `matelot users …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /admin/users` | Users (platform admin) |

### `matelot workspace …`

| Verb | Route | Does |
|---|---|---|
| `create` | `POST /organizations/:org/workspaces` | Create a workspace |
| `update` | `PATCH /workspaces/:workspace` | Rename / describe a workspace |
| `delete` | `DELETE /workspaces/:workspace` | Archive a workspace |

### `matelot workspaces …`

| Verb | Route | Does |
|---|---|---|
| `list` | `GET /organizations/:org/workspaces` | Workspaces |
