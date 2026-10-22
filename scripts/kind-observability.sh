#!/usr/bin/env bash
# The observability delivery on the local kind cluster (docs/observability.md): kube-prometheus-stack (Prometheus with
# exemplars, Grafana with Tempo / Loki datasources), Tempo, Loki and Alloy from their charts in namespace monitoring,
# then the cell switched on — ServiceMonitor, exporters, OTLP to Tempo — through its values file and `apply`.
#   make kind-observability TENANT=acme          (the cell exists: make provision / cell-provision.sh new + apply)
#   scripts/kind-observability.sh <slug> [--print] --print only prints the helm commands (to run them by hand)
# Versions are pinned (the ones the drop was validated against); values in deploy/observability/kind/.
set -euo pipefail
cd "$(dirname "$0")/.."
TENANT="${1:?tenant slug}"; PRINT=0; [ "${2:-}" = "--print" ] && PRINT=1
NS=monitoring; V=deploy/observability/kind
KPS_VERSION=92.11.0 TEMPO_VERSION=1.24.4 LOKI_VERSION=7.3.0 ALLOY_VERSION=1.14.1
CMDS=(
  "helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update"
  "helm repo add grafana https://grafana.github.io/helm-charts --force-update"
  "helm repo update prometheus-community grafana"
  "helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack --version $KPS_VERSION -n $NS --create-namespace -f $V/kube-prometheus-stack.values.yaml --wait --timeout 10m"
  "helm upgrade --install tempo grafana/tempo --version $TEMPO_VERSION -n $NS -f $V/tempo.values.yaml --wait --timeout 5m"
  "helm upgrade --install loki grafana/loki --version $LOKI_VERSION -n $NS -f $V/loki.values.yaml --wait --timeout 10m"
  "helm upgrade --install alloy grafana/alloy --version $ALLOY_VERSION -n $NS -f $V/alloy.values.yaml --wait --timeout 5m"
)
if [ "$PRINT" = 1 ]; then printf '%s\n' "${CMDS[@]}"; exit 0; fi
for c in "${CMDS[@]}"; do echo "+ $c"; eval "$c"; done

VALUES="deploy/cells/$TENANT.values.yaml"
[ -f "$VALUES" ] || { echo "$VALUES does not exist: provision the cell first (scripts/cell-provision.sh new --slug $TENANT …, then apply)" >&2; exit 1; }
python3 scripts/lib/values-observability.py "$VALUES" "http://tempo.$NS:4318" http/protobuf --stack --label release=kube-prometheus-stack
echo "   written to $VALUES (commit it); applying the cell"
bash scripts/cell-provision.sh apply --slug "$TENANT"

cat <<EOT

The stack runs in namespace $NS and the cell "$TENANT" is wired to it. To look:
  kubectl -n $NS port-forward svc/kube-prometheus-stack-grafana 3000:80 &      → http://localhost:3000  (admin / matelot-kind)
  kubectl -n $NS port-forward svc/kube-prometheus-stack-prometheus 9090:9090 & → http://localhost:9090/targets
Checks (the acceptance of docs/observability.md, drop 2):
  every serviceMonitor/tenant-$TENANT/$TENANT/* target UP     (Prometheus → Status → Targets)
  count by (job) (matelot_build_info)                        → matelot-api, matelot-worker, matelot-runner
  pg_up{namespace="tenant-$TENANT"}  redis_up{…}  jvm_memory_used_bytes{job="matelot-keycloak"}  go_goroutines{job="matelot-registry"}
  run a pipeline, then Grafana → Explore → Tempo → service "matelot-pipeline" → the trace → "Logs for this span" (Loki)
Without the stack again: empty the observability block in $VALUES and apply; helm uninstall alloy loki tempo kube-prometheus-stack -n $NS.
EOT
