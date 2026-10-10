#!/usr/bin/env bash
# Creates the local kind cluster with ingress-nginx, ready for `make deploy TENANT=<slug>`.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! kind get clusters 2>/dev/null | grep -qx secops; then
  kind create cluster --config deploy/kind/kind-config.yaml
fi

kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
echo "Waiting for ingress-nginx..."
# the Deployment exists as soon as the manifest is applied; its pods do not, so `kubectl wait` on pods fails on a fresh cluster
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=180s

cat <<MSG

kind cluster "secops" is ready. Add the tenant hosts to /etc/hosts, e.g. for TENANT=acme:

  127.0.0.1 acme.platform.local auth-acme.platform.local

MSG
