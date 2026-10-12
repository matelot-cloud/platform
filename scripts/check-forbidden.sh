#!/usr/bin/env bash
# Fails when a retired name survives anywhere in the repository (CI job `layout`, `make check-layout`).
# Add a string here whenever something is renamed: the previous GitHub organization, the old CLI mirror, old domains.
set -euo pipefail
cd "$(dirname "$0")/.."
FORBIDDEN=(
  "matelot-io"                        # GitHub organization before 2026-10-12 (now matelot-cloud)
  "dev-testing-secops-platform"       # the private CLI mirror (now matelot-cloud/setup-cli)
  "docs.matelot.dev"                  # placeholder domain of the first website drop
)
# tracked files when in git; otherwise everything except local build output
if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then list() { git ls-files -z; }
else list() { find . -type f ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/dist-worker/*' ! -path './.git/*' -print0; }; fi
status=0
for word in "${FORBIDDEN[@]}"; do
  # this script may name the words it forbids
  hits=$(list | xargs -0 grep -nI --fixed-strings -- "$word" 2>/dev/null | grep -v '^scripts/check-forbidden.sh:\|^\./scripts/check-forbidden.sh:' || true)
  if [ -n "$hits" ]; then echo "forbidden string \"$word\":" >&2; echo "$hits" | sed 's/^/  /' >&2; status=1; fi
done
[ $status -eq 0 ] && echo "forbidden strings: none" || exit 1
