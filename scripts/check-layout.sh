#!/usr/bin/env bash
# Fails when the repository root holds anything outside the monorepo layout (CI job `layout`, `make check-layout`).
# Drops are rsync'ed over the clone and rsync never deletes, so a renamed or moved folder — or a file that once lived
# at the root — leaves a stale copy behind (api/, cli/, helm/, ci-integration.md … from pre-monorepo drops).
# Allowed: the directories and the root files below; git-ignored entries (node_modules, dist, .env) are fine.
set -euo pipefail
cd "$(dirname "$0")/.."
ALLOWED_DIRS=".github apps deploy docs packages scripts tools"
ALLOWED_FILES="README.md CHANGELOG.md CLAUDE.md SETUP.md Makefile package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .gitignore .dockerignore docker-compose.yml .env.example"
ALLOWED_FILE_GLOBS="LICENSE* tsconfig*.json"
in_git=0; git rev-parse --is-inside-work-tree > /dev/null 2>&1 && in_git=1
ignored() { # git-ignored (or, outside git, the usual local entries)
  if [ $in_git = 1 ]; then git check-ignore -q "$1"; else case " node_modules dist backups .pnpm-store .env " in *" $1 "*) return 0;; esac; return 1; fi
}
stale=()
for e in * .*; do
  [ "$e" = "." ] || [ "$e" = ".." ] || [ "$e" = ".git" ] && continue
  [ -e "$e" ] || continue
  if [ -d "$e" ]; then
    case " $ALLOWED_DIRS " in *" $e "*) continue;; esac
  else
    case " $ALLOWED_FILES " in *" $e "*) continue;; esac
    ok=0; for g in $ALLOWED_FILE_GLOBS; do [[ "$e" == $g ]] && ok=1; done; [ $ok = 1 ] && continue
  fi
  ignored "$e" && continue
  stale+=("$e")
done
if [ ${#stale[@]} -gt 0 ]; then
  echo "stale entries at the repository root (allowed directories: $ALLOWED_DIRS; files: $ALLOWED_FILES $ALLOWED_FILE_GLOBS):" >&2
  for e in "${stale[@]}"; do [ -d "$e" ] && echo "  $e/" >&2 || echo "  $e" >&2; done
  echo "remove them (git rm -r <entry>) or add them to scripts/check-layout.sh if they belong — see CLAUDE.md § Repository layout" >&2
  exit 1
fi
echo "layout ok"
