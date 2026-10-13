#!/usr/bin/env bash
# release.yml: sign one pushed image (cosign keyless, GitHub OIDC), attach its SPDX SBOM, record the digest for the
# release notes. Env: NAME (api|worker|web|runner), IMAGE (ref@digest), DIGEST.
set -euo pipefail
: "${NAME:?}" "${IMAGE:?}" "${DIGEST:?}"
cosign sign --yes "$IMAGE"
syft "$IMAGE" -o spdx-json > "sbom-$NAME.spdx.json"
cosign attest --yes --type spdxjson --predicate "sbom-$NAME.spdx.json" "$IMAGE"
echo "$NAME $DIGEST" > "digest-$NAME.txt"
