#!/usr/bin/env bash
# Fails when a retired name survives in a tracked file (CI job `layout`, `make check-layout`).
# Add a string here whenever something is renamed: the previous GitHub organization, the old CLI mirror, old domains.
# Scope: `git ls-files` — tracked files only; ignored leftovers (apps/web/public/docs of the in-app docs build, dist/)
# are not scanned. Outside a git checkout (a drop folder) the working tree minus build output is scanned instead.
set -euo pipefail
cd "$(dirname "$0")/.."
FORBIDDEN=(
  "matelot-io"                        # GitHub organization before 2026-10-12 (now matelot-cloud)
  "dev-testing-secops-platform"       # the private CLI mirror (now matelot-cloud/setup-cli)
  "docs.matelot.dev"                  # placeholder domain of the first website drop
  "setup-cli#"                        # git-form CLI install (github:…/setup-cli#tag): npm 10 leaves a dangling symlink; use the release tarball
)
if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  list() { git ls-files -z --cached; }
else
  echo "check-forbidden: not a git checkout, scanning the working tree" >&2
  list() { find . -type f ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/dist-worker/*' ! -path './.git/*' ! -path './apps/web/public/docs/*' -print0; }
fi
status=0
for word in "${FORBIDDEN[@]}"; do
  # this script may name the words it forbids
  hits=$(list | xargs -0 grep -nI --fixed-strings -- "$word" 2>/dev/null | grep -v '^\(\./\)\?scripts/check-forbidden.sh:' || true)
  if [ -n "$hits" ]; then
    echo "forbidden string \"$word\":" >&2; echo "$hits" | sed 's/^/  /' >&2; status=1
    # a tracked file that .gitignore also matches is a leftover that was committed by mistake
    echo "$hits" | cut -d: -f1 | sort -u | while read -r f; do git check-ignore -q --no-index "$f" 2>/dev/null && echo "  ($f is tracked but git-ignored: git rm -r --cached $f)" >&2; done
  fi
done
# Public texts must not carry internal wording (verification notes, test scripts, environment limits): the source of
# the public release notes is checked against the same list the release job uses (rc.24 published the internal log).
PUBLIC_TEXTS=(docs/release-notes.md)
for f in "${PUBLIC_TEXTS[@]}"; do
  [ -f "$f" ] || { echo "public text $f is missing" >&2; status=1; continue; }
  # HTML comments are the file's internal header: never published, so not scanned
  hits=$(awk '/<!--/ { c = 1 } c { if (/-->/) c = 0; print ""; next } { print }' "$f" | grep -nEi -f <(grep -v '^#' scripts/lib/public-notes-internal-wording.txt | grep -v '^$') || true)
  if [ -n "$hits" ]; then
    echo "internal wording in the public text $f (scripts/lib/public-notes-internal-wording.txt):" >&2; echo "$hits" | cut -c1-200 | sed 's/^/  /' >&2; status=1
  fi
done
[ $status -eq 0 ] && echo "forbidden strings: none; public texts carry no internal wording" || exit 1
