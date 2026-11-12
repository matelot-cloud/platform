#!/usr/bin/env bash
# Prints the PUBLIC release notes of a tag (the body of the GitHub Release in matelot-cloud/matelot, before the
# Artifacts block the release job appends):  release-notes.sh vX.Y.Z[-rc.N] [docs/release-notes.md]
#
# Source: docs/release-notes.md — written for operators (features, fixes, upgrade notes, breaking changes). Never
# CHANGELOG.md: that is the internal drop log (verification notes, test scripts, environment limits), and its v0.1.0
# section outgrew GitHub's 125,000-character limit for a release body (rc.24: HTTP 422 after everything else was
# published).
#   final tag vX.Y.Z       → the curated summary of "## vX.Y.Z — …": everything before its first "### " entry
#   pre-release vX.Y.Z-…   → a short header + the NEWEST "### " entry of that section (the build being released)
# Guards (exit codes): 1 no "## vX.Y.Z" section · 3 internal wording in the output (the list in
# scripts/lib/public-notes-internal-wording.txt) · 4 output longer than RELEASE_NOTES_MAX characters (default 60000;
# the release job allows 100000 with the Artifacts block; GitHub's limit is 125000).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tag="${1:?tag (vX.Y.Z or vX.Y.Z-rc.N)}"; file="${2:-$here/../docs/release-notes.md}"
max="${RELEASE_NOTES_MAX:-60000}"; org="${ORG:-matelot-cloud}"
version="${tag#v}"; base="${version%%-*}"; pre=0; [ "$version" != "$base" ] && pre=1
out="$(mktemp)"; trap 'rm -f "$out" "$out.section"' EXIT

# the section "## v<base>" (heading: the tag, then end of line or a space), HTML comments dropped
awk -v h="## v$base" '
  /<!--/ { c = 1 } c { if (/-->/) c = 0; next }
  /^## / { if (found) exit; if ($0 == h || index($0, h " ") == 1) { found = 1 } }
  found { print }
' "$file" > "$out.section"
if [ ! -s "$out.section" ]; then
  echo "release-notes: $file has no \"## v$base\" section — add it (curated summary first, then one \"### \" entry per build, newest first; docs/release-process.md)" >&2
  exit 1
fi
title="$(head -1 "$out.section" | sed 's/^## //')"

if [ "$pre" = 0 ]; then
  # the curated summary: heading + everything before the first "### "
  awk 'NR > 1 && /^### / { exit } { print }' "$out.section" > "$out"
else
  {
    echo "Pre-release \`$version\` of **$title**. It is published for evaluation and upgrade testing; the final release notes will summarise the whole release."
    echo
    # the newest entry: from the first "### " to the next one
    awk '/^### / { n++ } n == 1 { print }' "$out.section"
    echo
    echo "What $base contains so far: https://github.com/$org/matelot/blob/main/CHANGELOG.md"
  } > "$out"
  grep -q '^### ' "$out" || { echo "release-notes: the \"## v$base\" section of $file has no \"### \" entry for this pre-release — add the newest build's entry at the top of the section" >&2; exit 1; }
fi
# trailing blank lines off
printf '%s\n' "$(cat "$out")" > "$out.section" && mv "$out.section" "$out"

# guard: internal wording
patterns="$here/lib/public-notes-internal-wording.txt"
leaks="$(grep -v '^#' "$patterns" | grep -v '^$' | grep -nEi -f /dev/stdin "$out" || true)"
if [ -n "$leaks" ]; then
  echo "release-notes: internal wording in the public notes of $tag (scripts/lib/public-notes-internal-wording.txt) — reword $file:" >&2
  echo "$leaks" | cut -c1-200 | sed 's/^/  /' >&2
  exit 3
fi
# guard: size (characters, as GitHub counts)
chars="$(wc -m < "$out" | tr -d ' ')"
if [ "$chars" -gt "$max" ]; then
  echo "release-notes: the notes of $tag are $chars characters, over the limit of $max (GitHub refuses a release body over 125000) — shorten $file" >&2
  exit 4
fi
cat "$out"
