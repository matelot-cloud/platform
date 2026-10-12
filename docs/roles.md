# Roles, permissions and token scopes

## Roles (memberships)

A membership gives a user a role on an organization, workspace, team or project; roles inherit downward.

| Role | Can |
|---|---|
| ORG_ADMIN | everything in the organization |
| SECURITY_ADMIN | security administration: policies, SLAs, channels, connections, exceptions (request + approve), decisions, remediations |
| COMPLIANCE_OFFICER | reads + compliance / evidence writes, approve exceptions |
| CISO | reads + accept risk, approve exceptions, incidents, memberships |
| CTO | reads + structure writes (workspaces, teams, projects) |
| TEAM_LEAD | team structure, services, environments, decisions, remediations, request exceptions, pipelines |
| PRODUCT_SECURITY_ENGINEER | decisions, remediations and issues, request exceptions, pipelines, SBOMs, sees runner pools and runners |
| DEVELOPER | pipelines, SBOMs, deployments, request exceptions, reads |
| AUDITOR / READ_ONLY / EXTERNAL_CONSULTANT | reads |

Exceptions are time-boxed risk acceptances, not policies: `exception:write` (request/create, revoke your own) and
`exception:approve` (make one active) are separate from `policy:write`. An exception created by someone who can
approve is active at once; otherwise it waits for an approver (Project → Security → Exceptions → Approve).

## Token scopes (personal tokens, `matelot login`, claude.ai connectors)

A token acts as the user with the user's **own roles** — the scope is a mask over what those roles allow, never a
different role (a fixed role for `write` was tried first and kept breaking first-run flows: an administrator's default
`matelot login` could not create a workspace).

| Scope | May | May not |
|---|---|---|
| `read` | every `*:read` permission the roles grant, `registry:pull`, `gate:evaluate`; HTTP `GET`/`HEAD` only | change anything |
| `write` (default of `matelot login`) | everything the roles grant **except** the administrative permissions below; any method except `DELETE` | administer, delete or archive |
| `sudo` (administrators only) | the full role, platform-admin elevation included; every method | — |

### Permission × scope

| Permission | read | write | sudo | Used for |
|---|---|---|---|---|
| `*:read` (`organization`, `workspace`, `project`, `vulnerability`, `policy`, `evidence`, `runner`, `job`, …) | ✅ | ✅ | ✅ | reading |
| `registry:pull`, `gate:evaluate` | ✅ | ✅ | ✅ | pulling images, evaluating a gate |
| `workspace:write`, `team:write`, `project:write`, `service:write`, `environment:write` | ❌ | ✅ | ✅ | creating and editing the structure |
| `job:create`, `job:cancel`, `registry:push`, `sbom:write`, `release:write`, `deployment:write` | ❌ | ✅ | ✅ | running pipelines, pushing, recording releases |
| `vulnerability:write`, `exception:write`, `policy:exception_request`, `evidence:write`, `risk:write`, `incident:write` | ❌ | ✅ | ✅ | deciding on findings, remediations, requesting exceptions |
| `organization:write`, `organization:create_child` | ❌ | ❌ | ✅ | organization settings, renames, subsidiaries |
| `membership:write` | ❌ | ❌ | ✅ | members and roles |
| `integration:write`, `integration:connect` | ❌ | ❌ | ✅ | connections hold credentials |
| `policy:write` | ❌ | ❌ | ✅ | policies, notification channels, SLA settings |
| `exception:approve`, `policy:exception_approve`, `risk:accept` | ❌ | ❌ | ✅ | accepting risk |
| `compliance:write` | ❌ | ❌ | ✅ | frameworks and controls |
| `runner:write` | ❌ | ❌ | ✅ | runner pools and registration tokens |
| any `DELETE` route (archive a workspace / project / team, delete a policy, integration, membership, token, runner pool) | ❌ | ❌ | ✅ | destructive operations |
| tokens (create / revoke personal and CI tokens), licence | ❌ | ❌ | ❌ | web session only |

The rows marked sudo-only are the `SUDO_ONLY` set in `apps/api/src/rbac/permissions.ts`; the `DELETE` rule is
`methodRefusedForScope` in `apps/api/src/auth/personal-tokens/personal-token.guard.ts`. Both are asserted by
`apps/api/src/rbac/token-scope-matrix.spec.ts`, which also walks the customer's first-run path with a write-scoped
administrator token — create workspace → team → project → run a pipeline → read findings → push to the registry — and
checks that only the administrative row needs sudo. A DEVELOPER's `write` token is still a DEVELOPER: the mask only
removes, it never adds.

### Scope × action (the consent page)

| Action | read | write | sudo |
|---|---|---|---|
| read findings / gates / evidence, pull from the registry, see runners | ✅ | ✅ | ✅ |
| create a workspace / team / project / service / environment | ❌ | ✅ | ✅ |
| run a pipeline, push to the registry, upload an SBOM, record a release / deployment | ❌ | ✅ | ✅ |
| decide on a finding, create / update a remediation, open an issue, request an exception | ❌ | ✅ | ✅ |
| approve an exception, accept a risk | ❌ | ❌ | ✅ |
| create a policy / notification channel, change SLA settings | ❌ | ❌ | ✅ |
| grant a membership, connect an integration, organization settings, manage runner pools | ❌ | ❌ | ✅ |
| archive or delete anything | ❌ | ❌ | ✅ |

The OAuth consent page (`/oauth/consent`) and `matelot_start_here` describe exactly this table.
