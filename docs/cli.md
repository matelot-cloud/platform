# CLI reference — `secops`

Environment: `SECOPS_URL` plus either `SECOPS_TOKEN` (personal access token, acts as you) or `SECOPS_KEY_ID` + `SECOPS_SECRET` (CI token). `--json` prints the raw response; otherwise lists print as tables.
Path flags: `--org`, `--project`, `--service`, `--env`, `--id` (or a positional id), `--from/--to`. `--org` is auto-detected when you belong to one organization (or set `SECOPS_ORG`).

## Delivery commands

| Command | Does |
|---|---|
| `matelot whoami` | identity and permissions of the token |
| `matelot doctor [--url URL]` | health of a cell after an install or upgrade: API ready, version, login, organization, runners online, registry; exit 1 when a check fails (`--json` for scripts). Run from the Compose folder (or `MATELOT_COMPOSE_DIR`), an unreachable API also names the container that is restarting or unhealthy and the `docker compose logs` command |
| `matelot pipeline --service ID [--template security] [--ref SHA] [--wait --timeout S]` | run the security pipeline; non-zero exit when it fails |
| `matelot deploy --env ID [--version V] [--image REF@DIGEST] [--commit SHA]` | record a deployment; a new version becomes a release; rejected by policies with *reject deployments* |
| `matelot promote --env ID --tag TAG` | copy a build image into the environment repository (= deploy); recorded immediately |
| `matelot gate --env ID --image REF \| --version V \| --ref SHA` | evaluate the environment's policies; exit 2 when a blocking policy fails |
| `matelot release --service ID --version V [--notes T]` | record a release |
| `matelot sbom --service ID --file bom.json --target source\|image [--version V] [--image REF]` | upload an SBOM |
| `matelot registry login [--connection NAME --service ID]` | docker login to the built-in registry or an ECR/ACR/Docker Hub connection |
| `matelot registry path --service ID [--env ID] [--connection NAME --repository NAME [--create]]` | image path in the built-in or an external registry |
| `matelot registry connections --service ID` | registry connections a service can use |
| `matelot request METHOD /api/v1/path [json]` | any endpoint |

## Resource commands

Form: `matelot <resource> <verb> [flags]`.

### me

| Command | API | Does |
|---|---|---|
| `matelot me show` | `GET /me` | Who am I (user + memberships) |

### orgs

| Command | API | Does |
|---|---|---|
| `matelot orgs list` | `GET /organizations` | Organizations I belong to |

### org

| Command | API | Does |
|---|---|---|
| `matelot org overview` | `GET /organizations/:org/overview` | Organization overview (counts, production, risk) |

### workspaces

| Command | API | Does |
|---|---|---|
| `matelot workspaces list` | `GET /organizations/:org/workspaces` | Workspaces |

### teams

| Command | API | Does |
|---|---|---|
| `matelot teams list` | `GET /organizations/:org/teams` | Teams |

### projects

| Command | API | Does |
|---|---|---|
| `matelot projects list` | `GET /organizations/:org/projects` | Projects |

### project

| Command | API | Does |
|---|---|---|
| `matelot project show` | `GET /projects/:project` | Project details |
| `matelot project overview` | `GET /projects/:project/overview` | Project overview |

### services

| Command | API | Does |
|---|---|---|
| `matelot services list` | `GET /projects/:project/services` | Services of a project |
| `matelot services list-org` | `GET /organizations/:org/services` | Services of the organization |

### service

| Command | API | Does |
|---|---|---|
| `matelot service show` | `GET /services/:service` | Service details |

### envs

| Command | API | Does |
|---|---|---|
| `matelot envs list` | `GET /services/:service/environments` | Environments of a service |

### env

| Command | API | Does |
|---|---|---|
| `matelot env show` | `GET /environments/:env` | Environment details |
| `matelot env registry` | `GET /environments/:env/registry` | Environment repository in the built-in registry |
| `matelot env lineage` | `GET /environments/:env/lineage` | Released vs running lanes, drift, history |
| `matelot env gate` | `GET /environments/:env/gate` | Latest gate evaluation of the environment |

### releases

| Command | API | Does |
|---|---|---|
| `matelot releases list` | `GET /services/:service/releases` | Releases of a service |

### release

| Command | API | Does |
|---|---|---|
| `matelot release create` | `POST /services/:service/releases` | Record a release |

### images

| Command | API | Does |
|---|---|---|
| `matelot images list` | `GET /services/:service/images` | Container images (registries) of a service |

### image

| Command | API | Does |
|---|---|---|
| `matelot image add` | `POST /services/:service/images` | Register an image (name, optional integrationId) |
| `matelot image sync` | `POST /images/:id/sync` | Read the registry now (tags, digests) |

### inventory

| Command | API | Does |
|---|---|---|
| `matelot inventory show` | `GET /services/:service/inventory` | Releases, images and environments joined |

### deployments

| Command | API | Does |
|---|---|---|
| `matelot deployments list` | `GET /services/:service/deployments` | Current deployment per environment + history |
| `matelot deployments list-org` | `GET /organizations/:org/deployments` | Current production deployments of the organization |

### sboms

| Command | API | Does |
|---|---|---|
| `matelot sboms list` | `GET /services/:service/sboms` | SBOMs of a service |

### sbom

| Command | API | Does |
|---|---|---|
| `matelot sbom show` | `GET /sboms/:id` | SBOM with components |
| `matelot sbom findings` | `GET /sboms/:id/findings` | Findings of one SBOM |
| `matelot sbom diff` | `GET /sboms/:from/diff/:to` | Diff two SBOMs (--from, --to) |

### components

| Command | API | Does |
|---|---|---|
| `matelot components search` | `GET /organizations/:org/components` | Where a component is used (--q) |

### findings

| Command | API | Does |
|---|---|---|
| `matelot findings list` | `GET /projects/:project/findings` | Dependency findings (--severity --status --kev --q) |
| `matelot findings list-org` | `GET /organizations/:org/findings` | Findings across the organization |
| `matelot findings summary` | `GET /projects/:project/findings/summary` | Open / KEV / production counts |
| `matelot findings environments` | `GET /projects/:project/findings/environments` | What runs in each environment, with counts |
| `matelot findings trend` | `GET /projects/:project/findings/trend` | Daily trend per environment (--days) |

### finding

| Command | API | Does |
|---|---|---|
| `matelot finding show` | `GET /findings/:id` | One finding with where it runs |
| `matelot finding set` | `PATCH /findings/:id` | Decision: --status open|accepted|false_positive|not_affected --note |

### code-findings

| Command | API | Does |
|---|---|---|
| `matelot code-findings list` | `GET /projects/:project/code-findings` | Secrets / IaC / SAST findings (--kind --severity --status) |
| `matelot code-findings summary` | `GET /projects/:project/code-findings/summary` | Code findings counts |

### code-finding

| Command | API | Does |
|---|---|---|
| `matelot code-finding set` | `PATCH /code-findings/:id` | Decision on a code finding (--status --note) |

### vulnerabilities

| Command | API | Does |
|---|---|---|
| `matelot vulnerabilities recorrelate [--service ID] [--wait] [--timeout 1800]` | `POST …/findings/recorrelate` → job; `GET /organizations/:org/correlation/jobs/:id` (or `/services/:id/…`) | Re-run advisory correlation (asynchronous; `--wait` polls until done) |

### risk

| Command | API | Does |
|---|---|---|
| `matelot risk list` | `GET /organizations/:org/risk` | Risk score per service |
| `matelot risk project` | `GET /projects/:project/risk` | Risk of a project |
| `matelot risk recompute` | `POST /organizations/:org/risk/recompute` | Recompute risk now |

### graph

| Command | API | Does |
|---|---|---|
| `matelot graph show` | `GET /projects/:project/graph` | Product map (nodes + edges) |

### policies

| Command | API | Does |
|---|---|---|
| `matelot policies list` | `GET /organizations/:org/policies` | Policies of the organization |
| `matelot policies in-force` | `GET /projects/:project/policies` | Policies in force on a project (own + inherited) |

### policy

| Command | API | Does |
|---|---|---|
| `matelot policy create` | `POST /organizations/:org/policies` | Create at the organization (--name --environments prod,staging --max-severity high --block-kev --block-secrets --require-sbom --max-iac high --action block|warn --enforce) |
| `matelot policy create-project` | `POST /projects/:project/policies` | Create at a project (same flags) |
| `matelot policy update` | `PATCH /policies/:id` | Update (--enabled true|false, --action, --enforce, rule flags) |
| `matelot policy delete` | `DELETE /policies/:id` | Delete a policy |

### gate

| Command | API | Does |
|---|---|---|
| `matelot gate evaluations` | `GET /services/:service/gate-evaluations` | Gate evaluations of a service |

### pipelines

| Command | API | Does |
|---|---|---|
| `matelot pipelines list` | `GET /projects/:project/pipelines` | Pipelines of a project |

### pipeline

| Command | API | Does |
|---|---|---|
| `matelot pipeline show` | `GET /pipelines/:id` | Pipeline with its jobs |
| `matelot pipeline templates` | `GET /pipeline-templates` | Pipeline templates |

### jobs

| Command | API | Does |
|---|---|---|
| `matelot jobs list` | `GET /projects/:project/jobs` | Jobs of a project |
| `matelot jobs active` | `GET /organizations/:org/jobs/active` | Queued / running jobs |

### job

| Command | API | Does |
|---|---|---|
| `matelot job show` | `GET /jobs/:id` | Job details |
| `matelot job logs` | `GET /jobs/:id/logs` | Job log lines |
| `matelot job create` | `POST /services/:service/jobs` | Queue a job (--type sbom|secrets|iac|repository_check … --ref) |

### runners

| Command | API | Does |
|---|---|---|
| `matelot runners list` | `GET /organizations/:org/runner-pools` | Runner pools and runners |

### runner

| Command | API | Does |
|---|---|---|
| `matelot runner agent` | `GET /runner-agent` | Latest runner version + image |

### integrations

| Command | API | Does |
|---|---|---|
| `matelot integrations list` | `GET /organizations/:org/integrations` | Connections (git, registries, k8s) |
| `matelot integrations providers` | `GET /integrations/providers` | Available providers |

### repositories

| Command | API | Does |
|---|---|---|
| `matelot repositories list` | `GET /organizations/:org/repositories` | Repositories |

### registry

| Command | API | Does |
|---|---|---|
| `matelot registry info` | `GET /registry/info` | Built-in registry info |
| `matelot registry reconcile` | `POST /organizations/:org/registry/reconcile` | Read the built-in registry now |

### registries

| Command | API | Does |
|---|---|---|
| `matelot registries list` | `GET /services/:service/registries` | Registry connections usable by a service |

### tokens

| Command | API | Does |
|---|---|---|
| `matelot tokens list` | `GET /me/tokens` | My personal access tokens |

### token

| Command | API | Does |
|---|---|---|
| `matelot token create` | `POST /me/tokens` | New personal token (--name --scope read|write|sudo --days N) — web session only |
| `matelot token revoke` | `DELETE /me/tokens/:id` | Revoke a personal token |

### ci-tokens

| Command | API | Does |
|---|---|---|
| `matelot ci-tokens list` | `GET /organizations/:org/api-tokens` | CI tokens |

### ci-token

| Command | API | Does |
|---|---|---|
| `matelot ci-token create` | `POST /organizations/:org/api-tokens` | Create a CI token (--name --scope-type PROJECT --scope-id ID --preset full|pipeline|deploy|registry --environments id,id) |
| `matelot ci-token revoke` | `DELETE /api-tokens/:id` | Revoke a CI token |

### audit

| Command | API | Does |
|---|---|---|
| `matelot audit list` | `GET /organizations/:org/audit-events` | Audit trail (--limit) |
| `matelot usage` | `GET /organizations/:org/usage` | Usage for a month: active seats, runner minutes, pipelines, jobs, SBOMs, history (--month YYYY-MM, --format csv) |
| `matelot onboarding` | `GET /organizations/:org/onboarding` | Organization setup (one-time, organization-level): source code, a runner, alerts, team — what is done, what is next, the command for each step (`dismiss` / `restore` hide or show it on the Overview) |
| `matelot coverage [--project ID] [--uncovered] [--gap CHECK] [--days N]` | `GET /organizations/:org/coverage`, `GET /projects/:project/coverage` | Service coverage, per service: repository · security pipeline in the last N days (default 30) · SBOM · a policy applies · a deployment recorded. `--uncovered` prints only the gaps with the commands that close them ([coverage.md](coverage.md)) |
| `matelot connection disconnect` | `POST /integrations/:id/disconnect` | Disconnect: keep the connection, forget the credentials |

### users

| Command | API | Does |
|---|---|---|
| `matelot users list` | `GET /admin/users` | Users (platform admin) |

### memberships

| Command | API | Does |
|---|---|---|
| `matelot memberships list` | `GET /memberships` | Memberships of a scope (--scope-type PROJECT --scope-id ID) |

### membership

| Command | API | Does |
|---|---|---|
| `matelot membership grant` | `POST /memberships` | Grant a role (--email --role DEVELOPER --scope-type PROJECT --scope-id ID) |

### meta

| Command | API | Does |
|---|---|---|
| `matelot meta show` | `GET /meta` | Platform metadata (version, roles) |

## Policy rule flags

`--name`, `--description`, `--environments production,staging` (empty = all), `--max-severity critical|high|medium|low|none`, `--block-kev [false]`, `--block-secrets [false]`, `--require-sbom [false]`, `--max-iac critical|high|medium|low`, `--honour-decisions [false]`, `--action block|warn`, `--enforce [false]`.

```bash
matelot policy create --name "Production baseline" --environments production --max-severity high --block-kev --block-secrets --require-sbom --action block --enforce
matelot policy create-project --project $PROJ --name "Dev advisory" --environments development --max-severity high --action warn
matelot policy update --id $POLICY --enabled false
matelot policies in-force --project $PROJ
```

## Examples

```bash
matelot findings list --project $PROJ --severity critical,high --status open
matelot findings environments --project $PROJ
matelot finding set --id $FINDING --status accepted --note "not reachable"
matelot env lineage --env $PROD --json | jq .drift
matelot sbom findings --id $SBOM
matelot job logs --id $JOB
matelot audit list --limit 20
matelot ci-token create --name build --scope-type PROJECT --scope-id $PROJ --preset full --environments $TEST
matelot registry reconcile
```

### templates & exceptions
| Command | Does |
|---|---|
| `matelot policy templates` | list ready-made policies |
| `matelot policy from-template --template cra-baseline [--name …]` / `from-template-project --project ID` | create a policy from a template |
| `matelot exceptions list [--active true]` | exceptions with state (active / expired / revoked) and how many findings they cover |
| `matelot exception create --service ID --kind vulnerability --match CVE-2024-1234 [--component openssl] --status accepted --reason "…" --until 2026-12-31 [--ticket URL]` | time-boxed acceptance in a service (`create-project`, `create-org` for wider scopes; `--kind code --match DS-0026 [--component deploy/]` for rules) |
| `matelot exception approve --id ID` · `matelot exception revoke --id ID` | approve a pending one · revoke (findings reopen) |

### remediation (M9)
| Command | Does |
|---|---|
| `matelot remediation queue --project ID` / `queue-org` | fix-first queue: score, severity, advisory, component, where it runs, SLA due, tracking |
| `matelot remediation create --service ID --kind vulnerability --match CVE-… [--component X] [--owner-email a@b] [--due 2026-12-31] [--notes …]` | track as work (idempotent) |
| `matelot remediation update --id ID --status in_progress\|done\|wont_fix [--owner-email …] [--due …]` | update |
| `matelot remediation issue --id ID [--provider jira --project-key SEC]` | open a GitHub issue in the service repo, or a Jira issue |
| `matelot remediations list --project ID [--status open,in_progress]` / `list-org` | tracked work |
| `matelot sla show` · `matelot sla set --critical 7 --high 30 --medium 90 --low 180 [--jira-project-key SEC]` | SLA days and issue defaults |

### Scoped remediation settings, issue trackers (M9 slice 2)
| Command | Does |
|---|---|
| `matelot sla show-scope --scope projects/ID` · `sla set-scope --scope teams/ID --critical 3 --issue-provider gitlab --jira-project-key PAY --issue-board https://github.com/orgs/acme/projects/5` | overrides stored at a scope (blank/null = inherit) |
| `matelot sla effective --project ID` | what applies to the project and which scope each value comes from (project → team → workspace → organization) |
| `matelot remediation issue --id ID [--provider github\|gitlab\|bitbucket\|jira]` | open the issue on the service repository's host, or in Jira (nearest connection on the chain) |

### MCP (M11)
| Command | Does |
|---|---|
| `matelot mcp` · `matelot mcp --check` | Claude Code / Desktop snippets for this cell's MCP server; --check runs the handshake and counts tools |

### CRA evidence (M10)
| Command | Does |
|---|---|
| `matelot evidence export --release ID [--out file.zip]` | download the signed evidence bundle of a release |
| `matelot evidence verify <bundle.zip>` | check every file's checksum and the cell signature (exit 2 on mismatch) |
| `matelot evidence summary --id ID` | the evidence as JSON |
| `matelot cra readiness --service ID` / `cra readiness-project --project ID` | readiness checks with the CRA requirement and the fix |

### notifications & VEX
| Command | Does |
|---|---|
| `matelot channels list` · `channels events` | channels and the events they can subscribe to |
| `matelot channel create --name ops --kind slack\|teams\|webhook --url https://… [--events gate.fail,sla.overdue] [--project ID]` | add a channel (URL stored encrypted) |
| `matelot channel create --name oncall --kind email --url "a@x.com,b@x.com"` | e-mail channel (recipients; the cell needs `SMTP_*` configured) |
| `matelot channel test --id ID` · `channel update --id ID --enabled false` · `channel delete --id ID` | manage |
| `matelot evidence vex --id RELEASE` | OpenVEX document of a release |

### workspace / team scope
| Command | Does |
|---|---|
| `matelot findings list-workspace --id WS [--team TEAM]` · `findings list-team --id TEAM` | findings of a workspace / team |
| `matelot findings summary-workspace\|environments-workspace --id WS [--team]` · `code-findings list-workspace --id WS` | counts, what runs where, code findings |
| `matelot risk workspace --id WS [--team]` · `risk team --id TEAM` | risk per service |
| `matelot components search-workspace --id WS --q openssl` · `components search-project --project ID --q …` | component search |
| `matelot remediation queue-workspace --id WS [--team]` · `cra readiness-workspace --id WS [--team]` | fix-first queue, CRA readiness |
| `matelot channels list-scope --scope workspaces/ID` · `channel create-scope --scope projects/ID --name … --kind … --url …` | scoped notification channels |

### configuration as code
`matelot apply --file matelot-config.yaml --scope projects/<id> [--dry-run]` applies channels, policies and SLAs
declaratively, keyed by name, at an organization / workspace / team / project. Re-running is a no-op; a changed
URL, event list, rule or SLA is updated; `${ENV_VAR}` placeholders are substituted from the environment (so
webhook URLs stay in CI secrets). YAML (simple subset) or JSON. Example: `docs/examples/matelot-config.yaml`.
API: `POST /<scope>/config/apply[?dryRun=true]`. Works with a CI token that has `policy:write` and `project:write`,
or a personal `write`/`sudo` token.
