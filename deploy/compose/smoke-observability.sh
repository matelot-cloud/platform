#!/usr/bin/env bash
# The observability pass of smoke.sh (`smoke.sh --observability`, sourced after the cell is up with
# COMPOSE_PROFILES=observability): everything is asked the way an operator would, through Caddy and Grafana's
# datasource proxy (nothing of the stack publishes a port). Fails with the Prometheus targets / the query answers.
# Uses smoke.sh's helpers: cli, cli_json, token, log, diagnose, BASE.
GRAFANA_PW="$(docker compose run --rm --no-deps init show | sed -n 's/^Grafana: .*local admin: admin \/ \([^)]*\)).*/\1/p')"
[ -n "$GRAFANA_PW" ] || { echo "init show prints no Grafana admin password (was the profile passed to init?)" >&2; docker compose run --rm --no-deps init show >&2; exit 1; }
# gf <url…>: a GET through Caddy as Grafana's local admin, like login-page-check.sh: the URL, the HTTP status and the
# first 300 bytes of the body go to stderr whenever the answer is not JSON with status 200, so a wrong route (the
# web app's HTML from Caddy's catch-all), a redirect, a 401 or a 502 is readable from the log; the body goes to stdout.
GF_BODY=./.smoke-gf.body
gf() {
  local url="" a code
  for a in "$@"; do case "$a" in http://*|https://*) url="$a" ;; esac; done   # the URL, wherever it is among curl's arguments
  code="$(curl -sS -u "admin:$GRAFANA_PW" -o "$GF_BODY" -w '%{http_code}' "$@" 2> "$GF_BODY.err")" || code="000 (curl: $(cat "$GF_BODY.err"))"
  if [ "$code" != 200 ] || ! head -c 1 "$GF_BODY" | grep -q '[{[]'; then
    printf 'gf %s → HTTP %s; body (first 300 bytes): %s\n' "$url" "$code" "$(head -c 300 "$GF_BODY" | tr '\n' ' ')" >&2
    return 1
  fi
  cat "$GF_BODY"
}
DS="$BASE/grafana/api/datasources/proxy/uid"

log "Grafana through Caddy: health, the provisioned datasources, the Keycloak sign-in offered"
# Grafana's own health answer: {"database":"ok",…}. Anything else after 3 minutes — the web app's HTML (Caddy without
# the /grafana route: init did not see the profile), a 502 (Grafana not up: its log follows), a redirect — fails here
# with what was received, not later with a JSON error at char 0.
up=0
for _ in $(seq 1 36); do
  if gf "$BASE/grafana/api/health" > "$GF_BODY.health" 2> "$GF_BODY.why" && grep -q '"database"' "$GF_BODY.health"; then up=1; break; fi
  sleep 5
done
if [ "$up" = 0 ]; then
  echo "Grafana did not answer $BASE/grafana/api/health with its health JSON in 180 s: $(cat "$GF_BODY.why")" >&2
  echo "---- Caddyfile route for /grafana (missing = init ran without the observability profile):" >&2; docker compose exec -T caddy cat /matelot/caddy/Caddyfile 2>/dev/null | grep -n -A2 "grafana" >&2 || true
  echo "---- grafana container (OOMKilled / restarts: a memory limit too small shows here):" >&2; docker compose ps -a grafana >&2
  docker inspect --format 'state={{.State.Status}} oomkilled={{.State.OOMKilled}} exit={{.State.ExitCode}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' "$(docker compose ps -aq grafana)" >&2 2>/dev/null || true
  docker compose logs --tail 60 grafana >&2; docker compose logs --tail 20 caddy >&2
  exit 1
fi
echo "   health: $(tr -d '\n' < "$GF_BODY.health")"
gf "$BASE/grafana/api/datasources" | python3 -c '
import sys, json
ds = {d["uid"]: d for d in json.load(sys.stdin)}
assert {"prometheus", "tempo", "loki"} <= set(ds), sorted(ds)
assert ds["prometheus"]["jsonData"]["exemplarTraceIdDestinations"][0]["datasourceUid"] == "tempo", ds["prometheus"]["jsonData"]
assert ds["tempo"]["jsonData"]["tracesToLogsV2"]["datasourceUid"] == "loki", ds["tempo"]["jsonData"]
print("   datasources:", ", ".join(sorted(ds)), "(exemplars → tempo, traces → loki)")'
curl -sS "$BASE/grafana/login" > "$GF_BODY" || true
grep -q "generic_oauth" "$GF_BODY" || { echo "Grafana's login page offers no Keycloak sign-in; first 300 bytes: $(head -c 300 "$GF_BODY" | tr '\n' ' ')" >&2; exit 1; }
curl -fsS -o /dev/null -w '%{redirect_url}\n' "$BASE/grafana/login/generic_oauth" | grep -q "/auth/realms/platform/protocol/openid-connect/auth?.*client_id=grafana" \
  || { echo "Grafana's sign-in does not redirect to the cell's Keycloak" >&2; curl -sS -D - -o /dev/null "$BASE/grafana/login/generic_oauth" >&2; exit 1; }
echo "   sign-in: redirects to the cell's Keycloak (client grafana)"

log "Grafana: the four dashboards provisioned in folder Matelot; Prometheus: the alert rules loaded"
gf "$BASE/grafana/api/search?type=dash-db&tag=matelot" | python3 -c '
import sys, json
d = {x["uid"]: x for x in json.load(sys.stdin)}
assert set(d) == {"matelot-cell-overview", "matelot-pipelines", "matelot-security-posture", "matelot-integrations"}, sorted(d)
assert all(x.get("folderTitle") == "Matelot" for x in d.values()), {k: v.get("folderTitle") for k, v in d.items()}
print("   dashboards:", ", ".join(sorted(x["title"] for x in d.values())))'
gf "$BASE/grafana/api/dashboards/uid/matelot-cell-overview" | python3 -c '
import sys, json
j = json.load(sys.stdin)["dashboard"]
uids = {t["datasource"]["uid"] for p in j["panels"] for t in p.get("targets", [])}
assert uids == {"prometheus"}, uids
print("   cell overview: %d panels, datasource inputs resolved" % len(j["panels"]))'
gf "$DS/prometheus/api/v1/rules" | python3 -c '
import sys, json
groups = {g["name"]: g for g in json.load(sys.stdin)["data"]["groups"]}
assert "matelot" in groups, sorted(groups)
names = sorted(r["name"] for r in groups["matelot"]["rules"])
assert {"MatelotApiDown", "MatelotNoRunnerOnline", "MatelotQueueBacklog", "MatelotBackupFailed", "MatelotBackupTooOld"} <= set(names), names
bad = [r["name"] for r in groups["matelot"]["rules"] if r.get("health") not in ("ok", "unknown")]
assert not bad, f"rules in error: {bad}"
print("   alert rules loaded:", len(names), "in group matelot; none in error")'

log "Prometheus: every target up (api, worker, runner, postgres, redis, keycloak, registry and the stack itself)"
targets_ok() {
  gf "$DS/prometheus/api/v1/targets?state=active" | python3 -c '
import sys, json
t = json.load(sys.stdin)["data"]["activeTargets"]
jobs = {}
for x in t: jobs.setdefault(x["labels"]["job"], []).append(x)
want = {"matelot-api", "matelot-worker", "matelot-runner", "matelot-postgres", "matelot-redis", "matelot-keycloak", "matelot-registry"}
missing = sorted(want - set(jobs)); down = sorted(f"{j} ({x.get(\"lastError\") or x[\"health\"]})" for j, xs in jobs.items() for x in xs if x["health"] != "up")
print(f"   {len(t)} targets; missing: {missing or \"none\"}; not up: {down or \"none\"}")
sys.exit(1 if missing or down else 0)'
}
ok=0; for _ in $(seq 1 24); do if targets_ok; then ok=1; break; fi; sleep 10; done
[ "$ok" = 1 ] || { echo "Prometheus targets not all up after 240 s" >&2; diagnose; exit 1; }
gf -G "$DS/prometheus/api/v1/query" --data-urlencode 'query=count by (job) (matelot_build_info)' | python3 -c '
import sys, json
jobs = {r["metric"]["job"] for r in json.load(sys.stdin)["data"]["result"]}
assert {"matelot-api", "matelot-worker", "matelot-runner"} <= jobs, jobs
print("   matelot_build_info:", ", ".join(sorted(jobs)))'
# one series per exporter, scoped to its job: the database / cache seen by its exporter, Keycloak's management
# endpoint (KC_METRICS_ENABLED), the registry's debug listener
for q in 'pg_up{job="matelot-postgres"} == 1' 'redis_up{job="matelot-redis"} == 1' 'jvm_memory_used_bytes{job="matelot-keycloak"}' 'go_goroutines{job="matelot-registry"}' 'count(up{cell="main"}) >= 7' 'matelot_pipeline_jobs_total{status="failed",kind="sbom"} == 0'; do
  gf -G "$DS/prometheus/api/v1/query" --data-urlencode "query=$q" | python3 -c 'import sys, json; r = json.load(sys.stdin)["data"]["result"]; assert r, sys.argv[1]; print("  ", sys.argv[1], "present")' "$q" \
    || { echo "no series for $q" >&2; exit 1; }
done

log "a pipeline on a public repository: its trace in Tempo, its logs in Loki by trace_id"
MATELOT_TOKEN="$(token)"; export MATELOT_URL="$BASE" MATELOT_TOKEN    # the administrator's Keycloak session (full rights, like the web app)
ORG="$(cli_json 'print(d[0]["id"])' -- request GET /api/v1/organizations)"
WS="$(cli_json 'print(d["id"])' -- workspace create --org "$ORG" --slug obs --name Observability)"
TEAM="$(cli_json 'print(d["id"])' -- team create --workspace "$WS" --slug platform --name Platform)"
PROJECT="$(cli_json 'print(d["id"])' -- project create --team "$TEAM" --slug demo --name Demo)"
SVC="$(cli_json 'print(d["id"])' -- service create --project "$PROJECT" --slug demo-app --name "demo app")"
REPO_URL="${SMOKE_REPOSITORY_URL:-https://github.com/matelot-cloud/matelot}"
CONN="$(cli_json 'print(d["id"])' -- connection create --org "$ORG" --body "{\"provider\":\"git\",\"name\":\"smoke\",\"repositoryUrl\":\"$REPO_URL\",\"auth\":{\"type\":\"none\"}}")"
REPO=""; for _ in $(seq 1 30); do
  REPO="$(cli_json 'print(d[0]["id"] if d else "")' -- request GET "/api/v1/integrations/$CONN/repositories" 2> /dev/null || true)"; [ -n "$REPO" ] && break; sleep 2
done
[ -n "$REPO" ] || { echo "the connection to $REPO_URL listed no repository after 60 s" >&2; docker compose logs --tail 40 worker >&2; exit 1; }
cli repository attach --service "$SVC" --repository-id "$REPO" --json > /dev/null
PIPE="$(cli pipeline --service "$SVC" --template checkout --wait --json)" || { echo "pipeline failed: $PIPE" >&2; docker compose logs --tail 40 runner >&2; exit 1; }
TRACE_ID="$(printf '%s' "$PIPE" | python3 -c 'import sys, json; d = json.load(sys.stdin); assert d["status"] == "succeeded", d["status"]; print(d["traceParent"].split("-")[1])')"
echo "   pipeline succeeded; trace $TRACE_ID"
ok=0; for _ in $(seq 1 24); do   # the batch processors flush within 5 s, the collector within its batch timeout
  if gf -H 'Accept: application/json' "$DS/tempo/api/traces/$TRACE_ID" 2> /dev/null | python3 -c '
import sys, json
raw = sys.stdin.read(); d = json.loads(raw)
batches = d.get("batches") or d.get("resourceSpans") or d.get("trace", {}).get("resourceSpans") or []
services = {a["value"].get("stringValue") for b in batches for a in b.get("resource", {}).get("attributes", []) if a["key"] == "service.name"}
names = {s["name"] for b in batches for ss in (b.get("scopeSpans") or b.get("instrumentationLibrarySpans") or []) for s in ss.get("spans", [])}
print(f"   tempo: {sum(1 for _ in names)} span names from {sorted(services)}")
sys.exit(0 if "matelot-pipeline" in services and "matelot-runner" in services and any(n.startswith("pipeline ") for n in names) else 1)'; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || { echo "the pipeline trace $TRACE_ID is not complete in Tempo after 120 s" >&2; docker compose logs --tail 30 otel-collector tempo >&2; exit 1; }
ok=0; for _ in $(seq 1 24); do   # Alloy tails the containers' logs; trace_id is structured metadata
  if gf -G "$DS/loki/loki/api/v1/query_range" --data-urlencode "query={cell=\"main\"} | trace_id=\"$TRACE_ID\"" --data-urlencode "since=1h" --data-urlencode "limit=200" 2> /dev/null | python3 -c '
import sys, json
r = json.load(sys.stdin)["data"]["result"]
lines = sum(len(s["values"]) for s in r); services = sorted({s["stream"].get("compose_service", "?") for s in r})
print(f"   loki: {lines} lines with the trace id from {services}")
sys.exit(0 if lines else 1)'; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || { echo "no log line with trace_id $TRACE_ID in Loki after 120 s" >&2; docker compose logs --tail 30 alloy loki >&2; exit 1; }

log "a backup reports itself: matelot_backup_last_success_timestamp_seconds (the same gauge as on Kubernetes)"
docker compose --profile backup run --rm backup > /dev/null || { echo "the backup run failed" >&2; exit 1; }
ok=0; for _ in $(seq 1 18); do
  if gf -G "$DS/prometheus/api/v1/query" --data-urlencode 'query=matelot_backup_last_success_timestamp_seconds > (time() - 3600)' | python3 -c 'import sys, json; r = json.load(sys.stdin)["data"]["result"]; print("   backup gauge:", [x["value"][1] for x in r]); sys.exit(0 if r else 1)'; then ok=1; break; fi
  sleep 10
done
[ "$ok" = 1 ] || { echo "no recent matelot_backup_last_success_timestamp_seconds after 180 s" >&2; docker compose logs --tail 20 api worker >&2; exit 1; }
log "observability smoke test passed"
