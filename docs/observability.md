# Observability — design

**Status:** design accepted (ADR 0004); **drop 1 (instrumentation) shipped**, drops 2–4 pending (plan at the end).
This page becomes the customer-facing `docs/observability.md` with the fourth drop; until then it is the
specification the drops are checked against. `docs/roadmap/v1.md` (M14) is the single place where status is ticked.

## Goal

A cell is observable out of the box, **with the customer's existing stack**. Every signal is standard — OTLP for
traces and logs, Prometheus exposition for metrics, JSON logs that carry the trace id — and we ship the dashboards
and alert rules. Nothing needs *our* Grafana: a customer with kube-prometheus-stack, Grafana Cloud, Datadog or an
OTel Collector of their own points one endpoint at the cell and is done. The Docker Compose quick start can bring a
small stack up on the same host with one profile, for evaluation and small teams.

## What a cell emits

| Signal | Producer | Transport | Default |
|---|---|---|---|
| Metrics | api, worker, runner (agent), Postgres and Redis exporters, registry, Keycloak | Prometheus exposition on a **separate port 9464** per pod (`/metrics`, no auth, never on the ingress); optional OTLP push | on |
| Traces | api, worker, runner | OTLP (gRPC or HTTP/protobuf) to `OTEL_EXPORTER_OTLP_ENDPOINT` | off until an endpoint is set |
| Logs | api, worker, runner | JSON on stdout (pino), one schema, `trace_id` / `span_id` / `request_id` on every line; collected by whatever reads container logs (Promtail / Alloy / Fluent Bit); optional OTLP | on |

Resource attributes on everything: `service.name` (`matelot-api` / `matelot-worker` / `matelot-runner`),
`service.version` (the image tag, from `APP_VERSION`), `deployment.environment` (`DEPLOYMENT_ENVIRONMENT`, default
`production`), `matelot.cell` (the tenant slug, `TENANT_SLUG`), `k8s.*` / `container.*` from the collector where
one runs. The runner adds `matelot.runner.name` and `matelot.runner.pool`.

### Traces

The OpenTelemetry SDK (`sdk-trace-node`) with the instrumentations for `http`, `express` (Nest runs on it; only the
route template, no per-middleware spans), `pg`, `ioredis` and `undici`/`fetch` in the API and the worker, started by
`apps/api/src/telemetry/tracing.ts`, preloaded with `node -r ./dist/telemetry/tracing.js` before Nest (the images'
entrypoints, Compose, `pnpm start`) — instrumentation must patch the modules before they load. Its contract:

* **A fast no-op when off.** Off is the default without an OTLP endpoint, or `MATELOT_TRACING_ENABLED=false`: the
  preload returns after one environment read, loads no SDK module and patches nothing (`tracing.spec.ts` asserts
  `require.cache`).
* **Never in the request path.** A `BatchSpanProcessor` exports asynchronously with a bounded queue (2048 spans, 512
  per batch, 5 s export timeout); an unreachable collector costs dropped spans and ONE warning per failure shape
  (counted, reported at shutdown) — never a slow request or a failed `/health/live`.
* **Clean shutdown.** SIGTERM / SIGINT and Nest's shutdown hook flush the queue with a 5 s cap, so the last spans of
  a pipeline job survive a pod rollout.

BullMQ needs no instrumentation package: `QueueService.enqueue` puts the active `traceparent` into the job data and
the worker's handlers run under it. The runner ships **no dependencies** (its image carries no `node_modules`), so it
has its own 300-line `telemetry.ts` with the same contract: W3C `traceparent` in, OTLP/HTTP JSON out (batched,
bounded, one warning, 5 s shutdown cap; `grpc` endpoints are refused with a warning), an `AsyncLocalStorage` current
span, child spans per phase.

**One trace per pipeline, end to end.** The pipeline queue is the `jobs` table (claimed by runners through
`POST /runner/jobs/claim`), not BullMQ, so propagation goes through our own protocol:

* **Ids are fixed when the pipeline is created, spans are emitted when things end.** `PipelineTelemetry.newTrace()`
  draws a trace id, a root span id for the pipeline and a span id per job, stored as W3C traceparents on the rows
  (`pipelines.trace_parent`, `jobs.trace_parent`, migration 0049). The pipeline's root span (`pipeline <name>`, start
  = created, end = terminal status) and each job's span (`job <kind>`, start = created so the queue wait is in it,
  events `claimed` / `started`, attributes `matelot.job.kind` = the job `type` — `repository_check`, `sbom`, `sca`,
  `sast`, `secrets`, `iac`, `policy_eval`, … — `matelot.job.id`, `matelot.pipeline.id`, project / service /
  organization ids, `matelot.runner.name`, `matelot.job.exit_code`, status) are emitted with those ids by whichever
  process finishes them (`PinnedIdGenerator`, `telemetry/ids.ts`): nothing is held in memory between requests, so
  API restarts and several replicas can neither lose nor duplicate a span. A retried job gets a new span id in the
  same trace.
* The claim response carries the job's traceparent (`Job.traceParent`); the runner starts `job run <kind>` under it
  with a child per phase (`checkout`, `tool syft` / `tool trivy` / `tool semgrep`, `upload sbom`, `upload findings`,
  `correlate`) and sends the `traceparent` header on every call back (`/start`, `/logs`, `/sbom`, `/code-findings`,
  `/complete`), so the API side of a job — SBOM ingestion, correlation, the gate — lands in the same trace.
* API → worker: `QueueService.enqueue` puts the active traceparent into the BullMQ job data (`__traceparent`), the
  handlers run under it (`queue github-sync`, `queue github-webhooks`). The worker's correlation loop runs as a root
  span `worker correlation`; the gate evaluation of a `policy_eval` job runs under that job's span (`gate evaluate`).
* Outbound integrations (GitHub, GitLab, Jira, registries, OSV / NVD mirrors) are `undici` client spans with
  `peer.service` set from the integration kind.

Sampling: `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`, default `parentbased_always_on` when an endpoint is
set (a cell does tens of requests per second at most). Never traced: `/health/*`, `/metrics`, the runners'
heartbeats (`/runner/heartbeat`, `/runner/jobs/:id/heartbeat`); the claim long-poll is traced (it is where a job
starts). Span attributes never carry a query string (`url.path` only): the redaction rule applies to spans too.

**Where to search.** The pipeline-level spans — `pipeline <name>` and the `job <kind>` spans — are emitted by
whichever process finishes the work (the API on a runner's `/complete`, the worker after a gate), so they carry a
resource of their own: service **`matelot-pipeline`** (attribute `matelot.emitted_by` names the process). In Jaeger
or Tempo: service `matelot-pipeline`, operation `pipeline Security pipeline`, or tag `matelot.pipeline.id=<id>`; the
request spans are under `matelot-api`, the phases under `matelot-runner`, the gate under `matelot-worker`.

**Span budget.** A security pipeline on kind first produced 1 824 spans, most of them Redis commands of the rate
limiter and BullMQ housekeeping, pool checkouts and sub-millisecond queries. `telemetry/trim.ts` drops, when a span
ends: ioredis housekeeping (`rl:` / `bull:` keys, `multi` / `exec` / `pexpire` / `evalsha`) whatever its duration and
any other Redis command under 5 ms; `pg-pool.connect` / `pg.connect` always and `pg.query:*` under 5 ms — a slow
query or command stays, and that is what the trace is for. The runner's log batches (`/logs`, dozens per job) are
sent with the trace's id but the sampled flag off, so the cell records no span for them; each batch is an event
`logs shipped` on the job span. The runners' claim long-poll (one request every 20 s per runner, with or without
work) is never a trace of its own: its request span is dropped by the same rules and the polling loop runs with
instrumentation suppressed, so an empty poll leaves nothing; a poll that hands out a job leaves one `claim` span in
the pipeline's trace under the job's span (`matelot.claim.polls`, `matelot.claim.waited_ms`, runner, pool). The
same for client polls: `matelot pipeline --wait` (and the correlation wait) sends each poll with a traceparent whose
sampled flag is off, and the cell's sampler (`telemetry/sampler.ts`) records no root trace for `GET
/pipelines/:id`, `/pipelines/:id/jobs`, `/jobs/:id`, `/jobs/:id/logs` and the correlation job endpoint from a client
that sends nothing — a poll inside a traced request stays a child of it. Worker timers are root spans named `worker
<loop>` (correlation, registry reconcile, exceptions, digest, remediation reconcile, snapshots, risk, usage, image
sync, enrichment); the every-few-seconds housekeeping (sweeper, gauges, platform heartbeat and the policy_eval queue
query) runs with instrumentation suppressed and the sweeper emits a `worker sweep` span only when it changed
something; module initialisation of the api and the worker (signing keys, caches) runs suppressed too — so every root
span is a request, a worker loop or a pipeline (the budget test fails on any other). `apps/api/test/span-budget.mjs` (CI, api job) runs a security pipeline through the
built api and worker with the real instrumentation and a fake runner, and fails above **150 spans** in the trace,
on any `/logs` span, when the root is not `pipeline Security pipeline` under `matelot-pipeline`, when any job of the
template lacks its `job <kind>`, `claim`, `/start` and `/complete` spans in the pipeline's trace (or has them in
another), when empty claim polls or `--wait` polls add a span, or when any root span is not a request, a `worker <loop>` or a
pipeline — today the trace holds 34 spans from the cell plus the runner's own (about 25 for the real one).

### Metrics

The OTel SDK's meter (`apps/api/src/telemetry/metrics.ts`) with explicit histogram buckets through Views — three
shapes of latency: **http** 5 ms–10 s, **pipeline jobs** 1 s–30 min, **correlation / ingestion** 100 ms–5 min — a
Prometheus / OpenMetrics page on port 9464 **and**, when `OTEL_METRICS_EXPORTER` includes `otlp`, a periodic OTLP push
of the same instruments. The page is rendered by our own serializer (`telemetry/exposition.ts`), not the SDK's
Prometheus exporter, for one reason: **trace exemplars**. The JS SDK collects none yet; ours attaches the last
sampled measurement per bucket as `# {trace_id="…",span_id="…"} <value> <ts>` to a scraper that accepts OpenMetrics
(Prometheus with `--enable-feature=exemplar-storage`; Grafana then jumps from a slow p95 bar to the exact trace).
Pipeline histograms point at the pipeline's trace, not at the HTTP request that reported the job. The format is
pinned by `exposition.spec.ts`: dots → underscores, the unit as suffix, `_total` on counters, `matelot_build_info` =
1, every label in the allowed set. Names follow the OTel conventions (`http.server.request.duration` →
`http_server_request_duration_seconds`); ours carry the `matelot_` prefix.

| Metric (Prometheus name) | Type | Labels | Source |
|---|---|---|---|
| `http_server_request_duration_seconds` | histogram | `http_request_method`, `http_route` (the **route template** `/api/v1/projects/:projectId`, never the raw path), `http_response_status_code` | api (interceptor after routing; probes excluded) |
| `db_client_connection_count` | gauge | `state` (used, idle, pending) | pool stats, every 5 s |
| `db_client_operation_duration_seconds` | histogram | `db_namespace`, `error_type` | the `pg` instrumentation (present while tracing is on), http buckets |
| `matelot_queue_jobs` | gauge | `queue` (`github-sync`, `github-webhooks`), `state` (waiting, active, delayed, failed) | worker, from BullMQ counts every 15 s |
| `matelot_queue_oldest_job_age_seconds` | gauge | `queue` | worker |
| `matelot_queue_jobs_processed_total` | counter | `queue`, `result` | worker (BullMQ events) |
| `matelot_pipeline_jobs_total` | counter | `kind`, `status` (succeeded, failed, cancelled, timed_out) | api, on `/complete` and the sweeper |
| `matelot_pipeline_job_duration_seconds` | histogram | `kind` | api, from `started_at` → `finished_at` |
| `matelot_pipeline_job_queue_wait_seconds` | histogram | `kind` | api, `created_at` → `started_at` |
| `matelot_pipeline_jobs_queued` | gauge | `kind`, `pool` | worker, `jobs` table every 15 s (the DB queue: depth and age below) |
| `matelot_pipeline_oldest_queued_job_age_seconds` | gauge | `pool` | worker |
| `matelot_pipelines_total` | counter | `status`, `trigger` | api |
| `matelot_runners_online` | gauge | `pool`, `managed` | worker, from heartbeats (online = heartbeat within 60 s) |
| `matelot_runners_busy` | gauge | `pool` | worker |
| `matelot_runner_last_seen_timestamp_seconds` | gauge | `pool` | worker: unix time of the newest heartbeat per pool, so `NoRunnerOnline` is `time() - … > 600`, an expression on the scrape |
| `matelot_runner_claims_total` | counter | `result` (job, empty, disconnected) | api |
| `matelot_runner_job_duration_seconds`, `matelot_runner_jobs_total`, `matelot_runner_busy` | histogram / counter / gauge | `kind`, `phase` / `kind`, `status` / — | runner (its own `/metrics`, `RUNNER_METRICS_PORT`; exemplars on the job histogram) |
| `matelot_sbom_ingest_duration_seconds`, `matelot_sbom_correlation_duration_seconds` | histogram | `source` | api / worker |
| `matelot_findings_open` | gauge | `severity`, `kind` (dependency, code) | worker, refreshed every 10 min with the correlation loop — **per cell, never per project** (cardinality) |
| `matelot_gate_evaluations_total` | counter | `result` (pass, fail, warn) | api |
| `matelot_sla_breaches` | gauge | `severity` | worker, hourly with the digest |
| `matelot_integration_sync_failures_total` | counter | `kind` (github, gitlab, jira, registry) | worker |
| `matelot_webhook_lag_seconds` | histogram | `provider` | worker (delivery time → processed) |
| `matelot_backup_last_success_timestamp_seconds`, `matelot_backup_last_duration_seconds` | gauge | — | drop 2: the backup CronJob reports to the API (`POST /internal/backup-report`, cell-local token); Compose `backup` service likewise |
| `matelot_license_seats_used`, `matelot_license_expiry_timestamp_seconds` | gauge | — | M13 (absent until licensing exists) |
| `matelot_build_info` | gauge (1) | `version`, `commit`, `node_version`, `component` | each process, from `/api/v1/version` data |

Rules: labels are bounded enumerations (kinds, statuses, pools, severities, route templates) — never ids, names,
repository paths or user input: `ALLOWED_LABELS` in `metrics.ts` is enforced at record time (an instrument with a
label outside it throws) and on the rendered page by the spec; the runner's metrics endpoint carries only its own
job histogram, counters and `build_info`; anything that needs a SQL query is computed in the worker on a timer
(`WorkerGauges`: queues and runners every 15 s, open findings with the 10-minute correlation loop) and exported as a
gauge whose absent series vanish, never on scrape.

Postgres and Redis: `postgres_exporter` and `redis_exporter` as sidecars of the bundled StatefulSets (off with
`postgres.bundled=false` — a managed database brings its own); Keycloak with `KC_METRICS_ENABLED=true` on its
management port (`/metrics`, already not on the ingress); the registry's debug port (`:5001/metrics`).

### Logs

pino stays. `apps/api/src/telemetry/log-schema.ts` (api + worker) and the runner's `JsonLogger` write one line shape —
`{"time","level","component","cell","msg","context","trace_id","span_id","request_id", …fields}` — `trace_id` /
`span_id` from the active span (a pino mixin), `request_id` from `x-request-id` as before; the runner's `console.*`
is gone. Log level per module: `LOG_LEVEL=info,jobs=debug,integrations.github=trace` (the first entry is the
default, then `module=level`, matched against Nest's logger context — `JobsService` is `jobs`). One redaction list
(`REDACTED_KEYS` in `log-schema.ts`: `authorization`, `cookie`, `password`, `secret`, `token`, `privateKey`,
`clientSecret`, `webhookSecret`, `apiKey`, `registrationToken`, `runnerToken`, …) applied at any depth to every
logger; `log-schema.spec.ts` logs an object carrying every known key, nested three levels, and fails if a value
survives. OTLP log export (`OTEL_LOGS_EXPORTER=otlp`) comes with drop 2 for customers whose collector prefers it to
scraping stdout; the stdout line is the primary.

Audit events and security events (gate failures, token misuse, sign-in anomalies) are also emitted as OTel log
records with a **stable** `event.name` (`matelot.audit`, `matelot.security`) and documented attributes, so a SIEM
ingests them without parsing our audit table (phase 4).

### Configuration

Standard OTel variables first, ours only where OTel has none. Every variable exists in both delivery forms
(`api-configmap.yaml` and `compose-init.sh`'s `env/api.env` — the existing rule) and in `apps/api/src/config/env.ts`.

| Variable | Meaning | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL` | where traces (and optionally metrics / logs) go; `grpc` or `http/protobuf` | unset → nothing is pushed |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | SDK sampler | `parentbased_always_on` |
| `OTEL_METRICS_EXPORTER` | `prometheus` (default), `otlp`, `none`, comma-separated (`prometheus,otlp` pushes too) | `prometheus` |
| `OTEL_TRACES_EXPORTER` | `otlp` (default), `console`, `file` (JSON lines to `OTEL_TRACES_FILE`; tests), `none` | `otlp` |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | override / extend the resource | set by the chart / compose per component |
| `MATELOT_METRICS_ENABLED`, `MATELOT_METRICS_PORT` | the `/metrics` listener | `true`, `9464` (runner: `RUNNER_METRICS_PORT`, `0` = off) |
| `MATELOT_TRACING_ENABLED` | the tracer provider (auto `true` when an endpoint is set; `false` forces it off) | derived |
| `DEPLOYMENT_ENVIRONMENT` | `deployment.environment` | `production` |
| `LOG_LEVEL` | default level, then `module=level` pairs | `info` |

`/api/v1/health/live` and `/ready` stay as they are. `/api/v1/version` carries `commit` and `builtAt` (`APP_COMMIT`,
`APP_BUILT_AT`, build arguments of the images set by the release workflow), the fields `matelot_build_info` carries.

## Delivery

Drop 1 gave every process its metrics port and its OTLP exporter; drop 2 delivers the signals to a stack — the
customer's (Helm: kube-prometheus-stack, Tempo, Loki, or anything that speaks OTLP and scrapes Prometheus) or the one
the Compose profile brings. Everything below is off by default: a cell installed with the chart's defaults renders
no monitoring CRD and runs on a bare kind cluster.

### Helm

```yaml
observability:
  environment: production         # deployment.environment on every signal
  metrics:
    enabled: true                 # /metrics on 9464 (api, worker, managed runners) + the scrape NetworkPolicy
    port: 9464
    scrapeFromNamespaces: [monitoring, observability]   # the only namespaces admitted to the metrics ports
    serviceMonitor:
      enabled: false              # one ServiceMonitor for every metrics Service below (needs the operator's CRDs)
      labels: {}                  # e.g. release: kube-prometheus-stack — what the Prometheus's selector wants
      interval: 30s
      scrapeTimeout: 10s
    exporters:
      enabled: false              # postgres_exporter / redis_exporter sidecars, Keycloak metrics, registry debug port
  otlp:
    endpoint: ""                  # e.g. http://tempo.monitoring:4318 → OTEL_* on every component
    protocol: http/protobuf       # or grpc
    headersSecret: ""             # a Secret holding OTEL_EXPORTER_OTLP_HEADERS (Grafana Cloud's token) — never values
    headersSecretKey: OTEL_EXPORTER_OTLP_HEADERS
    tracesSampler: parentbased_always_on
    tracesSamplerArg: ""
    metrics: false                # also push metrics over OTLP (OTEL_METRICS_EXPORTER=prometheus,otlp)
```

What renders:

* **Metrics Services.** One headless Service per target, `<release>-<name>-metrics`, port named `metrics`, labels
  `matelot.cloud/metrics: "true"` and `matelot.cloud/job: matelot-<name>`: api, worker, runner (managed runners),
  and with `exporters.enabled` postgres (9187) and redis (9121) when bundled, keycloak (9000, the management port)
  when bundled, registry (5001) when the built-in registry is on. They exist with or without the operator — any
  Prometheus can discover them by label.
* **ServiceMonitor** `<release>` (`serviceMonitor.enabled`): selects exactly those Services in the release's
  namespace, `jobLabel: matelot.cloud/job` (so the job is `matelot-api`, `matelot-postgres`, …), one endpoint on port
  `metrics`, and a relabel adding `cell=<slug>`. Rendering it with `metrics.enabled=false` fails with a message.
* **Exporters** (`exporters.enabled`): `postgres_exporter` v0.20.0 as a sidecar of the bundled Postgres
  (`localhost:5432`, credentials from the `<release>-postgres` Secret), `redis_exporter` v1.94.0 as a sidecar of the
  bundled Redis — neither with `bundled: false` (point your own exporter at the managed service); Keycloak gets
  `KC_METRICS_ENABLED=true` (`/metrics` on the management port 9000, which never reaches the ingress); the registry
  gets its `http.debug` listener on 5001 with Prometheus metrics. All of them run as non-root with a read-only root.
* **NetworkPolicy** `<release>-allow-metrics-scrape`: ingress to 9464 (+ 9187, 9121, 9000, 5001 with the exporters)
  only from `scrapeFromNamespaces`. No metrics Service is referenced by the ingress (`chart-test` asserts it).
* **OTLP headers** come only from a Secret: `observability.otlp.headersSecret` names it, every component gets
  `OTEL_EXPORTER_OTLP_HEADERS` through a `secretKeyRef`. The old `observability.otlp.headers` map is refused at
  render time ("tokens do not belong in values").
* **Backups** report themselves: the backup CronJob POSTs its outcome to the API (`/api/v1/internal/backup-reports`,
  a generated bearer `BACKUP_REPORT_TOKEN` in `<release>-api-secrets`, also on S3 uploads), and the worker publishes
  `matelot_backup_last_success_timestamp_seconds`, `matelot_backup_last_failure_timestamp_seconds` and
  `matelot_backup_last_duration_seconds` — the same gauges on Compose, where no kube-state-metrics exists.

`chart-test` renders defaults, OTLP on, metrics off, everything on and everything on with external Postgres / Redis,
and asserts among others: no `monitoring.coreos.com` resource with defaults; every ServiceMonitor endpoint port
exists on a Service whose selector matches a pod exposing that port; the job list per configuration; exporter args
and env; the NetworkPolicy ports; the backup report env for PVC and S3. CI's kind step installs the
prometheus-operator CRDs only (v0.94.1, the version kube-prometheus-stack 92.11.0 ships) and runs the server-side dry
run of the everything-on render, fresh and over an existing release.

### kube-prometheus-stack recipe

The values the drop was validated with are in `deploy/observability/kind/` (published as `examples/observability/` in
the helm-charts repository) — `make kind-observability TENANT=<slug>`
installs them and switches the cell on (or `scripts/kind-observability.sh <slug> --print` for the bare commands):

```sh
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack --version 92.11.0 \
  -n monitoring --create-namespace -f deploy/observability/kind/kube-prometheus-stack.values.yaml --wait
helm upgrade --install tempo grafana/tempo --version 1.24.4 -n monitoring -f deploy/observability/kind/tempo.values.yaml --wait
helm upgrade --install loki  grafana/loki  --version 7.3.0  -n monitoring -f deploy/observability/kind/loki.values.yaml --wait
helm upgrade --install alloy grafana/alloy --version 1.14.1 -n monitoring -f deploy/observability/kind/alloy.values.yaml --wait
```

and in the cell's values file (`deploy/cells/<slug>.values.yaml`, then `cell-provision.sh apply --slug <slug>`):

```yaml
observability:
  metrics:
    serviceMonitor:
      enabled: true
      labels: { release: kube-prometheus-stack }   # = the kube-prometheus-stack release name
    exporters:
      enabled: true
  otlp:
    endpoint: "http://tempo.monitoring:4318"
    protocol: http/protobuf
```

What matters in the stack's values: `prometheus.prometheusSpec.enableFeatures: [exemplar-storage]` (the trace links
on the histograms) and `serviceMonitorNamespaceSelector: {}` (cells live in `tenant-<slug>`); Grafana's
`sidecar.datasources.exemplarTraceIdDestinations` (`trace_id` → Tempo) and the Tempo / Loki datasources with
trace → logs by `trace_id`; Alloy turning our JSON log lines' `trace_id` / `span_id` into Loki structured metadata.
On a **real cluster** keep all of that and change: Grafana's admin password from a Secret
(`grafana.admin.existingSecret`), persistence and retention sized for the cluster (Prometheus
`storageSpec`, Loki / Tempo on object storage — `loki.storage.type: s3`, `deploymentMode: SimpleScalable`, Tempo
`storage.trace.backend: s3`), Alertmanager on, Alloy as a DaemonSet with `loki.source.file` over `/var/log/pods` if
the API-based tailing is too much load, and Grafana's ingress behind your SSO.

### Docker Compose

`COMPOSE_PROFILES=observability` in `.env` (or `docker compose --profile observability up -d`) adds:

| Service | Image | Role |
|---|---|---|
| `otel-collector` | otel/opentelemetry-collector-contrib 0.163.1 | OTLP in (the cell's `MATELOT_OTLP_ENDPOINT` defaults to `http://otel-collector:4318` with the profile), `matelot.cell` resource attribute, traces → Tempo |
| `prometheus` | prom/prometheus v3.15.0 | scrapes api, worker, runner (9464), the exporters, Keycloak (9000), the registry (5001) and the stack itself; exemplar storage on; 7 days |
| `tempo` | grafana/tempo 2.9.0 | single binary, local storage, 7 days |
| `loki` | grafana/loki 3.6.12 | single binary, TSDB v13 on the filesystem, structured metadata, 7 days |
| `alloy` | grafana/alloy v1.21.0 | the logs of this compose project's containers (Docker socket, read-only) → Loki; `trace_id` / `span_id` as structured metadata, `level` / `component` / `cell` / `compose_service` labels |
| `grafana` | grafana/grafana 12.4.12 | at `<domain>/grafana/` through Caddy; datasources provisioned (Prometheus exemplars → Tempo, Tempo → Loki by `trace_id`, Loki `trace_id` → Tempo) |
| `postgres-exporter`, `redis-exporter` | as on Helm | the bundled database and cache |

`init` renders their configuration into the config volume (the cell's slug substituted), turns on Keycloak's metrics
and the registry's debug listener, and generates Grafana's secrets like every other one. Grafana signs users in with
the cell's Keycloak (client `grafana`, confidential; `realm-sync` creates it in a realm that predates the profile);
they arrive as Viewers. The local `admin` account is for the operator: `docker compose run --rm init show` prints its
password. No service of the profile publishes a port — Prometheus, Tempo and Loki are reachable only on the compose
network and through Grafana. Alloy needs `/var/run/docker.sock` (read-only); that is a privileged handle on the host,
which is what container log collection costs — leave the profile off where that is not acceptable and send OTLP to
your own collector instead.

`smoke.sh --observability` (a second CI pass) brings the cell up with the profile and, through Caddy and Grafana's
datasource proxy only: the datasources and the Keycloak sign-in redirect; every Prometheus target `up`;
`matelot_build_info` from api / worker / runner; one series from each exporter; a `checkout` pipeline on a public
repository whose trace is in Tempo with `matelot-pipeline` and `matelot-runner` spans and whose log lines are in Loki
by `trace_id`; a backup run producing `matelot_backup_last_success_timestamp_seconds`.

### For customers who run their own collector

Point the cell at the collector (`observability.otlp.endpoint`, or `MATELOT_OTLP_ENDPOINT` on Compose) and let the
collector scrape the metrics Services. The configuration we recommend:

```yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }
  prometheus:
    config:
      scrape_configs:
        - job_name: matelot
          scrape_interval: 30s
          kubernetes_sd_configs: [{ role: endpoints }]
          relabel_configs:   # the cell's metrics Services only, job = matelot-<name>, cell = the namespace's slug
            - { source_labels: [__meta_kubernetes_service_label_matelot_cloud_metrics], regex: "true", action: keep }
            - { source_labels: [__meta_kubernetes_endpoint_port_name], regex: metrics, action: keep }
            - { source_labels: [__meta_kubernetes_service_label_matelot_cloud_job], target_label: job }
            - { source_labels: [__meta_kubernetes_namespace], regex: "tenant-(.+)", target_label: cell }
processors:
  memory_limiter: { check_interval: 1s, limit_percentage: 80, spike_limit_percentage: 20 }
  k8sattributes:
    extract: { metadata: [k8s.namespace.name, k8s.pod.name, k8s.deployment.name, k8s.statefulset.name] }
  batch: {}
exporters:
  prometheusremotewrite: { endpoint: https://prometheus.example.com/api/v1/write }
  otlp/tempo: { endpoint: tempo.monitoring:4317, tls: { insecure: true } }
  otlphttp/loki: { endpoint: http://loki.monitoring:3100/otlp }
service:
  pipelines:
    traces:  { receivers: [otlp], processors: [memory_limiter, k8sattributes, batch], exporters: [otlp/tempo] }
    metrics: { receivers: [prometheus, otlp], processors: [memory_limiter, k8sattributes, batch], exporters: [prometheusremotewrite] }
```

The collector's namespace must be in `observability.metrics.scrapeFromNamespaces`. Keep exemplars: the
`prometheusremotewrite` exporter forwards them when the receiving Prometheus has `exemplar-storage` on. Logs stay on
stdout as JSON (one schema, `trace_id` / `span_id` included) for whatever ships pod logs — Alloy, Fluent Bit, the
collector's `filelog` receiver; promote `trace_id` to structured metadata (Loki) or a field (Elastic), never to an
index label. Grafana Cloud: one OTLP endpoint with basic auth — put `Authorization=Basic <base64 instance:token>` in a
Secret under the key `OTEL_EXPORTER_OTLP_HEADERS` and name it in `observability.otlp.headersSecret`.

## Dashboards and alerts

Dashboards are JSON in `deploy/observability/dashboards/*.json`, one source reused by the chart (ConfigMaps) and
Compose (Grafana provisioning); the datasource is a `${DS_PROMETHEUS}` / `${DS_TEMPO}` input so they import into
any Grafana. Four of them:

1. **Cell overview** — health of every component (build_info present + up), RED per route group, queue depth
   (BullMQ and the pipeline queue), runners online / busy, pipelines per hour and success rate, DB connections and
   query latency, Redis latency, disk (backups PVC, registry PVC, Postgres PVC from kubelet metrics), certificate
   expiry (cert-manager / Caddy metrics), backup age.
2. **Pipelines** — per-kind durations p50 / p95, failures by kind, queue wait, runner utilisation, and a link from a
   pipeline row to its trace in Tempo (`matelot.pipeline.id` data link).
3. **Security posture** — open findings by severity over time, gate pass / fail rate, SLA breaches, SBOM coverage —
   the business gauges from the worker.
4. **Integrations** — sync failures by kind, webhook lag, registry pulls / pushes.

Alerts (`deploy/observability/rules/matelot.yaml`, the PrometheusRule's source), each with a `runbook_url` into
the alerts section of the customer page:

| Alert | Condition | Severity |
|---|---|---|
| `MatelotApiDown` | `up{job="matelot-api"} == 0` for 2 m, or no `matelot_build_info{component="api"}` | critical |
| `MatelotWorkerDown` | no worker `build_info` / `up == 0` for 5 m | critical |
| `MatelotNoRunnerOnline` | `sum(matelot_runners_online) == 0` for 10 m while `matelot_pipeline_jobs_queued > 0` | warning |
| `MatelotQueueBacklog` | `matelot_pipeline_oldest_queued_job_age_seconds > 600` or BullMQ oldest > 600 s for 10 m | warning |
| `MatelotPipelineFailureRate` | failed / total over 1 h > 50 % with ≥ 5 pipelines | warning |
| `MatelotDbConnectionsHigh` | pool in use > 80 % of `DB_POOL_MAX` for 10 m | warning |
| `MatelotBackupFailed` | the backup CronJob's last run failed (kube-state-metrics `kube_job_status_failed`) or `matelot_backup_last_success_timestamp_seconds` older than 2 × the schedule | critical |
| `MatelotBackupTooOld` | last success > 36 h | warning |
| `MatelotCertificateExpiring` | `certmanager_certificate_expiration_timestamp_seconds - time() < 14 d` | warning |
| `MatelotDiskAlmostFull` | any cell PVC `kubelet_volume_stats_available_bytes / capacity < 10 %` | critical |
| `MatelotKeycloakDown` | Keycloak `up == 0` for 2 m | critical |
| `MatelotLicenseExpiring` | `matelot_license_expiry_timestamp_seconds - time() < 14 d` (M13) | warning |

CI validates the dashboards (`dashboard-linter`) and the rules (`promtool check rules`, `promtool test rules`
with unit tests for `NoRunnerOnline`, `QueueBacklog`, `BackupTooOld`); `docs/observability.md` carries screenshots
of the four dashboards from the kind acceptance run.

## Product-facing (phase 4)

* **Settings → Observability** (cell administrators, under Administration): what is enabled (metrics, tracing, log
  export), the configured endpoints (headers masked), the last scrape time per component (each process records the
  time of its last `/metrics` request), a **Test OTLP** button (the API sends one span and reports the exporter's
  result), and the Grafana link when `observability.grafana.url` is set.
* `matelot doctor` gains an *observability* section: metrics endpoint reachable (through the API, since 9464 is
  not public), OTLP configured, last trace seen, last scrape.
* Audit and security events as OTel logs (schema above), documented field by field.
* Public docs: this page, rewritten for customers (recipes, dashboard gallery, alert list with runbooks, collector
  config).

## Security

* Metrics ports are never on the ingress; the NetworkPolicy limits them to the monitoring namespace(s); the Compose
  stack publishes none of them on the host — Prometheus scrapes on the compose network and Grafana is behind Caddy
  + Keycloak.
* No label or span attribute carries a secret, a token, a repository URL with credentials, or user input; route
  templates, not paths; the redaction list applies to logs *and* to span attributes (`http.url` is recorded without
  query string).
* OTLP headers (Grafana Cloud tokens) live in a Secret the operator creates (`observability.otlp.headersSecret`),
  referenced by every pod through a `secretKeyRef`; the chart refuses headers in values.
* The backup report endpoint is unauthenticated for users and accepts only the generated `BACKUP_REPORT_TOKEN`
  (compared in constant time); it is not in the OpenAPI document.
* Business gauges are per cell (the customer's own cell): no cross-tenant data exists in a cell.

## Plan — four drops

| Drop | Content | Acceptance |
|---|---|---|
| 1 — instrumentation ✅ | `tracing.ts` preload + SDK in api / worker; runner spans and `traceParent` in the claim protocol (`pipelines.trace_parent`, `jobs.trace_parent`, migration 0049); meter with Views + our exposition on 9464 (exemplars); log schema, per-module levels, redaction list + test; env in `env.ts`, `api-configmap.yaml`, `compose-init`; `/version` with commit; `make kind-jaeger` | `exposition.spec.ts` (format, buckets, exemplars, labels), `log-schema.spec.ts` (redaction, levels, trace ids), `tracing.spec.ts` (no-op when off, provider when on), `pipeline-trace.spec.ts` (create → claim → complete: one trace, pinned ids, parents, exemplars, BullMQ propagation), runner `telemetry.test.ts`; verified against a real Jaeger 2.22: a security pipeline (checkout, syft, trivy, semgrep, gate) is one trace across api, runner and worker |
| 2 — delivery | `observability.*` values, metrics Services + one ServiceMonitor, NetworkPolicy, exporter sidecars, Keycloak metrics, registry debug port, OTLP headers from a Secret only, backup reports → backup gauges; chart-test on / off; CI kind with the operator CRDs; Compose profile with collector, Prometheus, Tempo, Loki, Grafana (Keycloak sign-in), Alloy; `smoke.sh --observability`; the collector config and the kube-prometheus-stack recipe above; `make kind-observability` | chart-test and CI green; Compose smoke with the profile green (targets up, trace in Tempo, logs in Loki); on kind with the recipe: `apply` passes, every matelot target UP, `matelot_build_info` for api / worker / runner, the exporters' series, a demo-app pipeline trace in Tempo with its logs in Loki |
| 3 — dashboards and alerts | the four dashboards, the rules file, `promtool` / linter in CI, PrometheusRule and dashboards ConfigMaps, Grafana provisioning in Compose, screenshots | kind with kube-prometheus-stack + Tempo + Loki: dashboards show the demo pipeline; `NoRunnerOnline` fires with runners scaled to 0; `BackupFailed` fires when the CronJob is made to fail |
| 4 — product | Settings → Observability, doctor section, audit / security events as OTel logs, customer docs | render tests for the page; doctor test; the SIEM schema documented and covered by a test that pins the field names |

Acceptance for the milestone: on kind with kube-prometheus-stack, Tempo and Loki installed from their charts and
`observability.*` on, all targets up, our dashboards in Grafana with data from the demo-app pipeline, one pipeline
trace end to end in Tempo with its logs correlated in Loki by `trace_id`, and the two alerts above firing on demand;
the Compose profile reaches the same on one host.

## Out of scope

Our own hosted Grafana or a multi-cell fleet view (that is step 17, the control plane); profiling (pprof / Pyroscope);
synthetic checks from outside the cell (the customer's uptime tooling does that against `/api/v1/health/ready`);
metrics per project or per user (cardinality; the product's own dashboards cover that from the database).
