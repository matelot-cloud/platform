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
#        realm-update (stack running: point the imported Keycloak realm at the current MATELOT_DOMAIN / scheme — the
#        `realm-sync` service does this on every `up`; init/realm-sync.js is a copy of the chart's files/realm-sync.js)
set -euo pipefail
M="${MATELOT_CONFIG_DIR:-/matelot}"      # the config volume (overridable for the unit test)
V="${MATELOT_VOLUMES_DIR:-/volumes}"     # the data volumes, for ownership
MODE="${1:-init}"
DOMAIN="${MATELOT_DOMAIN:-localhost}"
ADMIN_EMAIL="${MATELOT_ADMIN_EMAIL:-admin@localhost}"
ORG_SLUG="${MATELOT_ORG_SLUG:-main}"
ORG_NAME="${MATELOT_ORG_NAME:-My organization}"
REGISTRY_PORT="${MATELOT_REGISTRY_PORT:-5000}"
DOCS_URL="${MATELOT_DOCS_URL:-https://matelot.cloud/docs/latest/}"
case "$DOMAIN" in
  localhost|127.0.0.1|*.localhost|[0-9]*.[0-9]*.[0-9]*.[0-9]*) SCHEME=http; LOCAL=1;;
  *) SCHEME="${MATELOT_SCHEME:-https}"; LOCAL=0;;
esac
BASE_URL="$SCHEME://$DOMAIN"
if [ "$LOCAL" = 1 ]; then REGISTRY_HOST="$DOMAIN:$REGISTRY_PORT"; REGISTRY_SITE=":5000"; else REGISTRY_HOST="registry.$DOMAIN"; REGISTRY_SITE="registry.$DOMAIN"; fi

rand() { openssl rand -hex "$1"; }   # 2*$1 hex characters
# Generated KEY=value files are sourced by `sh` (api, worker, keycloak, welcome): every value is single-quoted with
# embedded quotes escaped, so an organization name with spaces, a password with $ or #, or an e-mail with + are data,
# never commands. json_str escapes a value for the realm / config.json literals.
sq() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }
kv() { printf '%s=%s\n' "$2" "$(sq "$3")" >> "$1"; }   # kv FILE KEY VALUE
json_str() { printf %s "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
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
  # Keycloak imports realm.json once (IGNORE_EXISTING); after a domain or scheme change the realm in the database is
  # brought in line by the shared script (redirect URIs, sslRequired, …; users untouched)
  KC_BOOTSTRAP_ADMIN_USERNAME="$(cat "$M/secrets/keycloak/KC_BOOTSTRAP_ADMIN_USERNAME")"; KC_BOOTSTRAP_ADMIN_PASSWORD="$(cat "$M/secrets/keycloak/KC_BOOTSTRAP_ADMIN_PASSWORD")"
  # the administrator exists from the realm import; a MATELOT_ADMIN_EMAIL changed later is seeded (temporary password)
  SEED_USERS="$ADMIN_EMAIL"; SEED_PASSWORD="$(cat "$M/secrets/keycloak/SEED_ADMIN_PASSWORD")"
  export KC_BOOTSTRAP_ADMIN_USERNAME KC_BOOTSTRAP_ADMIN_PASSWORD SEED_USERS SEED_PASSWORD
  exec node "$(dirname "$0")/realm-sync.js" "${KEYCLOAK_URL:-http://keycloak:8080/auth}" "$M/keycloak/import/realm.json"
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
  handle /.well-known/* {
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
: > "$M/keycloak/keycloak.env"
kv "$M/keycloak/keycloak.env" KC_DB postgres
kv "$M/keycloak/keycloak.env" KC_DB_URL jdbc:postgresql://postgres:5432/keycloak
kv "$M/keycloak/keycloak.env" KC_DB_USERNAME "$PG_USER"
kv "$M/keycloak/keycloak.env" KC_DB_PASSWORD "$PG_PASSWORD"
kv "$M/keycloak/keycloak.env" KC_BOOTSTRAP_ADMIN_USERNAME "$(cat "$M/secrets/keycloak/KC_BOOTSTRAP_ADMIN_USERNAME")"
kv "$M/keycloak/keycloak.env" KC_BOOTSTRAP_ADMIN_PASSWORD "$(cat "$M/secrets/keycloak/KC_BOOTSTRAP_ADMIN_PASSWORD")"
kv "$M/keycloak/keycloak.env" KC_HOSTNAME "$BASE_URL/auth"
kv "$M/keycloak/keycloak.env" KC_HOSTNAME_BACKCHANNEL_DYNAMIC true
kv "$M/keycloak/keycloak.env" KC_HTTP_ENABLED true
kv "$M/keycloak/keycloak.env" KC_HTTP_RELATIVE_PATH /auth
kv "$M/keycloak/keycloak.env" KC_HTTP_MANAGEMENT_RELATIVE_PATH /
kv "$M/keycloak/keycloak.env" KC_PROXY_HEADERS xforwarded
kv "$M/keycloak/keycloak.env" KC_HEALTH_ENABLED true
# the "matelot" login theme (init/theme, a copy of the chart's files/theme) plus this cell's overrides in cell.css:
# the keycloak service copies it into /opt/keycloak/themes at start
THEME_SRC="${MATELOT_THEME_SRC:-$(dirname "$0")/theme/matelot}"
rm -rf "$M/keycloak/theme"; mkdir -p "$M/keycloak/theme"; cp -R "$THEME_SRC" "$M/keycloak/theme/matelot"
{
  echo "/* rendered by compose-init from MATELOT_THEME_LOGO / MATELOT_THEME_PRIMARY_COLOR */"
  echo ":root {"
  [ -n "${MATELOT_THEME_LOGO:-}" ] && echo "  --matelot-logo: url(\"$MATELOT_THEME_LOGO\");"
  [ -n "${MATELOT_THEME_PRIMARY_COLOR:-}" ] && echo "  --matelot-primary: $MATELOT_THEME_PRIMARY_COLOR;" && echo "  --matelot-primary-hover: ${MATELOT_THEME_PRIMARY_COLOR_HOVER:-$MATELOT_THEME_PRIMARY_COLOR};"
  echo "}"
} > "$M/keycloak/theme/matelot/login/resources/css/cell.css"
# the layout Keycloak resolves: themes/matelot/login/theme.properties (the keycloak service copies theme/matelot as is)
[ -f "$M/keycloak/theme/matelot/login/theme.properties" ] || { echo "login theme source $THEME_SRC has no login/theme.properties" >&2; exit 1; }
SEED_PASSWORD="$(cat "$M/secrets/keycloak/SEED_ADMIN_PASSWORD")"
cat > "$M/keycloak/import/realm.json" <<REALM
{
  "realm": "platform",
  "displayName": "$(json_str "$ORG_NAME")",
  "displayNameHtml": "$(json_str "$ORG_NAME")",
  "loginTheme": "matelot",
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
    { "username": "admin", "email": "$(json_str "$ADMIN_EMAIL")", "emailVerified": true, "enabled": true,
      "credentials": [{ "type": "password", "value": "$(json_str "$SEED_PASSWORD")", "temporary": false }] }
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
  "productName": "$(json_str "$ORG_NAME") · Matelot",
  "keycloakUrl": "$BASE_URL/auth",
  "realm": "platform",
  "clientId": "platform-web",
  "apiBaseUrl": "/api/v1",
  "docsUrl": "$DOCS_URL"
}
WEB

# non-secret environment of the api / worker, as KEY=value lines sourced by their entrypoint wrapper
E="$M/env/api.env"; : > "$E"
kv "$E" NODE_ENV production
kv "$E" PORT 3000
kv "$E" LOG_LEVEL "${MATELOT_LOG_LEVEL:-info}"
kv "$E" APP_VERSION "${MATELOT_VERSION:-unknown}"
kv "$E" KEYCLOAK_ISSUER "$BASE_URL/auth/realms/platform"
kv "$E" KEYCLOAK_JWKS_URI http://keycloak:8080/auth/realms/platform/protocol/openid-connect/certs
kv "$E" KEYCLOAK_AUDIENCE platform-api
kv "$E" BOOTSTRAP_ORG_SLUG "$ORG_SLUG"
kv "$E" BOOTSTRAP_ORG_NAME "$ORG_NAME"
kv "$E" BOOTSTRAP_ADMIN_EMAILS "$ADMIN_EMAIL"
kv "$E" CORS_ORIGINS "$BASE_URL"
kv "$E" WEB_BASE_URL "$BASE_URL"
kv "$E" API_PUBLIC_URL "$BASE_URL"        # what the OAuth metadata, registry realm and runner commands advertise (Caddy routes /api here)
kv "$E" KEYCLOAK_ADMIN_URL http://keycloak:8080/auth   # user administration and invite links through Keycloak's admin API (bootstrap admin from secrets/keycloak)
kv "$E" REGISTRY_INTERNAL_URL http://registry:5000   # how the api reaches the built-in registry (the public REGISTRY_HOST is Caddy; localhost:5000 inside the api container is the api)
kv "$E" GITHUB_APP_ID ""
kv "$E" GITHUB_APP_SLUG ""
kv "$E" GITHUB_API_URL https://api.github.com
kv "$E" GITHUB_URL https://github.com
# observability (docs/observability.md): the metrics page on :9464 of api and worker (compose network only, never
# through Caddy); OTLP tracing once MATELOT_OTLP_ENDPOINT is set in .env (and metrics pushed too with MATELOT_OTLP_METRICS=1)
kv "$E" MATELOT_METRICS_ENABLED true
kv "$E" MATELOT_METRICS_PORT 9464
kv "$E" DEPLOYMENT_ENVIRONMENT "${MATELOT_ENVIRONMENT:-production}"
if [ -n "${MATELOT_OTLP_ENDPOINT:-}" ]; then
  kv "$E" OTEL_EXPORTER_OTLP_ENDPOINT "$MATELOT_OTLP_ENDPOINT"
  kv "$E" OTEL_EXPORTER_OTLP_PROTOCOL "${MATELOT_OTLP_PROTOCOL:-http/protobuf}"
  [ -n "${MATELOT_OTLP_HEADERS:-}" ] && kv "$E" OTEL_EXPORTER_OTLP_HEADERS "$MATELOT_OTLP_HEADERS"
  kv "$E" OTEL_TRACES_SAMPLER "${MATELOT_TRACES_SAMPLER:-parentbased_always_on}"
  [ "${MATELOT_OTLP_METRICS:-0}" = 1 ] && kv "$E" OTEL_METRICS_EXPORTER "prometheus,otlp"
fi
kv "$E" MATELOT_LICENSE "${MATELOT_LICENSE:-}"
C="$M/env/cell.env"; : > "$C"
kv "$C" BASE_URL "$BASE_URL"; kv "$C" ADMIN_EMAIL "$ADMIN_EMAIL"; kv "$C" REGISTRY_HOST "$REGISTRY_HOST"; kv "$C" SCHEME "$SCHEME"

# ---- ownership: every service runs as a non-root user ------------------------------------------------------------
chmod -R a+rX "$M"                       # readable by the uids of the services; the volume is private to the stack
own() { [ -d "$2" ] || return 0; chown -R "$1" "$2" 2> /dev/null || echo "warning: cannot chown $2 to $1 (not root?)"; }
own 999:999 "$V/postgres"
for v in registry backups caddy-data caddy-config runner-data runner-work; do own 10001:10001 "$V/$v"; done
echo "matelot init: $BASE_URL (registry $REGISTRY_HOST, org $ORG_SLUG, admin $ADMIN_EMAIL)"
