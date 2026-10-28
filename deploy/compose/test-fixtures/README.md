# Recorded answers for smoke_checks_test.py

What `smoke.sh` / `smoke-observability.sh` fetch, saved so every check in `../smoke_checks.py` runs without Docker
(`python3 ../smoke_checks_test.py`, also run by `init/compose-init.test.sh` in CI's `layout` job).

| File | Source |
|---|---|
| `prometheus-*.json` | recorded from Prometheus 3.15.0 running `init/observability/prometheus.yml` (hosts swapped for a fake cell serving each job's metrics) with `observability/rules/matelot.yaml`; `prometheus-targets-registry-down.json` with the registry's endpoint stopped |
| `tempo-trace.json`, `tempo-trace-v2.json` | recorded from Tempo 2.9.0 running `init/observability/tempo.yaml`: `/api/traces/<id>` and `/api/v2/traces/<id>` (Accept: application/json) for a pipeline-shaped OTLP trace (matelot-pipeline root + job, matelot-runner, matelot-api spans) |
| `loki-query-range*.json` | recorded from Loki 3.6.12 running `init/observability/loki.yaml`: `query_range` of `{cell="main"} \| trace_id="…"` over lines pushed with trace_id / span_id as structured metadata (Alloy's pipeline), and the same query for an unknown id |
| `caddy-servers.json` | recorded from Caddy 2.9.1's admin API (`/config/apps/http/servers`) running the Caddyfile compose-init renders with the profile |
| `cli-*.json`, `oauth-*.json`, `keycloak-token.json` | written by hand from the API / Keycloak response shapes (only the fields the checks read are meaningful) |

Grafana's answers (datasources, dashboard search, a dashboard) are built by the test from the provisioning files
compose-init renders — no Grafana binary could be run where these were recorded.
