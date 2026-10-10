#!/usr/bin/env bash
# Stops every API / worker watcher of this checkout (`make dev`, `make worker`, `pnpm dev`) and the processes they run.
# Leftovers survive a closed terminal or a suspended job (Ctrl+Z) and keep restarting on every edit.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
api="$root/apps/api"
# watcher CLIs, `sh -c nest start …` wrappers and the node processes they run — whatever path form their args use
# (pnpm exec shows ./node_modules/.bin/…), kept when they belong to this checkout (cwd = apps/api or the path in args)
pids=""
for p in $(ps -eo pid=,args= | grep -E '@nestjs/cli/bin/nest\.js start|sh -c nest start|dist(-worker)?/(main|worker)' | grep -v grep | awk '{print $1}'); do
  cwd="$(readlink -f "/proc/$p/cwd" 2>/dev/null)"
  if [[ "$cwd" == "$api" ]] || tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -qF "$api"; then pids="$pids $p"; fi
done
pids=$(echo $pids | tr ' ' '\n' | sort -u | tr '\n' ' ')
if [[ -z "${pids// /}" ]]; then echo "no API / worker watcher running"; exit 0; fi
echo "stopping: $pids"
kill $pids 2>/dev/null
for _ in $(seq 1 20); do alive=$(for p in $pids; do kill -0 "$p" 2>/dev/null && echo "$p"; done); [[ -z "$alive" ]] && break; sleep 0.25; done
[[ -n "${alive:-}" ]] && { echo "forcing: $alive"; kill -9 $alive 2>/dev/null; }
echo "done"
