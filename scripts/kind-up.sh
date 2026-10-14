#!/usr/bin/env bash
# Creates the local kind cluster with ingress-nginx and cert-manager (+ a self-signed CA ClusterIssuer "selfsigned"),
# ready for `make deploy TENANT=<slug>` or `scripts/cell-provision.sh new/apply` — with HTTPS, because browsers treat only
# https:// and localhost as secure contexts and Keycloak's login page needs one (crypto.subtle); plain HTTP on
# acme.platform.local cannot sign in. CERT_MANAGER_VERSION pins the release.
set -euo pipefail
cd "$(dirname "$0")/.."
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.17.2}"

if ! kind get clusters 2>/dev/null | grep -qx secops; then
  kind create cluster --config deploy/kind/kind-config.yaml
fi

kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
echo "Waiting for ingress-nginx..."
# the Deployment exists as soon as the manifest is applied; its pods do not, so `kubectl wait` on pods fails on a fresh cluster
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=180s

echo "Installing cert-manager $CERT_MANAGER_VERSION..."
kubectl apply -f "https://github.com/cert-manager/cert-manager/releases/download/$CERT_MANAGER_VERSION/cert-manager.yaml"
for d in cert-manager cert-manager-webhook cert-manager-cainjector; do kubectl -n cert-manager rollout status "deployment/$d" --timeout=180s; done
# A local CA: bootstrap issuer → CA certificate → ClusterIssuer "selfsigned" (CA type), so every cell's certificates chain
# to one CA you can trust once in the browser/OS (see the message below). The webhook may need a few seconds after rollout.
for _ in $(seq 1 12); do
  kubectl apply -f deploy/kind/cert-manager-selfsigned.yaml > /dev/null 2>&1 && break
  sleep 5
done
kubectl apply -f deploy/kind/cert-manager-selfsigned.yaml
kubectl -n cert-manager wait --for=condition=Ready certificate/matelot-dev-ca --timeout=120s
kubectl wait --for=condition=Ready clusterissuer/selfsigned --timeout=60s

cat <<MSG

kind cluster "secops" is ready: ingress-nginx, cert-manager, ClusterIssuer "selfsigned" (local CA "matelot-dev-ca").
Add the tenant hosts to /etc/hosts, e.g. for TENANT=acme:

  127.0.0.1 acme.platform.local auth-acme.platform.local registry-acme.platform.local

Cells use HTTPS with certificates from that CA (make deploy / cell-provision.sh new on this context set it). The browser
shows a certificate warning you can click through; to remove it, trust the CA once:

  kubectl -n cert-manager get secret matelot-dev-ca -o jsonpath='{.data.ca\.crt}' | base64 -d > matelot-dev-ca.crt
  (macOS: security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db matelot-dev-ca.crt ·
   Linux: copy to /usr/local/share/ca-certificates/ and update-ca-certificates · or import it in the browser)

MSG
