#!/usr/bin/env bash
# Jaeger (all-in-one, in-memory) on the local kind cluster, and the cell pointed at it — the pipeline trace without
# installing Tempo: `make kind-jaeger TENANT=acme`, run a pipeline, open http://localhost:16686 (port-forward below).
#   scripts/kind-jaeger.sh <tenant slug>   (the cell must be deployed: make deploy TENANT=<slug>)
# Jaeger listens for OTLP on 4318 (http/protobuf) and 4317 (grpc); the cell's api, worker and managed runners get
# OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger.observability:4318 through observability.otlp.endpoint (restarted by the
# upgrade: the configmap is part of their pod checksum). Remove with: helm upgrade … --set observability.otlp.endpoint=""
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
helm upgrade "$TENANT" deploy/helm/secops-cell --namespace "tenant-$TENANT" --reuse-values --set "observability.otlp.endpoint=http://jaeger.$NS:4318" --set observability.otlp.protocol=http/protobuf --wait --timeout 10m
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
