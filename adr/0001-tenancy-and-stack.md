# ADR 0001 — Tenancy model and core stack

**Status:** accepted · **Date:** 2026-09-18

## Context

The product is a B2B security/compliance platform for enterprise clients who expect strong
isolation, SSO/SAML integration and, frequently, their own compliance evidence about how their
data is separated. We also need multiple organizations inside one client (parent company with
subsidiaries, MSSP serving several customers) and an agentic AI layer whose actions must be
attributable and permission-scoped.

## Decisions

### 1. One dedicated cell per client, operated by us
Each client gets its own Kubernetes namespace (`tenant-<slug>`) holding the API, workers, Postgres,
Redis and Keycloak, deployed as one Helm release of `deploy/helm/secops-cell`. A control plane
(later) provisions cells and rolls versions across them.

*Why:* physical isolation is easy to explain and audit; noisy-neighbour and blast-radius problems
disappear; per-client versions and maintenance windows become possible; the Helm chart doubles as
the on-prem/regulated-deployment story.
*Cost:* fleet operations (upgrades, monitoring, cost per idle client). Accepted; it is the control
plane's job.

### 2. Keep organization scoping inside the cell
Organizations remain a first-class entity with a parent/child hierarchy, even though a cell serves
one client. Parent-org roles apply inside child orgs.

*Why:* subsidiaries and MSSP customers are per-client requirements, not cross-client ones.

### 3. Keycloak per cell owns authentication; the platform owns authorization
Keycloak (realm `platform`) issues RS256 tokens; the API validates them against the realm JWKS and
provisions users just-in-time. Roles are **not** Keycloak roles: they are platform memberships
(`user × role × scope`) because the permission model is hierarchical and resource-scoped.

*Why:* SSO/SAML/OIDC brokering, MFA and session management are solved problems in Keycloak;
authorization must understand the platform's hierarchy, which Keycloak does not.

### 4. TypeScript / NestJS
Chosen by the team. Modules map 1:1 to the product's domains; DI makes the RBAC guard and audit
service pervasive without boilerplate.

### 5. Drizzle ORM with generated SQL migrations
*Why over Prisma:* no native query engine to ship (smaller images, faster cold start in cells),
migrations are plain SQL under review, and the query builder stays close to SQL for the
graph-style queries the security graph and risk engine will need. Migrations are applied by the
API pod's init container, so an image rollout carries its schema.

### 6. Audit trail is a domain concern, not middleware
Services write explicit audit events with before/after state and reason. The request id from
`x-request-id` is stored with each event so logs and audit rows correlate.

## Consequences

* Every new domain follows the same template: schema in `schema.ts`, permissions declared in
  `permissions.ts`, controller routes with `@RequirePermission`, service methods that audit.
* The agent layer (step 7) will act *through* the same API with a service identity whose
  memberships bound what it may touch; `actor_type = AI_AGENT` is already in the schema.
