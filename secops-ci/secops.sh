#!/usr/bin/env bash
# secops.sh — talk to the SecOps platform from any CI with a signed CI token (no bearer secrets on the wire).
#
# Environment: SECOPS_URL (https://acme.secops.example.com), SECOPS_KEY_ID (sk_…), SECOPS_SECRET (sec_…)
# Usage:
#   secops.sh whoami
#   secops.sh deploy  --env <environmentId> --version 1.2.0 [--image ghcr.io/acme/app:1.2.0]
#   secops.sh release --service <serviceId> --version 1.2.0 [--notes "text"]
#   secops.sh pipeline --service <serviceId> [--template security] [--ref <branch|tag|commit sha>]
#   secops.sh sbom --service <serviceId> --file bom.cdx.json --target source|image [--version 1.2.0] [--image ref]
#   secops.sh request POST /api/v1/… '{"json":true}'         # any endpoint
# Signature: SecOps-HMAC-SHA256 keyId,ts,nonce,sig  with sig = HMAC-SHA256(secret, "v1\n"ts"\n"nonce"\n"METHOD"\n"path"\n"sha256(body))
set -euo pipefail

: "${SECOPS_URL:?SECOPS_URL is required}"; : "${SECOPS_KEY_ID:?SECOPS_KEY_ID is required}"; : "${SECOPS_SECRET:?SECOPS_SECRET is required}"
BASE="${SECOPS_URL%/}"

request() {
  local method="$1" path="$2" body="${3:-}"
  local ts nonce bodyhash sts sig
  ts=$(date +%s)
  nonce=$(openssl rand -hex 16)
  bodyhash=$(printf '%s' "$body" | openssl dgst -sha256 | sed 's/^.* //')
  sts=$(printf 'v1\n%s\n%s\n%s\n%s\n%s' "$ts" "$nonce" "$method" "$path" "$bodyhash")
  sig=$(printf '%s' "$sts" | openssl dgst -sha256 -hmac "$SECOPS_SECRET" | sed 's/^.* //')
  curl --fail-with-body -sS -X "$method" "$BASE$path" \
    -H "Authorization: SecOps-HMAC-SHA256 keyId=$SECOPS_KEY_ID,ts=$ts,nonce=$nonce,sig=$sig" \
    -H "Content-Type: application/json" -H "User-Agent: secops-ci/0.1" \
    ${body:+--data-binary "$body"}
  echo
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

cmd="${1:-}"; shift || true
case "$cmd" in
  whoami) request GET /api/v1/api-tokens/whoami ;;
  deploy)
    env=""; version=""; image=""
    while [[ $# -gt 0 ]]; do case "$1" in --env) env="$2"; shift 2;; --version) version="$2"; shift 2;; --image) image="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
    [[ -n "$env" ]] || { echo "--env <environmentId> is required" >&2; exit 2; }
    body="{\"source\":\"api\""; [[ -n "$version" ]] && body="$body,\"version\":\"$(json_escape "$version")\""; [[ -n "$image" ]] && body="$body,\"imageRef\":\"$(json_escape "$image")\""; body="$body}"
    request POST "/api/v1/environments/$env/deployments" "$body" ;;
  release)
    service=""; version=""; notes=""
    while [[ $# -gt 0 ]]; do case "$1" in --service) service="$2"; shift 2;; --version) version="$2"; shift 2;; --notes) notes="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
    [[ -n "$service" && -n "$version" ]] || { echo "--service and --version are required" >&2; exit 2; }
    body="{\"version\":\"$(json_escape "$version")\""; [[ -n "$notes" ]] && body="$body,\"notes\":\"$(json_escape "$notes")\""; body="$body}"
    request POST "/api/v1/services/$service/releases" "$body" ;;
  pipeline)
    service=""; template="security"; ref=""
    while [[ $# -gt 0 ]]; do case "$1" in --service) service="$2"; shift 2;; --template) template="$2"; shift 2;; --ref) ref="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
    [[ -n "$service" ]] || { echo "--service <serviceId> is required" >&2; exit 2; }
    body="{\"template\":\"$(json_escape "$template")\""; [[ -n "$ref" ]] && body="$body,\"ref\":\"$(json_escape "$ref")\""; body="$body}"
    request POST "/api/v1/services/$service/pipelines" "$body" ;;
  sbom)
    service=""; file=""; target="source"; version=""; image=""
    while [[ $# -gt 0 ]]; do case "$1" in --service) service="$2"; shift 2;; --file) file="$2"; shift 2;; --target) target="$2"; shift 2;; --version) version="$2"; shift 2;; --image) image="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
    [[ -n "$service" && -f "$file" ]] || { echo "--service and --file <sbom.json> are required" >&2; exit 2; }
    doc=$(cat "$file")
    body="{\"target\":\"$target\""; [[ -n "$version" ]] && body="$body,\"version\":\"$(json_escape "$version")\""; [[ -n "$image" ]] && body="$body,\"imageRef\":\"$(json_escape "$image")\""; body="$body,\"document\":$doc}"
    request POST "/api/v1/services/$service/sboms" "$body" ;;
  request) request "$1" "$2" "${3:-}" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
