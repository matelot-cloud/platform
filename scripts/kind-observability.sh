#!/usr/bin/env bash
# The observability delivery on the local kind cluster (docs/observability.md): kube-prometheus-stack (Prometheus with
# exemplars, Grafana with Tempo / Loki datasources), Tempo, Loki and Alloy from their charts in namespace monitoring,
# then the cell switched on — ServiceMonitor, PrometheusRule, exporters, dashboards, OTLP to Alloy's receiver (traces →
# Tempo, the audit / security event records → Loki; never to Tempo directly, which takes no logs) — through its values
# file and `apply`.
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
python3 scripts/lib/values-observability.py "$VALUES" "http://alloy.$NS:4318" http/protobuf --stack --label release=kube-prometheus-stack --logs
echo "   written to $VALUES (commit it); applying the cell"
bash scripts/cell-provision.sh apply --slug "$TENANT"

cat <<EOT

The stack runs in namespace $NS and the cell "$TENANT" is wired to it. To look:
  kubectl -n $NS port-forward svc/kube-prometheus-stack-grafana 3000:80 &      → http://localhost:3000  (admin / matelot-kind)
  kubectl -n $NS port-forward svc/kube-prometheus-stack-prometheus 9090:9090 & → http://localhost:9090/targets
  kubectl -n $NS port-forward svc/kube-prometheus-stack-alertmanager 9093:9093 & → http://localhost:9093  (Matelot* alerts on route "matelot")
Checks (the acceptance of docs/observability.md, drops 2 and 3):
  every serviceMonitor/tenant-$TENANT/$TENANT/* target UP     (Prometheus → Status → Targets)
  count by (job) (matelot_build_info)                        → matelot-api, matelot-worker, matelot-runner
  pg_up{namespace="tenant-$TENANT"}  redis_up{…}  jvm_memory_used_bytes{job="matelot-keycloak"}  go_goroutines{job="matelot-registry"}
  run a pipeline, then Grafana → Explore → Tempo → service "matelot-pipeline" → the trace → a span → "Related logs" (Loki)
  the events as OTLP log records (through Alloy):  {service_name=~"matelot-(api|worker)"} | event_name="matelot.security"
  …and the same events as stdout lines:          {namespace="tenant-$TENANT"} | json | event_name="matelot.security"
  matelot doctor: tracing → http://alloy.$NS:4318/v1/traces OK, events → …/v1/logs OK with no export failures
  Grafana → Dashboards → folder Matelot: Cell overview, Pipelines, Security posture, Integrations (from the cell's ConfigMaps)
  Prometheus → Alerts: groups matelot and matelot-kubernetes (the cell's PrometheusRule); scale the runners to 0 with a
  job queued → MatelotNoRunnerOnline after 10 m; make the backup CronJob fail (kubectl create job … --from=cronjob/$TENANT-backup
  with a wrong PGHOST) → MatelotBackupFailed after its report
Without the stack again: empty the observability block in $VALUES and apply; helm uninstall alloy loki tempo kube-prometheus-stack -n $NS.
EOT
