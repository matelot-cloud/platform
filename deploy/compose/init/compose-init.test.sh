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
# observability: metrics always on (compose network only), OTLP only once MATELOT_OTLP_ENDPOINT is set
check_env "$M/env/api.env" MATELOT_METRICS_ENABLED true
check_env "$M/env/api.env" MATELOT_METRICS_PORT 9464
check_env "$M/env/api.env" OTEL_EXPORTER_OTLP_ENDPOINT ""
grep -q 'node -r ./dist/telemetry/tracing.js dist/main.js' ../compose.yaml && grep -q 'node -r ./dist/telemetry/tracing.js dist/worker.js' ../compose.yaml || { echo "FAIL: api / worker must start through the tracing preload" >&2; exit 1; }
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
assert realm["displayName"] == name and realm["displayNameHtml"] == name and realm["loginTheme"] == "matelot", (realm["displayName"], realm.get("loginTheme"))
u = realm["users"][0]; assert u["email"] == email and u["credentials"][0]["value"] == pw
assert realm["clients"][1]["redirectUris"] == ["http://localhost/*"] and realm["sslRequired"] == "none"
web = json.load(open(f"{m}/web/config.json")); assert web["productName"] == f"{name} · Matelot" and web["keycloakUrl"] == "http://localhost/auth"
print("json ok")
PY
# the login theme is assembled into the config volume (keycloak copies it to /opt/keycloak/themes at start): the
# chart's files plus cell.css from the branding variables — empty here, so only the defaults of matelot.css apply
for f in theme.properties messages/messages_en.properties resources/css/matelot.css resources/css/cell.css resources/js/matelot.js resources/img/favicon.svg resources/img/favicon.ico resources/img/favicon-32.png resources/img/logo.png resources/img/apple-touch-icon.png; do
  [ -f "$M/keycloak/theme/matelot/login/$f" ] || { echo "FAIL: theme file missing: $f" >&2; exit 1; }
done
grep -q '^parent=keycloak.v2' "$M/keycloak/theme/matelot/login/theme.properties"
# compose.yaml copies theme/matelot to /opt/keycloak/themes/matelot: the file Keycloak looks up is themes/matelot/login/theme.properties
[ -f "$M/keycloak/theme/matelot/login/theme.properties" ] && [ ! -e "$M/keycloak/theme/matelot/theme.properties" ] || { echo "FAIL: theme must be laid out as theme/matelot/login/theme.properties (one level too high = stock theme)" >&2; exit 1; }
grep -q 'test -f /opt/keycloak/themes/matelot/login/theme.properties' ../compose.yaml || { echo "FAIL: compose.yaml must refuse to start keycloak without themes/matelot/login/theme.properties" >&2; exit 1; }
grep -q -- '--matelot-logo' "$M/keycloak/theme/matelot/login/resources/css/cell.css" && { echo "FAIL: cell.css should carry no logo without MATELOT_THEME_LOGO" >&2; exit 1; }
# secrets are generated once: a second run with a new domain keeps them and rewrites the derived files
cp "$M/secrets/cell-key/CELL_ENCRYPTION_KEY" "$T/key1"; cp "$M/secrets/postgres/POSTGRES_PASSWORD" "$T/pg1"
MATELOT_ORG_NAME="$NAME" MATELOT_DOMAIN=matelot.example.com MATELOT_ACME_EMAIL="$EMAIL" MATELOT_THEME_LOGO='https://cdn.example.com/logo.png' MATELOT_THEME_PRIMARY_COLOR='#0f766e' MATELOT_OTLP_ENDPOINT=http://jaeger:4318 MATELOT_OTLP_HEADERS='Authorization=Basic abc' MATELOT_OTLP_METRICS=1 bash compose-init.sh > "$T/out2" 2>&1 || { cat "$T/out2"; exit 1; }
check_env "$M/env/api.env" OTEL_EXPORTER_OTLP_ENDPOINT "http://jaeger:4318"
check_env "$M/env/api.env" OTEL_EXPORTER_OTLP_PROTOCOL "http/protobuf"
check_env "$M/env/api.env" OTEL_EXPORTER_OTLP_HEADERS "Authorization=Basic abc"
check_env "$M/env/api.env" OTEL_METRICS_EXPORTER "prometheus,otlp"
grep -q -- '--matelot-logo: url("https://cdn.example.com/logo.png");' "$M/keycloak/theme/matelot/login/resources/css/cell.css" || { echo "FAIL: cell.css logo override" >&2; exit 1; }
grep -q -- '--matelot-primary: #0f766e;' "$M/keycloak/theme/matelot/login/resources/css/cell.css" || { echo "FAIL: cell.css colour override" >&2; exit 1; }
grep -q -- '--matelot-primary-hover: #0f766e;' "$M/keycloak/theme/matelot/login/resources/css/cell.css" || { echo "FAIL: hover defaults to the primary colour" >&2; exit 1; }
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
# the observability profile (COMPOSE_PROFILES=observability → MATELOT_PROFILES): Grafana's secrets, its route, its
# Keycloak client, the exporters' switches, the runner's OTLP default and the stack's configs rendered for the cell
MATELOT_PROFILES=observability MATELOT_ORG_SLUG=acme MATELOT_ORG_NAME="$NAME" MATELOT_DOMAIN=matelot.example.com MATELOT_ACME_EMAIL="$EMAIL" bash compose-init.sh > "$T/out3" 2>&1 || { cat "$T/out3"; exit 1; }
for f in grafana/GF_SECURITY_ADMIN_PASSWORD grafana/GRAFANA_OIDC_CLIENT_SECRET api-secrets/BACKUP_REPORT_TOKEN; do [ -s "$M/secrets/$f" ] || { echo "FAIL: secret $f" >&2; exit 1; }; done
grep -q "handle /grafana\* {" "$M/caddy/Caddyfile" && grep -q "reverse_proxy grafana:3000" "$M/caddy/Caddyfile" || { echo "FAIL: Grafana route" >&2; exit 1; }
check_env "$M/keycloak/keycloak.env" KC_METRICS_ENABLED true
check_env "$M/env/api.env" OTEL_EXPORTER_OTLP_ENDPOINT "http://otel-collector:4318"
check_env "$M/env/runner.env" OTEL_EXPORTER_OTLP_ENDPOINT "http://otel-collector:4318"
check_env "$M/env/runner.env" MATELOT_CELL acme
check_env "$M/env/grafana.env" GF_SERVER_ROOT_URL "https://matelot.example.com/grafana/"
check_env "$M/env/grafana.env" GF_PLUGINS_PREINSTALL_DISABLED true
check_env "$M/env/grafana.env" GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET__FILE /matelot/secrets/grafana/GRAFANA_OIDC_CLIENT_SECRET
python3 - "$M" <<'PY'
import json, sys, yaml, pathlib
m = pathlib.Path(sys.argv[1])
r = json.load(open(m / "keycloak/import/realm.json"))
g = next(c for c in r["clients"] if c["clientId"] == "grafana")
assert g["secret"] == (m / "secrets/grafana/GRAFANA_OIDC_CLIENT_SECRET").read_text().strip() and not g.get("publicClient"), g
assert g["redirectUris"] == ["https://matelot.example.com/grafana/login/generic_oauth"] and g["attributes"]["matelot.createIfMissing"] == "true", g
reg = yaml.safe_load(open(m / "registry/config.yml"))
assert reg["http"]["debug"] == {"addr": ":5001", "prometheus": {"enabled": True, "path": "/metrics"}}, reg["http"].get("debug")
o = m / "observability"
for f in ("otel-collector.yaml", "tempo.yaml", "loki.yaml", "prometheus.yml", "grafana/datasources/datasources.yaml"):
    assert "__CELL__" not in (o / f).read_text(), f
    yaml.safe_load(open(o / f))
assert "__CELL__" not in (o / "alloy.alloy").read_text()
prom = yaml.safe_load(open(o / "prometheus.yml"))
assert prom["global"]["external_labels"]["cell"] == "acme"
jobs = {j["job_name"] for j in prom["scrape_configs"]}
assert {"matelot-api", "matelot-worker", "matelot-runner", "matelot-postgres", "matelot-redis", "matelot-keycloak", "matelot-registry"} <= jobs, jobs
ds = {d["uid"]: d for d in yaml.safe_load(open(o / "grafana/datasources/datasources.yaml"))["datasources"]}
assert ds["prometheus"]["jsonData"]["exemplarTraceIdDestinations"][0]["datasourceUid"] == "tempo"
assert ds["tempo"]["jsonData"]["tracesToLogsV2"]["datasourceUid"] == "loki" and 'cell="acme"' in ds["tempo"]["jsonData"]["tracesToLogsV2"]["query"]
# drop 3: the dashboards are provisioned with their inputs resolved to those datasources; Prometheus loads the rules and
# labels every cell target with cell="<slug>" (what the rules and the $cell variable group on)
dash = sorted(p.name for p in (o / "grafana/dashboards").glob("*.json"))
assert dash == ["cell-overview.json", "integrations.json", "pipelines.json", "security-posture.json"], dash
for f in dash:
    body = (o / "grafana/dashboards" / f).read_text(); assert "${DS_" not in body, f
    j = json.loads(body); assert {t["datasource"]["uid"] for p in j["panels"] for t in p.get("targets", [])} == {"prometheus"}, f
prov = yaml.safe_load(open(o / "grafana/dashboards/dashboards.yaml"))["providers"][0]
assert prov["options"]["path"] == "/matelot/observability/grafana/dashboards" and prov["folder"] == "Matelot"
assert prom["rule_files"] == ["/matelot/observability/rules/matelot.yaml"] and (o / "rules/matelot.yaml").exists()
for j in prom["scrape_configs"]:
    if j["job_name"].startswith("matelot-"): assert j["static_configs"][0]["labels"] == {"cell": "acme"}, j
rules = yaml.safe_load(open(o / "rules/matelot.yaml")); assert rules["groups"][0]["name"] == "matelot"
PY
MATELOT_PROFILES=observability bash compose-init.sh show | grep -q "Grafana" || { echo "FAIL: show prints Grafana" >&2; exit 1; }
# without the profile nothing of it is rendered into the Caddyfile or Keycloak
MATELOT_ORG_NAME="$NAME" MATELOT_DOMAIN=matelot.example.com MATELOT_ACME_EMAIL="$EMAIL" bash compose-init.sh > /dev/null 2>&1
! grep -q "grafana" "$M/caddy/Caddyfile" || { echo "FAIL: Grafana route without the profile" >&2; exit 1; }
! grep -q KC_METRICS_ENABLED "$M/keycloak/keycloak.env" || { echo "FAIL: Keycloak metrics without the profile" >&2; exit 1; }
# compose.yaml: every MATELOT_* this script reads reaches it through x-config-env (the theme and OTLP settings once
# did not); no service of the observability profile publishes a port (they are reached through Caddy or not at all)
python3 - ../compose.yaml compose-init.sh <<'PY'
import re, sys, yaml
compose = yaml.safe_load(open(sys.argv[1]))
read = set(re.findall(r"\$\{(MATELOT_[A-Z_]+)", open(sys.argv[2]).read()))
internal = {"MATELOT_CONFIG_DIR", "MATELOT_VOLUMES_DIR", "MATELOT_THEME_SRC", "MATELOT_OBSERVABILITY_SRC"}   # set by the init service itself
passed = set(compose["x-config-env"])
missing = sorted(read - internal - passed)
assert not missing, f"compose-init.sh reads {missing} but x-config-env does not pass them"
assert compose["x-config-env"]["MATELOT_PROFILES"] == "${COMPOSE_PROFILES:-}"
obs = [n for n, s in compose["services"].items() if "observability" in (s.get("profiles") or [])]
assert {"otel-collector", "prometheus", "tempo", "loki", "grafana", "alloy", "postgres-exporter", "redis-exporter"} <= set(obs), obs
for n in obs:
    assert not compose["services"][n].get("ports"), f"{n} publishes a port"
PY
echo "compose-init ok (incl. the observability profile)"
