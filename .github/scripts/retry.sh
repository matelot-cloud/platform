#!/usr/bin/env bash
# retry <label> <command…> — runs the command up to RETRY_ATTEMPTS times (default 3), sleeping RETRY_DELAYS between
# attempts (default "30 60"), logging every failure with its exit code; exits with the last code when all fail.
# For the release steps that talk to services that fail transiently (Sigstore's Fulcio / Rekor, GitHub's API):
# rc.18 needed two manual reruns, a Sigstore hiccup on the web image and an HTTP 500 creating the release.
# Sourced (`. .github/scripts/retry.sh`) or run (`bash .github/scripts/retry.sh <label> <command…>`).
retry() {
  local label="$1"; shift
  local attempts="${RETRY_ATTEMPTS:-3}" delays code=0 n
  read -r -a delays <<< "${RETRY_DELAYS:-30 60}"
  for ((n = 1; n <= attempts; n++)); do
    "$@" && return 0
    code=$?
    if [ "$n" -lt "$attempts" ]; then
      local wait="${delays[$((n - 1))]:-${delays[-1]}}"
      echo "::warning::$label: attempt $n/$attempts failed (exit $code); retrying in ${wait}s" >&2
      sleep "$wait"
    else
      echo "::error::$label: failed $attempts times (last exit $code)" >&2
    fi
  done
  return "$code"
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  retry "$@"
fi
