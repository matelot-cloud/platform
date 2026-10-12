#!/usr/bin/env bash
# End-to-end check of a Docker Compose cell, the way a new user would do it (CI runs it with freshly built images):
#   up → wait for the cell through Caddy → sign in as the generated administrator → matelot doctor → create a
#   workspace/team/project → backup (--compose) → destroy everything (down -v) → restore → the project is back.
#   deploy/compose/smoke.sh [--keep]          (env: MATELOT_CLI="node ../../apps/cli/dist/index.js" to use a checkout)
# Needs: docker compose v2, curl, python3 (JSON), the matelot CLI (or MATELOT_CLI), and ports 80/5000 free.
set -euo pipefail
cd "$(dirname "$0")"
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1
CLI="${MATELOT_CLI:-matelot}"
# cell-backup.sh / cell-restore.sh: ../../scripts in the platform checkout, ./scripts in the published docker/ folder
SCRIPTS="${CELL_SCRIPTS:-}"; [ -n "$SCRIPTS" ] || { if [ -f ../../scripts/cell-backup.sh ]; then SCRIPTS="$(cd ../../scripts && pwd)"; else SCRIPTS="$(pwd)/scripts"; fi; }
[ -f .env ] || cp .env.example .env
# values with spaces and shell/JSON metacharacters: a cell whose organization name or password breaks a generated
# file must fail here, not at a customer (quoting rules of compose .env: single quotes keep $ and # literal)
grep -q '^MATELOT_ORG_NAME=' .env && sed -i "s/^MATELOT_ORG_NAME=.*/MATELOT_ORG_NAME='Acme Corp (EU) #1'/" .env
grep -q '^MATELOT_ADMIN_PASSWORD=' .env && sed -i "s/^MATELOT_ADMIN_PASSWORD=.*/MATELOT_ADMIN_PASSWORD='Sm0ke#pass\$1 ok'/" .env
BASE="http://localhost:${MATELOT_HTTP_PORT:-80}"
log() { printf '\n== %s\n' "$*"; }
cleanup() { rm -f ./.smoke-login.err ./.smoke-credentials.json; if [ "$KEEP" = 0 ]; then log "down -v"; docker compose down -v --remove-orphans > /dev/null 2>&1 || true; fi; }
trap cleanup EXIT

wait_ready() { # through the proxy, as a browser would
  for i in $(seq 1 90); do
    if curl -fsS -o /dev/null "$BASE/api/v1/health/ready" && curl -fsS -o /dev/null "$BASE/healthz"; then return 0; fi
    sleep 5
  done
  echo "the cell did not become ready through $BASE in 450 s" >&2; diagnose; docker compose logs --tail 50 api keycloak caddy >&2; return 1
}
token() { # password grant on the web client (enabled for evaluation installs): the CLI accepts the Keycloak token as MATELOT_TOKEN
  local pw; pw="$(docker compose run --rm --no-deps init show | sed -n 's/^Admin password: *//p')"
  curl -fsS -X POST "$BASE/auth/realms/platform/protocol/openid-connect/token" -d client_id=platform-web -d grant_type=password -d "username=admin" --data-urlencode "password=$pw" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])'
}

diagnose() { # every container that is not running and healthy: its state and the last log lines — the root cause, not "dependency failed"
  echo "---- docker compose ps -a" >&2; docker compose ps -a >&2
  for c in $(docker compose ps -a --format '{{.Name}} {{.State}} {{.Health}}' | awk '$2 != "running" || ($3 != "" && $3 != "healthy") {print $1}'); do
    echo "---- $c" >&2; docker logs --tail 30 "$c" >&2 2>&1 || true
  done
}
log "docker compose up -d"
docker compose up -d || { echo "docker compose up failed" >&2; diagnose; exit 1; }
log "waiting for $BASE"; wait_ready
docker compose logs welcome | tail -12
log "matelot doctor (before login: the public checks)"
export MATELOT_URL="$BASE"
export MATELOT_CREDENTIALS="$PWD/.smoke-credentials.json"; rm -f "$MATELOT_CREDENTIALS"
$CLI doctor || true
log "OAuth discovery through the proxy"
curl -fsS "$BASE/.well-known/oauth-authorization-server" | python3 -c '
import sys, json
from urllib.parse import urlsplit
def origin(u):  # same rule as the CLI: scheme + lower-case host, default port dropped
    p = urlsplit(u); port = p.port
    if port in (None, 80 if p.scheme == "http" else 443): return f"{p.scheme}://{p.hostname}"
    return f"{p.scheme}://{p.hostname}:{port}"
m = json.load(sys.stdin); print(json.dumps(m, indent=1))
base = origin(sys.argv[1])
bad = [k for k in ("authorization_endpoint", "token_endpoint") if origin(m.get(k, "http://-")) != base]
assert not bad, f"endpoints not on {base}: {bad} ({[m.get(k) for k in bad]}) — API_PUBLIC_URL is wrong on the cell"
print("discovery ok: endpoints on", base)' "$BASE"
log "matelot login through the proxy (OAuth code flow, consent approved with the administrator's session)"
# `matelot login --no-browser` prints the authorize link and waits for the browser callback on 127.0.0.1; this script
# plays the browser: follow the link (API → consent page redirect), approve with the signed-in administrator, call back.
KC_TOKEN="$(token)"
$CLI login --url "$BASE" --no-browser --scope write 2> ./.smoke-login.err &
LOGIN_PID=$!
AUTH_URL=""; for i in $(seq 1 30); do AUTH_URL="$(grep -o 'http[^ ]*/api/v1/oauth/authorize?[^ ]*' ./.smoke-login.err | head -1 || true)"; [ -n "$AUTH_URL" ] && break; sleep 1; done
[ -n "$AUTH_URL" ] || { echo "matelot login printed no authorize link:" >&2; cat ./.smoke-login.err >&2; kill $LOGIN_PID 2>/dev/null; exit 1; }
echo "authorize link: $AUTH_URL"
CONSENT="$(curl -sS -o /dev/null -w '%{redirect_url}' "$AUTH_URL")" || { echo "could not follow the authorize link $AUTH_URL (curl exit $?)" >&2; echo "discovery document:" >&2; curl -sS "$BASE/.well-known/oauth-authorization-server" >&2 || true; kill $LOGIN_PID 2>/dev/null; exit 1; }
case "$CONSENT" in *"/oauth/consent?"*) echo "consent page: ${CONSENT%%\?*}" ;; *) echo "authorize did not redirect to the consent page: [$CONSENT]" >&2; curl -sS -D - -o /dev/null "$AUTH_URL" >&2 || true; kill $LOGIN_PID 2>/dev/null; exit 1;; esac
APPROVE_BODY="$(python3 -c 'import sys,json,urllib.parse; q=urllib.parse.parse_qs(urllib.parse.urlsplit(sys.argv[1]).query); print(json.dumps({k: q[k][0] for k in ("client_id","redirect_uri","scope","state","code_challenge") if k in q}))' "$CONSENT")"
REDIRECT="$(curl -fsS -X POST "$BASE/api/v1/oauth/approve" -H "Authorization: Bearer $KC_TOKEN" -H 'content-type: application/json' -d "$APPROVE_BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin)["redirect"])')"
curl -fsS -o /dev/null "$REDIRECT"            # the CLI's local callback: it exchanges the code and stores the login
wait $LOGIN_PID || { echo "matelot login failed:" >&2; cat ./.smoke-login.err >&2; exit 1; }
rm -f ./.smoke-login.err
log "matelot doctor (with the stored login)"
$CLI whoami
$CLI cells
$CLI doctor
log "runners stay online: doctor again after the stale threshold (the sweeper marks silent runners offline after 60 s)"
sleep 75
$CLI doctor --json | python3 -c 'import sys,json; d=json.load(sys.stdin); r=[c for c in d["checks"] if c["name"]=="runners"][0]; assert r["ok"], r["detail"]; print("runners:", r["detail"])'
log "create workspace / team / project"
ORG="$($CLI request GET /api/v1/organizations --json | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])')"
WS="$($CLI workspace create --org "$ORG" --slug smoke --name Smoke --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
TEAM="$($CLI team create --workspace "$WS" --slug platform --name Platform --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
PROJECT="$($CLI project create --team "$TEAM" --slug payments --name Payments --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
echo "project $PROJECT"
log "backup --compose"
rm -rf ./smoke-backups; bash "$SCRIPTS/cell-backup.sh" --compose . -d ./smoke-backups
ARCHIVE="$(ls ./smoke-backups/*.tar.gz)"
log "destroy: docker compose down -v"
docker compose down -v
log "restore --compose $ARCHIVE"
bash "$SCRIPTS/cell-restore.sh" --compose . --yes "$ARCHIVE"
wait_ready
MATELOT_TOKEN="$(token)"; export MATELOT_TOKEN     # same generated password: the secrets came back with the archive
$CLI doctor
$CLI request GET "/api/v1/projects/$PROJECT" --json | python3 -c 'import sys,json; p=json.load(sys.stdin); assert p["slug"]=="payments", p; print("project restored:", p["name"])'
rm -rf ./smoke-backups
log "smoke test passed"
