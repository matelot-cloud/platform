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
| PRODUCT_SECURITY_ENGINEER | decisions, remediations and issues, request exceptions, pipelines, SBOMs |
| DEVELOPER | pipelines, SBOMs, deployments, request exceptions, reads |
| AUDITOR / READ_ONLY / EXTERNAL_CONSULTANT | reads |

Exceptions are time-boxed risk acceptances, not policies: `exception:write` (request/create, revoke your own) and
`exception:approve` (make one active) are separate from `policy:write`. An exception created by someone who can
approve is active at once; otherwise it waits for an approver (Project → Security → Exceptions → Approve).

## Token scopes (personal tokens, `matelot login`, claude.ai connectors)

A token acts as the user, but the scope caps what the user's roles allow. Administrative roles are **downgraded**:

| Scope | Effective role for ORG_ADMIN / SECURITY_ADMIN memberships | Cell admins without memberships |
|---|---|---|
| `read` | AUDITOR | AUDITOR on every organization |
| `write` | PRODUCT_SECURITY_ENGINEER | PRODUCT_SECURITY_ENGINEER on every organization |
| `sudo` | unchanged (ORG_ADMIN); platform-admin elevation applies | everything |

Other roles are unchanged by `write` (a DEVELOPER's write token is a DEVELOPER); `read` tokens are read-only on every route.

### Scope × action (asserted by `apps/api/src/rbac/token-scope-matrix.spec.ts`)

| Action | read | write | sudo |
|---|---|---|---|
| read findings / gates / evidence | ✅ | ✅ | ✅ |
| decide on a finding | ❌ | ✅ | ✅ |
| create / update a remediation, open an issue | ❌ | ✅ | ✅ |
| request an exception | ❌ | ✅ | ✅ |
| approve an exception | ❌ | ❌ | ✅ |
| create a policy | ❌ | ❌ | ✅ |
| create a notification channel | ❌ | ❌ | ✅ |
| change SLA settings | ❌ | ❌ | ✅ |
| run a pipeline | ❌ | ✅ | ✅ |
| grant a membership | ❌ | ❌ | ✅ |

The OAuth consent page (`/oauth/consent`) and `matelot_start_here` describe exactly this table.
