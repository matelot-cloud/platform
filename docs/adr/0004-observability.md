# ADR 0004 — Observability: OpenTelemetry-first, the customer's stack, dashboards and alerts shipped

**Status:** accepted · **Date:** 2026-10-19 · design: `docs/observability.md`

## Decision

1. **Standard signals, no vendor path.** Traces and (optionally) metrics and logs leave a cell as OTLP; metrics are
   also exposed in Prometheus format on a separate port (9464) of every process; logs are JSON on stdout with the
   trace id on every line. Configuration uses the OpenTelemetry environment variables (`OTEL_EXPORTER_OTLP_*`,
   `OTEL_TRACES_SAMPLER`, `OTEL_*_EXPORTER`) and adds `MATELOT_*` switches only where OTel defines none.
2. **We ship the content, not the backend.** Four Grafana dashboards and one alert-rule file live in
   `deploy/observability/` and are delivered by the chart (dashboards ConfigMaps for the Grafana sidecar, a
   `PrometheusRule`) and by Compose (Grafana provisioning). The customer's Prometheus / Grafana / Tempo / Loki — or
   Grafana Cloud, or any OTLP backend — is the target. The Compose `observability` profile bundles a small stack for
   one host; the chart never installs a monitoring stack, only talks to one (`ServiceMonitor` / `PodMonitor` /
   `PrometheusRule` when the operator's CRDs exist, all off by default).
3. **One trace per pipeline.** The pipeline queue is our own (the `jobs` table, claimed by runners), so the W3C
   `traceparent` is carried in our protocol: stored on the pipeline row, handed to the runner in the claim response
   under a per-job parent span, sent back on every runner → API call; API → worker through BullMQ job data. A
   pipeline is one trace from creation to the gate result.
4. **Cardinality rules are part of the design.** Labels are bounded enumerations (job kinds, statuses, pools,
   severities, HTTP route templates); never ids, names, paths or user input. Business gauges (open findings, SLA
   breaches) are per cell and computed by the worker on a timer, never on scrape. The runner exposes only its own
   job histogram and `build_info`.
5. **Metrics ports are internal.** 9464 and the exporters' ports are never on the ingress; the NetworkPolicy admits
   the monitoring namespace only; Compose publishes none of them. The redaction list used for logs also applies to
   span attributes.
6. **Default posture:** metrics on, tracing off until an OTLP endpoint is configured, log export off (stdout is the
   log). A cell with no monitoring stack behaves exactly as today.

## Why

* Customers install the cell on their own infrastructure and already run a monitoring stack (kube-prometheus-stack
  is the common case; Grafana Cloud and Datadog next). Anything proprietary — our Grafana, our agent — would be a
  second stack to operate and a reason not to deploy. OTLP + Prometheus exposition is what every one of those ingests.
* Shipping dashboards and alerts is the difference between "has metrics" and "is observable": the operator gets the
  cell overview, the pipeline view and the posture view on day one, and `NoRunnerOnline` / `BackupFailed` /
  `CertificateExpiring` are the incidents we have seen on kind and in provisioning.
* The pipeline trace is the diagnostic we lack today: a failed or slow pipeline is spread over API logs, worker logs
  and runner logs with nothing joining them. One trace with correlated logs replaces that.
* Cardinality and port rules up front, because they are the two ways a well-meant metric takes down a Prometheus
  or leaks data, and both are cheaper as design than as incident.

## Consequences

* Node processes start with a preload (`node -r ./dist/tracing.js`): auto-instrumentation must patch `http`, `pg`,
  `ioredis`, `bullmq`, `undici` before Nest loads them. The images' entrypoints change in drop 1.
* `pipelines` gains a `trace_parent` column (migration + snapshot, as the schema rule requires); the runner protocol
  gains `Job.traceparent` (optional, so old runners keep working — the cell already tells an outdated runner to
  rebuild).
* The runner moves from `console.*` to pino with the shared schema; its `/metrics` is a second listener in the agent.
* Every new environment variable is added in three places (`env.ts`, `api-configmap.yaml`, `compose-init.sh`) — the
  existing rule — and the chart's `observability` block renders them per component.
* The bundled Postgres and Redis get exporter sidecars (not when `bundled=false`); Keycloak's management port
  gains `/metrics`; the registry opens its debug port on the pod network only.
* CI grows: kube-prometheus-stack CRDs on kind for the fully-on render, `promtool` and a dashboard linter, and a
  second Compose smoke run with the profile (about 3 minutes more).
* M13 (licensing) will fill the `matelot_license_*` placeholders and the `LicenseExpiring` alert.

## Alternatives considered

* **prom-client + ad-hoc tracing.** Less to install, but two instrumentation layers (Prometheus client for
  metrics, something else for traces) with no shared context, and no OTLP for customers who want it. The OTel SDK's
  Prometheus exporter gives the same `/metrics` with one meter.
* **Bundle Grafana in the chart.** Rejected: a second Grafana in a cluster that already has one, upgrades we would
  own, SSO wiring per customer. Compose gets the bundle because one host has no stack to join.
* **Metrics behind the API with a token.** Rejected: Prometheus scraping with bearer tokens works but every
  recipe becomes a special case; a separate internal port with a NetworkPolicy is the convention operators expect.
* **Traces per job instead of per pipeline.** Simpler propagation, but the question is always "why did this
  pipeline take 12 minutes", which needs the queue wait and the gate evaluation in the same view.
