#!/usr/bin/env bash
# Prints an access token from Keycloak using the password grant (dev only).
#   scripts/token.sh                       # admin@acme.local against localhost:8080
#   KC=http://auth-acme.platform.local scripts/token.sh dev dev
set -euo pipefail
KC="${KC:-http://localhost:8080}"
REALM="${REALM:-platform}"
USERNAME="${1:-admin}"
PASSWORD="${2:-admin}"
curl -sf -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
  -d client_id=platform-web -d grant_type=password \
  -d "username=$USERNAME" -d "password=$PASSWORD" | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])'
