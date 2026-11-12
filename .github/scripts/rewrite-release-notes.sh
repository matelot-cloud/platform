#!/usr/bin/env bash
# Rewrites the notes of releases ALREADY published in $ORG/matelot whose body carries internal wording (up to rc.23
# the body was the internal CHANGELOG section: verification notes, test scripts, environment limits).
#   new body = a short public paragraph + the release's own "## Artifacts" block, kept byte for byte (digests,
#              cosign commands, install link)
# A release without internal wording is left alone; one without an Artifacts block is reported, not touched.
#   DRY_RUN=1 (default) prints what would change; DRY_RUN=0 edits.   Env: ORG, GH_TOKEN (Contents read/write on matelot)
#   .github/scripts/rewrite-release-notes.sh [tag …]     no tag = every release of the repository
set -euo pipefail
: "${ORG:?}"
here="$(cd "$(dirname "$0")" && pwd)"
patterns="$here/../../scripts/lib/public-notes-internal-wording.txt"
DRY_RUN="${DRY_RUN:-1}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
grep -v '^#' "$patterns" | grep -v '^$' > "$T/patterns"

# pure: stdin = the published body, $1 = tag, stdout = the new body; exit 0 rewritten · 10 clean (nothing to do) · 11 no Artifacts block
rewrite_body() {
  local tag="$1" body="$T/body.$$"
  cat > "$body"
  # only the part before the Artifacts block is ours to judge (the block names the signing identity on purpose)
  awk '/^## Artifacts[[:space:]]*$/ { exit } { print }' "$body" > "$body.head"
  grep -qEi -f "$T/patterns" "$body.head" || return 10
  grep -q '^## Artifacts[[:space:]]*$' "$body" || return 11
  local version="${tag#v}" base; base="${version%%-*}"
  if [ "$version" != "$base" ]; then
    echo "Pre-release \`$version\` of Matelot $base, published for evaluation and upgrade testing."
  else
    echo "Matelot $version."
  fi
  echo
  echo "What this release line contains: https://github.com/$ORG/matelot/blob/main/CHANGELOG.md — the notes of the newest release describe the latest changes."
  echo
  awk '/^## Artifacts[[:space:]]*$/ { on = 1 } on { print }' "$body"
}

if [ "${1:-}" = "--filter" ]; then rewrite_body "${2:?tag}"; exit $?; fi   # for the test: body on stdin

if [ $# -gt 0 ]; then tags=("$@"); else mapfile -t tags < <(gh release list --repo "$ORG/matelot" --limit 200 --json tagName --jq '.[].tagName'); fi
changed=0; clean=0; skipped=0
for tag in "${tags[@]}"; do
  gh release view "$tag" --repo "$ORG/matelot" --json body --jq .body > "$T/published.md"
  set +e; rewrite_body "$tag" < "$T/published.md" > "$T/new.md"; code=$?; set -e
  case $code in
    10) clean=$((clean + 1)); echo "$tag: no internal wording — left as it is" ;;
    11) skipped=$((skipped + 1)); echo "::warning::$tag: internal wording but no '## Artifacts' block — not touched; edit it by hand" ;;
    0)
      changed=$((changed + 1))
      echo "$tag: $(wc -m < "$T/published.md") → $(wc -m < "$T/new.md") characters; internal wording found, e.g.: $(awk '/^## Artifacts[[:space:]]*$/ { exit } { print }' "$T/published.md" | grep -oEi -f "$T/patterns" | sort -u | awk 'NR <= 5' | tr '\n' ';')"
      if [ "$DRY_RUN" = 0 ]; then gh release edit "$tag" --repo "$ORG/matelot" --notes-file "$T/new.md" > /dev/null; echo "   rewritten"; else echo "   (dry run — DRY_RUN=0 to rewrite)"; awk 'NR <= 8 { print "   | " $0 }' "$T/new.md"; fi ;;
    *) echo "::error::$tag: rewrite failed ($code)"; exit 1 ;;
  esac
done
echo "releases: ${#tags[@]} · with internal wording: $changed $([ "$DRY_RUN" = 0 ] && echo rewritten || echo "(dry run)") · clean: $clean · need a manual edit: $skipped"
