#!/usr/bin/env bash
# release.yml: create (or complete) the GitHub Release v$VERSION in $ORG/matelot with notes.md and the SBOM assets.
# Idempotent, so it can be retried and re-run: a release that already exists (an attempt that created it and then got
# an HTTP 500 uploading the assets, or a re-run of the job) gets its notes and assets updated instead of failing on
# "already exists". Env: ORG, VERSION, PRERELEASE (true|false), GH_TOKEN.
set -euo pipefail
: "${ORG:?}" "${VERSION:?}"
# shellcheck source=.github/scripts/retry.sh
. "$(dirname "$0")/retry.sh"
publish() {
  local flags=(); [ "${PRERELEASE:-false}" = "true" ] && flags+=(--prerelease)
  if gh release view "v$VERSION" --repo "$ORG/matelot" > /dev/null 2>&1; then
    echo "release v$VERSION exists: updating its notes and assets"
    gh release edit "v$VERSION" --repo "$ORG/matelot" --title "Matelot v$VERSION" --notes-file notes.md "${flags[@]}" &&
      gh release upload "v$VERSION" --repo "$ORG/matelot" --clobber matelot-*.spdx.json
  else
    # the public repo has no code: the release is a tag on its default branch
    gh release create "v$VERSION" --repo "$ORG/matelot" --target main --title "Matelot v$VERSION" --notes-file notes.md "${flags[@]}" matelot-*.spdx.json
  fi
}
retry "GitHub release v$VERSION" publish
