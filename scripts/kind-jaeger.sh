#!/usr/bin/env bash
# Jaeger (all-in-one, in-memory) on the local kind cluster, and the cell pointed at it — the pipeline trace without
# installing Tempo: `make kind-jaeger TENANT=acme`, run a pipeline, open http://localhost:16686 (port-forward below).
#   scripts/kind-jaeger.sh <tenant slug>   (the cell must be deployed: make deploy TENANT=<slug>)
# Jaeger listens for OTLP on 4318 (http/protobuf) and 4317 (grpc); the cell's api, worker and managed runners get
# OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger.observability:4318 through observability.otlp.endpoint, written into
# deploy/cells/<slug>.values.yaml (the source of truth for `apply`) and applied; a cell without a values file (make
# deploy) is upgraded with --reuse-values. Turn it off by emptying the endpoint in the values file and applying again
# (scripts/lib/values-observability.py <file> "").
set -euo pipefail
cd "$(dirname "$0")/.."
TENANT="${1:?tenant slug}"; NS="observability"
kubectl get namespace "$NS" > /dev/null 2>&1 || kubectl create namespace "$NS" > /dev/null
kubectl apply -n "$NS" -f - > /dev/null <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: jaeger, labels: { app: jaeger } }
spec:
  replicas: 1
  selector: { matchLabels: { app: jaeger } }
  template:
    metadata: { labels: { app: jaeger } }
    spec:
      containers:
        - name: jaeger
          image: jaegertracing/jaeger:2.11.0
          ports: [{ containerPort: 16686, name: ui }, { containerPort: 4317, name: otlp-grpc }, { containerPort: 4318, name: otlp-http }]
          resources: { requests: { cpu: 50m, memory: 256Mi }, limits: { memory: 1Gi } }
---
apiVersion: v1
kind: Service
metadata: { name: jaeger, labels: { app: jaeger } }
spec:
  selector: { app: jaeger }
  ports: [{ name: ui, port: 16686 }, { name: otlp-grpc, port: 4317 }, { name: otlp-http, port: 4318 }]
YAML
kubectl -n "$NS" rollout status deployment/jaeger --timeout=180s
ENDPOINT="http://jaeger.$NS:4318"
VALUES="deploy/cells/$TENANT.values.yaml"
if [ -f "$VALUES" ]; then
  # the cell's values file is the source of truth for `apply` (docs/cell-provisioning.md): the endpoint goes there and
  # survives every later upgrade, like any other cell setting; apply rolls the api / worker / runners (configmap checksum)
  python3 scripts/lib/values-observability.py "$VALUES" "$ENDPOINT" http/protobuf
  echo "   written to $VALUES (commit it); applying the cell"
  bash scripts/cell-provision.sh apply --slug "$TENANT"
else
  # no values file (a `make deploy` cell): the chart is upgraded in place — a later `apply` would need the values file
  echo "   $VALUES does not exist (a make deploy cell): setting the endpoint on the release with --reuse-values; a cell provisioned with apply keeps it in its values file instead" >&2
  helm upgrade "$TENANT" deploy/helm/secops-cell --namespace "tenant-$TENANT" --reuse-values --set "observability.otlp.endpoint=$ENDPOINT" --set observability.otlp.protocol=http/protobuf --wait --timeout 10m
fi
cat <<EOT

Jaeger is up and the cell "$TENANT" exports traces to it. To look:
  kubectl -n $NS port-forward svc/jaeger 16686:16686 &
  open http://localhost:16686   → service "matelot-pipeline" (the pipeline and job spans, whichever process emitted
                                  them), "matelot-api", "matelot-runner", "matelot-worker"
Run a pipeline (matelot pipeline run … or the web app) and search service matelot-pipeline, operation
"pipeline Security pipeline": one trace with the api's request spans, the runner's phases and the worker's gate
evaluation. Metrics of a pod:
  kubectl -n tenant-$TENANT port-forward deploy/$TENANT-api 9464:9464 & curl -s localhost:9464/metrics | grep matelot_
EOT
