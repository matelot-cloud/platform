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
the pipeline's trace under the job's span: it starts when the job became claimable (`jobs.queued_at` — creation for
the first stage, the stage opening for later ones, a retry or a lost lease afterwards; the job span has a `queued`
event there) and ends at the hand-out, so it is the job's queue wait and never starts before its parent; the runner's
own long-poll wait, which may have begun before the job existed, is only the attribute `matelot.claim.waited_ms`
(with `matelot.claim.polls`, runner, pool). **Client polls** are never a trace of their own: the web app marks every
background refetch (its refresh interval, a window regaining focus, an invalidation when a job finished) and the CLI
its `--wait` loops with `x-matelot-poll: 1` (the CLI also sends a traceparent whose sampled flag is off, for older
cells); the cell's sampler (`telemetry/sampler.ts`) records no root for a GET that carries the header, nor for `GET
/pipelines/:id`, `/pipelines/:id/jobs`, `/jobs/:id`, `/jobs/:id/logs` and the correlation job endpoint from any
client. Every other parentless GET is recorded for a share of the trace ids — `MATELOT_TRACES_GET_RATIO`
(`observability.otlp.getRatio`, default 0.1): reads are many and alike, one in ten shows the latency profile —
and mutations (POST, PUT, PATCH, DELETE) always; a request inside a sampled trace follows its parent, poll or not.
One open tab was ~150 root traces in 10 minutes (jobs/active, audit-events, /me, …) before this. Worker timers are
root spans named `worker <loop>` (correlation, registry reconcile, exceptions, digest, remediation reconcile,
snapshots, risk, usage, image sync, enrichment) under service `matelot-worker`; the every-few-seconds housekeeping
(sweeper, gauges, platform heartbeat and the policy_eval queue query) runs with instrumentation suppressed and the
sweeper emits a `worker sweep` span (also `matelot-worker`: only a pipeline's root and job spans belong to
`matelot-pipeline`) only when it changed something; module initialisation of the api and the worker (signing keys,
caches) runs suppressed too — so every root span is a request, a worker loop or a pipeline (the budget test fails on
any other). `apps/api/test/span-budget.mjs` (CI, api job) runs a security pipeline through the
built api and worker with the real instrumentation and a fake runner, and fails above **150 spans** in the trace,
on any `/logs` span, when the root is not `pipeline Security pipeline` under `matelot-pipeline`, when any job of the
template lacks its `job <kind>`, `claim`, `/start` and `/complete` spans in the pipeline's trace (or has them in
another), when empty claim polls or `--wait` polls add a span, when a simulated web session (ten marked polls of four
routes) adds a root, when a span starts before or ends after its parent, when a span other than a pipeline's root or
job carries service `matelot-pipeline`, or when any root span is not a request, a `worker <loop>` or a
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

**Every enumerable series exists from the first scrape, at zero** (`KNOWN_LABEL_SETS` in `metrics.ts`,
`seedKnownSeries`; the runner's `telemetry.ts` likewise): job kind × terminal status, pipeline status × trigger, claim
and gate results, queue × result, the correlation / sync / webhook sets — counters through `add(0)`, histograms as
empty buckets rendered by the serializer until observed. A series that first appears at its observed value gives
`rate()` and `increase()` nothing for that first event: the alert on the first failed job and the p95 after the first
pipeline were both NaN. Both the api and the worker publish the pipeline families (either process can be the one
that finishes a given job: the runner API, the worker's policy_eval, a timeout, a cancel), so dashboards sum over
`job`. What stays lazy, because its label set is not known at startup: the HTTP histogram (route template × method ×
status) and the per-pool gauges — their queries use `or vector(0)` / `absent()` where a missing series matters.

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
| `matelot_pipeline_job_queue_wait_seconds` | histogram | `kind` | api, `queued_at` → `started_at` (queued = claimable: creation for the first stage, the stage opening for later ones) |
| `matelot_pipeline_jobs_queued` | gauge | `kind`, `pool` | worker, `jobs` table every 15 s (the DB queue: depth and age below) |
| `matelot_pipeline_oldest_queued_job_age_seconds` | gauge | `pool` | worker |
| `matelot_pipelines_total` | counter | `status`, `trigger` | api |
| `matelot_runners_online` | gauge | `pool`, `managed` | worker, from heartbeats (online = heartbeat within 60 s) |
| `matelot_runners_busy` | gauge | `pool` | worker |
| `matelot_runner_last_seen_timestamp_seconds` | gauge | `pool` | worker: unix time of the newest heartbeat per pool, so `NoRunnerOnline` is `time() - … > 600`, an expression on the scrape |
| `matelot_runner_claims_total` | counter | `result` (job, empty, disconnected) | api |
| `matelot_runner_job_duration_seconds`, `matelot_runner_jobs_total`, `matelot_runner_busy` | histogram / counter / gauge | `kind`, `phase` / `kind`, `status` / — | runner (its own `/metrics`, `RUNNER_METRICS_PORT`; exemplars on the job histogram) |
| `matelot_sbom_ingest_duration_seconds`, `matelot_sbom_correlation_duration_seconds` | histogram | `source` (runner, ci_upload, manual / loop) | api (`SbomService.ingest`) / worker |
| `matelot_findings_open` | gauge | `severity`, `kind` (dependency, code) | worker, refreshed every 10 min with the correlation loop — **per cell, never per project** (cardinality) |
| `matelot_gate_evaluations_total` | counter | `result` (pass, fail, warn) | api |
| `matelot_sla_breaches` | gauge | `severity` | worker, every 10 min with the findings refresh: open / in-progress remediations past `due_at` |
| `matelot_integration_sync_failures_total` | counter | `kind` (github, gitlab, jira, registry) | worker |
| `matelot_webhook_lag_seconds` | histogram | `provider` | worker (delivery time → processed) |
| `matelot_backup_last_success_timestamp_seconds`, `matelot_backup_last_failure_timestamp_seconds`, `matelot_backup_last_duration_seconds` | gauge | — | worker, from the backup reports (`POST /api/v1/internal/backup-reports`, cell-local token) the backup CronJob / Compose `backup` service send |
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

Grafana gets `GF_PLUGINS_PREINSTALL_DISABLED=true` there and on Compose: Grafana 12 otherwise downloads plugins
(pyroscope, exploretraces, metricsdrilldown) from the internet on every start, which an air-gapped cluster cannot do
and none of our dashboards needs. What matters in the stack's values: `prometheus.prometheusSpec.enableFeatures: [exemplar-storage]` (the trace links
on the histograms) and `serviceMonitorNamespaceSelector: {}` (cells live in `tenant-<slug>`); Grafana's
`sidecar.datasources.exemplarTraceIdDestinations` (`trace_id` → Tempo) and the Tempo / Loki datasources with
trace → logs by `trace_id`; Alloy turning our JSON log lines' `trace_id` / `span_id` into Loki structured metadata.
On a **real cluster** keep all of that and change: Grafana's admin password from a Secret
(`grafana.admin.existingSecret`), persistence and retention sized for the cluster (Prometheus
`storageSpec`, Loki / Tempo on object storage — `loki.storage.type: s3`, `deploymentMode: SimpleScalable`, Tempo
`storage.trace.backend: s3`), Alertmanager on, Alloy as a DaemonSet with `loki.source.file` over `/var/log/pods` if
the API-based tailing is too much load, and Grafana's ingress behind your SSO.

### Docker Compose

`COMPOSE_PROFILES=observability` in `.env` (or `docker compose --profile observability up -d`) — on a new cell or an
existing one: `init` rewrites the Caddyfile on every `up` and Caddy reloads it (`caddy run --watch`), so `/grafana/`
appears without recreating anything — adds:

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

Four dashboards and one rules file, shipped twice from one source: `deploy/observability/dashboards/*.json` and
`deploy/observability/rules/*.yaml`, copied into the chart (`files/observability`) and the Compose profile
(`init/observability`) by `python3 tools/dashboards/build.py` (`make dashboards`) — `chart-test` fails when a copy
differs. The dashboards are **generated**: edit `tools/dashboards/build.py`, never the JSON. `tools/dashboards/test.py`
(CI, chart job) regenerates and compares, parses every panel query and rule expression with `promtool`, and checks
that every metric a query names is one a process emits — ours from the instrument declarations in
`telemetry/metrics.ts` and the runner's `telemetry.ts`, the exporters' and Kubernetes' from its allowlist — so a
dashboard cannot plot a metric nobody publishes. The rules' unit tests (`rules/matelot_test.yaml`, `promtool test
rules`) run there too.

Every query is scoped to the **`cell`** variable (`label_values(matelot_build_info, cell)`): on Helm the ServiceMonitor's
relabel adds `cell=<slug>` to every series; on Compose the scrape jobs carry it as a target label (an external label
would not reach the rules or the variable). The datasources are inputs (`${DS_PROMETHEUS}`, `${DS_TEMPO}`) in the
source JSON, so it imports into any Grafana; the chart resolves them to the uids of
`observability.grafana.dashboards.datasources` (kube-prometheus-stack's `prometheus`, our `tempo`) and compose-init to
its provisioned datasources, because provisioning does not resolve inputs.

| Dashboard (uid) | Rows |
|---|---|
| **Cell overview** (`matelot-cell-overview`) | Components (api, worker, Keycloak, Postgres, Redis, registry up; runners online; version) · Traffic RED (requests/s by route, 5xx ratio, p50/p95/p99) · Queues and runners (pipeline jobs queued by kind, oldest queued job by pool, runners online/busy, BullMQ by queue and state) · Pipelines (per hour by status, success rate, jobs finished) · Database and cache (pool connections per process, query p95, Postgres transactions and size, Redis commands and memory) · Backups, storage and certificates (backup age, duration, last failure; PVC usage and certificate expiry from the cluster — empty on Compose) |
| **Pipelines** (`matelot-pipelines`, variable `kind`) | Jobs (duration p95/p50 by kind with exemplars, finished per hour by status, failures by kind, queue wait p95, the runners' own duration) · Runners (utilisation, claims/s by result, online by pool) · Pipelines (duration p95 by status, per hour by trigger, a 24 h table by kind). The traces: the exemplar dots open the job's trace in Tempo; a text panel gives the TraceQL for the failed pipelines |
| **Security posture** (`matelot-security-posture`) | Findings (open by severity and kind, critical/high stats, SLA breaches, total) · Gates and SLAs (evaluations per hour by result, fail ratio, breaches by severity) · SBOMs (ingested per hour by source, ingest p95, correlation run p95) |
| **Integrations** (`matelot-integrations`) | Source and issue trackers (sync failures by kind, worker queue jobs by result, webhook lag p95, failed BullMQ jobs) · Built-in registry (requests/s by handler and method = pulls and pushes, 4xx/5xx, p95) · Keycloak (active requests, JVM heap, Agroal pool) |

Two gauges that existed as instruments but were never set now are: `matelot_sla_breaches{severity}` (open or
in-progress remediations past their due date, with the findings refresh every 10 minutes) and
`matelot_sbom_ingest_duration_seconds{source}` (around `SbomService.ingest`; source = runner, ci_upload, manual).
"SBOM coverage" as a per-service ratio is the product's own Coverage page, not a cell metric (it would be per
service: cardinality); the dashboard shows ingests per hour by source. Where the design said "a link from a pipeline
row to its trace", the metrics carry no pipeline ids (labels are bounded sets), so the link is the exemplar on the
duration histograms plus the TraceQL panel.

**Helm:** `observability.prometheusRules.enabled` renders the PrometheusRule `<release>` (labels from
`prometheusRules.labels`, e.g. `release: kube-prometheus-stack`; `prometheusRules.kubernetes: false` leaves out the
group that needs kube-state-metrics / kubelet / cert-manager; `runbookBaseUrl` rewrites every `runbook_url`);
`observability.grafana.dashboards.enabled` renders one ConfigMap per dashboard with `grafana_dashboard: "1"` and the
`grafana_folder: Matelot` annotation for the sidecar (`deploy/observability/kind/kube-prometheus-stack.values.yaml`
sets `sidecar.dashboards.folderAnnotation` and `ruleNamespaceSelector: {}`). Both need `metrics.enabled` and the
operator's CRDs; `make kind-observability` switches them on with the rest. **Compose:** the profile's Prometheus loads
`rules/matelot.yaml` (its `/alerts` page shows them; Grafana's alert list too) and Grafana provisions the four
dashboards into folder *Matelot*; `smoke.sh --observability` asserts the dashboards, the rules and that the inputs
resolved. Screenshots of the dashboards are not in this repository: they come from the kind acceptance run.

### Alerts

`deploy/observability/rules/matelot.yaml` (every stack) and `matelot-kubernetes.yaml` (Kubernetes metrics). Each
alert links here (`runbook_url`, `#alert-<name>`); severities: *critical* = users or data are affected now, *warning*
= they will be. Prometheus evaluates them; routing to a pager is the customer's Alertmanager.

| Alert | Condition | Severity |
|---|---|---|
| `MatelotApiDown` | `up{job="matelot-api"} == 0` for 2 m | critical |
| `MatelotApiAbsent` | no `matelot-api` target at all for 5 m | critical |
| `MatelotWorkerDown` | `up{job="matelot-worker"} == 0` for 5 m | critical |
| `MatelotKeycloakDown` | `up{job="matelot-keycloak"} == 0` for 2 m | critical |
| `MatelotNoRunnerOnline` | runners online = 0 (or none ever reported) while `matelot_pipeline_jobs_queued > 0`, for 10 m | warning |
| `MatelotQueueBacklog` | oldest queued pipeline job or BullMQ job older than 600 s, for 10 m | warning |
| `MatelotPipelineFailureRate` | failed / total pipelines over 1 h > 50 % with ≥ 5 pipelines, for 15 m | warning |
| `MatelotDbConnectionsHigh` | a process has > 8 of its 10 pool connections in use, or callers waiting, for 10 m | warning |
| `MatelotBackupFailed` | the last backup report is a failure newer than the last success, for 5 m | critical |
| `MatelotBackupTooOld` | last success older than 36 h, for 1 h | warning |
| `MatelotLicenseExpiring` | `matelot_license_expiry_timestamp_seconds - time() < 14 d` (absent until M13) | warning |
| `MatelotBackupJobFailed` (k8s) | `kube_job_status_failed` of a `*-backup-*` Job in a `tenant-*` namespace | critical |
| `MatelotCertificateExpiring` (k8s) | `certmanager_certificate_expiration_timestamp_seconds - time() < 14 d` | warning |
| `MatelotDiskAlmostFull` (k8s) | a `tenant-*` PVC under 10 % free (kubelet volume stats), for 15 m | critical |

Runbooks:

#### Alert: MatelotApiDown
The api pod answers no scrape. `kubectl -n tenant-<slug> get pods` / `docker compose ps`: a crash loop shows in the
restart count; `kubectl logs deploy/<slug>-api --previous` has the reason — most often the database unreachable at
start (`DATABASE_URL`, Postgres down: see Postgres on the Cell overview) or a failed migration (the init container's
log). `/api/v1/health/ready` through the ingress says whether users are affected; if only the metrics port is
unreachable the NetworkPolicy or the ServiceMonitor changed (`scrapeFromNamespaces`).

#### Alert: MatelotApiAbsent
Prometheus has no target: the metrics Service is gone (`kubectl -n tenant-<slug> get svc <slug>-api-metrics`), the
ServiceMonitor is not selected (its labels must match the Prometheus's `serviceMonitorSelector` — the `release` label
of kube-prometheus-stack), or `observability.metrics.enabled` was turned off while this rule stayed loaded.

#### Alert: MatelotWorkerDown
Background work stopped: source sync, webhooks, correlation, the policy_eval stage of pipelines, the sweeper. Same
diagnosis as the api (`deploy/<slug>-worker`); the worker also needs Redis (`REDIS_URL`) — a Redis down shows as
`redis_up 0` on the overview. Pipelines whose next stage is *evaluate* stay queued until it is back.

#### Alert: MatelotKeycloakDown
Nobody can sign in. `kubectl -n tenant-<slug> logs deploy/<slug>-keycloak`: its database (the `keycloak` database on
the same Postgres), the hostname settings after a domain change (`KC_HOSTNAME`), or memory. Existing tokens keep
working until they expire; the API itself is up.

#### Alert: MatelotNoRunnerOnline
Jobs wait and no runner has sent a heartbeat for a minute. Managed runners: `kubectl -n tenant-<slug> get sts
<slug>-runner` (scaled to 0? crash loop? the registration secret rotated?). Customer runners: their host, their
network path to the API, their token. `matelot runners list` and `matelot doctor` show the same from the CLI. The
queued jobs run as soon as a runner with the required tags comes back; nothing is lost.

#### Alert: MatelotQueueBacklog
The oldest queued job has waited more than 10 minutes. Pipeline jobs: not enough runners for the load, or jobs whose
`requiredTags` / requested pool no runner serves (`matelot job show <id>`); the Pipelines dashboard's *Queue wait* and
*Runners online by pool* tell which. BullMQ jobs (source sync, webhooks): the worker is down or saturated — the
Integrations dashboard's *Worker queue jobs* and *Failed BullMQ jobs*.

#### Alert: MatelotPipelineFailureRate
More than half the pipelines of the last hour failed, at least five of them. Look at the Pipelines dashboard's
*Failures per hour by kind*: one kind failing everywhere is a scanner image or a repository the runners cannot
reach (the job log: `matelot job logs <id>`); every kind failing is the runner's environment (disk, network, a
broken image pull). A gate (`policy_eval`) failing every run is a policy, not an outage — the Security posture
dashboard's gate panels.

#### Alert: MatelotDbConnectionsHigh
A process holds more than 8 of its 10 pool connections, or requests wait for one. A slow query is the usual cause:
`pg_stat_activity` on the cell's Postgres (`kubectl exec … psql`), or the *Query latency p95* panel; a sustained load
needs more api replicas (`api.replicas`) rather than a bigger pool.

#### Alert: MatelotBackupFailed
The last backup run reported a failure. The reason is in the report (`backup_reports` table through
`GET /api/v1/internal/backup-reports` is not exposed; the API's audit trail has `backup.failed` with the error) and
in the Job's log (`kubectl -n tenant-<slug> logs job/<name>`; Compose: `docker compose --profile backup run --rm
backup`). Typical: Postgres unreachable (the run waits two minutes for it), the backups PVC full
(`MatelotDiskAlmostFull`), S3 credentials. Run one by hand: `make backup TENANT=<slug>`.

#### Alert: MatelotBackupTooOld
No successful backup for 36 hours. The CronJob is suspended or its schedule changed (`kubectl -n tenant-<slug> get
cronjob`), every run fails (see above), or backups were disabled (`backup.enabled`) while the rules stayed loaded —
then turn the rules off or the backups on.

#### Alert: MatelotLicenseExpiring
The licence expires within 14 days (M13 licensing; the metric does not exist before). Renew the key in Settings →
License; the cell falls back to the Free tier otherwise.

#### Alert: MatelotBackupJobFailed
Kubernetes saw a backup Job pod fail (kube-state-metrics). Same as `MatelotBackupFailed`, from the cluster's side:
`kubectl -n <namespace> get jobs` and the failed pod's log.

#### Alert: MatelotCertificateExpiring
cert-manager has not renewed a cell certificate due within 14 days: `kubectl -n <namespace> describe certificate`
and the issuer's challenge (DNS of `<slug>.<domain>`, `auth-<slug>.<domain>`, `registry-<slug>.<domain>` pointing at
the ingress; rate limits). Users see browser warnings when it expires.

#### Alert: MatelotDiskAlmostFull
A cell volume has under 10 % free: Postgres (`<slug>-postgres`), the registry, or the backups PVC. Grow the PVC if the
storage class allows expansion; otherwise prune — backup retention (`backup.retentionDays`), registry garbage
collection, or the database's own growth (SBOM documents are the bulk). Postgres stopping on a full disk takes the
cell down.

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
| 3 — dashboards and alerts | the four dashboards generated by `tools/dashboards/build.py`, the rules files with promtool unit tests, `tools/dashboards/test.py` in CI (regeneration, expression parsing, every metric published), PrometheusRule + dashboards ConfigMaps in the chart, Grafana provisioning + `rule_files` in Compose, `smoke.sh --observability` asserting both, the runbooks above; with it the fixes the rc.20 run asked for: series seeded at zero, the claim span inside its job, `worker sweep` under matelot-worker, the image tag pinned by `apply --tag`, the backup waiting for Postgres, polls never roots (`x-matelot-poll`) and GETs ratio-sampled | kind with kube-prometheus-stack + Tempo + Loki: dashboards show the demo pipeline; `NoRunnerOnline` fires with runners scaled to 0; `BackupFailed` fires when the CronJob is made to fail |
| 4 — product | Settings → Observability, doctor section, audit / security events as OTel logs, customer docs | render tests for the page; doctor test; the SIEM schema documented and covered by a test that pins the field names |

Acceptance for the milestone: on kind with kube-prometheus-stack, Tempo and Loki installed from their charts and
`observability.*` on, all targets up, our dashboards in Grafana with data from the demo-app pipeline, one pipeline
trace end to end in Tempo with its logs correlated in Loki by `trace_id`, and the two alerts above firing on demand;
the Compose profile reaches the same on one host.

## Out of scope

Our own hosted Grafana or a multi-cell fleet view (that is step 17, the control plane); profiling (pprof / Pyroscope);
synthetic checks from outside the cell (the customer's uptime tooling does that against `/api/v1/health/ready`);
metrics per project or per user (cardinality; the product's own dashboards cover that from the database).
