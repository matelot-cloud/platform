#!/usr/bin/env bash
# Refuses to start a second API / worker watcher. Two `nest start --watch` processes for the same entry both restart on
# every edit and fight over the port (EADDRINUSE; the old instance keeps serving stale code), or run the worker twice.
#   scripts/dev-guard.sh api|worker
set -euo pipefail
what="${1:?api|worker}"
if [[ "$what" == api ]]; then
  # a watcher of dist/main (any --entryFile other than worker), or anything already on the API port
  others=$(ps -eo pid=,args= | grep -E '[n]est(\.js)? start --watch' | grep -v -- '--entryFile worker' || true)
  port="${PORT:-3000}"
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then busy=1; else busy=0; fi
else
  others=$(ps -eo pid=,args= | grep -E '[n]est(\.js)? start --watch' | grep -- '--entryFile worker' || true)
  busy=0
fi
if [[ -n "$others" || "$busy" == 1 ]]; then
  echo "make ${what/api/dev}: another ${what} is already running — two watchers both restart on every edit (EADDRINUSE / a stale instance keeps serving)." >&2
  [[ -n "$others" ]] && echo "$others" | sed 's/^/  /' >&2
  [[ "$busy" == 1 ]] && echo "  port ${port} is in use (lsof -i :${port} / ss -ltnp | grep :${port})" >&2
  echo "Stop them with: make dev-stop   (or Ctrl+C in their terminal / kill <pid>; DEV_GUARD=0 starts anyway)" >&2
  exit 1
fi
