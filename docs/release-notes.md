# Release notes

<!--
INTERNAL HEADER — never published (scripts/release-notes.sh drops HTML comments).

This file is the source of the PUBLIC release notes: the body of each GitHub Release in matelot-cloud/matelot.
CHANGELOG.md stays the internal drop log and is never published.

  ## vX.Y.Z — <one line>      one section per release, newest first
  <curated summary>           everything before the first "### ": the notes of the FINAL release vX.Y.Z
  ### <date> — <title>        one entry per released build, newest first: the notes of a PRE-RELEASE vX.Y.Z-rc.N
                              are the newest entry only

Write for an operator: what changed, what to do on upgrade, what breaks. No verification notes, test names, file
paths of this repository, environment limits or drop numbers — scripts/lib/public-notes-internal-wording.txt lists
what the release job, `scripts/release-notes.test.sh` and check-forbidden refuse. Keep an entry under a screen or two;
the whole notes must stay under 60,000 characters (GitHub's limit for a release body is 125,000).
Preview:  scripts/release-notes.sh v0.1.0-rc.25      scripts/release-notes.sh v0.1.0
-->

## v0.1.0 — first self-hosted release

The first release you can install on your own infrastructure: one **cell** per organization, from the Helm chart
`oci://ghcr.io/matelot-cloud/charts/secops-cell` (production) or with Docker Compose on one host (evaluation and small
teams). Both use the same images and the same backup format.

- **One cell per organization**: API, worker, web app, managed runners, built-in container registry, Postgres, Redis
  and Keycloak; generated secrets that survive upgrades; upgrades roll only the application pods.
- **Inventory and SBOM**: repositories, builds, releases, images, deployments and Kubernetes / cloud discovery in one
  graph; an SBOM per release; continuous correlation with vulnerability intelligence.
- **Security pipeline** per service (checkout, SBOM, secrets, IaC, SAST, dependency scanning) with a policy gate;
  managed runners in the cell and self-hosted runner pools; signed, scoped CI tokens; CI examples for GitHub Actions,
  GitLab CI and Bitbucket Pipelines.
- **Vulnerabilities and risk**: findings correlated with images and deployments; risk scored by CVSS, exploitation,
  exposure and criticality; VEX; a fix-first queue; SLAs; issues in GitHub, GitLab, Bitbucket and Jira with status sync.
- **Policies, gates and exceptions** inherited from organization to environment; deployment gates; policy templates.
- **Keyless registry access** for ECR, ACR and Artifact Registry through workload identity federation; token-based
  access for Docker Hub, GHCR and any v2 registry.
- **CRA evidence**: a signed evidence bundle per release, CRA readiness checks, an audit trail on every change.
- **Notifications** to Slack, Microsoft Teams, e-mail and webhooks.
- **Identity and access**: Keycloak per cell (SSO / SAML / MFA), hierarchical roles from organization to environment,
  an administration area, usage and rate limits.
- **Observability**: Prometheus metrics for every component, one OpenTelemetry trace per pipeline, structured JSON
  logs with trace ids, four Grafana dashboards and a set of alert rules with runbooks; audit and security events with
  a documented schema for your SIEM; **Administration → Observability** and `matelot doctor` show whether anything is
  listening.
- **CLI** `matelot` (npm package `matelot-cli`, GitHub Action `matelot-cloud/setup-cli`) with every action of the web
  app; an **MCP server** for AI assistants.
- **Operations**: scheduled backups to a volume or S3, restore and disaster-recovery procedures, `matelot doctor`.

**Installing**: follow the installation guide linked at the end of these notes. **Upgrading from a pre-release**: set
the new version (`image.tag` in your values file, `MATELOT_VERSION` in `.env`) and apply; database migrations run on
start. No setting was renamed between the pre-releases and this release.

### 2026-11-12 — Observability status that tells the truth, events from every component

What changed for an operator since the previous pre-release:

- **Administration → Observability and `matelot doctor` count the audit and security events of the api *and* the
  worker.** Policy-gate failures and job / pipeline transitions are emitted by the worker and were missing from the
  totals, so a blocked pipeline showed "0 security events". The page shows the counts per component and per pod.
- **Export failures are reported per signal**, each with its last error as one line — for example
  `OTLPExporterError: Not Found (HTTP 404) — POST http://tempo:4318/v1/logs`. A failing log export no longer shows up
  as a tracing failure.
- **A rollout no longer looks like a failure**: pods that were replaced or have stopped reporting are listed with
  their age and are not counted.
- **Test OTLP** waits for the export to finish and reports an endpoint that does not answer, instead of "sent".
- **CLI 2.25.1**: `matelot request GET /admin/observability` works without the `/api/v1` prefix; a request answered by
  the web app instead of the API is an error with a hint; `matelot doctor` prints `OK grafana` when a Grafana URL is
  set.

**Upgrade notes**

- OTLP log records (`observability.otlp.logs: true` on Helm, `MATELOT_OTLP_LOGS=1` on Compose) need an OTLP endpoint
  that accepts **logs** — an OpenTelemetry Collector or Grafana Alloy forwarding to Loki or your SIEM. Tempo accepts
  traces only: if your cell sends OTLP straight to Tempo, leave the setting off (the events remain JSON lines on
  stdout) or put a collector in between. The observability guide has an Alloy example.
- Update the CLI to 2.25.1 to read the new status fields; older CLIs keep working and show the api's counts only.
- No values or environment variables were renamed. No breaking changes.

### 2026-11-01 — Administration → Observability, `matelot doctor` observability checks, audit and security events for SIEMs

- **Administration → Observability** (cell administrators): whether metrics, tracing and OTLP log export are on, the
  last metrics scrape and trace per component, the OTLP endpoint with header names only (values are never shown), a
  **Test OTLP** button and a link to your Grafana (`observability.grafana.url` / `MATELOT_GRAFANA_URL`).
- **`matelot doctor`** gained an observability section (`metrics`, `tracing`, `events`, `grafana`) and `--test-otlp`.
- **Audit and security events**: every audit entry (`event.name = matelot.audit`) and every refusal — failed
  authentication, rejected CI token, denied access, rate limit, failed policy gate (`matelot.security`) — is written
  as a JSON line and, optionally, as an OpenTelemetry log record with a documented, stable set of attributes.
- **Dashboards**: runner long-polls no longer distort the request-latency panels; the 5xx ratio shows 0 instead of
  "no data".

**Upgrade notes**: new optional settings `observability.otlp.logs` and `observability.grafana.url`; nothing to change
for an existing installation.
