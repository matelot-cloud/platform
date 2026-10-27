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
# every generated secret has a values override (`"value" .Values.…`): without one this check cannot pin it, and drop 2's
# BACKUP_REPORT_TOKEN (`"value" ""`) made it fail in CI while the stand-in renderer said the chart was fine
import re
helpers = open(f"{chart}/templates/_helpers.tpl").read()
calls = re.findall(r'include "cell\.generated" \(dict ([^\n]*)\)', helpers)
assert calls, "no cell.generated callers found"
for c in calls:
    name = re.search(r'"name" "(\w+)"', c).group(1)
    # the registry key pair's explicit form is registry.tokenKey + registry.tokenCert, passed as $explicit
    assert re.search(r'"value" (\.Values\.[\w.]+|\(coalesce \$explicit)', c), f"generated secret {name} has no values override (\"value\" .Values.…): it cannot be pinned, and an explicit value cannot be given"
report = by(first, "Secret", "acme-api-secrets")["stringData"]["BACKUP_REPORT_TOKEN"]
# every generated secret the chart keeps through `lookup` on a cluster has a values override: that is how this check
# (no cluster, so `helm template` would roll a new one per render) pins it — a generated secret without one fails here
pins = [f"--set=encryptionKey={cell_key}", f"--set=registry.eventsSecret={reg['REGISTRY_EVENTS_SECRET']}", f"--set=managedRunners.secret={runner}", f"--set=keycloak.seedAdminPassword={seed}", f"--set=backup.reportToken={report}", f"--set-file=registry.tokenKey={out}/reg.key", f"--set-file=registry.tokenCert={out}/reg.crt"]
second = render(pins)
a, b = checksums(first), checksums(second)
for w in a:
    if a[w] != b[w]:
        print(f"{w}: checksums differ between install and upgrade:\n  install {a[w]}\n  upgrade {b[w]}"); sys.exit(1)
for kind, name in [("Secret", "acme-cell-key"), ("Secret", "acme-registry"), ("Secret", "acme-managed-runner"), ("Secret", "acme-api-secrets"), ("Secret", "acme-keycloak"), ("ConfigMap", "acme-registry-config")]:
    assert by(first, kind, name) == by(second, kind, name), f"{kind}/{name} renders differently on install vs upgrade"
# every key of the generated Secrets is covered by a pin: a new generated key must get a values override and a pin here
generated = {"acme-cell-key": ["CELL_ENCRYPTION_KEY"], "acme-managed-runner": ["MANAGED_RUNNER_SECRET"], "acme-api-secrets": ["BACKUP_REPORT_TOKEN"], "acme-keycloak": ["SEED_ADMIN_PASSWORD"], "acme-registry": ["REGISTRY_EVENTS_SECRET", "registry.key", "registry.crt"]}
third = render(pins)
for name, keys in generated.items():
    for k in keys: assert by(second, "Secret", name)["stringData"][k] == by(third, "Secret", name)["stringData"][k], f"Secret {name}.{k} is not pinned: a generated secret without a values override rolls on every helm template"
print("   install and upgrade render identical checksums for", ", ".join(sorted(a)))

# an image release must roll only the workloads whose image changed — never the database, Keycloak, Redis or registry
def pod_templates(docs):
    return {f"{d['kind']}/{d['metadata']['name']}": d["spec"]["template"] for d in docs if d["kind"] in ("Deployment", "StatefulSet")} | \
           {f"CronJob/{d['metadata']['name']}": d["spec"]["jobTemplate"]["spec"]["template"] for d in docs if d["kind"] == "CronJob"}
# (generated secrets pinned as above: without a cluster each `helm template` would roll new ones, and the registry's
#  checksum legitimately covers its token key pair — on a real upgrade `lookup` returns the stored pair)
pinned = pins
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
# What `helm template` cannot catch but the API server rejects: a ConfigMap / Secret key present in BOTH data and
# binaryData ("duplicate of key present in binaryData" — the theme's favicon.svg once matched a text rule and an img/
# rule), an invalid key ([-._a-zA-Z0-9]+, at most 253 characters), a duplicate resource (kind/namespace/name twice).
# CI additionally runs `kubectl apply --dry-run=server` on a kind cluster (ci.yml, chart job); `apply` does the same
# against the cell's cluster before every upgrade.
python3 - "$OUT" <<'PY'
import glob, re, sys, yaml
out = sys.argv[1]
KEY = re.compile(r"^[-._a-zA-Z0-9]+$")
for f in sorted(glob.glob(f"{out}/*.yaml")):
    seen = set()
    for d in yaml.safe_load_all(open(f)):
        if not d or "kind" not in d: continue
        ident = (d["kind"], d["metadata"].get("namespace", ""), d["metadata"]["name"])
        assert ident not in seen, f"{f}: {ident} rendered twice"
        seen.add(ident)
        if d["kind"] in ("ConfigMap", "Secret"):
            data, binary = set(d.get("data") or {}), set(d.get("binaryData") or {})
            assert not (data & binary), f"{f}: {ident} has keys in both data and binaryData: {sorted(data & binary)}"
            bad = [k for k in data | binary if not KEY.match(k) or len(k) > 253]
            assert not bad, f"{f}: {ident} has invalid keys: {bad}"
print("   no ConfigMap / Secret key in both data and binaryData; keys valid; no resource rendered twice")
PY
# the Docker Compose stack ships copies of the chart's backup scripts: they must be identical (release.yml publishes both)
for f in backup.sh backup-report.sh restore-db.sh; do cmp -s "$CHART/files/$f" "deploy/compose/backup/$f" || { echo "deploy/compose/backup/$f differs from $CHART/files/$f (copy it over)" >&2; exit 1; }; done
cmp -s "$CHART/files/realm-sync.js" deploy/compose/init/realm-sync.js || { echo "deploy/compose/init/realm-sync.js differs from $CHART/files/realm-sync.js (copy it over)" >&2; exit 1; }
diff -r "$CHART/files/theme" deploy/compose/init/theme > /dev/null || { echo "deploy/compose/init/theme differs from $CHART/files/theme (cp -R it over)" >&2; diff -rq "$CHART/files/theme" deploy/compose/init/theme >&2; exit 1; }
# the login theme's icons are the web app's (apps/web/public is the source; tools/icons/build.mjs writes both)
for f in favicon.svg favicon.ico favicon-32.png apple-touch-icon.png; do cmp -s "apps/web/public/$f" "$CHART/files/theme/matelot/login/resources/img/$f" || { echo "login theme $f differs from apps/web/public/$f (run pnpm icons:build)" >&2; exit 1; }; done
# the matelot login theme: one ConfigMap holding every theme file (images as binaryData), mounted at
# /opt/keycloak/themes/matelot with the keys mapped back to login/… paths; realm.json selects it and names the tenant;
# keycloak.theme.enabled=false leaves the stock theme
run theme-branded --set tenant.name="Globex Corporation" --set keycloak.theme.logo=https://cdn.globex.test/logo.png --set keycloak.theme.primaryColor="#0f766e"
run theme-off --set keycloak.theme.enabled=false
python3 - "$OUT" "$CHART" <<'PY'
import base64, json, os, sys, yaml
out, chart = sys.argv[1:]
def docs(name): return [d for d in yaml.safe_load_all(open(f"{out}/{name}.yaml")) if d]
def by(ds, kind, name): return next(d for d in ds if d["kind"] == kind and d["metadata"]["name"] == name)
# Keycloak resolves a theme as themes/<name>/<type>/theme.properties: what matters is the path a file RESOLVES to
# (mountPath + item path), not that a mount exists. rc.14 mounted login/'s contents at themes/matelot (one level too
# high): "Failed to find LOGIN theme matelot", stock page. Every file under files/theme/matelot must land at
# /opt/keycloak/themes/matelot/<its path>, and themes/matelot/login/theme.properties must be among them.
THEMES = "/opt/keycloak/themes"
root = f"{chart}/files/theme/matelot"
files = sorted(os.path.relpath(os.path.join(d, f), root) for d, _, fs in os.walk(root) for f in fs)   # login/theme.properties, …
assert "login/theme.properties" in files and "login/resources/css/cell.css" in files, files
for name, logo in (("defaults", None), ("theme-branded", "https://cdn.globex.test/logo.png")):
    ds = docs(name)
    cm = by(ds, "ConfigMap", "acme-keycloak-theme")
    keys = set(cm.get("data", {})) | set(cm.get("binaryData", {}))
    assert keys == {f.replace("/", "__") for f in files}, (sorted(keys), files)
    for f in files:
        if f.endswith((".png", ".ico")):
            assert base64.b64decode(cm["binaryData"][f.replace("/", "__")]) == open(f"{root}/{f}", "rb").read(), f"{f} binaryData differs"
        elif f != "login/resources/css/cell.css":
            assert cm["data"][f.replace("/", "__")].strip() == open(f"{root}/{f}").read().strip(), f"{f} data differs"
    assert "parent=keycloak.v2" in cm["data"]["login__theme.properties"]
    cell = cm["data"]["login__resources__css__cell.css"]
    assert ("--matelot-logo" in cell) == bool(logo) and ("--matelot-primary: #0f766e" in cell) == bool(logo), cell
    dep = by(ds, "Deployment", "acme-keycloak"); pod = dep["spec"]["template"]["spec"]
    vol = next(v for v in pod["volumes"] if v["name"] == "theme")["configMap"]
    assert vol["name"] == "acme-keycloak-theme", vol
    kc = next(c for c in pod["containers"] if c["name"] == "keycloak")
    mount = next(m for m in kc["volumeMounts"] if m["name"] == "theme")
    assert mount.get("readOnly") and not mount.get("subPath"), mount
    # the resolved paths, as kubelet projects them: mountPath joined with each item's path
    resolved = {}
    for i in vol["items"]:
        assert i["key"] in keys, f"volume item {i} names a key the ConfigMap does not hold"
        assert not i["path"].startswith("/") and ".." not in i["path"].split("/"), i
        resolved[i["key"]] = os.path.normpath(os.path.join(mount["mountPath"], i["path"]))
    assert len(resolved) == len(vol["items"]) == len(files), (len(resolved), len(vol["items"]), len(files))
    assert resolved["login__theme.properties"] == f"{THEMES}/matelot/login/theme.properties", resolved["login__theme.properties"]
    assert set(resolved.values()) == {f"{THEMES}/matelot/{f}" for f in files}, sorted(set(resolved.values()) ^ {f"{THEMES}/matelot/{f}" for f in files})
    assert "checksum/theme" in dep["spec"]["template"]["metadata"]["annotations"]
    realm = json.loads(by(ds, "ConfigMap", "acme-keycloak-realm")["data"]["realm.json"])
    assert realm["loginTheme"] == "matelot" and realm["displayName"] == realm["displayNameHtml"], (realm["displayName"], realm.get("loginTheme"))
    assert "Security Platform" not in realm["displayName"]
    if name == "theme-branded": assert realm["displayName"] == "Globex Corporation"
off = docs("theme-off")
assert not any(d["kind"] == "ConfigMap" and d["metadata"]["name"] == "acme-keycloak-theme" for d in off)
assert "loginTheme" not in json.loads(by(off, "ConfigMap", "acme-keycloak-realm")["data"]["realm.json"])
assert not any(v["name"] == "theme" for v in by(off, "Deployment", "acme-keycloak")["spec"]["template"]["spec"]["volumes"])
print("   login theme: ConfigMap holds every file (images binary, cell.css from values); every item resolves to /opt/keycloak/themes/matelot/<path>, login/theme.properties included; realm selects it; theme.enabled=false is stock")
PY
# observability (docs/observability.md, drops 1–2). Defaults: metrics ports + env, one metrics Service per scrape target,
# the scrape NetworkPolicy, no exporter, no monitoring CRD. otlp: OTEL_* everywhere, headers from a Secret (never
# values). all-on: ServiceMonitor + exporters — every ServiceMonitor endpoint must hit a Service port that exists and
# every metrics Service must target a container port that exists (a ServiceMonitor pointing at nothing is silent:
# the target simply never appears). metrics-off: nothing.
run otlp --set observability.otlp.endpoint=http://jaeger.observability:4318 --set observability.otlp.headersSecret=grafana-cloud-otlp --set observability.otlp.metrics=true
run metrics-off --set observability.metrics.enabled=false
run observability-all --set observability.metrics.serviceMonitor.enabled=true --set observability.metrics.serviceMonitor.labels.release=kube-prometheus-stack --set observability.metrics.exporters.enabled=true --set observability.otlp.endpoint=http://tempo.monitoring:4318 --set backup.enabled=true --set observability.prometheusRules.enabled=true --set observability.prometheusRules.labels.release=kube-prometheus-stack --set observability.prometheusRules.runbookBaseUrl=https://docs.example.com/obs.html/ --set observability.grafana.dashboards.enabled=true --set observability.grafana.dashboards.datasources.tempo=tempo-main
run rules-no-kube --set observability.prometheusRules.enabled=true --set observability.prometheusRules.kubernetes=false
# drop 3: the dashboards and rules the chart ships are the copies of deploy/observability (built by tools/dashboards/build.py)
for f in rules/matelot.yaml rules/matelot-kubernetes.yaml dashboards/cell-overview.json dashboards/pipelines.json dashboards/security-posture.json dashboards/integrations.json; do cmp -s "$CHART/files/observability/$f" "deploy/observability/$f" || { echo "$CHART/files/observability/$f differs from deploy/observability/$f (copy it over)" >&2; exit 1; }; done
cmp -s deploy/compose/init/observability/rules/matelot.yaml deploy/observability/rules/matelot.yaml || { echo "deploy/compose/init/observability/rules/matelot.yaml differs from deploy/observability/rules/matelot.yaml (copy it over)" >&2; exit 1; }
for f in cell-overview pipelines security-posture integrations; do cmp -s "deploy/compose/init/observability/grafana/dashboards/$f.json" "deploy/observability/dashboards/$f.json" || { echo "deploy/compose/init/observability/grafana/dashboards/$f.json differs from deploy/observability/dashboards/$f.json (copy it over)" >&2; exit 1; }; done
if helm template acme "$CHART" --set observability.metrics.enabled=false --set observability.prometheusRules.enabled=true > /dev/null 2>&1; then echo "a PrometheusRule without metrics must be refused" >&2; exit 1; fi
run observability-external --set observability.metrics.serviceMonitor.enabled=true --set observability.metrics.exporters.enabled=true --set postgres.bundled=false --set postgres.externalUrl=postgresql://u:p@db:5432/platform --set postgres.externalKeycloakJdbcUrl=jdbc:postgresql://db:5432/keycloak --set redis.bundled=false --set redis.externalUrl=redis://redis.example:6379
if helm template acme "$CHART" --set observability.otlp.headers.Authorization=x > "$OUT/headers.err" 2>&1; then echo "observability.otlp.headers (tokens in values) must be refused" >&2; exit 1; fi
grep -q "observability.otlp.headers was removed" "$OUT/headers.err" || { echo "the headers refusal must say what to do: $(cat "$OUT/headers.err")" >&2; exit 1; }
if helm template acme "$CHART" --set observability.metrics.enabled=false --set observability.metrics.serviceMonitor.enabled=true > /dev/null 2>&1; then echo "a ServiceMonitor without metrics must be refused" >&2; exit 1; fi
python3 - "$OUT" <<'PY'
import sys, yaml
out = sys.argv[1]
def docs(name): return [d for d in yaml.safe_load_all(open(f"{out}/{name}.yaml")) if d]
def by(ds, kind, name): return next(d for d in ds if d["kind"] == kind and d["metadata"]["name"] == name)
def kinds(ds, kind): return [d for d in ds if d["kind"] == kind]
def pod(d): return d["spec"]["template"]["spec"] if d["kind"] != "CronJob" else d["spec"]["jobTemplate"]["spec"]["template"]["spec"]
def container(ds, kind, name, c): return next(x for x in pod(by(ds, kind, name))["containers"] if x["name"] == c)
def env(c): return {e["name"]: e.get("value") for e in c.get("env", [])}
def envref(c, n): return next((e.get("valueFrom") for e in c.get("env", []) if e["name"] == n), None)
WORKLOADS = (("Deployment", "acme-api", "api"), ("Deployment", "acme-worker", "worker"), ("StatefulSet", "acme-runner", "runner"))
def metrics_services(ds): return [d for d in kinds(ds, "Service") if d["metadata"].get("labels", {}).get("matelot.cloud/metrics") == "true"]

def check_targets(ds, name):
    """every metrics Service selects a workload whose pods expose the Service's targetPort (by name)"""
    workloads = [d for d in ds if d["kind"] in ("Deployment", "StatefulSet")]
    for svc in metrics_services(ds):
        sel = svc["spec"]["selector"]
        pods = [w for w in workloads if all(w["spec"]["template"]["metadata"]["labels"].get(k) == v for k, v in sel.items())]
        assert pods, f"{name}: {svc['metadata']['name']} selects no workload ({sel})"
        port = svc["spec"]["ports"][0]
        assert port["name"] == "metrics", (name, svc["metadata"]["name"], port)
        names = {p.get("name") for w in pods for c in w["spec"]["template"]["spec"]["containers"] for p in c.get("ports", [])}
        assert port["targetPort"] in names, f"{name}: {svc['metadata']['name']} targets port {port['targetPort']!r}, the pods expose {sorted(n for n in names if n)}"

# --- defaults: Services for api / worker / runner, nothing else
d = docs("defaults")
cm = by(d, "ConfigMap", "acme-api-config")["data"]
assert cm["MATELOT_METRICS_ENABLED"] == "true" and cm["MATELOT_METRICS_PORT"] == "9464" and cm["DEPLOYMENT_ENVIRONMENT"] == "production", cm
assert "OTEL_EXPORTER_OTLP_ENDPOINT" not in cm, "no OTLP env without an endpoint"
for kind, name, c in WORKLOADS:
    ports = {p["name"]: p["containerPort"] for p in container(d, kind, name, c).get("ports", [])}
    assert ports.get("metrics") == 9464, (name, ports)
    assert envref(container(d, kind, name, c), "OTEL_EXPORTER_OTLP_HEADERS") is None
assert env(container(d, "Deployment", "acme-api", "api"))["MATELOT_COMPONENT"] == "api"
assert env(container(d, "Deployment", "acme-worker", "worker"))["MATELOT_COMPONENT"] == "worker"
r = env(container(d, "StatefulSet", "acme-runner", "runner"))
assert r["RUNNER_METRICS_PORT"] == "9464" and r["MATELOT_CELL"] == "acme" and "OTEL_EXPORTER_OTLP_ENDPOINT" not in r, r
assert sorted(s["metadata"]["labels"]["matelot.cloud/job"] for s in metrics_services(d)) == ["matelot-api", "matelot-runner", "matelot-worker"], [s["metadata"]["name"] for s in metrics_services(d)]
check_targets(d, "defaults")
np = by(d, "NetworkPolicy", "acme-allow-metrics-scrape")["spec"]
assert np["ingress"][0]["ports"] == [{"port": 9464}] and {f["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"] for f in np["ingress"][0]["from"]} == {"monitoring", "observability"}, np
assert not any(x["apiVersion"].startswith("monitoring.coreos.com") for x in d), "no monitoring CRD with defaults"
assert [c["name"] for c in pod(by(d, "StatefulSet", "acme-postgres"))["containers"]] == ["postgres"] and [c["name"] for c in pod(by(d, "Deployment", "acme-redis"))["containers"]] == ["redis"], "no exporter sidecar by default"
assert "KC_METRICS_ENABLED" not in env(container(d, "Deployment", "acme-keycloak", "keycloak"))
assert "debug:" not in by(d, "ConfigMap", "acme-registry-config")["data"]["config.yml"]
assert "http://acme-api/api/v1/registry/events" in by(d, "ConfigMap", "acme-registry-config")["data"]["config.yml"], "registry notifications go to the api Service port (80)"
assert by(d, "Secret", "acme-api-secrets")["stringData"]["BACKUP_REPORT_TOKEN"], "the backup report token is generated"

# --- otlp: env everywhere, headers from the named Secret
o = docs("otlp")
cm = by(o, "ConfigMap", "acme-api-config")["data"]
assert cm["OTEL_EXPORTER_OTLP_ENDPOINT"] == "http://jaeger.observability:4318" and cm["OTEL_EXPORTER_OTLP_PROTOCOL"] == "http/protobuf" and cm["OTEL_TRACES_SAMPLER"] == "parentbased_always_on" and cm["OTEL_METRICS_EXPORTER"] == "prometheus,otlp", cm
for kind, name, c in WORKLOADS:
    ref = envref(container(o, kind, name, c), "OTEL_EXPORTER_OTLP_HEADERS")
    assert ref == {"secretKeyRef": {"name": "grafana-cloud-otlp", "key": "OTEL_EXPORTER_OTLP_HEADERS"}}, (name, ref)
assert not any(x["kind"] == "Secret" and "OTEL_EXPORTER_OTLP_HEADERS" in (x.get("stringData") or {}) for x in o), "OTLP headers never rendered into a Secret from values"
r = env(container(o, "StatefulSet", "acme-runner", "runner"))
assert r["OTEL_EXPORTER_OTLP_ENDPOINT"] == "http://jaeger.observability:4318" and r["OTEL_EXPORTER_OTLP_PROTOCOL"] == "http/protobuf", r

# --- all on: ServiceMonitor ↔ Services ↔ container ports; exporters; Keycloak / registry metrics; NetworkPolicy
a = docs("observability-all")
jobs = sorted(s["metadata"]["labels"]["matelot.cloud/job"] for s in metrics_services(a))
assert jobs == ["matelot-api", "matelot-keycloak", "matelot-postgres", "matelot-redis", "matelot-registry", "matelot-runner", "matelot-worker"], jobs
check_targets(a, "observability-all")
sms = kinds(a, "ServiceMonitor")
assert len(sms) == 1, sms
sm = sms[0]
assert sm["apiVersion"] == "monitoring.coreos.com/v1" and sm["metadata"]["labels"]["release"] == "kube-prometheus-stack", sm["metadata"]
assert sm["spec"]["jobLabel"] == "matelot.cloud/job" and sm["spec"]["namespaceSelector"] == {"matchNames": ["tenant-acme"]}, sm["spec"]
sel = sm["spec"]["selector"]["matchLabels"]
selected = [s for s in kinds(a, "Service") if all(s["metadata"].get("labels", {}).get(k) == v for k, v in sel.items())]
assert {s["metadata"]["name"] for s in selected} == {s["metadata"]["name"] for s in metrics_services(a)}, "the ServiceMonitor selects exactly the metrics Services"
for ep in sm["spec"]["endpoints"]:
    for s in selected: assert any(p["name"] == ep["port"] for p in s["spec"]["ports"]), f"ServiceMonitor endpoint port {ep['port']!r} missing on {s['metadata']['name']}"
    assert ep["path"] == "/metrics" and {"targetLabel": "cell", "replacement": "acme"} in ep["relabelings"], ep
pg = pod(by(a, "StatefulSet", "acme-postgres"))["containers"]
assert [c["name"] for c in pg] == ["postgres", "metrics"], pg
pe = pg[1]
assert pe["image"].startswith("quay.io/prometheuscommunity/postgres-exporter:v") and envref(pe, "DATA_SOURCE_PASS") == {"secretKeyRef": {"name": "acme-postgres", "key": "POSTGRES_PASSWORD"}}, pe
assert env(pe)["DATA_SOURCE_URI"] == "localhost:5432/platform?sslmode=disable" and pe["args"] == ["--web.listen-address=:9187"], pe
rc = pod(by(a, "Deployment", "acme-redis"))["containers"]
assert [c["name"] for c in rc] == ["redis", "metrics"] and rc[1]["args"] == ["-redis.addr=redis://localhost:6379", "-web.listen-address=:9121"], rc
assert env(container(a, "Deployment", "acme-keycloak", "keycloak"))["KC_METRICS_ENABLED"] == "true"
reg = yaml.safe_load(by(a, "ConfigMap", "acme-registry-config")["data"]["config.yml"])
assert reg["http"]["debug"] == {"addr": ":5001", "prometheus": {"enabled": True, "path": "/metrics"}}, reg["http"]
assert {"containerPort": 5001, "name": "metrics"} in container(a, "Deployment", "acme-registry", "registry")["ports"]
assert by(a, "Ingress", "acme-registry")["spec"]["rules"][0]["http"]["paths"][0]["backend"]["service"]["port"] == {"name": "http"}, "the registry's metrics port never reaches the ingress"
np = by(a, "NetworkPolicy", "acme-allow-metrics-scrape")["spec"]
assert sorted(p["port"] for p in np["ingress"][0]["ports"]) == [5001, 9000, 9121, 9187, 9464], np["ingress"][0]["ports"]
for ing in kinds(a, "Ingress"):
    for rule in ing["spec"]["rules"]:
        for path in rule["http"]["paths"]:
            svc = path["backend"]["service"]["name"]
            assert not svc.endswith("-metrics"), f"ingress {ing['metadata']['name']} routes to a metrics Service"
# the backup job reports every run (dump with a PVC; the upload step with S3) with the generated token
cj = by(a, "CronJob", "acme-backup")
dump = next(c for c in pod(cj).get("initContainers", []) + pod(cj)["containers"] if c["name"] == "dump")
assert env(dump)["REPORT_URL"] == "http://acme-api/api/v1/internal/backup-reports" and env(dump)["REPORT_SUCCESS"] == "1" and env(dump)["DESTINATION"] == "pvc", env(dump)
assert envref(dump, "REPORT_TOKEN") == {"secretKeyRef": {"name": "acme-api-secrets", "key": "BACKUP_REPORT_TOKEN"}}
assert "backup-report.sh" in by(a, "ConfigMap", "acme-backup-script")["data"]
s3 = docs("backup-s3")
cj = by(s3, "CronJob", "acme-backup")
dump = next(c for c in pod(cj)["initContainers"] if c["name"] == "dump")
up = next(c for c in pod(cj)["containers"] if c["name"] == "upload")
assert env(dump)["REPORT_SUCCESS"] == "0" and env(dump)["DESTINATION"] == "s3://b/cells/acme", env(dump)
assert "report_backup succeeded upload" in up["command"][2] and "report_backup failed upload" in up["command"][2] and envref(up, "REPORT_TOKEN"), up["command"]
assert any(m["mountPath"] == "/scripts" for m in up["volumeMounts"]), "the upload step needs backup-report.sh"

# --- external Postgres / Redis: no sidecar, no Service for them; the rest of the exporters stay
x = docs("observability-external")
jobs = sorted(s["metadata"]["labels"]["matelot.cloud/job"] for s in metrics_services(x))
assert jobs == ["matelot-api", "matelot-keycloak", "matelot-registry", "matelot-runner", "matelot-worker"], jobs
check_targets(x, "observability-external")

# --- metrics off: nothing at all
m = docs("metrics-off")
assert by(m, "ConfigMap", "acme-api-config")["data"]["MATELOT_METRICS_ENABLED"] == "false"
for kind, name, c in WORKLOADS:
    assert not any(p["name"] == "metrics" for p in container(m, kind, name, c).get("ports", [])), name
assert env(container(m, "StatefulSet", "acme-runner", "runner"))["RUNNER_METRICS_PORT"] == "0"
assert not metrics_services(m) and not any(x["kind"] == "NetworkPolicy" and x["metadata"]["name"] == "acme-allow-metrics-scrape" for x in m)
# drop 3: PrometheusRule (both groups, the runbook base rewritten, the operator's labels) and one ConfigMap per dashboard
# for Grafana's sidecar, inputs resolved to datasource uids; nothing of it by default
import json
pr = kinds(a, "PrometheusRule"); assert len(pr) == 1, len(pr)
pr = pr[0]; assert pr["metadata"]["labels"]["release"] == "kube-prometheus-stack" and pr["metadata"]["labels"]["matelot.cloud/cell"] == "acme"
assert [g["name"] for g in pr["spec"]["groups"]] == ["matelot", "matelot-kubernetes"], pr["spec"]["groups"]
rules = [r for g in pr["spec"]["groups"] for r in g["rules"]]
assert {r["alert"] for r in rules} >= {"MatelotApiDown", "MatelotNoRunnerOnline", "MatelotQueueBacklog", "MatelotBackupFailed", "MatelotBackupTooOld", "MatelotDiskAlmostFull"}, sorted(r["alert"] for r in rules)
for r in rules:
    assert r["annotations"]["runbook_url"] == f"https://docs.example.com/obs.html#alert-{r['alert'].lower()}", r["annotations"]["runbook_url"]   # the trailing slash of the value is dropped
    assert r["labels"]["severity"] in ("critical", "warning") and r["annotations"]["summary"] and r["annotations"]["description"], r["alert"]
src = yaml.safe_load(open("deploy/observability/rules/matelot.yaml"))["groups"][0]["rules"]
assert [r["expr"] for r in pr["spec"]["groups"][0]["rules"]] == [r["expr"] for r in src], "the chart renders the rules' expressions byte for byte"
nk = docs("rules-no-kube"); nkp = kinds(nk, "PrometheusRule")[0]
assert [g["name"] for g in nkp["spec"]["groups"]] == ["matelot"], "prometheusRules.kubernetes=false drops the Kubernetes group"
dash = [x for x in kinds(a, "ConfigMap") if x["metadata"]["name"].startswith("acme-dashboard-")]
assert sorted(x["metadata"]["name"] for x in dash) == ["acme-dashboard-cell-overview", "acme-dashboard-integrations", "acme-dashboard-pipelines", "acme-dashboard-security-posture"], [x["metadata"]["name"] for x in dash]
for x in dash:
    assert x["metadata"]["labels"]["grafana_dashboard"] == "1" and x["metadata"]["annotations"]["grafana_folder"] == "Matelot", x["metadata"]
    (key, body), = x["data"].items()
    assert key.startswith("matelot-") and key.endswith(".json"), key
    assert "${DS_" not in body, f"{key}: an unresolved datasource input"
    j = json.loads(body)
    uids = {t["datasource"]["uid"] for p in j["panels"] for t in p.get("targets", [])}
    assert uids == {"prometheus"}, (key, uids)
    assert j["uid"] == key[:-5] and all(v["name"] != "x" for v in j["templating"]["list"])
    if key == "matelot-pipelines.json": assert "tempo-main" in body or "${DS_TEMPO}" not in open(f"deploy/observability/dashboards/pipelines.json").read(), "the Tempo input resolves to grafana.dashboards.datasources.tempo"
assert not kinds(d, "PrometheusRule") and not [x for x in kinds(d, "ConfigMap") if "dashboard" in x["metadata"]["name"]], "no rules / dashboards by default"
print("   observability drop 3: PrometheusRule with both groups (Kubernetes group optional), runbook base rewritten, operator labels; four dashboard ConfigMaps for the sidecar with inputs resolved; nothing by default")
print("   observability: metrics Services ↔ container ports ↔ the ServiceMonitor all line up (7 targets all-on, 5 with an external database / Redis, 3 by default); exporters, Keycloak and registry metrics only when asked; OTLP headers only from a Secret; the backup job reports every run; nothing with metrics off")
PY
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
