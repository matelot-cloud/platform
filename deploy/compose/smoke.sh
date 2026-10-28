#!/usr/bin/env bash
# End-to-end check of a Docker Compose cell, the way a new user would do it (CI runs it with freshly built images):
#   up → wait for the cell through Caddy → sign in as the generated administrator → matelot doctor → create a
#   workspace/team/project → backup (--compose) → destroy everything (down -v) → restore → the project is back.
#   deploy/compose/smoke.sh [--keep]          (env: MATELOT_CLI="node ../../apps/cli/dist/index.js" to use a checkout)
#   deploy/compose/smoke.sh --check           only resolves the CLI and prints its version (no Docker): CI's self-test
#   deploy/compose/smoke.sh --observability   the second pass: the cell with COMPOSE_PROFILES=observability — every
#                                             Prometheus target up, a pipeline's trace in Tempo, its logs in Loki by
#                                             trace_id, the backup gauge (all asked through Caddy → Grafana's proxy)
# Needs: docker compose v2, curl, python3 (JSON), the matelot CLI (or MATELOT_CLI), and ports 80/5000 free.
set -euo pipefail
cd "$(dirname "$0")"
KEEP=0; CHECK=0; OBS=0
for a in "$@"; do case "$a" in --keep) KEEP=1 ;; --check) CHECK=1 ;; --observability) OBS=1 ;; *) echo "usage: smoke.sh [--keep] [--observability] | --check" >&2; exit 2 ;; esac; done
# The CLI command is a word list, never one string: MATELOT_CLI="node ../../apps/cli/dist/index.js" has a space, and
# "$MATELOT_CLI" would look for a program named `node ../../apps/cli/dist/index.js` (exit 127). Split on purpose, once.
read -ra CLI <<< "${MATELOT_CLI:-matelot}"
cli() { "${CLI[@]}" "$@"; }   # every CLI call in this script goes through here (or cli_json below)
# cell-backup.sh / cell-restore.sh: ../../scripts in the platform checkout, ./scripts in the published docker/ folder
SCRIPTS="${CELL_SCRIPTS:-}"; [ -n "$SCRIPTS" ] || { if [ -f ../../scripts/cell-backup.sh ]; then SCRIPTS="$(cd ../../scripts && pwd)"; else SCRIPTS="$(pwd)/scripts"; fi; }
# The stack runs from its own env file (.env.smoke, via COMPOSE_ENV_FILES, inherited by every `docker compose` below and
# by the backup/restore scripts): the user's .env is never read or written. Values with spaces and shell/JSON
# metacharacters on purpose — a cell whose organization name or password breaks a generated file must fail here, not at
# a customer (quoting rules of compose .env: single quotes keep $ and # literal).
[ "$CHECK" = 1 ] || {
  { grep -v '^MATELOT_ORG_NAME=\|^MATELOT_ADMIN_PASSWORD=\|^MATELOT_VERSION=' .env.example
    echo "MATELOT_VERSION=${MATELOT_VERSION:-latest}"            # CI: the images built from this commit
    [ -z "${MATELOT_REGISTRY_PREFIX:-}" ] || echo "MATELOT_REGISTRY_PREFIX=$MATELOT_REGISTRY_PREFIX"
    echo "MATELOT_ORG_NAME='Acme Corp (EU) #1'"
    echo "MATELOT_ADMIN_PASSWORD='Sm0ke#pass\$1 ok'"
    [ "$OBS" = 0 ] || echo "COMPOSE_PROFILES=observability"
  } > .env.smoke
  export COMPOSE_ENV_FILES="$PWD/.env.smoke"
  [ "$OBS" = 0 ] || export COMPOSE_PROFILES=observability   # also in the env file (as a user would set it); exported so every compose call agrees
}
BASE="http://localhost:${MATELOT_HTTP_PORT:-80}"
log() { printf '\n== %s\n' "$*"; }
# cli_json <python expr over `d`> -- <cli args…>: runs the CLI with --json, fails with its stderr (and stdout) printed when
# the command fails — never pipe straight into json.load, which hides a 403 behind "Expecting value: line 1 column 1".
cli_json() {
  local expr="$1"; shift; [ "${1:-}" = "--" ] && shift
  local out err rc=0
  out="$(cli "$@" --json 2> ./.smoke-cli.err)" || rc=$?
  err="$(cat ./.smoke-cli.err 2>/dev/null || true)"; rm -f ./.smoke-cli.err
  if [ "$rc" != 0 ]; then printf 'matelot %s failed (exit %s)\nstderr: %s\nstdout: %s\n' "$*" "$rc" "$err" "$out" >&2; return "$rc"; fi
  [ -z "$err" ] || printf '%s\n' "$err" >&2
  printf '%s' "$out" | python3 -c "import sys,json; d=json.load(sys.stdin); $expr"
}
if [ "$CHECK" = 1 ]; then printf 'CLI command: %q' "${CLI[0]}"; printf ' %q' "${CLI[@]:1}"; echo; cli --version; exit 0; fi
# down -v BEFORE removing .env.smoke: every compose call reads it (COMPOSE_ENV_FILES), and without it compose refuses to
# run ("couldn't find env file") — the old order failed silently, left the whole stack running, and the next pass
# (--observability) came up over it: caddy was not recreated and kept routes without /grafana.
cleanup() {
  rm -rf ./.smoke-login.err ./.smoke-cli.err ./.smoke-gf.body* ./.smoke-credentials.json ./.smoke-Dockerfile ./.smoke-context.txt ./.smoke-ctx
  [ "$KEEP" = 0 ] || return 0
  log "down -v"
  docker compose down -v --remove-orphans > ./.smoke-down.log 2>&1 || { echo "WARNING: docker compose down -v failed — the stack may still be running:" >&2; cat ./.smoke-down.log >&2; }
  rm -f ./.env.smoke ./.smoke-down.log
}
trap cleanup EXIT
# start from nothing: a stack left over by an earlier run (same project name) would be reused by `up`, and its
# containers keep what they started with — the test would not be a fresh install
# (by project label, not `compose ps`: that lists only the active profiles' services, not a previous pass's others)
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-matelot}" 2> /dev/null)" ]; then
  log "a stack of project ${COMPOSE_PROJECT_NAME:-matelot} is already there: down -v first"
  docker compose down -v --remove-orphans || { echo "could not remove the leftover stack" >&2; exit 1; }
fi

wait_ready() { # through the proxy, as a browser would
  for _ in $(seq 1 90); do
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
docker compose logs realm-sync | grep -q "realm platform synced\|realm platform: already in sync" || { echo "realm-sync did not run (docker compose logs realm-sync):" >&2; docker compose logs realm-sync >&2; exit 1; }
log "sign-in page: the matelot login theme (title, favicon, logo, our CSS) through Caddy"
# a theme Keycloak cannot find is silent apart from ONE log line (it falls back to the stock theme, HTTP 200): fail on
# that line, then on the page itself; on failure show what the container holds under /opt/keycloak/themes/matelot
theme_failed() { docker compose logs keycloak 2>/dev/null | grep -q "Failed to find LOGIN theme"; }
if theme_failed; then
  echo "Keycloak could not load the matelot theme (themes/matelot/login/theme.properties missing?):" >&2
  docker compose logs keycloak 2>/dev/null | grep "Failed to find" >&2; docker compose exec -T keycloak find /opt/keycloak/themes/matelot -maxdepth 2 >&2 || true; exit 1
fi
bash "$(dirname "$0")/login-page-check.sh" "$BASE" || { docker compose logs --tail 30 keycloak >&2; docker compose exec -T keycloak find /opt/keycloak/themes/matelot -maxdepth 2 >&2 || true; exit 1; }
theme_failed && { echo "the page rendered but Keycloak logged 'Failed to find LOGIN theme' meanwhile" >&2; exit 1; }
echo "   keycloak log: no 'Failed to find LOGIN theme'"
if [ "$OBS" = 1 ]; then . "$(dirname "$0")/smoke-observability.sh"; exit 0; fi
log "matelot doctor (before login: the public checks)"
export MATELOT_URL="$BASE"
export MATELOT_CREDENTIALS="$PWD/.smoke-credentials.json"; rm -f "$MATELOT_CREDENTIALS"
cli doctor || true
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
cli login --url "$BASE" --no-browser --scope write 2> ./.smoke-login.err &
LOGIN_PID=$!
AUTH_URL=""; for _ in $(seq 1 30); do AUTH_URL="$(grep -o 'http[^ ]*/api/v1/oauth/authorize?[^ ]*' ./.smoke-login.err | head -1 || true)"; [ -n "$AUTH_URL" ] && break; sleep 1; done
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
cli whoami
cli cells
cli doctor
log "runners stay online: doctor again after the stale threshold (the sweeper marks silent runners offline after 60 s)"
sleep 75
cli_json 'r=[c for c in d["checks"] if c["name"]=="runners"][0]; assert r["ok"], r["detail"]; print("runners:", r["detail"])' -- doctor
log "create workspace / team / project (write-scoped administrator token: day-to-day work needs no sudo)"
ORG="$(cli_json 'print(d[0]["id"])' -- request GET /api/v1/organizations)"
WS="$(cli_json 'print(d["id"])' -- workspace create --org "$ORG" --slug smoke --name Smoke)"
TEAM="$(cli_json 'print(d["id"])' -- team create --workspace "$WS" --slug platform --name Platform)"
PROJECT="$(cli_json 'print(d["id"])' -- project create --team "$TEAM" --slug payments --name Payments)"
echo "project $PROJECT"
log "built-in registry: login → docker push → the push notification registers the image → image sync reads the tags"
SVC="$(cli_json 'print(d["id"])' -- service create --project "$PROJECT" --slug api --name API)"
cli registry info
cli registry login                                            # the stored login (personal token) → docker login localhost:5000
IMAGE_REF="$(cli registry path --service "$SVC")"             # the full pushable reference: localhost:5000/smoke/platform/payments/api
echo "image reference: $IMAGE_REF"
case "$IMAGE_REF" in "localhost:${MATELOT_REGISTRY_PORT:-5000}/"*) ;; *) echo "registry path must start with the registry host" >&2; exit 1;; esac
printf 'FROM scratch\nCOPY smoke.txt /smoke.txt\n' > ./.smoke-Dockerfile; echo "smoke $(date -u +%FT%TZ)" > ./.smoke-context.txt
mkdir -p ./.smoke-ctx && cp ./.smoke-context.txt ./.smoke-ctx/smoke.txt
docker build -q -t "$IMAGE_REF:1" -f ./.smoke-Dockerfile ./.smoke-ctx > /dev/null
docker push "$IMAGE_REF:1"
echo "pushed; a push elsewhere must be refused by the registry (the repository is not a service path):"
docker tag "$IMAGE_REF:1" "localhost:${MATELOT_REGISTRY_PORT:-5000}/not-a-service:1"
if docker push "localhost:${MATELOT_REGISTRY_PORT:-5000}/not-a-service:1" > ./.smoke-cli.err 2>&1; then echo "a push outside the service paths was accepted" >&2; cat ./.smoke-cli.err >&2; exit 1; fi
grep -q "insufficient_scope\|denied\|unauthorized" ./.smoke-cli.err || { echo "unexpected push failure:" >&2; cat ./.smoke-cli.err >&2; exit 1; }; echo "refused as expected"
IMG=""; for _ in $(seq 1 30); do IMG="$(cli_json 'print(next((i["id"] for i in d if i["name"].lower()=="'"$IMAGE_REF"'".lower()), ""))' -- images list --service "$SVC")"; [ -n "$IMG" ] && break; sleep 2; done
[ -n "$IMG" ] || { echo "the push notification did not register the image (docker compose logs registry api):" >&2; docker compose logs --tail 30 registry api >&2; exit 1; }
echo "image registered: $IMG"
cli_json 'assert d["tags"] >= 1, d; print("image sync:", d)' -- image sync --service "$SVC" --id "$IMG"
cli_json 'i=[i for i in d if i["id"]=="'"$IMG"'"][0]; assert i.get("lastError") in (None, ""), i; assert any(t.get("tag")=="1" for t in i["tags"]), i; print("tags:", [t["tag"] for t in i["tags"]])' -- images list --service "$SVC"
log "the write scope stops at destructive operations: archiving the project must be refused (403), not done"
if cli request DELETE "/api/v1/projects/$PROJECT" --json > ./.smoke-cli.err 2>&1; then echo "a write-scoped token archived a project" >&2; cat ./.smoke-cli.err >&2; exit 1; fi
grep -q "sudo" ./.smoke-cli.err || { echo "unexpected refusal:" >&2; cat ./.smoke-cli.err >&2; exit 1; }; rm -f ./.smoke-cli.err; echo "refused as expected"
log "service account at project level: bot member + token; the token reads the project; revoked, it is refused"
# managing members needs membership:write — a write-scoped login cannot (sudo or a browser session can)
if cli service-accounts list --scope "projects/$PROJECT" > /dev/null 2>&1 && cli access-token create --scope "projects/$PROJECT" --name smoke-denied --role READ_ONLY --token-scope read --days 1 > ./.smoke-cli.err 2>&1; then echo "a write-scoped login created a bot member" >&2; exit 1; fi
grep -q "membership:write" ./.smoke-cli.err || { echo "unexpected refusal:" >&2; cat ./.smoke-cli.err >&2; exit 1; }; rm -f ./.smoke-cli.err
ADMIN_SESSION="$(token)"   # the administrator's Keycloak session token: full rights, like the web app
SAT_JSON="$(MATELOT_TOKEN="$ADMIN_SESSION" cli access-token create --scope "projects/$PROJECT" --name smoke-bot --role DEVELOPER --token-scope read --days 1 --json)"
BOT_ID="$(printf '%s' "$SAT_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["serviceAccount"]["id"])')"
BOT_TOKEN_ID="$(printf '%s' "$SAT_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"]["id"])')"
BOT_TOKEN="$(printf '%s' "$SAT_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"]["token"])')"
MATELOT_TOKEN="$BOT_TOKEN" cli_json 'assert d["slug"]=="payments", d; print("bot reads project:", d["name"])' -- request GET "/api/v1/projects/$PROJECT"
MATELOT_TOKEN="$ADMIN_SESSION" cli_json 'm=[r for r in d["members"] if r["user"]["kind"]=="service_account"]; assert m and m[0]["role"]=="DEVELOPER", d; print("listed as a member:", m[0]["user"]["displayName"], m[0]["roleLabel"])' -- members list --scope "projects/$PROJECT"
MATELOT_TOKEN="$ADMIN_SESSION" cli service-accounts token-revoke --id "$BOT_ID" --token-id "$BOT_TOKEN_ID" > /dev/null
if MATELOT_TOKEN="$BOT_TOKEN" cli request GET "/api/v1/projects/$PROJECT" > ./.smoke-cli.err 2>&1; then echo "a revoked service-account token still works" >&2; exit 1; fi
grep -q "401" ./.smoke-cli.err || { echo "unexpected failure for the revoked token:" >&2; cat ./.smoke-cli.err >&2; exit 1; }; rm -f ./.smoke-cli.err; echo "revoked token refused (401)"
MATELOT_TOKEN="$ADMIN_SESSION" cli service-accounts delete --id "$BOT_ID" > /dev/null
log "backup --compose"
rm -rf ./smoke-backups; bash "$SCRIPTS/cell-backup.sh" --compose . -d ./smoke-backups
ARCHIVE="$(ls ./smoke-backups/*.tar.gz)"
ADMIN_PW_BEFORE="$(docker compose run --rm --no-deps init show | sed -n 's/^Admin password: *//p')"
log "disaster: docker compose down -v, then a fresh start (a new host: new secrets are generated before anyone restores)"
docker compose down -v
sed -i '/^MATELOT_ADMIN_PASSWORD=/d' .env.smoke     # the new host has no fixed password: everything is generated afresh
docker compose up -d; wait_ready
ADMIN_PW_FRESH="$(docker compose run --rm --no-deps init show | sed -n 's/^Admin password: *//p')"
[ "$ADMIN_PW_FRESH" != "$ADMIN_PW_BEFORE" ] || { echo "the fresh start kept the old admin password — the volumes were not removed?" >&2; exit 1; }
if cli doctor > /dev/null 2>&1 && cli whoami > /dev/null 2>&1; then echo "the stored login still works on a fresh cell — the restore test would prove nothing" >&2; exit 1; fi
echo "fresh cell: the stored login is rejected as expected"
log "restore --compose $ARCHIVE (--yes) into the running fresh cell"
bash "$SCRIPTS/cell-restore.sh" --compose . --yes "$ARCHIVE"
wait_ready
log "after the restore: the ORIGINAL stored login works again (cell key, API secrets and the token's hash came back)"
unset MATELOT_TOKEN
cli whoami
cli doctor
cli_json 'assert d["slug"]=="payments", d; print("project restored:", d["name"])' -- request GET "/api/v1/projects/$PROJECT"
ADMIN_PW_AFTER="$(docker compose run --rm --no-deps init show | sed -n 's/^Admin password: *//p')"
[ "$ADMIN_PW_AFTER" = "$ADMIN_PW_BEFORE" ] || { echo "admin password after the restore differs from the one backed up" >&2; exit 1; }
docker compose logs welcome | grep -q -- "$ADMIN_PW_BEFORE" || { echo "the welcome banner does not show the restored admin password:" >&2; docker compose logs welcome >&2; exit 1; }
echo "welcome banner shows the restored admin login"
rm -rf ./smoke-backups
log "smoke test passed"
