# Step 02 — Catalog I: services, environments, source control (GitHub App), connected resources ✅

**Goal.** Make a Project a real security context: it owns Services and Environments, and it is
connected to the systems where its software lives, starting with GitHub. After this step the
platform knows *which repositories belong to which service of which product*, kept in sync by
webhooks. This is the inventory every later step (SBOM, vulnerabilities, policies, evidence)
attaches to.

## Scope

**In**
1. Services and Environments under Project (the two missing levels of the hierarchy).
2. Integrations model: a *connection* to an external system, owned by an organization, with
   credentials stored encrypted in the cell; and *connected resources* that link an external
   object (a repository, later a Jira project, a Kubernetes namespace…) to a service.
3. GitHub via a **GitHub App** (installation per organization): list installations and
   repositories, attach repositories to services, receive webhooks (push, pull_request,
   repository, installation), keep repository metadata current (default branch, visibility,
   archived, languages, branch protection on default branch — the first piece of evidence).
4. A background worker (BullMQ on the cell's Redis) for webhook processing and periodic sync.
5. UI: Project page with Services & Environments; "Connect GitHub" flow; repository picker;
   repository list with sync status.

**Out (later steps)**: GitLab/Bitbucket/Azure DevOps (same model, step 16); pipelines, registries,
Kubernetes and cloud (step 04); Jira (step 09); scanning of any kind (step 03+).

## Data model (new tables)

| Table | Key columns |
|-------|-------------|
| `services` | id, project_id, slug, name, description, kind (`api`, `worker`, `web`, `library`, `firmware`, `infrastructure`, `other`), criticality (inherits project unless set), timestamps, archived_at |
| `environments` | id, service_id, slug, name, kind (`development`, `testing`, `staging`, `production`), internet_facing bool, timestamps |
| `integrations` | id, organization_id, provider (`github`; later `gitlab`, `jira`, `aws`…), name, status (`pending`, `connected`, `error`, `disconnected`), external_account_id (GitHub installation id), settings jsonb, credentials_encrypted bytea, last_synced_at, last_error, timestamps |
| `repositories` | id, integration_id, external_id, full_name, default_branch, visibility, archived, languages jsonb, html_url, branch_protection jsonb (snapshot), last_synced_at, timestamps; unique (integration_id, external_id) |
| `service_repositories` | service_id, repository_id, role (`primary`, `secondary`), created_at; unique pair |
| `webhook_deliveries` | id, integration_id, provider_delivery_id, event, payload jsonb, received_at, processed_at, status, error; unique (integration_id, provider_delivery_id) — idempotent |

Credentials: AES-256-GCM with a per-cell key from `CELL_ENCRYPTION_KEY` (Helm secret). Never
returned by the API.

## Permissions (added to `permissions.ts`)
`service:read/write`, `environment:read/write`, `integration:read/write/connect` (connect = add or
remove an external connection; ORG_ADMIN and SECURITY_ADMIN only), `repository:read`.

## API
```
GET/POST   /projects/:projectId/services                 GET/PATCH/DELETE /services/:serviceId
GET/POST   /services/:serviceId/environments             GET/PATCH/DELETE /environments/:environmentId
GET/POST   /organizations/:organizationId/integrations   GET/DELETE       /integrations/:integrationId
GET        /integrations/:integrationId/repositories     (from GitHub, cached)   POST …/sync
POST       /services/:serviceId/repositories   {repositoryId}     DELETE /services/:serviceId/repositories/:repositoryId
GET        /organizations/:organizationId/repositories    (inventory, with service links)
POST       /webhooks/github                              (public, signature-verified)
GET        /integrations/github/install-url              (redirect target for the GitHub App)
GET        /integrations/github/callback                 (installation_id → creates integration)
```

## Worker
`apps/api` gains a `worker` process mode (`node dist/worker.js`): BullMQ queues `github-webhooks`
and `github-sync`. The Helm chart adds a `worker` Deployment. Jobs are idempotent and audited as
`SYSTEM` actor with `reason = "webhook: <event>"`.

## UI
* Project page (new route `/projects/:projectId`): header with criticality, tabs *Services*,
  *Environments*, *Repositories*, *Activity*.
* Organization → *Integrations* page: connected systems, "Connect GitHub" (opens the App
  installation), status, last sync, disconnect.
* Repository picker inside a service: search installed repos, attach as primary/secondary.
* Sidebar gains *Integrations* (Platform group) and *Inventory → Repositories*.

## Acceptance criteria
- [x] A service with environments can be created under a project (API + Project page); RBAC scopes extend to service/environment.
- [x] GitHub App installation creates an integration; repositories list within 10 s. *(verified against a fake GitHub API; real GitHub pending your App)*
- [x] Attaching a repository to a service records it; a push webhook updates metadata within 5 s (worker running).
- [x] Webhook deliveries are idempotent (replay → duplicate) and signature-checked (bad signature → 401).
- [x] Branch protection snapshot stored for the default branch and visible in the UI (Repositories page, service repositories).
- [x] Unit tests: encryption round-trip, webhook signature, app JWT, RBAC (incl. service/environment and admin bypass); render test covers Project, Integrations and Repositories pages.

## Connection levels (GitLab model)
A connection lives at the **organization, workspace, team or project** level (`integrations.scope_type`
/ `scope_id`) and is usable by everything below it. `GET /projects/:id/integrations` returns a
project's own connections plus the inherited ones; `GET /projects/:id/repositories` the repositories
available to it. A repository can be attached to a service only if its connection sits on the
service's path. Connect / sync / disconnect are authorized at the connection's own level, so a team
lead or developer can connect their project's repositories while organization-wide connections stay
with administrators. Migration `0004`.

## Navigation (GitLab model)
The URL is the context. Navbar: organization → **workspace** → **project** switchers. The left
menu changes with the context: organization (Overview, Projects, Repositories, Integrations,
Members, Audit trail, Administration), workspace (`/workspaces/:id`: Overview, Teams & projects,
Repositories, Integrations, Members, Settings), project (`/projects/:id`: Overview, Services,
Environments, Repositories, Integrations, Members, Settings). Settings pages edit name,
description (and criticality for projects) and archive.

## Self-service (no operator configuration needed)
Teams connect everything themselves through the *Connect a source* wizard on a project, team or
workspace: choose the type → fill in → **Test connection** → connect. For GitHub they can either
install the platform-wide App with one click (if the cell offers one) or **register their
organization's own GitHub App** (App ID, slug, private key, webhook secret) and install it; each
own-App connection has its own webhook endpoint `/webhooks/github/<connectionId>` verified with its
own secret. The GitHub App return lands back on the project page for project-level connections.

**Deploy keys are generated by the platform** (RSA 4096, private half encrypted, never shown): the
wizard shows the public key to add on the git host, then *Test connection* (`POST
/integrations/:id/verify`) takes the connection live. Teams never run `ssh-keygen`.

## Connection types (added on request)
| Type | Auth | Inventory | Use for |
|------|------|-----------|---------|
| GitHub App | app installation | all repositories of the installation + webhooks | GitHub (recommended) |
| GitHub token | personal access token (HTTPS) | what the token can read, optionally one org/user | GitHub without an App |
| GitLab token | personal/group/project token (HTTPS) | membership projects or one group with subgroups | gitlab.com and self-managed |
| Git repository | none / token / username+password (HTTPS) or SSH deploy key | one repository, verified with `git ls-remote`, default branch detected | Bitbucket, Azure DevOps, Gitea, internal hosts |

Credentials are verified before saving and stored AES-256-GCM encrypted with the cell key; git
authenticates through environment (`http.extraheader`) or a temporary 0600 key file, never argv.
Repositories carry `cloneUrl`/`sshUrl` for the runner (step 03). The API/worker image includes
`git` and `openssh-client`.

## Progress log
* Slice 1 (done): schema for services, environments, integrations, repositories, service_repositories,
  webhook_deliveries (migration `0001`); `SERVICE`/`ENVIRONMENT` scope types in RBAC with visibility
  through descendants; Services & Environments API; org-wide services list; meta exposes kinds.
* Slice 2 (done): GitHub App client (app JWT → installation tokens), signed setup state, callback,
  installation sync, repository inventory, service↔repository links, signed + idempotent webhooks,
  BullMQ worker process (`dist/worker.js`, `make worker`), encryption at rest, Helm worker
  Deployment and secrets (generated cell key kept across upgrades).
* Slice 3b (done): connection types above; `POST /organizations/:id/integrations`; Connect dialog in
  the Integrations page; migration `0003`.
* Slice 3 (done): Project page (`/projects/:id`: services, environments with exposure flag,
  repository attach/detach), Integrations page (Connect GitHub, sync, disconnect, return handling),
  Repositories inventory page (orphans highlighted), sidebar entries.

**Remaining before closing the step:** a real GitHub App connected by the owner (everything above
is verified against a fake GitHub API); then mark the step done in the roadmap index.

## Open decisions
* GitHub App credentials (app id, private key, webhook secret, client id/secret) are cell-level
  values in Helm; a public-cloud "shared app" comes with the provisioning control plane (step 17).
* Repository *content* is never fetched in this step; the runner (step 03) clones inside the
  customer's network when a job needs it.
* The generic `connected_resources` link (project ↔ Jira project / namespace / account / pipeline)
  is introduced in step 04 once those object types exist; this step links repositories to services.
