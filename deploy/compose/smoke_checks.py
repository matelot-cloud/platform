#!/usr/bin/env python3
"""The checks smoke.sh and smoke-observability.sh run on the answers they fetch — one subcommand each, the answer on
stdin, a one-line verdict on stdout, exit 0 (pass) or 1 (fail, with the reason on stderr). They used to be `python3 -c
'…'` snippets inside bash single quotes, where a `\\"` reaches Python as a backslash: the Prometheus-targets check was a
SyntaxError on every attempt and the targets were never checked. Here they are plain Python, and
smoke_checks_test.py runs every subcommand against recorded answers (deploy/compose/test-fixtures/) without Docker.

  python3 smoke_checks.py <check> [args…] < answer.json
"""
import json
import sys
import urllib.parse

# the scrape jobs of a cell (the chart's matelot.cloud/job names; compose's static jobs use the same)
CELL_JOBS = {"matelot-api", "matelot-worker", "matelot-runner", "matelot-postgres", "matelot-redis", "matelot-keycloak", "matelot-registry"}
DASHBOARDS = {"matelot-cell-overview", "matelot-pipelines", "matelot-security-posture", "matelot-integrations"}
REQUIRED_ALERTS = {"MatelotApiDown", "MatelotNoRunnerOnline", "MatelotQueueBacklog", "MatelotBackupFailed", "MatelotBackupTooOld"}


class CheckFailed(Exception):
    pass


def need(cond, message):
    if not cond:
        raise CheckFailed(message)


def load(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise CheckFailed(f"not JSON ({e}); first 300 bytes: {text[:300]!r}")


# ---- smoke.sh --------------------------------------------------------------------------------------------------
def origin(url):
    """Scheme + lower-case host, default port dropped — the CLI's rule for comparing the discovery endpoints."""
    p = urllib.parse.urlsplit(url)
    if p.port in (None, 80 if p.scheme == "http" else 443):
        return f"{p.scheme}://{p.hostname}"
    return f"{p.scheme}://{p.hostname}:{p.port}"


def oauth_discovery(d, base):
    bad = [k for k in ("authorization_endpoint", "token_endpoint") if origin(d.get(k, "http://-")) != origin(base)]
    need(not bad, f"endpoints not on {origin(base)}: {bad} ({[d.get(k) for k in bad]}) — API_PUBLIC_URL is wrong on the cell")
    return f"discovery ok: endpoints on {origin(base)}"


def access_token(d):
    need("access_token" in d, f"no access_token in the token response: {sorted(d)}")
    return d["access_token"]


def approve_body(consent_url):
    """The consent page's query → the JSON body the approve call takes."""
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(consent_url).query)
    return json.dumps({k: q[k][0] for k in ("client_id", "redirect_uri", "scope", "state", "code_challenge") if k in q})


def field(d, path):
    """A value by dotted path (`serviceAccount.id`, `0.id`), printed bare."""
    cur = d
    for part in path.split("."):
        cur = cur[int(part)] if isinstance(cur, list) else cur[part]
    return cur


# ---- smoke-observability.sh: Grafana -----------------------------------------------------------------------------
def caddy_routes(d):
    lines = []
    for name, srv in d.items():
        paths = [m.get("path") for r in srv.get("routes", []) for m in (r.get("match") or []) if "path" in m]
        lines.append("  %s %s: %s" % (name, srv.get("listen"), paths))
    return "\n".join(lines)


def grafana_datasources(d):
    ds = {x["uid"]: x for x in d}
    need({"prometheus", "tempo", "loki"} <= set(ds), "datasources: %s" % sorted(ds))
    need(ds["prometheus"]["jsonData"]["exemplarTraceIdDestinations"][0]["datasourceUid"] == "tempo", "prometheus exemplars: %s" % ds["prometheus"]["jsonData"])
    need(ds["tempo"]["jsonData"]["tracesToLogsV2"]["datasourceUid"] == "loki", "tempo → logs: %s" % ds["tempo"]["jsonData"])
    return "   datasources: %s (exemplars → tempo, traces → loki)" % ", ".join(sorted(ds))


def grafana_dashboards(d):
    found = {x["uid"]: x for x in d}
    need(set(found) == DASHBOARDS, "dashboards: %s" % sorted(found))
    folders = {k: v.get("folderTitle") for k, v in found.items()}
    need(all(f == "Matelot" for f in folders.values()), "folders: %s" % folders)
    return "   dashboards: %s" % ", ".join(sorted(x["title"] for x in found.values()))


def grafana_dashboard_inputs(d):
    j = d["dashboard"]
    uids = {t["datasource"]["uid"] for p in j["panels"] for t in p.get("targets", [])}
    need(uids == {"prometheus"}, "datasource uids in the panels: %s (an unresolved ${DS_…} input?)" % sorted(uids))
    return "   %s: %d panels, datasource inputs resolved" % (j["uid"], len(j["panels"]))


# ---- smoke-observability.sh: Prometheus --------------------------------------------------------------------------
def prometheus_rules(d):
    groups = {g["name"]: g for g in d["data"]["groups"]}
    need("matelot" in groups, "rule groups: %s" % sorted(groups))
    names = sorted(r["name"] for r in groups["matelot"]["rules"])
    need(REQUIRED_ALERTS <= set(names), "alerts missing: %s" % sorted(REQUIRED_ALERTS - set(names)))
    bad = ["%s: %s" % (r["name"], r.get("lastError", "")) for r in groups["matelot"]["rules"] if r.get("health") not in ("ok", "unknown")]
    need(not bad, "rules in error: %s" % bad)
    return "   alert rules loaded: %d in group matelot; none in error" % len(names)


def prometheus_targets(d):
    targets = d["data"]["activeTargets"]
    jobs = {}
    for x in targets:
        jobs.setdefault(x["labels"]["job"], []).append(x)
    missing = sorted(CELL_JOBS - set(jobs))
    down = sorted("%s %s (%s)" % (j, x.get("scrapeUrl", ""), x.get("lastError") or x["health"]) for j, xs in jobs.items() for x in xs if x["health"] != "up")
    line = "   %d targets; missing: %s; not up: %s" % (len(targets), missing or "none", down or "none")
    need(not missing and not down, line)
    return line


def query_result(d):
    need(d.get("status") == "success", "query failed: %s" % d)
    return d["data"]["result"]


def build_info(d):
    jobs = {r["metric"].get("job") for r in query_result(d)}
    need({"matelot-api", "matelot-worker", "matelot-runner"} <= jobs, "matelot_build_info from: %s" % sorted(j for j in jobs if j))
    return "   matelot_build_info: %s" % ", ".join(sorted(jobs))


def series_present(d, query):
    r = query_result(d)
    need(r, "no series for %s" % query)
    return "   %s present (%d series)" % (query, len(r))


def backup_gauge(d):
    r = query_result(d)
    need(r, "no recent matelot_backup_last_success_timestamp_seconds")
    return "   backup gauge: %s" % [x["value"][1] for x in r]


# ---- smoke-observability.sh: the pipeline's trace and logs -------------------------------------------------------
def pipeline_trace_id(d):
    need(d.get("status") == "succeeded", "pipeline status %s (jobs: %s)" % (d.get("status"), [(j.get("name"), j.get("status")) for j in d.get("jobs", [])]))
    tp = d.get("traceParent") or ""
    parts = tp.split("-")
    need(len(parts) == 4 and len(parts[1]) == 32, "no traceParent on the pipeline: %r" % tp)
    return parts[1]


def tempo_trace(d):
    """Tempo's /api/traces/<id> (OTLP JSON: `batches`, or `resourceSpans` / `trace.resourceSpans` in newer answers)."""
    batches = d.get("batches") or d.get("resourceSpans") or d.get("trace", {}).get("resourceSpans") or []
    services = {a["value"].get("stringValue") for b in batches for a in b.get("resource", {}).get("attributes", []) if a["key"] == "service.name"}
    names = {s["name"] for b in batches for ss in (b.get("scopeSpans") or b.get("instrumentationLibrarySpans") or []) for s in ss.get("spans", [])}
    line = "   tempo: %d span names from %s" % (len(names), sorted(services))
    need("matelot-pipeline" in services and "matelot-runner" in services and any(n.startswith("pipeline ") for n in names), line)
    return line


def loki_lines(d):
    r = d["data"]["result"]
    lines = sum(len(s["values"]) for s in r)
    services = sorted({s["stream"].get("compose_service", "?") for s in r})
    line = "   loki: %d lines with the trace id from %s" % (lines, services)
    need(lines > 0, line)
    return line


CHECKS = {
    "oauth-discovery": (oauth_discovery, 1), "access-token": (access_token, 0), "field": (field, 1),
    "caddy-routes": (caddy_routes, 0), "grafana-datasources": (grafana_datasources, 0), "grafana-dashboards": (grafana_dashboards, 0),
    "grafana-dashboard-inputs": (grafana_dashboard_inputs, 0), "prometheus-rules": (prometheus_rules, 0),
    "prometheus-targets": (prometheus_targets, 0), "build-info": (build_info, 0), "series-present": (series_present, 1),
    "backup-gauge": (backup_gauge, 0), "pipeline-trace-id": (pipeline_trace_id, 0), "tempo-trace": (tempo_trace, 0), "loki-lines": (loki_lines, 0),
}


def main(argv):
    if len(argv) >= 2 and argv[0] == "approve-body":   # no stdin: the consent URL is the argument
        print(approve_body(argv[1]))
        return 0
    if not argv or argv[0] not in CHECKS:
        print("usage: smoke_checks.py <%s|approve-body> [arg] < answer" % "|".join(sorted(CHECKS)), file=sys.stderr)
        return 2
    fn, nargs = CHECKS[argv[0]]
    args = argv[1:1 + nargs]
    if len(args) != nargs:
        print("%s takes %d argument(s)" % (argv[0], nargs), file=sys.stderr)
        return 2
    try:
        out = fn(load(sys.stdin.read()), *args)
    except CheckFailed as e:
        print("%s: %s" % (argv[0], e), file=sys.stderr)
        return 1
    except (KeyError, IndexError, TypeError, ValueError) as e:
        print("%s: unexpected answer shape (%s: %s)" % (argv[0], type(e).__name__, e), file=sys.stderr)
        return 1
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
