#!/usr/bin/env bash
# The chart's Keycloak login theme on a real kubelet: renders the chart, applies its theme + realm ConfigMaps to a kind
# (or any) cluster, starts ONE Keycloak pod with exactly the Deployment's theme volume and mount (no Postgres: dev mode
# with the embedded database, the realm imported from the chart's ConfigMap), then checks what only a running server
# shows — the file Keycloak resolves (themes/matelot/login/theme.properties) is there, the log has no "Failed to find
# LOGIN theme" (a missing theme is silent apart from that line: stock page, HTTP 200), and the sign-in page carries our
# title, theme and assets (deploy/compose/login-page-check.sh, the same check the Compose smoke test runs).
# rc.14 shipped the login/ directory's contents one level too high; chart-test asserts the resolved paths statically,
# this is the dynamic half. CI: job `chart`, after the kind dry-run. Needs helm, kubectl, a cluster, about 90 s.
#   scripts/chart-theme-kind-test.sh [namespace]   (default theme-check)
set -euo pipefail
cd "$(dirname "$0")/.."
NS="${1:-theme-check}"; PORT="${THEME_CHECK_PORT:-8081}"
T="$(mktemp -d)"; trap 'kill "${PF:-}" 2>/dev/null || true; kubectl delete namespace "$NS" --wait=false > /dev/null 2>&1 || true; rm -rf "$T"' EXIT
helm template acme deploy/helm/secops-cell --namespace "$NS" --set tenant.name="Globex Corporation" --set keycloak.theme.logo=https://cdn.globex.test/logo.png --set keycloak.theme.primaryColor="#0f766e" > "$T/rendered.yaml"
# the two ConfigMaps as rendered, and a pod built from the Deployment's keycloak container: same image, same theme
# volume + mount, same realm mount; dev mode with the embedded database, the realm allowing this port's redirect URI
python3 - "$T/rendered.yaml" "$T/check.yaml" "$PORT" <<'PY'
import json, sys, yaml
rendered, out, port = sys.argv[1], sys.argv[2], sys.argv[3]
ds = [d for d in yaml.safe_load_all(open(rendered)) if d]
def by(kind, name): return next(d for d in ds if d["kind"] == kind and d["metadata"]["name"] == name)
theme, realm, dep = by("ConfigMap", "acme-keycloak-theme"), by("ConfigMap", "acme-keycloak-realm"), by("Deployment", "acme-keycloak")
r = json.loads(realm["data"]["realm.json"])
for c in r.get("clients", []):
    if c["clientId"] == "platform-web": c["redirectUris"] = [f"http://localhost:{port}/*"] + c.get("redirectUris", [])
realm["data"]["realm.json"] = json.dumps(r)
pod = dep["spec"]["template"]["spec"]
kc = next(c for c in pod["containers"] if c["name"] == "keycloak")
volumes = [v for v in pod["volumes"] if v["name"] in ("theme", "realm")]
mounts = [m for m in kc["volumeMounts"] if m["name"] in ("theme", "realm")]
assert any(v["name"] == "theme" for v in volumes) and any(m["name"] == "theme" for m in mounts), "the Deployment has no theme volume / mount"
check = {"apiVersion": "v1", "kind": "Pod", "metadata": {"name": "theme-check", "labels": {"app": "theme-check"}},
         "spec": {"restartPolicy": "Never", "volumes": volumes, "containers": [{
             "name": "keycloak", "image": kc["image"], "volumeMounts": mounts,
             "command": ["/opt/keycloak/bin/kc.sh", "start-dev", "--import-realm", "--http-relative-path=/auth", "--http-port=8080"],
             "env": [{"name": "KC_BOOTSTRAP_ADMIN_USERNAME", "value": "admin"}, {"name": "KC_BOOTSTRAP_ADMIN_PASSWORD", "value": "admin"}, {"name": "KC_HEALTH_ENABLED", "value": "true"}],
             "ports": [{"containerPort": 8080}]}]}}
for d in (theme, realm, check): d["metadata"].pop("namespace", None)
with open(out, "w") as f: yaml.safe_dump_all([theme, realm, check], f)
print(f"   pod theme-check: image {kc['image']}, volumes {[v['name'] for v in volumes]}, theme mounted at {next(m['mountPath'] for m in mounts if m['name'] == 'theme')}")
PY
kubectl create namespace "$NS" > /dev/null
kubectl apply -n "$NS" -f "$T/check.yaml" > /dev/null
echo "   waiting for Keycloak (image pull + start, up to 4 min)"
for _ in $(seq 1 48); do
  phase="$(kubectl get pod theme-check -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  [ "$phase" = Running ] && kubectl logs theme-check -n "$NS" 2>/dev/null | grep -q "Listening on" && break
  [ "$phase" = Failed ] && { kubectl logs theme-check -n "$NS" | tail -30 >&2; echo "the Keycloak pod failed" >&2; exit 1; }
  sleep 5
done
kubectl logs theme-check -n "$NS" | grep -q "Listening on" || { kubectl describe pod theme-check -n "$NS" | tail -20 >&2; kubectl logs theme-check -n "$NS" | tail -30 >&2; echo "Keycloak did not start" >&2; exit 1; }
# 1. the file Keycloak resolves, at the path the volume items produce
kubectl exec theme-check -n "$NS" -- test -f /opt/keycloak/themes/matelot/login/theme.properties || {
  echo "themes/matelot/login/theme.properties is missing in the pod; what the mount holds:" >&2; kubectl exec theme-check -n "$NS" -- find /opt/keycloak/themes/matelot -maxdepth 2 >&2 || true; exit 1; }
echo "   /opt/keycloak/themes/matelot/login/theme.properties: present"
# 2. the page, through a port-forward (the realm answers once the import is done)
kubectl port-forward pod/theme-check -n "$NS" "$PORT:8080" > "$T/pf.log" 2>&1 &
PF=$!
for _ in $(seq 1 30); do curl -fsS -o /dev/null "http://localhost:$PORT/auth/realms/platform" 2>/dev/null && break; sleep 2; done
bash deploy/compose/login-page-check.sh "http://localhost:$PORT" || { kubectl logs theme-check -n "$NS" | tail -30 >&2; exit 1; }
# 3. the one line a missing theme leaves (Keycloak answers 200 with the stock theme otherwise)
if kubectl logs theme-check -n "$NS" | grep -q "Failed to find LOGIN theme"; then
  kubectl logs theme-check -n "$NS" | grep "Failed to find" >&2; echo "Keycloak could not load the matelot theme" >&2; exit 1
fi
echo "   keycloak log: no 'Failed to find LOGIN theme'"
echo "chart login theme ok on $(kubectl config current-context): mounted where Keycloak resolves it, page branded, assets served"
