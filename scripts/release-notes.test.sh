#!/usr/bin/env bash
# Tests scripts/release-notes.sh on the REAL docs/release-notes.md and on fixtures (CI job `layout`):
#   - the notes of the next pre-release and of the final release exist, are small, and carry no internal wording
#   - the internal CHANGELOG is what the guards exist for: its newest entry trips the wording guard, and its whole
#     section (what rc.24 tried to publish: 125,185 characters, HTTP 422) trips the size guard
set -euo pipefail
cd "$(dirname "$0")/.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "release-notes.test: $*" >&2; exit 1; }
LIMIT=100000   # the release job's hard limit for notes.md (GitHub: 125000); the Artifacts block is about 1,500

# every release section of the real file: final + a pre-release of it
sections="$(grep -E '^## v[0-9]+\.[0-9]+\.[0-9]+( |$)' docs/release-notes.md | sed -E 's/^## (v[0-9.]+).*/\1/')"
[ -n "$sections" ] || fail "docs/release-notes.md has no '## vX.Y.Z' section"
for v in $sections; do
  for tag in "$v" "$v-rc.99"; do
    bash scripts/release-notes.sh "$tag" > "$T/notes.md" || fail "release-notes.sh $tag failed (exit $?)"
    n=$(wc -m < "$T/notes.md")
    [ "$n" -gt 200 ] || fail "$tag: only $n characters"
    [ "$n" -le 60000 ] || fail "$tag: $n characters"
    [ $((n + 2000)) -le $LIMIT ] || fail "$tag: $n characters leaves no room for the Artifacts block under $LIMIT"
    grep -q '<!--' "$T/notes.md" && fail "$tag: an HTML comment (the internal header) reached the notes"
    echo "   $tag: $n characters"
  done
  # a pre-release carries exactly one entry; the final none (the curated summary only)
  [ "$(bash scripts/release-notes.sh "$v-rc.99" | grep -c '^### ')" = 1 ] || fail "$v-rc.99: not exactly one ### entry"
  [ "$(bash scripts/release-notes.sh "$v" | grep -c '^### ')" = 0 ] || fail "$v: the final notes contain ### entries"
done
newest="$(echo "$sections" | head -1)"
first_entry="$(awk '/^### /{print; exit}' docs/release-notes.md)"
bash scripts/release-notes.sh "$newest-rc.99" > "$T/pre.md"; grep -qF -- "$first_entry" "$T/pre.md" || fail "the pre-release notes are not the newest entry ($first_entry)"

# no section → exit 1, for a final and for a pre-release
for tag in v9.9.9 v9.9.9-rc.1; do
  set +e; bash scripts/release-notes.sh "$tag" > /dev/null 2> "$T/err"; code=$?; set -e
  [ $code = 1 ] && grep -q 'has no "## v9.9.9" section' "$T/err" || fail "$tag: expected exit 1 with a clear message, got $code: $(cat "$T/err")"
done
# a prefix is not a match: "## v0.1.0" must not answer v0.1
set +e; bash scripts/release-notes.sh v0.1 > /dev/null 2>&1; code=$?; set -e
[ $code = 1 ] || fail "v0.1 matched a longer version's section (exit $code)"

# the internal CHANGELOG through the same script: wording guard (exit 3) on its newest entry …
{ echo "## v0.1.0 — internal"; echo; echo "summary"; echo; awk '/^### /{n++} n==1' CHANGELOG.md; } > "$T/internal.md"
set +e; bash scripts/release-notes.sh v0.1.0-rc.1 "$T/internal.md" > /dev/null 2> "$T/err"; code=$?; set -e
[ $code = 3 ] || fail "the internal CHANGELOG's newest entry passed the wording guard (exit $code) — extend scripts/lib/public-notes-internal-wording.txt"
grep -q 'internal wording' "$T/err" || fail "exit 3 without the message"
# … every internal entry is caught (each one names a test, a path or an environment), so none can be pasted across
total=0; caught=0
awk -v dir="$T" '/^## /{s++} s==1 && /^### /{n++} s==1 && n>0 { print > (dir "/entry-" n ".md") }' CHANGELOG.md
for e in "$T"/entry-*.md; do
  total=$((total + 1))
  { echo "## v0.1.0 — x"; echo; cat "$e"; } > "$T/one.md"
  set +e; bash scripts/release-notes.sh v0.1.0-rc.1 "$T/one.md" > /dev/null 2>&1; code=$?; set -e
  [ $code = 3 ] && caught=$((caught + 1))
done
[ "$total" -ge 40 ] || fail "only $total entries found in CHANGELOG.md's first section"
[ $((caught * 100 / total)) -ge 90 ] || fail "the wording guard catches only $caught of $total internal CHANGELOG entries"
# … and the size guard (exit 4) on a body as long as the section rc.24 tried to publish
{ echo "## v0.1.0 — big"; echo; echo "### entry"; awk 'BEGIN { for (i = 0; i < 2100; i++) print "Operators can now configure the retention of their audit trail per organization." }'; } > "$T/big.md"
set +e; bash scripts/release-notes.sh v0.1.0-rc.1 "$T/big.md" > /dev/null 2> "$T/err"; code=$?; set -e
[ $code = 4 ] && grep -q 'over the limit of 60000' "$T/err" || fail "a 170,000-character body passed the size guard (exit $code): $(cat "$T/err")"
# the real CHANGELOG section really is over GitHub's limit — the reason it is not the source any more
[ "$(awk '/^## /{s++} s==1' CHANGELOG.md | wc -m)" -gt 100000 ] || echo "   (CHANGELOG.md's first section is under 100,000 characters now)"

# a clean fixture passes, HTML comments are dropped, the final stops at the first entry
printf '%s\n' '# Notes' '<!-- internal: do not publish' 'second line -->' '## v1.2.0 — a title' '' 'Summary line.' '' '### 2026-01-02 — newest' '' '- new thing' '' '### 2026-01-01 — older' '' '- old thing' '' '## v1.1.0 — previous' '' 'Old summary.' > "$T/ok.md"
out="$(bash scripts/release-notes.sh v1.2.0 "$T/ok.md")"; [ "$out" = "$(printf '%s\n' '## v1.2.0 — a title' '' 'Summary line.')" ] || fail "final notes of the fixture: $out"
out="$(bash scripts/release-notes.sh v1.2.0-rc.3 "$T/ok.md")"
grep -q 'new thing' <<< "$out" || fail "pre-release: newest entry missing"
grep -q 'old thing\|Old summary\|do not publish' <<< "$out" && fail "pre-release: more than the newest entry: $out"
grep -q 'Pre-release `1.2.0-rc.3` of \*\*v1.2.0 — a title\*\*' <<< "$out" || fail "pre-release header: $out"
# the fixer for releases already published (.github/scripts/rewrite-release-notes.sh): an rc.23-style body — the
# internal section + Artifacts — becomes a short public paragraph + the same Artifacts block; a clean body is left alone
R=.github/scripts/rewrite-release-notes.sh
artifacts="$(printf '%s\n' '## Artifacts' '' '```' 'ghcr.io/matelot-cloud/api:0.1.0-rc.23@sha256:abc' '```' '' "cosign verify ghcr.io/matelot-cloud/api:0.1.0-rc.23 --certificate-identity-regexp 'https://github.com/matelot-cloud/platform/'")"
{ awk '/^## /{s++} s==1 && ++n <= 400' CHANGELOG.md; echo; echo "$artifacts"; } > "$T/published.md"
ORG=matelot-cloud bash $R --filter v0.1.0-rc.23 < "$T/published.md" > "$T/rewritten.md" || fail "rewrite of an rc.23-style body failed (exit $?)"
[ "$(wc -m < "$T/rewritten.md")" -lt 2000 ] || fail "the rewritten body is $(wc -m < "$T/rewritten.md") characters"
[ "$(awk '/^## Artifacts/{on=1} on' "$T/rewritten.md")" = "$artifacts" ] || fail "the Artifacts block changed in the rewrite"
awk '/^## Artifacts/{exit} {print}' "$T/rewritten.md" > "$T/rewritten.head"; grep -v '^#' scripts/lib/public-notes-internal-wording.txt | grep -v '^$' > "$T/patterns"
grep -qEi -f "$T/patterns" "$T/rewritten.head" && fail "the rewritten body still carries internal wording"
set +e; ORG=matelot-cloud bash $R --filter v0.1.0-rc.23 < "$T/rewritten.md" > /dev/null; code=$?; set -e
[ $code = 10 ] || fail "a clean body was not left alone (exit $code)"
set +e; { bash scripts/release-notes.sh v0.1.0-rc.99; echo; echo "$artifacts"; } | ORG=matelot-cloud bash $R --filter v0.1.0-rc.99 > /dev/null; code=$?; set -e
[ $code = 10 ] || fail "the notes release.yml publishes now would be rewritten by the fixer (exit $code)"
set +e; awk '/^## /{s++} s==1 && ++n <= 50' CHANGELOG.md | ORG=matelot-cloud bash $R --filter v0.1.0-rc.1 > /dev/null; code=$?; set -e
[ $code = 11 ] || fail "a leaked body without an Artifacts block must be reported, not rewritten (exit $code)"
echo "release-notes ok ($(echo "$sections" | wc -w) release section(s); the internal CHANGELOG is refused: wording guard $caught/$total entries, size guard; published releases: fixer keeps the Artifacts block)"
