# CLAUDE.md — working notes for Claude Code

This file is read automatically by Claude Code. It carries the context and decisions from the
design sessions so every new session starts with them.

## What this is

A B2B Product Security / DevSecOps / Compliance SaaS platform. Each client gets **one dedicated
"tenant cell"** (namespace `tenant-<slug>`: API, web app, Postgres, Redis, Keycloak) deployed as
one release of the Helm chart in `deploy/helm/secops-cell`. We operate the cells; a control
plane (not built yet) will provision them. Full product spec lives with the owner; the roadmap
below is the agreed build order.

## Stack (do not change without an ADR in docs/adr)

- Backend: TypeScript, **NestJS 11 line** (pinned; Nest 12 upgrade is a separate task), Drizzle ORM
  with generated SQL migrations in `apps/api/drizzle` (commit the SQL and `meta/`), zod env
  validation, pino logs, Swagger at `/api/docs`, global prefix `/api/v1`.
- The CLI is the npm package `apps/cli` (`secops-platform-cli`, mirrored to github.com/dev-testing-secops-platform/secops-platform-cli for publishing, zero dependencies); the GitHub Action
  `tools/setup-cli` installs it; every command shown in the UI and docs uses the CLI (`secops …`).
  `tools/secops-ci/secops.sh` exists only as a no-Node fallback and is not advertised. Keep the signing
  code in sync with `apps/api/src/tokens/signing.ts`.
- CI/CD authenticates with **signed CI tokens** (`apps/api/src/tokens`, `docs/ci-integration.md`), never
  bearer secrets; the guard order is ApiTokenGuard → JwtAuthGuard → PermissionGuard.
- Identity: **Keycloak per cell** owns authentication (SSO/SAML/MFA). The platform owns
  authorization, GitLab-style (ADR 0003): cell level `users.platform_role` (`admin` bypasses all
  scoped checks, can disable users; Administration area) + memberships = `user × role × scope`
  with permissions inheriting down Organization → Workspace → Team → Project → Service →
  Environment. See `apps/api/src/rbac/` and `apps/api/src/admin/`.
- Frontend: `apps/web` = TailAdmin React template (MIT; React 19, TypeScript, Tailwind v4, dark
  mode) in `src/{layout,components,context,icons}`, plus our code in `src/platform` (auth gate, API
  hooks, state, shared components) and `src/pages`. Path alias `@/` = `src/`. tsconfig is strict with
  `verbatimModuleSyntax` and `erasableSyntaxOnly` (use `import type`, no parameter properties).
  Runtime config from `/config.json`. `pnpm --filter @secops/web test` renders the whole app in
  jsdom with a fake API — keep it green.
- Infra: pnpm workspaces, Docker images per app, Helm chart, kind for local Kubernetes.

## Commands

```
make install        pnpm install
make dev-infra      docker compose: postgres, redis, keycloak (admin/admin, dev/dev)
make migrate        apply migrations to .env DATABASE_URL
make dev            API with hot reload on :3000
make runner         local runner agent from source (apps/runner); RUNNER_REGISTRATION_TOKEN=… on first start
make worker         background worker (BullMQ: GitHub sync + webhooks, job sweeper); builds into apps/api/dist-worker
                    so it never races `make dev` on dist/; never run Nest code with tsx —
                    it drops decorator metadata and DI silently injects undefined.
                    `make dev` / `make worker` refuse to start a second watcher (scripts/dev-guard.sh;
                    DEV_GUARD=0 to skip): two API watchers fight over :3000 on every edit;
                    `make dev-stop` stops every leftover API / worker watcher of this checkout
make web            web app on :5173 (proxies /api)
make test           unit tests (RBAC matrix)
pnpm db:generate    after editing apps/api/src/database/schema.ts
make kind-up / kind-load / deploy TENANT=acme
make backup TENANT=acme / restore TENANT=acme ARCHIVE=…   cell backup (CronJob in the chart) and restore; docs/backup-restore.md
make provision TENANT=globex / decommission TENANT=globex   real cells from deploy/cells/<slug>.values.yaml; docs/cell-provisioning.md
```

Verify before finishing any task: `pnpm -r typecheck && pnpm -r test && pnpm -r build`.
API e2e without Keycloak: `node apps/api/test/fake-idp.js serve` + a token from
`node apps/api/test/fake-idp.js token admin@acme.local` against a running API.

## UI conventions (apps/web)
- One button system: `primaryButton`, `outlineButton`, `dangerButton`, `linkButton`, `dangerLink`, `codeBlock` from
  `platform/components/ui.tsx` — never define button classes locally. Tables use `th`/`td`/`trBorder`;
  flush cards use `Toolbar`, `Note`, `Tabs`, `EmptyState`; KPI tiles use `Kpi` from `Dashboard.tsx`; background work is shown by the header `ActivityIndicator` (`useActiveJobs` refreshes all queries when a job finishes) and inline via `usePendingSboms` + `Spinner` — never leave a result slot silently empty while a job runs; the project layout owns the **global service selector** (`useProject().service` = chosen or null for all, `focusService` = chosen or first; never add per-page service dropdowns); logs and histories use `TerminalLog` (black panel, line numbers, streams); provider logos via `BrandIcon` (`EnvironmentManager.tsx`); per-row management goes in a `Manage` window (`EnvironmentManager`, `IntegrationManager`), never inline link rows.
- Card headers: title + one-line description, actions right-aligned; content padding 24 px (`px-6`).

## Conventions

- Every mutation goes through a service that writes an audit event (`AuditService.record`)
  with before/after and, where the user gave one, a reason. Controllers never touch the DB.
- Routes declare `@RequirePermission('<domain>:<verb>')`; scope comes from route params
  (`:organizationId | :workspaceId | :teamId | :projectId`). New domains add their permissions to
  `apps/api/src/rbac/permissions.ts` and the role matrix; extend the spec in
  `authorization.service.spec.ts`.
- Slugs are immutable identifiers; names are editable; deletes are archives (`archivedAt`).
- Org-wide list endpoints filter per row with `authz.can(...)` (see `ProjectsService.listForOrganization`).
- Frontend: GitLab-style context navigation — `/workspaces/:id/*` and `/projects/:id/*` layouts
  (`src/pages/workspace/layout.tsx`, `src/pages/project/layout.tsx`) provide the context via
  Outlet; the sidebar (`src/layout/AppSidebar.tsx`) picks its menu from the route; the navbar
  switcher is `src/platform/header/ContextSwitcher.tsx`. New section = page under the right layout
  + hooks in `src/platform/api/hooks.ts`; respect 403 with an explanatory empty state.
- Keep the Helm chart deployable with defaults on kind; anything production-only is a values switch.

## v1 focus (read first)

`docs/concept-v1.md` is the product we ship first; `docs/roadmap/v1.md` is its milestone plan
(M1–M12) with status. Work on the current v1 milestone; do not start deferred items. The 17-step
roadmap remains the long-term map.

## Roadmap

The build order lives in `docs/roadmap/README.md`, one document per step with scope, data
model, API, UI and acceptance criteria; the product concept is `docs/concept.md`. Work on the
step marked *in progress*, update its progress log and tick its acceptance criteria as they pass.
v1 milestones: M1–M6 ✅ (… SBOM, dependency + code findings) · M7 slice 1 ✅ (risk score, graph, lineage) · M8 ✅ (policies, gates, templates, exceptions) · M9 slice 1 ✅ (SLAs, fix-first queue, remediations, GitHub/Jira issues) · M10 slice 1 ✅ (signed evidence bundles, CRA readiness) · VEX + notifications ✅ · next: issue-status sync, SAST, M11 AI, M12 launch. Steps: 01 ✅ · 02 ✅ · 03 🔨 (managed runners left) · 04 partial (inventory done) · 03 runners & scheduler ·
04 catalog II (pipelines, builds, releases, images, deployments, Kubernetes, cloud) · 05 SBOM ·
06 scanning suite & scanner import · 07 vulnerabilities & risk · 08 policies, gates, CLI ·
09 remediation, SLA, Jira, notifications · 10 compliance, evidence, audit management ·
11 risk register, incidents, CRA/NIS2 · 12 graph, score, dashboards · 13 templates, baselines,
discovery · 14 public API, SDKs, webhooks · 15 agentic AI · 16 enterprise identity, MSSP, more
providers · 17 provisioning control plane.

## Known gaps

- The chart, provisioning, backup/restore (PVC and S3) and upgrades are verified on kind (Oct 2026); no real cloud
  cluster yet. `make helm-lint` (scripts/chart-test.sh) is the gate for chart changes.
- The web app is tested in jsdom (test/render.mjs) and has been used in a real browser on kind; no full visual pass yet.
- Product name is a placeholder ("Security Platform" / `secops`).
- MCP server: apps/api/src/mcp (tools generated from OpenAPI; docs/mcp.md). CLI: `matelot mcp`.
- Documentation site: `tools/docs-site/build.mjs` renders `docs/*.md` (sections in its SITE table) into `apps/web/public/docs/`
  during the web build; served at `/docs/` on every cell. A new doc goes into the SITE table; `node tools/docs-site/build.mjs --check` verifies links.
