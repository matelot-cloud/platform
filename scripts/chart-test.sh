#!/usr/bin/env bash
# Lint and render the cell chart in the configurations that matter, with the real helm (CI and `make helm-lint`).
#   scripts/chart-test.sh            # needs helm 3 on PATH
set -euo pipefail
cd "$(dirname "$0")/.."
CHART=deploy/helm/secops-cell
[ ! -e helm ] || { echo "stale chart copy at ./helm — the chart lives in deploy/helm/secops-cell only (git rm -r helm)" >&2; exit 1; }
OUT="${CHART_TEST_OUT:-$(mktemp -d)}"
run() { # run <name> [helm template args…]
  local name="$1"; shift
  echo "== $name"
  helm lint "$CHART" "$@" > "$OUT/$name.lint" || { cat "$OUT/$name.lint"; exit 1; }
  helm template acme "$CHART" --namespace tenant-acme "$@" > "$OUT/$name.yaml"
  grep -c '^kind:' "$OUT/$name.yaml" | sed 's/^/   resources: /'
}
run defaults
run production -f "$CHART/values-production.example.yaml"
run backup-pvc --set backup.enabled=true
run backup-s3 --set backup.enabled=true --set backup.pvc.enabled=false --set backup.s3.enabled=true --set backup.s3.bucket=b --set backup.s3.prefix=cells/acme
run external-db --set postgres.bundled=false --set postgres.externalUrl=postgresql://u:p@db:5432/platform --set postgres.externalKeycloakJdbcUrl=jdbc:postgresql://db:5432/keycloak --set backup.enabled=true
run tls --set ingress.tls=true
run insecure-hostname --set ingress.tls=false --set tenant.domain=platform.example.com
run plain-localhost --set ingress.tls=false --set tenant.domain=localhost
run no-managed-runners --set managedRunners.enabled=false --set registry.enabled=false
# what must and must not be there
# plain HTTP on a hostname that is not localhost cannot sign in (browsers: secure contexts only): the chart must say so —
# in NOTES.txt (helm template never prints it) and as an annotation on the Ingress (what this test can see)
grep -q 'matelot.cloud/insecure-context: "WARNING: ingress.tls is false' "$OUT/insecure-hostname.yaml" || { echo "tls=false on a real hostname must carry the insecure-context warning" >&2; exit 1; }
grep -q 'Crypto.subtle is available only in secure contexts' "$OUT/insecure-hostname.yaml" || { echo "the insecure-context warning must quote the browser error" >&2; exit 1; }
grep -q 'insecure-context' "$OUT/tls.yaml" && { echo "tls=true must not warn" >&2; exit 1; }
grep -q 'insecure-context' "$OUT/plain-localhost.yaml" && { echo "plain HTTP on localhost must not warn" >&2; exit 1; }
grep -q 'cell.insecureContext' "$CHART/templates/NOTES.txt" || { echo "NOTES.txt must carry the insecure-context warning" >&2; exit 1; }
grep -q 'kind: CronJob' "$OUT/backup-pvc.yaml" && ! grep -q 'kind: CronJob' "$OUT/defaults.yaml" || { echo "backup CronJob rendering is wrong" >&2; exit 1; }
grep -q 'kind: PersistentVolumeClaim' "$OUT/backup-pvc.yaml" && grep -q 'initContainers' "$OUT/backup-s3.yaml" || { echo "backup storage rendering is wrong" >&2; exit 1; }
grep -q 'DATABASE_URL' "$OUT/external-db.yaml" || { echo "external-db backup should use DATABASE_URL" >&2; exit 1; }
grep -q '"docsUrl": "https://matelot.cloud/docs/latest/"' "$OUT/defaults.yaml" || { echo "web config.json should carry the default docsUrl" >&2; exit 1; }
grep -q 'API_PUBLIC_URL: "http://acme.platform.local"' "$OUT/defaults.yaml" || { echo "api-configmap must set API_PUBLIC_URL to the cell's public URL" >&2; exit 1; }
grep -q 'path: /.well-known' "$OUT/defaults.yaml" || { echo "the app ingress must route /.well-known to the API (matelot login discovery)" >&2; exit 1; }
# data outlives `helm uninstall`: every PVC the chart creates is kept; Keycloak waits for Postgres instead of restarting
python3 - "$OUT/backup-pvc.yaml" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
for d in docs:
    if d["kind"] == "PersistentVolumeClaim":
        assert d["metadata"].get("annotations", {}).get("helm.sh/resource-policy") == "keep", f"PVC {d['metadata']['name']} would be deleted by helm uninstall"
kc = next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"].endswith("-keycloak"))
assert any(c["name"] == "wait-for-postgres" for c in kc["spec"]["template"]["spec"].get("initContainers", [])), "keycloak has no wait-for-postgres init container"
print("   PVCs kept on uninstall; keycloak waits for postgres")
PY
# invalid combinations are refused
if helm template acme "$CHART" --set backup.enabled=true --set backup.pvc.enabled=false > /dev/null 2>&1; then echo "backup without storage must fail" >&2; exit 1; fi
if helm template acme "$CHART" --set backup.enabled=true --set backup.s3.enabled=true > /dev/null 2>&1; then echo "s3 without bucket must fail" >&2; exit 1; fi
# Generated secrets: an install (nothing to look up) must render the same bytes as the next upgrade (lookup returns what
# the install stored), otherwise every first upgrade rolls the pods. `helm template` has no cluster, so the upgrade path
# is simulated by feeding the generated values back in explicitly, which is what lookup would return.
echo "== generated secrets: install == upgrade, and one value per render"
python3 - "$OUT" <<'PY'
import subprocess, sys, os, yaml
out = sys.argv[1]; chart = "deploy/helm/secops-cell"
def render(extra):
    y = subprocess.run(["helm", "template", "acme", chart, "--namespace", "tenant-acme", "--set", "backup.enabled=true", *extra], check=True, capture_output=True, text=True).stdout
    return [d for d in yaml.safe_load_all(y) if d]
def by(docs, kind, name): return next(d for d in docs if d["kind"] == kind and d["metadata"]["name"] == name)
def checksums(docs):
    return {f"{d['kind']}/{d['metadata']['name']}": d["spec"]["template"]["metadata"].get("annotations", {}) for d in docs if d["kind"] in ("Deployment", "StatefulSet")}
first = render([])
cell_key = by(first, "Secret", "acme-cell-key")["stringData"]["CELL_ENCRYPTION_KEY"]
reg = by(first, "Secret", "acme-registry")["stringData"]
runner = by(first, "Secret", "acme-managed-runner")["stringData"]["MANAGED_RUNNER_SECRET"]
# one value per render: the registry config must carry the same events secret as the Secret the API reads
config = by(first, "ConfigMap", "acme-registry-config")["data"]["config.yml"]
assert reg["REGISTRY_EVENTS_SECRET"] in config, "registry config.yml and Secret disagree on REGISTRY_EVENTS_SECRET"
open(f"{out}/reg.key", "w").write(reg["registry.key"]); open(f"{out}/reg.crt", "w").write(reg["registry.crt"])
seed = by(first, "Secret", "acme-keycloak")["stringData"]["SEED_ADMIN_PASSWORD"]
second = render([f"--set=encryptionKey={cell_key}", f"--set=registry.eventsSecret={reg['REGISTRY_EVENTS_SECRET']}", f"--set=managedRunners.secret={runner}", f"--set=keycloak.seedAdminPassword={seed}", f"--set-file=registry.tokenKey={out}/reg.key", f"--set-file=registry.tokenCert={out}/reg.crt"])
a, b = checksums(first), checksums(second)
for w in a:
    if a[w] != b[w]:
        print(f"{w}: checksums differ between install and upgrade:\n  install {a[w]}\n  upgrade {b[w]}"); sys.exit(1)
for kind, name in [("Secret", "acme-cell-key"), ("Secret", "acme-registry"), ("Secret", "acme-managed-runner"), ("Secret", "acme-api-secrets"), ("Secret", "acme-keycloak"), ("ConfigMap", "acme-registry-config")]:
    assert by(first, kind, name) == by(second, kind, name), f"{kind}/{name} renders differently on install vs upgrade"
print("   install and upgrade render identical checksums for", ", ".join(sorted(a)))

# an image release must roll only the workloads whose image changed — never the database, Keycloak, Redis or registry
def pod_templates(docs):
    return {f"{d['kind']}/{d['metadata']['name']}": d["spec"]["template"] for d in docs if d["kind"] in ("Deployment", "StatefulSet")} | \
           {f"CronJob/{d['metadata']['name']}": d["spec"]["jobTemplate"]["spec"]["template"] for d in docs if d["kind"] == "CronJob"}
# (generated secrets pinned as above: without a cluster each `helm template` would roll new ones, and the registry's
#  checksum legitimately covers its token key pair — on a real upgrade `lookup` returns the stored pair)
pinned = [f"--set=encryptionKey={cell_key}", f"--set=registry.eventsSecret={reg['REGISTRY_EVENTS_SECRET']}", f"--set=managedRunners.secret={runner}", f"--set=keycloak.seedAdminPassword={seed}", f"--set-file=registry.tokenKey={out}/reg.key", f"--set-file=registry.tokenCert={out}/reg.crt"]
# the realm-sync hook seeds tenant.adminEmails with the generated temporary password; off with keycloak.seedAdmins=false
job = by(first, "Job", "acme-realm-sync"); env = {e["name"]: e for e in job["spec"]["template"]["spec"]["containers"][0]["env"]}
assert env["SEED_USERS"]["value"] == ",".join(yaml.safe_load(open(f"{chart}/values.yaml"))["tenant"]["adminEmails"]), "SEED_USERS must be tenant.adminEmails"
assert env["SEED_PASSWORD"]["valueFrom"]["secretKeyRef"] == {"name": "acme-keycloak", "key": "SEED_ADMIN_PASSWORD"}
assert job["metadata"]["annotations"]["helm.sh/hook-delete-policy"] == "before-hook-creation", "the last realm-sync Job must stay for kubectl logs"
noseed = render(["--set", "keycloak.seedAdmins=false"])
assert "SEED_ADMIN_PASSWORD" not in by(noseed, "Secret", "acme-keycloak")["stringData"] and "SEED_USERS" not in {e["name"] for e in by(noseed, "Job", "acme-realm-sync")["spec"]["template"]["spec"]["containers"][0]["env"]}
print("   realm-sync seeds", env["SEED_USERS"]["value"], "with SEED_ADMIN_PASSWORD; seedAdmins=false renders neither")
tag_a = render(pinned + ["--set", "image.tag=1.0.0", "--set", "worker.image.tag=1.0.0", "--set", "web.image.tag=1.0.0", "--set", "managedRunners.image.tag=1.0.0"])
tag_b = render(pinned + ["--set", "image.tag=1.0.1", "--set", "worker.image.tag=1.0.1", "--set", "web.image.tag=1.0.1", "--set", "managedRunners.image.tag=1.0.1"])
pa, pb = pod_templates(tag_a), pod_templates(tag_b)
changed = sorted(k for k in pa if pa[k] != pb[k])
expected = sorted(["Deployment/acme-api", "Deployment/acme-worker", "Deployment/acme-web", "StatefulSet/acme-runner"])
assert changed == expected, f"an image tag change rolls {changed}, expected only {expected}"
for k in ("StatefulSet/acme-postgres", "Deployment/acme-keycloak", "Deployment/acme-redis", "Deployment/acme-registry", "CronJob/acme-backup"):
    assert k in pa and pa[k] == pb[k], f"{k} pod template differs across tags"
print("   an image tag change rolls only", ", ".join(changed))
# a TLS switch or a domain change rolls what carries the URLs (api/worker via their ConfigMap checksum, Keycloak via its
# realm checksum, web config, the registry whose token realm URL carries the scheme) — never the database, Redis, the
# runners or the backup job. (Deployment/acme-registry was once on the must-not-roll list below and CI `chart` failed
# on it twice when a drop re-added it: keep it off.)
http_a = render(pinned + ["--set", "ingress.tls=false"])
https_b = render(pinned + ["--set", "ingress.tls=true"])
qa, qb = pod_templates(http_a), pod_templates(https_b)
rolled = sorted(k for k in qa if qa[k] != qb[k])
for k in ("StatefulSet/acme-postgres", "Deployment/acme-redis", "StatefulSet/acme-runner", "CronJob/acme-backup"):
    assert k in qa and qa[k] == qb[k], f"{k} pod template changes on a TLS switch (it must not restart): rolled={rolled}"
print("   a TLS switch rolls only", ", ".join(rolled))
dom_b = render(pinned + ["--set", "tenant.domain=other.example.com"])
ra, rb = pod_templates(http_a), pod_templates(dom_b)
rolled = sorted(k for k in ra if ra[k] != rb[k])
for k in ("StatefulSet/acme-postgres", "Deployment/acme-redis", "StatefulSet/acme-runner", "CronJob/acme-backup"):
    assert k in ra and ra[k] == rb[k], f"{k} pod template changes on a domain change (it must not restart): rolled={rolled}"
print("   a domain change rolls only", ", ".join(rolled))
PY
# the Docker Compose stack ships copies of the chart's backup scripts: they must be identical (release.yml publishes both)
for f in backup.sh restore-db.sh; do cmp -s "$CHART/files/$f" "deploy/compose/backup/$f" || { echo "deploy/compose/backup/$f differs from $CHART/files/$f (copy it over)" >&2; exit 1; }; done
cmp -s "$CHART/files/realm-sync.js" deploy/compose/init/realm-sync.js || { echo "deploy/compose/init/realm-sync.js differs from $CHART/files/realm-sync.js (copy it over)" >&2; exit 1; }
# the realm-sync hook: post-install + post-upgrade, mounts the realm ConfigMap, runs the shared script; Keycloak's import
# directory gets realm.json only (the script must not land in /opt/keycloak/data/import)
grep -q 'helm.sh/hook: post-install,post-upgrade' "$OUT/defaults.yaml" && grep -q 'node, /realm/realm-sync.js\|"node", "/realm/realm-sync.js"' "$OUT/defaults.yaml" || { echo "realm-sync hook Job missing" >&2; exit 1; }
grep -q 'items: \[{ key: realm.json, path: realm.json }\]\|key: realm.json' "$OUT/defaults.yaml" || { echo "keycloak must mount only realm.json from the realm ConfigMap" >&2; exit 1; }
# the http → https upgrade scenario at the rendering level: the realm the hook applies carries the https redirect URI
grep -q '"https://acme.platform.local/\*"' "$OUT/tls.yaml" && grep -q '"sslRequired": "external"' "$OUT/tls.yaml" || { echo "tls=true realm must carry https redirect URIs and sslRequired external" >&2; exit 1; }
grep -q '"http://acme.platform.local/\*"' "$OUT/defaults.yaml" || { echo "tls=false realm must carry the http redirect URI" >&2; exit 1; }
# user administration: the api reaches the bundled Keycloak's admin API with the bootstrap admin from the keycloak Secret
grep -q 'KEYCLOAK_ADMIN_URL: "http://acme-keycloak:8080"' "$OUT/defaults.yaml" && grep -q 'key: KC_BOOTSTRAP_ADMIN_PASSWORD' "$OUT/defaults.yaml" || { echo "api must get KEYCLOAK_ADMIN_URL and the Keycloak bootstrap admin" >&2; exit 1; }
docker compose -f deploy/compose/compose.yaml --env-file deploy/compose/.env.example config --quiet 2>/dev/null && echo "   compose.yaml renders" || echo "   (docker compose not available: compose.yaml not rendered here)"
echo "chart ok ($OUT)"
