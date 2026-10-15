#!/usr/bin/env bash
# Unit test of compose-init.sh: runs it against a temp directory (no Docker) with hostile values and checks that
# every generated file survives being sourced by `sh` / parsed as JSON, that secrets are generated once, and that
# a domain change rewrites the derived configuration. CI runs it (job `layout`); needs bash, openssl, python3.
set -euo pipefail
cd "$(dirname "$0")"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export MATELOT_CONFIG_DIR="$T/m" MATELOT_VOLUMES_DIR="$T/v"
mkdir -p "$T/v/postgres" "$T/v/registry"
NAME="Acme Corp (EU) 'quoted' \$HOME #1 a=b \"dq\" back\\slash"
PASS="p'ss\$word#1=x\"y"
EMAIL="ops+matelot@example.com"
MATELOT_ORG_NAME="$NAME" MATELOT_ADMIN_PASSWORD="$PASS" MATELOT_ADMIN_EMAIL="$EMAIL" MATELOT_VERSION=1.2.3 MATELOT_LICENSE='lic$#' bash compose-init.sh > "$T/out1" 2>&1 || { cat "$T/out1"; exit 1; }
grep -q "generated secrets/cell-key/CELL_ENCRYPTION_KEY" "$T/out1"
M="$T/m"

check_env() { # check_env FILE KEY EXPECTED — the file sourced by a POSIX sh yields the exact value
  local got; got="$(sh -c "set -a; . '$1'; set +a; printf %s \"\$$2\"")"
  [ "$got" = "$3" ] || { echo "FAIL: $1 $2 → [$got] expected [$3]" >&2; exit 1; }
}
check_env "$M/env/api.env" BOOTSTRAP_ORG_NAME "$NAME"
check_env "$M/env/api.env" BOOTSTRAP_ADMIN_EMAILS "$EMAIL"
check_env "$M/env/api.env" MATELOT_LICENSE 'lic$#'
check_env "$M/env/api.env" APP_VERSION 1.2.3
check_env "$M/env/api.env" API_PUBLIC_URL "http://localhost"
check_env "$M/env/api.env" REGISTRY_INTERNAL_URL "http://registry:5000"
check_env "$M/env/api.env" KEYCLOAK_ADMIN_URL "http://keycloak:8080/auth"
check_env "$M/env/cell.env" ADMIN_EMAIL "$EMAIL"
check_env "$M/keycloak/keycloak.env" KC_DB_PASSWORD "$(cat "$M/secrets/postgres/POSTGRES_PASSWORD")"
check_env "$M/keycloak/keycloak.env" KC_HOSTNAME "http://localhost/auth"
# the api entrypoint's loader: every secret file becomes a variable, files with a dot (registry.key) are skipped
got="$(sh -c "set -a; . '$M/env/api.env'; set +a; for f in '$M'/secrets/*/*; do k=\"\$(basename \"\$f\")\"; case \"\$k\" in *.*) continue;; esac; export \"\$k=\$(cat \"\$f\")\"; done; printf %s \"\$SEED_ADMIN_PASSWORD|\$BOOTSTRAP_ORG_NAME\"")"
[ "$got" = "$PASS|$NAME" ] || { echo "FAIL: loader → [$got]" >&2; exit 1; }
[ "$(cat "$M/secrets/keycloak/SEED_ADMIN_PASSWORD")" = "$PASS" ]
# JSON files parse and carry the values verbatim
python3 - "$M" "$NAME" "$PASS" "$EMAIL" <<'PY'
import json, sys
m, name, pw, email = sys.argv[1:]
realm = json.load(open(f"{m}/keycloak/import/realm.json"))
assert realm["displayName"] == f"{name} · Matelot", realm["displayName"]
u = realm["users"][0]; assert u["email"] == email and u["credentials"][0]["value"] == pw
assert realm["clients"][1]["redirectUris"] == ["http://localhost/*"] and realm["sslRequired"] == "none"
web = json.load(open(f"{m}/web/config.json")); assert web["productName"] == f"{name} · Matelot" and web["keycloakUrl"] == "http://localhost/auth"
print("json ok")
PY
# secrets are generated once: a second run with a new domain keeps them and rewrites the derived files
cp "$M/secrets/cell-key/CELL_ENCRYPTION_KEY" "$T/key1"; cp "$M/secrets/postgres/POSTGRES_PASSWORD" "$T/pg1"
MATELOT_ORG_NAME="$NAME" MATELOT_DOMAIN=matelot.example.com MATELOT_ACME_EMAIL="$EMAIL" bash compose-init.sh > "$T/out2" 2>&1 || { cat "$T/out2"; exit 1; }
! grep -q "generated" "$T/out2" || { echo "FAIL: secrets regenerated on the second run" >&2; cat "$T/out2"; exit 1; }
cmp -s "$T/key1" "$M/secrets/cell-key/CELL_ENCRYPTION_KEY" && cmp -s "$T/pg1" "$M/secrets/postgres/POSTGRES_PASSWORD"
check_env "$M/env/api.env" KEYCLOAK_ISSUER "https://matelot.example.com/auth/realms/platform"
check_env "$M/env/api.env" API_PUBLIC_URL "https://matelot.example.com"
check_env "$M/keycloak/keycloak.env" KC_HOSTNAME "https://matelot.example.com/auth"
grep -q "handle /.well-known/\* {" "$M/caddy/Caddyfile" && grep -q "^matelot.example.com {" "$M/caddy/Caddyfile" && grep -q "^registry.matelot.example.com {" "$M/caddy/Caddyfile" && grep -q "email $EMAIL" "$M/caddy/Caddyfile"
[ "$(cat "$M/secrets/registry/REGISTRY_HOST")" = "registry.matelot.example.com" ]
python3 -c "import json,sys; r=json.load(open(sys.argv[1])); assert r['sslRequired']=='external' and r['clients'][1]['redirectUris']==['https://matelot.example.com/*']" "$M/keycloak/import/realm.json"
grep -q "realm: https://matelot.example.com/api/v1/registry/token" "$M/registry/config.yml"
# show prints the login; restore-secrets maps a Kubernetes-named secret directory
MATELOT_ADMIN_EMAIL="$EMAIL" bash compose-init.sh show | grep -q "Admin password: $PASS"
mkdir -p "$T/restore/acme-cell-key" && printf 'abc' > "$T/restore/acme-cell-key/CELL_ENCRYPTION_KEY"
bash compose-init.sh restore-secrets "$T/restore" > /dev/null
[ "$(cat "$M/secrets/cell-key/CELL_ENCRYPTION_KEY")" = "abc" ] || { echo "FAIL: restore-secrets" >&2; exit 1; }
# ownership of the data volumes (only meaningful as root; as a user chown fails silently in the script? no: it must not fail the run)
[ -d "$T/v/postgres" ]
# realm-update runs the shared realm-sync script with the bootstrap admin from the secrets: against a closed port it
# must give up with a clear message after REALM_SYNC_TIMEOUT (the script itself is tested by realm-sync.test.js)
out="$(KEYCLOAK_URL=http://127.0.0.1:1/auth REALM_SYNC_TIMEOUT=1 bash compose-init.sh realm-update 2>&1)" && { echo "FAIL: realm-update should fail against a closed port" >&2; exit 1; }
printf '%s' "$out" | grep -q "keycloak at http://127.0.0.1:1/auth not ready after 1s" || { echo "FAIL: realm-update message: $out" >&2; exit 1; }
echo "compose-init ok"
