# Roles, permissions and token scopes

## Roles (memberships)

A membership gives a person (or a service account) a role on an organization, workspace, team or project; roles
inherit downward, like GitLab group → subgroup → project memberships. Every level has a **Members** page (Organization
→ Members, Workspace → Members, Team → Members (Workspace → Teams → the team), Project → Members)
listing the direct members and, read-only, everyone who inherits a role from above — with where it is granted (a
link), who granted it, when, and the optional expiry date.

Roles in the order they are offered, the closest GitLab role, and where each is offered:

| Role | Can | GitLab | Offered at |
|---|---|---|---|
| ORG_ADMIN — Organization admin | everything in the organization: settings, members, connections, policies, licence | Owner | organization |
| SECURITY_ADMIN — Security admin | policies, SLAs, channels, connections, members, exceptions (request + approve), decisions, remediations | Maintainer | every level |
| CISO | reads + accept risk, approve exceptions, incidents, members | Maintainer | organization, workspace |
| CTO | reads + structure writes (workspaces, teams, projects, services), members | Maintainer | organization, workspace |
| COMPLIANCE_OFFICER — Compliance officer | reads + compliance / evidence writes, approve exceptions | Reporter | every level |
| TEAM_LEAD — Team lead | team structure, services, environments, members, connections, runners, pipelines, decisions | Maintainer | workspace, team, project |
| PRODUCT_SECURITY_ENGINEER — Product security engineer | decisions, remediations and issues, request exceptions, pipelines, SBOMs, evidence, sees runners | Developer | every level |
| DEVELOPER — Developer | pipelines, images, SBOMs, releases, deployments, request exceptions, reads findings | Developer | workspace, team, project |
| AUDITOR — Auditor | reads everything, including the audit trail and evidence | Reporter | every level |
| EXTERNAL_CONSULTANT — External consultant | reads + risk records; give them an expiry date | Reporter | every level |
| READ_ONLY — Read only | structure, findings and SBOMs; no audit trail, no evidence | Guest | every level |

**GitLab → Matelot**, for teams moving over: *Owner* → Organization admin (organization) · *Maintainer* → Security
admin, Team lead, CTO or CISO depending on whether the person administers security, a team's structure, or the
organization's structure / risk · *Developer* → Developer (builds and ships) or Product security engineer (triages
findings) · *Reporter* → Auditor, Compliance officer or External consultant · *Guest* → Read only. Matelot has no
*Planner* role; custom roles are a named capability (`custom_roles`) not built yet.

### Rules (enforced by the API, so the web app, the CLI and the MCP server behave alike)

- **Who manages members:** whoever holds `membership:write` at the scope (organization admin, security admin, CISO, CTO,
  team lead). With a token that means **sudo** (or the web session): a `write` token cannot manage members.
- **Never above your own role:** you can grant, change or remove only roles whose permissions you hold at that scope
  (cell administrators excepted). A team lead can add developers to a project, not security admins.
- **Raise, never lower:** a direct role at a lower level must add something to what the person inherits from above;
  `READ_ONLY` on a project for someone who is `AUDITOR` on the workspace is refused, with where the inherited role
  comes from. Change or remove it where it is granted instead.
- **One direct membership per person per scope:** adding someone who is already a direct member changes their role.
- **Expiry (optional):** from the end of the chosen day the membership no longer grants anything; the row stays,
  marked *expired*, until someone removes or renews it.
- **The last organization admin** of an organization cannot be removed, demoted or given an expiry.
- **Leaving:** anyone may remove their own direct membership (except the last organization admin).
- **Service accounts** can hold roles only at the scope that owns them and below (they are not offered elsewhere).
- Every change is in the audit trail: `membership.granted`, `membership.updated`, `membership.revoked`,
  `membership.left`, `user.invited`, `user.created`, `user.disabled`, `user.deleted`, `service_account.*`.

### Adding people

*Invite members* (any Members page, `matelot members add`): search existing people by name or e-mail and/or paste
several e-mail addresses, pick a role (only the ones offered at that level; the ones above your own are disabled) and
an optional expiry. An address nobody has used yet is **invited**: with the bundled Keycloak a sign-in account is
created and a one-time setup link (valid 7 days) is e-mailed when the cell has SMTP, or shown once to copy otherwise;
with an external identity provider the person simply gets the role at their first sign-in.

### User administration

Administration → Users (cell administrators and admins of the root organization; `matelot users …`): create a user
(temporary password or setup link), disable / enable (sign-in and every token refused, sessions ended, roles kept),
reset a password (temporary, or a one-time reset link), delete (their roles and tokens go too; a sole organization
admin cannot be deleted), and see a person's roles across scopes and their tokens. Only cell administrators change
the cell role (administrator / user).

### Capabilities (licensing, M13)

Each part of this is a named capability so the licence can map it to Free / Premium / Ultimate later — today all are
on: `inherited_members`, `member_expiry`, `bulk_invite`, `invite_links`, `user_admin`, `service_accounts`,
`scope_access_tokens` (`custom_roles` is reserved, not built). `GET /api/v1/meta` lists them; an operator can turn one
off with `MATELOT_FEATURES_DISABLED=service_accounts,…` on the API.

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
| `integration:connect` | ❌ | ✅ | ✅ | connecting a git host or registry to a project, team or workspace (at organization level also `organization:write`: an owner) |
| `vulnerability:write`, `exception:write`, `policy:exception_request`, `evidence:write`, `risk:write`, `incident:write` | ❌ | ✅ | ✅ | deciding on findings, remediations, requesting exceptions |
| `organization:write`, `organization:create_child` | ❌ | ❌ | ✅ | organization settings, renames, subsidiaries |
| `membership:write` | ❌ | ❌ | ✅ | members and roles |
| `integration:write` | ❌ | ❌ | ✅ | changing or rotating credentials, disconnecting, syncing on demand, deleting a connection |
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
| connect a git host / registry to a project, team or workspace | ❌ | ✅ | ✅ |
| approve an exception, accept a risk | ❌ | ❌ | ✅ |
| create a policy / notification channel, change SLA settings | ❌ | ❌ | ✅ |
| grant a membership, connect at organization level, disconnect / rotate credentials, organization settings, manage runner pools | ❌ | ❌ | ✅ |
| archive or delete anything | ❌ | ❌ | ✅ |

The OAuth consent page (`/oauth/consent`) and `matelot_start_here` describe exactly this table.
