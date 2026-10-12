#!/usr/bin/env bash
# First-start initialisation of a Matelot Docker Compose cell. Runs in the api image (bash + openssl) as root, once
# before the other services, and is idempotent:
#   - secrets under /matelot/secrets/<name>/<KEY> are generated ONCE and never overwritten (same layout as the
#     Kubernetes Secrets the chart creates, so backups restore across the two installs);
#   - derived configuration (Caddyfile, Keycloak realm + conf, registry config, web config.json) is rewritten on every
#     start from MATELOT_DOMAIN & co., so changing .env and restarting applies it (the realm is imported once by
#     Keycloak: redirect URIs of an existing realm are updated by `compose-init.sh realm-update`, see the README);
#   - data volumes get the uid of the non-root user that runs each service.
# Modes: (default) init · show (print the admin login) · restore-secrets DIR (copy a backup's secrets/ in, then init)
#        realm-update (stack running: point the imported Keycloak realm at the current MATELOT_DOMAIN)
set -euo pipefail
M=/matelot
MODE="${1:-init}"
DOMAIN="${MATELOT_DOMAIN:-localhost}"
ADMIN_EMAIL="${MATELOT_ADMIN_EMAIL:-admin@localhost}"
ORG_SLUG="${MATELOT_ORG_SLUG:-main}"
ORG_NAME="${MATELOT_ORG_NAME:-My organization}"
REGISTRY_PORT="${MATELOT_REGISTRY_PORT:-5000}"
DOCS_URL="${MATELOT_DOCS_URL:-https://matelot-cloud.github.io/website/docs/latest/}"
case "$DOMAIN" in
  localhost|127.0.0.1|*.localhost|[0-9]*.[0-9]*.[0-9]*.[0-9]*) SCHEME=http; LOCAL=1;;
  *) SCHEME="${MATELOT_SCHEME:-https}"; LOCAL=0;;
esac
BASE_URL="$SCHEME://$DOMAIN"
if [ "$LOCAL" = 1 ]; then REGISTRY_HOST="$DOMAIN:$REGISTRY_PORT"; REGISTRY_SITE=":5000"; else REGISTRY_HOST="registry.$DOMAIN"; REGISTRY_SITE="registry.$DOMAIN"; fi

rand() { openssl rand -hex "$1"; }   # 2*$1 hex characters
secret() { # secret <dir> <KEY> <generator…>: write once
  local name="$1" key="$2" dir="$M/secrets/$1"; shift 2
  mkdir -p "$dir"
  if [ ! -s "$dir/$key" ]; then "$@" > "$dir/$key"; echo "generated secrets/$name/$key"; fi
}
if [ "$MODE" = show ]; then
  echo "URL:            $BASE_URL"; echo "Admin login:    $ADMIN_EMAIL"; echo "Admin password: $(cat "$M/secrets/keycloak/SEED_ADMIN_PASSWORD")"; exit 0
fi
if [ "$MODE" = restore-secrets ]; then
  SRC="${2:?restore-secrets <dir with secrets/*/>}"
  for d in "$SRC"/*/; do
    [ -d "$d" ] || continue
    base="$(basename "$d")"   # Kubernetes archives carry the release prefix (acme-cell-key): keep the suffix
    for n in cell-key api-secrets postgres keycloak managed-runner registry; do case "$base" in *"$n") base="$n";; esac; done
    mkdir -p "$M/secrets/$base"; cp -f "$d"/* "$M/secrets/$base/"; echo "restored secrets/$base ($(ls "$d" | tr '\n' ' '))"
  done
  MODE=init
fi
if [ "$MODE" = realm-update ]; then
  # Keycloak imports realm.json once; after a domain change the platform-web redirect URIs and sslRequired are updated in place
  exec node -e '
    const [base, user, pass, sslRequired] = process.argv.slice(1);
    const kc = "http://keycloak:8080/auth";
    (async () => {
      const t = await (await fetch(`${kc}/realms/master/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: user, password: pass }) })).json();
      if (!t.access_token) throw new Error("keycloak admin login failed: " + JSON.stringify(t));
      const h = { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" };
      const r = await fetch(`${kc}/admin/realms/platform`, { method: "PUT", headers: h, body: JSON.stringify({ sslRequired }) });
      if (!r.ok) throw new Error(`realm update: HTTP ${r.status}`);
      const [c] = await (await fetch(`${kc}/admin/realms/platform/clients?clientId=platform-web`, { headers: h })).json();
      const u = await fetch(`${kc}/admin/realms/platform/clients/${c.id}`, { method: "PUT", headers: h, body: JSON.stringify({ ...c, redirectUris: [`${base}/*`] }) });
      if (!u.ok) throw new Error(`client update: HTTP ${u.status}`);
      console.log(`realm platform updated: redirect ${base}/*, sslRequired ${sslRequired}`);
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$BASE_URL" "$(cat "$M/secrets/keycloak/KC_BOOTSTRAP_ADMIN_USERNAME")" "$(cat "$M/secrets/keycloak/KC_BOOTSTRAP_ADMIN_PASSWORD")" "$([ "$SCHEME" = https ] && echo external || echo none)"
fi
command -v openssl > /dev/null || { echo "openssl is required in the init image" >&2; exit 1; }

# ---- secrets (generated once) ---------------------------------------------------------------------------------
secret cell-key CELL_ENCRYPTION_KEY rand 32
secret postgres POSTGRES_USER echo platform
secret postgres POSTGRES_DB echo platform
secret postgres POSTGRES_PASSWORD rand 24
secret keycloak KC_BOOTSTRAP_ADMIN_USERNAME echo admin
secret keycloak KC_BOOTSTRAP_ADMIN_PASSWORD rand 16
if [ -n "${MATELOT_ADMIN_PASSWORD:-}" ]; then secret keycloak SEED_ADMIN_PASSWORD printf '%s' "$MATELOT_ADMIN_PASSWORD"
else secret keycloak SEED_ADMIN_PASSWORD sh -c "openssl rand -base64 18 | tr -d '/+=' | cut -c1-16"; fi
secret managed-runner MANAGED_RUNNER_SECRET rand 24
secret registry REGISTRY_EVENTS_SECRET rand 24
if [ ! -s "$M/secrets/registry/registry.key" ] || [ ! -s "$M/secrets/registry/registry.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=secops-registry-token" \
    -keyout "$M/secrets/registry/registry.key" -out "$M/secrets/registry/registry.crt" 2> /dev/null
  echo "generated secrets/registry/registry.key + registry.crt"
fi
PG_PASSWORD="$(cat "$M/secrets/postgres/POSTGRES_PASSWORD")"
PG_USER="$(cat "$M/secrets/postgres/POSTGRES_USER")"
# derived connection strings (rewritten every start so a restored password propagates)
mkdir -p "$M/secrets/api-secrets"
printf 'postgresql://%s:%s@postgres:5432/platform' "$PG_USER" "$PG_PASSWORD" > "$M/secrets/api-secrets/DATABASE_URL"
printf 'redis://redis:6379' > "$M/secrets/api-secrets/REDIS_URL"
printf '%s' "$REGISTRY_HOST" > "$M/secrets/registry/REGISTRY_HOST"
printf '/matelot/secrets/registry/registry.key' > "$M/secrets/registry/REGISTRY_TOKEN_KEY_PATH"
printf '%s' "$PG_USER" > "$M/secrets/keycloak/KC_DB_USERNAME"; printf '%s' "$PG_PASSWORD" > "$M/secrets/keycloak/KC_DB_PASSWORD"

# ---- derived configuration (rewritten every start) --------------------------------------------------------------
mkdir -p "$M/caddy" "$M/keycloak/import" "$M/registry" "$M/web" "$M/env"
{
  [ -n "${MATELOT_ACME_EMAIL:-}" ] && printf '{\n  email %s\n}\n' "$MATELOT_ACME_EMAIL"
  if [ "$LOCAL" = 1 ]; then echo ":80 {"; else echo "$DOMAIN {"; fi   # local: plain HTTP for any Host; domain: automatic HTTPS
  cat <<'CADDY'
  encode gzip
  handle /healthz {
    respond "ok" 200
  }
  handle /api/* {
    reverse_proxy api:3000
  }
  handle /auth/* {
    reverse_proxy keycloak:8080
  }
  handle {
    reverse_proxy web:8080
  }
}
CADDY
  echo "$REGISTRY_SITE {"
  echo "  reverse_proxy registry:5000"
  echo "}"
} > "$M/caddy/Caddyfile"

SSL_REQUIRED=none; [ "$SCHEME" = https ] && SSL_REQUIRED=external
cat > "$M/keycloak/keycloak.env" <<KC
KC_DB=postgres
KC_DB_URL=jdbc:postgresql://postgres:5432/keycloak
KC_DB_USERNAME=$PG_USER
KC_DB_PASSWORD=$PG_PASSWORD
KC_BOOTSTRAP_ADMIN_USERNAME=$(cat "$M/secrets/keycloak/KC_BOOTSTRAP_ADMIN_USERNAME")
KC_BOOTSTRAP_ADMIN_PASSWORD=$(cat "$M/secrets/keycloak/KC_BOOTSTRAP_ADMIN_PASSWORD")
KC_HOSTNAME=$BASE_URL/auth
KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true
KC_HTTP_ENABLED=true
KC_HTTP_RELATIVE_PATH=/auth
KC_HTTP_MANAGEMENT_RELATIVE_PATH=/
KC_PROXY_HEADERS=xforwarded
KC_HEALTH_ENABLED=true
KC
SEED_PASSWORD="$(cat "$M/secrets/keycloak/SEED_ADMIN_PASSWORD")"
cat > "$M/keycloak/import/realm.json" <<REALM
{
  "realm": "platform",
  "displayName": "$ORG_NAME · Matelot",
  "enabled": true,
  "sslRequired": "$SSL_REQUIRED",
  "registrationAllowed": false,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "bruteForceProtected": true,
  "accessTokenLifespan": 900,
  "clients": [
    { "clientId": "platform-api", "name": "Platform API", "enabled": true, "protocol": "openid-connect", "bearerOnly": true, "publicClient": false },
    {
      "clientId": "platform-web", "name": "Platform Web", "enabled": true, "protocol": "openid-connect", "publicClient": true,
      "standardFlowEnabled": true, "directAccessGrantsEnabled": true,
      "redirectUris": ["$BASE_URL/*"], "webOrigins": ["+"],
      "attributes": { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": "+" },
      "protocolMappers": [
        { "name": "platform-api-audience", "protocol": "openid-connect", "protocolMapper": "oidc-audience-mapper", "consentRequired": false,
          "config": { "included.client.audience": "platform-api", "id.token.claim": "false", "access.token.claim": "true" } }
      ]
    }
  ],
  "users": [
    { "username": "admin", "email": "$ADMIN_EMAIL", "emailVerified": true, "enabled": true, "firstName": "Cell", "lastName": "Admin",
      "credentials": [{ "type": "password", "value": "$SEED_PASSWORD", "temporary": false }] }
  ]
}
REALM

cat > "$M/registry/config.yml" <<REG
version: 0.1
log: { level: info }
storage:
  filesystem: { rootdirectory: /var/lib/registry }
  delete: { enabled: true }
http:
  addr: :5000
  headers: { X-Content-Type-Options: [nosniff] }
auth:
  token:
    realm: $BASE_URL/api/v1/registry/token
    service: secops-registry
    issuer: secops-cell
    rootcertbundle: /matelot/secrets/registry/registry.crt
notifications:
  endpoints:
    - name: platform
      url: http://api:3000/api/v1/registry/events
      headers: { Authorization: ["Bearer $(cat "$M/secrets/registry/REGISTRY_EVENTS_SECRET")"] }
      timeout: 5s
      threshold: 3
      backoff: 10s
      ignoredmediatypes: [application/octet-stream]
REG

cat > "$M/web/config.json" <<WEB
{
  "productName": "$ORG_NAME · Matelot",
  "keycloakUrl": "$BASE_URL/auth",
  "realm": "platform",
  "clientId": "platform-web",
  "apiBaseUrl": "/api/v1",
  "docsUrl": "$DOCS_URL"
}
WEB

# non-secret environment of the api / worker, as KEY=value lines sourced by their entrypoint wrapper
cat > "$M/env/api.env" <<ENV
NODE_ENV=production
PORT=3000
LOG_LEVEL=${MATELOT_LOG_LEVEL:-info}
APP_VERSION=${MATELOT_VERSION:-unknown}
KEYCLOAK_ISSUER=$BASE_URL/auth/realms/platform
KEYCLOAK_JWKS_URI=http://keycloak:8080/auth/realms/platform/protocol/openid-connect/certs
KEYCLOAK_AUDIENCE=platform-api
BOOTSTRAP_ORG_SLUG=$ORG_SLUG
BOOTSTRAP_ORG_NAME=$ORG_NAME
BOOTSTRAP_ADMIN_EMAILS=$ADMIN_EMAIL
CORS_ORIGINS=$BASE_URL
WEB_BASE_URL=$BASE_URL
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_API_URL=https://api.github.com
GITHUB_URL=https://github.com
MATELOT_LICENSE=${MATELOT_LICENSE:-}
ENV
printf 'BASE_URL=%s\nADMIN_EMAIL=%s\nREGISTRY_HOST=%s\nSCHEME=%s\n' "$BASE_URL" "$ADMIN_EMAIL" "$REGISTRY_HOST" "$SCHEME" > "$M/env/cell.env"

# ---- ownership: every service runs as a non-root user ------------------------------------------------------------
chmod -R a+rX "$M"                       # readable by the uids of the services; the volume is private to the stack
[ -d /volumes/postgres ] && chown -R 999:999 /volumes/postgres
for v in registry backups caddy-data caddy-config runner-data runner-work; do [ -d "/volumes/$v" ] && chown -R 10001:10001 "/volumes/$v"; done
echo "matelot init: $BASE_URL (registry $REGISTRY_HOST, org $ORG_SLUG, admin $ADMIN_EMAIL)"
