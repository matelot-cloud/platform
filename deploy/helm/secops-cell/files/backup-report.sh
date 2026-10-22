#!/usr/bin/env bash
# backup-report.sh <succeeded|failed> <step> [archive] [bytes] [destination] [error] — tells the cell's API how a
# backup run ended (POST $REPORT_URL, Bearer $REPORT_TOKEN), so matelot_backup_last_success_timestamp_seconds & co.
# exist on Helm and on Compose alike (docs/observability.md). Env: REPORT_URL, REPORT_TOKEN, STARTED_AT (unix seconds).
# Never fails the backup: no URL / token = nothing sent; a report that cannot be delivered is logged and dropped.
# curl when the image has it (aws-cli), else plain bash /dev/tcp (the postgres image has no curl; the URL is the api
# Service on the cluster / compose network, plain HTTP).
report_backup() {
  local status="$1" step="$2" archive="${3:-}" bytes="${4:-}" destination="${5:-}" error="${6:-}"
  [ -n "${REPORT_URL:-}" ] && [ -n "${REPORT_TOKEN:-}" ] || return 0
  esc() { printf '%s' "$1" | head -c 1500 | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '; }
  local body="{\"status\":\"$status\",\"step\":\"$step\""
  [ -n "${STARTED_AT:-}" ] && body="$body,\"startedAt\":$STARTED_AT"
  [ -n "$archive" ] && body="$body,\"archive\":\"$(esc "$archive")\""
  [ -n "$bytes" ] && body="$body,\"bytes\":$bytes"
  [ -n "$destination" ] && body="$body,\"destination\":\"$(esc "$destination")\""
  [ -n "$error" ] && body="$body,\"error\":\"$(esc "$error")\""
  body="$body}"
  local code
  if command -v curl > /dev/null 2>&1; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H "Authorization: Bearer $REPORT_TOKEN" -H 'Content-Type: application/json' --data "$body" "$REPORT_URL" 2>&1)" || code="${code:-000}"
  else
    local rest="${REPORT_URL#http://}" hostport path host port
    hostport="${rest%%/*}"; path="/${rest#*/}"; host="${hostport%%:*}"; port="${hostport##*:}"; [ "$port" = "$hostport" ] && port=80
    local length; length="$(printf '%s' "$body" | LC_ALL=C wc -c | tr -d ' ')"   # bytes, not characters (an error text may be UTF-8)
    code="$( { exec 3<>"/dev/tcp/$host/$port" && printf 'POST %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "$path" "$hostport" "$REPORT_TOKEN" "$length" "$body" >&3 && head -1 <&3 | cut -d' ' -f2; } 2>/dev/null)" || code=000
  fi
  case "$code" in 2??) echo "backup report: $status ($step) → HTTP $code";; *) echo "backup report: $status ($step) not delivered (HTTP ${code:-000}); the backup itself is unaffected" >&2;; esac
  return 0
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then report_backup "$@"; fi
