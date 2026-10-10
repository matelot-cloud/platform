# Step 01 — Foundation ✅

**Goal.** A deployable tenant cell with the core domain, identity, authorization and audit trail
that every later feature builds on, and a web app shell in the chosen template.

## Delivered
* Tenant cell Helm chart: API, web, Postgres, Redis, Keycloak, network policies; kind workflow.
* Domain: Organization (with parent/subsidiary) → Workspace → Team → Project (criticality).
* Keycloak authentication (OIDC, JIT user provisioning, invite-by-email), platform RBAC:
  memberships = user × role × scope, permissions inherit downwards, structural visibility upwards.
  11 roles from the concept; permission matrix in `apps/api/src/rbac/permissions.ts`.
* Audit trail with actor (user / system / AI agent), before/after, reason, request id.
* Web app (TailAdmin): Overview, Projects, Members, Audit trail; light/dark; organization switcher.
* CI: typecheck, unit tests, migrations on a fresh DB, chart lint, image builds, jsdom render test.

## Amendment (during step 02)
* Two-level access control (ADR 0003): cell administrators vs users, Administration → Users page,
  user disabling; scoped roles unchanged and extended to service/environment.

## Acceptance criteria (met)
- [x] `make deploy TENANT=acme` produces a working cell in kind (chart reviewed; first real deploy may need small fixes).
- [x] A project-scoped developer sees only their path; cannot escalate; auditors are read-only (unit + e2e verified).
- [x] Every mutation writes an audit event with request correlation.
