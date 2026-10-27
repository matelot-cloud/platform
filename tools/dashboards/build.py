#!/usr/bin/env python3
"""Builds the four Grafana dashboards of a cell (docs/observability.md, "Dashboards and alerts") into
deploy/observability/dashboards/*.json — the one source the chart (ConfigMaps for the Grafana sidecar) and the Compose
profile (Grafana provisioning) ship. Hand-edit this file, not the JSON: `python3 tools/dashboards/build.py` rewrites
the JSON, `python3 tools/dashboards/test.py` fails CI when the two differ, when a query names a metric no process
emits, or when an expression does not parse. The datasources are inputs (${DS_PROMETHEUS}, ${DS_TEMPO}), so the
JSON imports into any Grafana; every query is filtered on the `cell` variable.
"""
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parents[2] / "deploy/observability/dashboards"
DS = {"type": "prometheus", "uid": "${DS_PROMETHEUS}"}
TEMPO = {"type": "tempo", "uid": "${DS_TEMPO}"}
RATE = "$__rate_interval"
CELL = 'cell="$cell"'

_ids = iter(range(1, 10_000))


def target(expr: str, legend: str = "__auto", **kw) -> dict:
    t = {"datasource": DS, "expr": expr, "legendFormat": legend, "refId": kw.pop("refId", "A"), "range": True, "instant": False}
    t.update(kw)
    return t


def panel(kind: str, title: str, targets: list, w: int, h: int, *, unit: str | None = None, description: str | None = None, options: dict | None = None, overrides: list | None = None, defaults: dict | None = None, **extra) -> dict:
    for i, t in enumerate(targets):
        t["refId"] = chr(ord("A") + i)
    fd = {"color": {"mode": "palette-classic"}, "custom": {}, "mappings": [], "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}]}}
    if unit:
        fd["unit"] = unit
    if defaults:
        fd.update(defaults)
    p = {"id": next(_ids), "type": kind, "title": title, "datasource": DS, "targets": targets, "gridPos": {"w": w, "h": h, "x": 0, "y": 0}, "fieldConfig": {"defaults": fd, "overrides": overrides or []}, "options": options or {}}
    if description:
        p["description"] = description
    p.update(extra)
    return p


def timeseries(title, targets, w=12, h=8, unit=None, stack=False, fill=10, **kw):
    p = panel("timeseries", title, targets, w, h, unit=unit, options={"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True}, "tooltip": {"mode": "multi", "sort": "desc"}}, **kw)
    p["fieldConfig"]["defaults"]["custom"] = {"drawStyle": "line", "lineWidth": 1, "fillOpacity": fill, "showPoints": "never", "spanNulls": False, "stacking": {"mode": "normal" if stack else "none", "group": "A"}, "axisPlacement": "auto"}
    return p


def stat(title, targets, w=4, h=4, unit=None, thresholds=None, mappings=None, text_mode="value", color_mode="value", decimals=None, **kw):
    p = panel("stat", title, targets, w, h, unit=unit, options={"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "textMode": text_mode, "colorMode": color_mode, "graphMode": "none", "justifyMode": "center", "orientation": "auto"}, **kw)
    if thresholds:
        p["fieldConfig"]["defaults"]["thresholds"] = {"mode": "absolute", "steps": thresholds}
    if mappings:
        p["fieldConfig"]["defaults"]["mappings"] = mappings
    if decimals is not None:
        p["fieldConfig"]["defaults"]["decimals"] = decimals
    for t in p["targets"]:
        t["instant"] = True
        t["range"] = False
    return p


def gauge(title, targets, w=4, h=4, unit="percentunit", thresholds=None, **kw):
    p = panel("gauge", title, targets, w, h, unit=unit, options={"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "showThresholdLabels": False, "showThresholdMarkers": True}, **kw)
    p["fieldConfig"]["defaults"]["thresholds"] = {"mode": "absolute", "steps": thresholds or [{"color": "green", "value": None}, {"color": "orange", "value": 0.7}, {"color": "red", "value": 0.9}]}
    p["fieldConfig"]["defaults"].update({"min": 0, "max": 1})
    return p


def table(title, targets, w=12, h=8, unit=None, **kw):
    p = panel("table", title, targets, w, h, unit=unit, options={"showHeader": True, "cellHeight": "sm", "footer": {"show": False}}, **kw)
    for t in p["targets"]:
        t.update({"instant": True, "range": False, "format": "table"})
    return p


def text(title, markdown, w=24, h=3):
    return {"id": next(_ids), "type": "text", "title": title, "gridPos": {"w": w, "h": h, "x": 0, "y": 0}, "options": {"mode": "markdown", "content": markdown}}


def row(title: str) -> dict:
    return {"id": next(_ids), "type": "row", "title": title, "collapsed": False, "gridPos": {"w": 24, "h": 1, "x": 0, "y": 0}, "panels": []}


UP_DOWN = [{"type": "value", "options": {"0": {"text": "DOWN", "color": "red", "index": 1}, "1": {"text": "UP", "color": "green", "index": 0}}}]
UP_THRESHOLDS = [{"color": "red", "value": None}, {"color": "green", "value": 1}]


def layout(panels: list) -> list:
    """Flows the panels left to right, top to bottom, 24 columns wide; a row panel starts a new line."""
    x = y = line_h = 0
    out = []
    for p in panels:
        w, h = p["gridPos"]["w"], p["gridPos"]["h"]
        if p["type"] == "row" or x + w > 24:
            y += line_h
            x, line_h = 0, 0
        p["gridPos"].update({"x": x, "y": y})
        x += w
        line_h = max(line_h, h)
        if p["type"] == "row":
            y += 1
            x, line_h = 0, 0
        out.append(p)
    return out


def dashboard(uid: str, title: str, tags: list, panels: list, variables: list, description: str, tempo=False) -> dict:
    inputs = [{"name": "DS_PROMETHEUS", "label": "Prometheus", "description": "", "type": "datasource", "pluginId": "prometheus", "pluginName": "Prometheus"}]
    if tempo:
        inputs.append({"name": "DS_TEMPO", "label": "Tempo", "description": "", "type": "datasource", "pluginId": "tempo", "pluginName": "Tempo"})
    cell_var = {"name": "cell", "label": "Cell", "type": "query", "datasource": DS, "query": {"query": "label_values(matelot_build_info, cell)", "refId": "cell"}, "definition": "label_values(matelot_build_info, cell)", "refresh": 1, "sort": 1, "includeAll": False, "multi": False, "current": {}, "options": [], "hide": 0}
    return {
        "__inputs": inputs,
        "__requires": [],
        "uid": uid, "title": title, "description": description, "tags": ["matelot", *tags], "editable": True, "graphTooltip": 1,
        "timezone": "browser", "time": {"from": "now-6h", "to": "now"}, "refresh": "30s", "schemaVersion": 39, "version": 1,
        "templating": {"list": [cell_var, *variables]},
        "annotations": {"list": [{"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True, "hide": True, "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts", "type": "dashboard"}]},
        "links": [{"title": "Matelot dashboards", "type": "dashboards", "tags": ["matelot"], "asDropdown": True, "includeVars": True, "keepTime": True}, {"title": "Observability guide", "type": "link", "url": "https://matelot-cloud.github.io/website/docs/latest/observability.html", "targetBlank": True}],
        "panels": layout(panels),
    }


def hist_p(q: float, metric: str, by: str = "", selector: str = CELL) -> str:
    by_clause = f"by (le{', ' + by if by else ''})"
    return f"histogram_quantile({q}, sum {by_clause} (rate({metric}_bucket{{{selector}}}[{RATE}])))"


# ----------------------------------------------------------------------------------------------- 1. cell overview
def cell_overview() -> dict:
    panels = [
        row("Components"),
        stat("API", [target(f'min(up{{job="matelot-api", {CELL}}})')], mappings=UP_DOWN, thresholds=UP_THRESHOLDS, w=3, color_mode="background"),
        stat("Worker", [target(f'min(up{{job="matelot-worker", {CELL}}})')], mappings=UP_DOWN, thresholds=UP_THRESHOLDS, w=3, color_mode="background"),
        stat("Keycloak", [target(f'min(up{{job="matelot-keycloak", {CELL}}})')], mappings=UP_DOWN, thresholds=UP_THRESHOLDS, w=3, color_mode="background", description="Needs observability.metrics.exporters (Helm) or the Compose profile"),
        stat("Postgres", [target(f'min(pg_up{{{CELL}}})')], mappings=UP_DOWN, thresholds=UP_THRESHOLDS, w=3, color_mode="background", description="postgres_exporter: observability.metrics.exporters"),
        stat("Redis", [target(f'min(redis_up{{{CELL}}})')], mappings=UP_DOWN, thresholds=UP_THRESHOLDS, w=3, color_mode="background", description="redis_exporter: observability.metrics.exporters"),
        stat("Registry", [target(f'min(up{{job="matelot-registry", {CELL}}})')], mappings=UP_DOWN, thresholds=UP_THRESHOLDS, w=3, color_mode="background"),
        stat("Runners online", [target(f'sum(matelot_runners_online{{{CELL}}}) or vector(0)')], w=3, thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 1}], description="Runners with a heartbeat in the last 60 s, every pool"),
        stat("Version", [target(f'matelot_build_info{{component="api", {CELL}}}', "{{version}}")], w=3, text_mode="name", color_mode="none", description="The api image's version (matelot_build_info)"),
        row("Traffic (RED)"),
        timeseries("Requests / s by route", [target(f'topk(12, sum by (http_route) (rate(http_server_request_duration_seconds_count{{{CELL}}}[{RATE}])))', "{{http_route}}")], w=8, unit="reqps", description="The twelve busiest route templates; probes and polls that the sampler drops are still counted here"),
        timeseries("5xx ratio", [target(f'sum(rate(http_server_request_duration_seconds_count{{http_response_status_code=~"5..", {CELL}}}[{RATE}])) / sum(rate(http_server_request_duration_seconds_count{{{CELL}}}[{RATE}]))', "5xx")], w=8, unit="percentunit", fill=20),
        timeseries("Latency p50 / p95 / p99", [target(hist_p(0.5, "http_server_request_duration_seconds"), "p50"), target(hist_p(0.95, "http_server_request_duration_seconds"), "p95"), target(hist_p(0.99, "http_server_request_duration_seconds"), "p99")], w=8, unit="s", fill=0),
        row("Queues and runners"),
        timeseries("Pipeline jobs queued by kind", [target(f'sum by (kind) (matelot_pipeline_jobs_queued{{{CELL}}})', "{{kind}}")], w=8, stack=True, description="Jobs waiting for a runner (the jobs table), refreshed by the worker every 15 s"),
        timeseries("Oldest queued job by pool", [target(f'max by (pool) (matelot_pipeline_oldest_queued_job_age_seconds{{{CELL}}})', "{{pool}}")], w=8, unit="s", fill=0, description="MatelotQueueBacklog fires above 10 minutes"),
        timeseries("Runners online / busy by pool", [target(f'sum by (pool) (matelot_runners_online{{{CELL}}})', "online · {{pool}}"), target(f'sum by (pool) (matelot_runners_busy{{{CELL}}})', "busy · {{pool}}")], w=8, fill=0),
        timeseries("BullMQ jobs by queue and state", [target(f'sum by (queue, state) (matelot_queue_jobs{{{CELL}}})', "{{queue}} · {{state}}")], w=12, stack=True, description="The worker's own queues (source sync, webhooks)"),
        timeseries("Oldest BullMQ job", [target(f'max by (queue) (matelot_queue_oldest_job_age_seconds{{{CELL}}})', "{{queue}}")], w=12, unit="s", fill=0),
        row("Pipelines"),
        timeseries("Pipelines finished per hour by status", [target(f'sum by (status) (increase(matelot_pipelines_total{{{CELL}}}[1h]))', "{{status}}")], w=12, stack=True),
        stat("Success rate (24 h)", [target(f'sum(increase(matelot_pipelines_total{{status="succeeded", {CELL}}}[24h])) / sum(increase(matelot_pipelines_total{{{CELL}}}[24h]))')], w=6, h=8, unit="percentunit", thresholds=[{"color": "red", "value": None}, {"color": "orange", "value": 0.5}, {"color": "green", "value": 0.9}], decimals=0),
        stat("Jobs finished (24 h)", [target(f'sum(increase(matelot_pipeline_jobs_total{{{CELL}}}[24h]))')], w=6, h=8, decimals=0),
        row("Database and cache"),
        timeseries("Postgres pool connections (api + worker)", [target(f'sum by (job, state) (db_client_connection_count{{{CELL}}})', "{{job}} · {{state}}")], w=8, stack=True, description="Each process has a pool of 10; MatelotDbConnectionsHigh fires above 8 in use or any caller waiting"),
        timeseries("Query latency p95", [target(hist_p(0.95, "db_client_operation_duration_seconds", "job"), "{{job}}")], w=8, unit="s", fill=0, description="The pg instrumentation's histogram: present while tracing is on"),
        timeseries("Postgres transactions / s", [target(f'sum by (datname) (rate(pg_stat_database_xact_commit{{datname=~"platform|keycloak", {CELL}}}[{RATE}]))', "{{datname}}")], w=8, unit="ops", fill=0),
        timeseries("Database size", [target(f'pg_database_size_bytes{{datname=~"platform|keycloak", {CELL}}}', "{{datname}}")], w=8, unit="bytes", fill=0),
        timeseries("Redis commands / s", [target(f'sum(rate(redis_commands_processed_total{{{CELL}}}[{RATE}]))', "commands")], w=8, unit="ops", fill=0),
        timeseries("Redis memory", [target(f'redis_memory_used_bytes{{{CELL}}}', "used"), target(f'redis_memory_max_bytes{{{CELL}}} > 0', "max")], w=8, unit="bytes", fill=0),
        row("Backups, storage and certificates"),
        stat("Last successful backup", [target(f'time() - max(matelot_backup_last_success_timestamp_seconds{{{CELL}}})')], w=6, unit="s", thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 90000}, {"color": "red", "value": 129600}], description="Age; MatelotBackupTooOld fires at 36 h", decimals=0),
        stat("Last backup duration", [target(f'max(matelot_backup_last_duration_seconds{{{CELL}}})')], w=6, unit="s", decimals=0),
        stat("Last failed backup", [target(f'time() - max(matelot_backup_last_failure_timestamp_seconds{{{CELL}}})')], w=6, unit="s", thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 604800}], description="Age of the last failure (green once a week has passed); the reason is in the API's backup reports", decimals=0),
        stat("Backup reports", [target(f'count(matelot_backup_last_success_timestamp_seconds{{{CELL}}}) or vector(0)')], w=6, mappings=[{"type": "value", "options": {"0": {"text": "none yet", "color": "orange", "index": 0}}}], thresholds=[{"color": "orange", "value": None}, {"color": "green", "value": 1}], description="0 until the first run reports (backups off, or the job never ran)"),
        timeseries("Volume usage (Kubernetes: kubelet volume stats)", [target(f'kubelet_volume_stats_used_bytes{{namespace="tenant-$cell"}} / kubelet_volume_stats_capacity_bytes{{namespace="tenant-$cell"}}', "{{persistentvolumeclaim}}")], w=12, unit="percentunit", fill=0, description="Postgres, registry and backups PVCs; MatelotDiskAlmostFull fires under 10 % free. Empty on Compose."),
        timeseries("Certificate expiry (Kubernetes: cert-manager)", [target(f'certmanager_certificate_expiration_timestamp_seconds{{namespace="tenant-$cell"}} - time()', "{{name}}")], w=12, unit="s", fill=0, description="MatelotCertificateExpiring fires under 14 days. Empty on Compose (Caddy renews on its own)."),
    ]
    return dashboard("matelot-cell-overview", "Matelot · Cell overview", ["overview"], panels, [], "Health of every component of one cell, traffic, queues, runners, pipelines, database, backups.")


# ----------------------------------------------------------------------------------------------- 2. pipelines
def pipelines() -> dict:
    kind_var = {"name": "kind", "label": "Job kind", "type": "query", "datasource": DS, "query": {"query": 'label_values(matelot_pipeline_jobs_total{cell="$cell"}, kind)', "refId": "kind"}, "definition": 'label_values(matelot_pipeline_jobs_total{cell="$cell"}, kind)', "refresh": 1, "sort": 1, "includeAll": True, "multi": True, "current": {"text": "All", "value": "$__all"}, "options": [], "hide": 0}
    K = f'kind=~"$kind", {CELL}'
    tempo_link = 'https://matelot-cloud.github.io/website/docs/latest/observability.html#traces'
    panels = [
        text("Traces", f"Every pipeline is **one trace** under service `matelot-pipeline` (api, runner and worker spans together). From here: the exemplars on the duration panels (the dots) open the trace of that very job in Tempo; Explore → Tempo → search service `matelot-pipeline`, or TraceQL `{{ resource.service.name = \"matelot-pipeline\" && span.matelot.pipeline.status = \"failed\" }}` for the failed ones. [How the trace is built]({tempo_link}).", h=3),
        row("Jobs"),
        timeseries("Job duration p95 by kind", [target(hist_p(0.95, "matelot_pipeline_job_duration_seconds", "kind", K), "{{kind}}")], w=12, unit="s", fill=0, description="started → finished, from the cell's view; exemplars link to the trace"),
        timeseries("Job duration p50 by kind", [target(hist_p(0.5, "matelot_pipeline_job_duration_seconds", "kind", K), "{{kind}}")], w=12, unit="s", fill=0),
        timeseries("Jobs finished per hour by status", [target(f'sum by (status) (increase(matelot_pipeline_jobs_total{{{K}}}[1h]))', "{{status}}")], w=12, stack=True),
        timeseries("Failures per hour by kind (failed + timed out)", [target(f'sum by (kind) (increase(matelot_pipeline_jobs_total{{status=~"failed|timed_out", {K}}}[1h]))', "{{kind}}")], w=12, stack=True),
        timeseries("Queue wait p95 by kind", [target(hist_p(0.95, "matelot_pipeline_job_queue_wait_seconds", "kind", K), "{{kind}}")], w=12, unit="s", fill=0, description="queued → started: how long a job waited for a runner (the claim span of the trace)"),
        timeseries("Runner-side duration p95 by kind", [target(hist_p(0.95, "matelot_runner_job_duration_seconds", "kind", f'kind=~"$kind", phase="total", {CELL}'), "{{kind}}")], w=12, unit="s", fill=0, description="From the runners' own /metrics (managed runners on Helm; the Compose runner). Checkout, scan and upload included."),
        row("Runners"),
        timeseries("Runner utilisation", [target(f'sum(matelot_runners_busy{{{CELL}}}) / sum(matelot_runners_online{{{CELL}}})', "busy / online")], w=8, unit="percentunit", fill=20),
        timeseries("Claims / s by result", [target(f'sum by (result) (rate(matelot_runner_claims_total{{{CELL}}}[{RATE}]))', "{{result}}")], w=8, fill=0, description="job = a runner got work; empty = a long-poll that found none (one per runner every 20 s); disconnected = the runner went away mid-claim"),
        timeseries("Runners online by pool", [target(f'sum by (pool, managed) (matelot_runners_online{{{CELL}}})', "{{pool}} (managed={{managed}})")], w=8, stack=True),
        row("Pipelines"),
        timeseries("Pipeline duration p95 by status", [target(hist_p(0.95, "matelot_pipeline_duration_seconds", "status"), "{{status}}")], w=12, unit="s", fill=0, description="created → finished"),
        timeseries("Pipelines per hour by trigger", [target(f'sum by (trigger) (increase(matelot_pipelines_total{{{CELL}}}[1h]))', "{{trigger}}")], w=12, stack=True),
        table("Last 24 h by kind", [target(f'sum by (kind) (increase(matelot_pipeline_jobs_total{{status="succeeded", {K}}}[24h]))', "succeeded"), target(f'sum by (kind) (increase(matelot_pipeline_jobs_total{{status=~"failed|timed_out", {K}}}[24h]))', "failed"), target(f'sum by (kind) (increase(matelot_pipeline_jobs_total{{status="skipped", {K}}}[24h]))', "skipped")], w=24, h=8, description="Counts per job kind over the last day",
              transformations=[{"id": "joinByField", "options": {"byField": "kind", "mode": "outer"}}, {"id": "organize", "options": {"excludeByName": {"Time": True, "Time 1": True, "Time 2": True, "Time 3": True}, "renameByName": {"Value #A": "succeeded", "Value #B": "failed / timed out", "Value #C": "skipped"}}}]),
    ]
    return dashboard("matelot-pipelines", "Matelot · Pipelines", ["pipelines"], panels, [kind_var], "Pipeline jobs by kind: durations, failures, queue wait, runner utilisation; the traces are one click away through exemplars.", tempo=True)


# ----------------------------------------------------------------------------------------------- 3. security posture
def security_posture() -> dict:
    panels = [
        row("Findings"),
        timeseries("Open findings by severity", [target(f'sum by (severity) (matelot_findings_open{{{CELL}}})', "{{severity}}")], w=12, stack=True, description="Dependency and code findings with status open, refreshed every 10 minutes with the correlation loop", overrides=[{"matcher": {"id": "byName", "options": "critical"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "dark-red"}}]}, {"matcher": {"id": "byName", "options": "high"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]}, {"matcher": {"id": "byName", "options": "medium"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "orange"}}]}, {"matcher": {"id": "byName", "options": "low"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "yellow"}}]}]),
        timeseries("Open findings by kind", [target(f'sum by (kind) (matelot_findings_open{{{CELL}}})', "{{kind}}")], w=12, stack=True),
        stat("Critical open", [target(f'sum(matelot_findings_open{{severity="critical", {CELL}}}) or vector(0)')], w=6, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}], decimals=0),
        stat("High open", [target(f'sum(matelot_findings_open{{severity="high", {CELL}}}) or vector(0)')], w=6, thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 1}], decimals=0),
        stat("SLA breaches", [target(f'sum(matelot_sla_breaches{{{CELL}}}) or vector(0)')], w=6, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}], description="Open or in-progress remediations past their due date", decimals=0),
        stat("Findings open (all)", [target(f'sum(matelot_findings_open{{{CELL}}}) or vector(0)')], w=6, decimals=0),
        row("Gates and SLAs"),
        timeseries("Gate evaluations per hour by result", [target(f'sum by (result) (increase(matelot_gate_evaluations_total{{{CELL}}}[1h]))', "{{result}}")], w=12, stack=True, overrides=[{"matcher": {"id": "byName", "options": "fail"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]}, {"matcher": {"id": "byName", "options": "warn"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "orange"}}]}, {"matcher": {"id": "byName", "options": "pass"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}}]}]),
        timeseries("Gate fail ratio (1 h)", [target(f'sum(increase(matelot_gate_evaluations_total{{result="fail", {CELL}}}[1h])) / sum(increase(matelot_gate_evaluations_total{{{CELL}}}[1h]))', "fail")], w=12, unit="percentunit", fill=20),
        timeseries("SLA breaches by severity", [target(f'sum by (severity) (matelot_sla_breaches{{{CELL}}})', "{{severity}}")], w=12, stack=True),
        row("SBOMs"),
        timeseries("SBOMs ingested per hour by source", [target(f'sum by (source) (increase(matelot_sbom_ingest_duration_seconds_count{{{CELL}}}[1h]))', "{{source}}")], w=12, stack=True, description="runner = pipeline sbom jobs; ci_upload = `matelot sbom`; manual = the web app. Coverage per service is the product's own view (Coverage page)."),
        timeseries("SBOM ingest p95 by source", [target(hist_p(0.95, "matelot_sbom_ingest_duration_seconds", "source"), "{{source}}")], w=6, unit="s", fill=0),
        timeseries("Correlation run p95", [target(hist_p(0.95, "matelot_sbom_correlation_duration_seconds", "source"), "{{source}}")], w=6, unit="s", fill=0, description="The worker's advisory ↔ SBOM correlation loop (every 10 minutes)"),
    ]
    return dashboard("matelot-security-posture", "Matelot · Security posture", ["security"], panels, [], "Open findings, gate results, SLA breaches and SBOM ingestion of one cell — the business gauges the worker publishes.")


# ----------------------------------------------------------------------------------------------- 4. integrations
def integrations() -> dict:
    panels = [
        row("Source and issue trackers"),
        timeseries("Sync failures per hour by kind", [target(f'sum by (kind) (increase(matelot_integration_sync_failures_total{{{CELL}}}[1h]))', "{{kind}}")], w=12, stack=True),
        timeseries("Worker queue jobs per hour by queue and result", [target(f'sum by (queue, result) (increase(matelot_queue_jobs_processed_total{{{CELL}}}[1h]))', "{{queue}} · {{result}}")], w=12, stack=True),
        timeseries("Webhook lag p95 by provider", [target(hist_p(0.95, "matelot_webhook_lag_seconds", "provider"), "{{provider}}")], w=12, unit="s", fill=0, description="Delivery time at the provider → processed by the worker"),
        timeseries("Failed BullMQ jobs waiting", [target(f'sum by (queue) (matelot_queue_jobs{{state="failed", {CELL}}})', "{{queue}}")], w=12, fill=0),
        row("Built-in registry"),
        timeseries("Registry requests / s by handler and method", [target(f'sum by (handler, method) (rate(registry_http_requests_total{{{CELL}}}[{RATE}]))', "{{handler}} {{method}}")], w=12, unit="reqps", stack=True, description="blob / manifest GET = pulls, PUT = pushes (observability.metrics.exporters turns the registry's metrics on)"),
        timeseries("Registry 4xx / 5xx per minute", [target(f'sum by (code) (increase(registry_http_requests_total{{code=~"4..|5..", {CELL}}}[1m]))', "{{code}}")], w=6, fill=0),
        timeseries("Registry request p95", [target(hist_p(0.95, "registry_http_request_duration_seconds", "handler"), "{{handler}}")], w=6, unit="s", fill=0),
        row("Keycloak"),
        timeseries("Keycloak active requests", [target(f'sum(http_server_active_requests{{job="matelot-keycloak", {CELL}}})', "active")], w=8, fill=0),
        timeseries("Keycloak JVM heap", [target(f'sum(jvm_memory_used_bytes{{area="heap", job="matelot-keycloak", {CELL}}})', "heap used")], w=8, unit="bytes", fill=0),
        timeseries("Keycloak DB pool (agroal)", [target(f'agroal_active_count{{job="matelot-keycloak", {CELL}}}', "active"), target(f'agroal_awaiting_count{{job="matelot-keycloak", {CELL}}}', "awaiting")], w=8, fill=0),
    ]
    return dashboard("matelot-integrations", "Matelot · Integrations", ["integrations"], panels, [], "What the cell talks to: source and issue-tracker syncs, webhooks, the built-in registry, Keycloak.")


DASHBOARDS = {"cell-overview": cell_overview, "pipelines": pipelines, "security-posture": security_posture, "integrations": integrations}


def render() -> dict[str, str]:
    global _ids
    out = {}
    for name, fn in DASHBOARDS.items():
        _ids = iter(range(1, 10_000))
        out[f"{name}.json"] = json.dumps(fn(), indent=2, sort_keys=False) + "\n"
    return out


# the copies the two deliveries ship (chart-test compares them with the source): dashboards and rules
ROOT = OUT.parents[1]
COPIES = {
    "dashboards": [ROOT / "deploy/helm/secops-cell/files/observability/dashboards", ROOT / "deploy/compose/init/observability/grafana/dashboards"],
    "rules": {"matelot.yaml": [ROOT / "deploy/helm/secops-cell/files/observability/rules", ROOT / "deploy/compose/init/observability/rules"], "matelot-kubernetes.yaml": [ROOT / "deploy/helm/secops-cell/files/observability/rules"]},
}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, body in render().items():
        (OUT / name).write_text(body, encoding="utf-8")
        print(f"{OUT / name}: {len(json.loads(body)['panels'])} panels")
        for d in COPIES["dashboards"]:
            d.mkdir(parents=True, exist_ok=True); (d / name).write_text(body, encoding="utf-8")
    for rule, dests in COPIES["rules"].items():
        for d in dests:
            d.mkdir(parents=True, exist_ok=True); (d / rule).write_text((OUT.parent / "rules" / rule).read_text(), encoding="utf-8")
    print("copies: chart files/observability, compose init/observability")
