#!/usr/bin/env bash
# Prints the CHANGELOG.md section of a release: changelog-section.sh vX.Y.Z [CHANGELOG.md]
# The section is the first "## " heading that starts with the tag (e.g. "## v1.2.0 — …"). When no heading names the
# tag, the first section of the file is printed with a note and the exit code is 2 (the release workflow accepts that
# for pre-release tags only).
set -euo pipefail
tag="${1:?tag}"; file="${2:-$(dirname "$0")/../CHANGELOG.md}"
version="${tag#v}"
awk -v tag="$tag" -v version="$version" '
  /^## / { if (found) exit; if (index($0, "## " tag) == 1 || index($0, "## " version) == 1) { found = 1; print; next } ; if (!first) { first = 1; firstStart = NR } }
  found { print }
' "$file" > /tmp/changelog-section.$$ || true
if [ -s /tmp/changelog-section.$$ ]; then cat /tmp/changelog-section.$$; rm -f /tmp/changelog-section.$$; exit 0; fi
rm -f /tmp/changelog-section.$$
echo "_No CHANGELOG section is titled \`## $tag\`; these are the latest changes on the branch._"
echo
awk '/^## /{ n++ } n==1 { print }' "$file"
exit 2
