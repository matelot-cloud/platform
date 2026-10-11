#!/usr/bin/env bash
# Fails when the repository root holds a directory outside the monorepo layout (CI and `make check-layout`).
# Drops are rsync'ed over the clone and rsync never deletes, so a renamed or moved folder leaves a stale copy behind
# (api/, cli/, helm/ … from pre-monorepo drops). Allowed: the directories below; files at the root are not checked.
set -euo pipefail
cd "$(dirname "$0")/.."
ALLOWED=".github apps deploy docs packages scripts tools"
# local-only folders that git ignores are fine (node_modules, dist, backups…): only tracked / untracked-but-not-ignored ones count
stale=()
for d in */ .*/; do
  d="${d%/}"; [ "$d" = "." ] || [ "$d" = ".." ] || [ "$d" = ".git" ] && continue
  case " $ALLOWED " in *" $d "*) continue;; esac
  if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then git check-ignore -q "$d" && continue
  else case " node_modules dist backups .pnpm-store " in *" $d "*) continue;; esac; fi   # outside git: the usual local folders
  stale+=("$d")
done
if [ ${#stale[@]} -gt 0 ]; then
  echo "stale top-level directories (not part of the layout: $ALLOWED):" >&2
  for d in "${stale[@]}"; do echo "  $d/" >&2; done
  echo "remove them (git rm -r <dir>) — see CLAUDE.md § Repository layout" >&2
  exit 1
fi
echo "layout ok"
