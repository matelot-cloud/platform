#!/usr/bin/env bash
# release.yml: sign one pushed image (cosign keyless, GitHub OIDC), attach its SPDX SBOM, record the digest for the
# release notes. Env: NAME (api|worker|web|runner), IMAGE (ref@digest), DIGEST.
# cosign talks to Fulcio / Rekor and both have transient failures: each call is retried (retry.sh, 3 attempts, 30 s /
# 60 s). Signing the same digest twice is harmless (a second signature / attestation on the same image).
set -euo pipefail
: "${NAME:?}" "${IMAGE:?}" "${DIGEST:?}"
# shellcheck source=.github/scripts/retry.sh
. "$(dirname "$0")/retry.sh"
retry "cosign sign $NAME" cosign sign --yes "$IMAGE"
retry "syft $NAME" sh -c 'syft "$1" -o spdx-json > "$2"' syft "$IMAGE" "sbom-$NAME.spdx.json"
retry "cosign attest $NAME" cosign attest --yes --type spdxjson --predicate "sbom-$NAME.spdx.json" "$IMAGE"
echo "$NAME $DIGEST" > "digest-$NAME.txt"
