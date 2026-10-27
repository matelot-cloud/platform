#!/usr/bin/env python3
"""The dashboards and alert rules are checked, not trusted (CI: chart job; `make docs-check` neighbours):
  * deploy/observability/dashboards/*.json is exactly what build.py renders (edit the generator, not the JSON);
  * every panel query and every rule expression parses (promtool check rules over a synthetic rules file, the
    Grafana variables substituted) — PROMTOOL=/path/to/promtool or promtool on PATH;
  * every metric a query names is one a cell emits: ours from the instrument names in apps/api/src/telemetry/metrics.ts
    and apps/runner/src/telemetry.ts, the exporters' and Kubernetes' from the allowlist below — a dashboard that
    plots a metric nobody publishes is wrong without anybody noticing;
  * every query is scoped to the cell variable; panel ids are unique; the datasources are inputs.
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
DASH = ROOT / "deploy/observability/dashboards"
RULES = ROOT / "deploy/observability/rules"
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import build  # noqa: E402

# metrics other processes publish (exporters, Kubernetes, Prometheus itself): name → why it exists
EXTERNAL = {
    "up": "Prometheus", "time": "PromQL function (never a metric)", "vector": "PromQL function",
    "pg_up": "postgres_exporter", "pg_stat_database_xact_commit": "postgres_exporter", "pg_database_size_bytes": "postgres_exporter",
    "redis_up": "redis_exporter", "redis_commands_processed_total": "redis_exporter", "redis_memory_used_bytes": "redis_exporter", "redis_memory_max_bytes": "redis_exporter",
    "registry_http_requests_total": "distribution (docker/go-metrics NewDefaultHttpMetrics)", "registry_http_request_duration_seconds": "distribution",
    "http_server_active_requests": "Keycloak (Quarkus micrometer)", "jvm_memory_used_bytes": "Keycloak", "agroal_active_count": "Keycloak", "agroal_awaiting_count": "Keycloak",
    "kubelet_volume_stats_used_bytes": "kubelet", "kubelet_volume_stats_capacity_bytes": "kubelet", "kubelet_volume_stats_available_bytes": "kubelet",
    "certmanager_certificate_expiration_timestamp_seconds": "cert-manager", "kube_job_status_failed": "kube-state-metrics",
    "matelot_license_expiry_timestamp_seconds": "M13 (placeholder in the design; absent until licensing exists)",
}
FUNCTIONS = {"sum", "max", "min", "count", "avg", "rate", "increase", "histogram_quantile", "topk", "by", "le", "or", "and", "unless", "absent", "time", "vector", "on", "ignoring", "group_left", "group_right", "without", "bool", "offset"}


def our_metrics() -> dict[str, str]:
    """Prometheus family names from the instrument declarations (name + kind → suffixes)."""
    out = {}
    api = (ROOT / "apps/api/src/telemetry/metrics.ts").read_text()
    def prom(name: str, unit: str | None, counter=False) -> str:
        n = name.replace(".", "_")
        if unit == "s" and not n.endswith("_seconds"): n += "_seconds"
        if counter and not n.endswith("_total"): n += "_total"
        return n
    for m in re.finditer(r"hist\('([a-z._]+)'", api): out[prom(m.group(1), "s")] = "histogram"
    for m in re.finditer(r"gauge\('([a-z._]+)',\s*'[^']*'(?:,\s*'([a-z]+)')?", api): out[prom(m.group(1), m.group(2))] = "gauge"
    for m in re.finditer(r"createCounter\('([a-z._]+)'", api): out[prom(m.group(1), None, True)] = "counter"
    out["db_client_operation_duration_seconds"] = "histogram"   # the pg instrumentation, kept with our buckets (metrics.ts views)
    runner = (ROOT / "apps/runner/src/telemetry.ts").read_text() + (ROOT / "apps/runner/src/index.ts").read_text()
    for m in re.finditer(r"\.(inc|set|observe)\('(matelot_[a-z_]+)'", runner): out[m.group(2)] = {"inc": "counter", "set": "gauge", "observe": "histogram"}[m.group(1)]
    for m in re.finditer(r"out: string\[\] = \['# HELP (matelot_[a-z_]+)", runner): out[m.group(1)] = "gauge"
    return out


def metric_names(expr: str) -> set[str]:
    """Metric names in a PromQL expression: identifiers outside label selectors and grouping clauses that are not functions."""
    cleaned = re.sub(r'"[^"]*"', '""', expr)
    cleaned = re.sub(r"\{[^}]*\}", "{}", cleaned)                                   # label selectors
    cleaned = re.sub(r"\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)", " ", cleaned)   # grouping clauses
    cleaned = re.sub(r"\[[^\]]*\]", "", cleaned)                                     # ranges
    names = set(re.findall(r"(?<![\w$.])([a-z_][a-z0-9_]*)\b(?!\s*\()", cleaned))  # not followed by ( → not a function call
    return {n for n in names if n not in FUNCTIONS and not n.startswith("__") and not re.fullmatch(r"[0-9]+[a-z]*", n)}


def family(name: str, families: dict[str, str]) -> str | None:
    if name in families or name in EXTERNAL: return name
    for suffix in ("_bucket", "_count", "_sum"):
        base = name[: -len(suffix)] if name.endswith(suffix) else None
        if base and ((families.get(base) == "histogram") or (base in EXTERNAL and base.endswith("_seconds"))): return base
    return None


def substitute(expr: str) -> str:
    return expr.replace("$__rate_interval", "5m").replace("$__range", "1h").replace("tenant-$cell", "tenant-acme").replace('"$cell"', '"acme"').replace('"$kind"', '"sbom"')


def main() -> int:
    problems: list[str] = []
    families = our_metrics()
    known = set(families) | set(EXTERNAL)
    rendered = build.render()
    for name, body in rendered.items():
        on_disk = (DASH / name).read_text() if (DASH / name).exists() else None
        if on_disk != body: problems.append(f"{name}: differs from what build.py renders (run python3 tools/dashboards/build.py)")
    exprs: list[tuple[str, str]] = []
    for name, body in rendered.items():
        d = json.loads(body)
        ids = [p["id"] for p in d["panels"]]
        if len(ids) != len(set(ids)): problems.append(f"{name}: duplicate panel ids")
        if not any(i["name"] == "DS_PROMETHEUS" for i in d["__inputs"]): problems.append(f"{name}: no DS_PROMETHEUS input")
        if not any(v["name"] == "cell" for v in d["templating"]["list"]): problems.append(f"{name}: no cell variable")
        for p in d["panels"]:
            for t in p.get("targets", []):
                if t.get("datasource") != build.DS: problems.append(f"{name} · {p['title']}: target datasource is not ${{DS_PROMETHEUS}}")
                e = t["expr"]
                if "$cell" not in e: problems.append(f"{name} · {p['title']}: query not scoped to the cell: {e}")
                exprs.append((f"{name} · {p['title']}", e))
    for rules in sorted(RULES.glob("*.yaml")):
        if rules.name.endswith("_test.yaml"): continue
        text = rules.read_text()
        for m in re.finditer(r"expr:\s*(\|?)\s*\n?((?:[ \t]+[^\n]*\n)+|[^\n]*\n)", text):
            e = m.group(2)
            if m.group(1): e = " ".join(l.strip() for l in e.strip("\n").split("\n"))
            exprs.append((f"{rules.name}", e.strip()))
    for where, e in exprs:
        for n in metric_names(substitute(e)):
            if n not in known and family(n, families) is None: problems.append(f"{where}: metric {n} is published by nobody (telemetry/metrics.ts, runner telemetry.ts, or EXTERNAL in tools/dashboards/test.py)")
    # every alert's runbook_url points at a runbook heading of docs/observability.md ("#### Alert: <Name>" → #alert-<name>)
    doc = (ROOT / "docs/observability.md").read_text()
    headings = {re.sub(r"[^a-z0-9]+", "-", h.lower()).strip("-") for h in re.findall(r"^#{2,6}\s+(.+)$", doc, re.M)}
    for rules in sorted(RULES.glob("*.yaml")):
        if rules.name.endswith("_test.yaml"): continue
        for alert, anchor in re.findall(r"- alert: (\w+)[\s\S]*?runbook_url: \S+#([a-z0-9-]+)", rules.read_text()):
            if anchor != f"alert-{alert.lower()}": problems.append(f"{rules.name}: {alert}'s runbook_url anchor is #{anchor}, expected #alert-{alert.lower()}")
            if anchor not in headings: problems.append(f"{rules.name}: {alert}'s runbook heading '#### Alert: {alert}' is missing from docs/observability.md")
    promtool = os.environ.get("PROMTOOL") or shutil.which("promtool")
    if not promtool: problems.append("promtool not found (PROMTOOL=… or on PATH): the expressions were not parsed")
    else:
        with tempfile.TemporaryDirectory() as t:
            rules_file = pathlib.Path(t) / "check.yaml"
            lines = ["groups:", "  - name: dashboard-expressions", "    rules:"]
            for i, (where, e) in enumerate(exprs):
                if where.endswith(".yaml"): continue   # the rules files are checked as themselves below
                lines += [f"      - record: check_{i}", f"        expr: {json.dumps(substitute(e))}"]
            rules_file.write_text("\n".join(lines) + "\n")
            r = subprocess.run([promtool, "check", "rules", str(rules_file)], capture_output=True, text=True)
            if r.returncode != 0: problems.append("a dashboard expression does not parse:\n" + r.stdout + r.stderr)
            files = [str(f) for f in sorted(RULES.glob("*.yaml")) if not f.name.endswith("_test.yaml")]
            r = subprocess.run([promtool, "check", "rules", *files], capture_output=True, text=True)
            if r.returncode != 0: problems.append("rules do not parse:\n" + r.stdout + r.stderr)
            r = subprocess.run([promtool, "test", "rules", str(RULES / "matelot_test.yaml")], capture_output=True, text=True, cwd=str(RULES))
            if r.returncode != 0: problems.append("rule unit tests failed:\n" + r.stdout + r.stderr)
    if problems:
        print("dashboards/rules check FAILED:\n  " + "\n  ".join(problems)); return 1
    print(f"dashboards ok ({len(rendered)} dashboards, {len(exprs)} expressions parsed, every metric published by a known process; rules parse and their unit tests pass)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
