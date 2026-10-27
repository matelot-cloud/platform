#!/usr/bin/env bash
# Cell backup (runs in the postgres image from the chart's CronJob): pg_dump --format=custom of every database in
# $DATABASES plus the cell's Secrets mounted under $SECRETS_DIR, as one <cell>-<UTC stamp>.tar.gz in $OUT_DIR, with a
# .sha256 next to it and a "latest.tar.gz" symlink; archives older than $RETENTION_DAYS days are pruned.
# Restore with scripts/cell-restore.sh from https://github.com/matelot-cloud/helm-charts (docs: backup-restore).
set -euo pipefail
# Each run is reported to the cell's API (backup-report.sh; REPORT_URL / REPORT_TOKEN, optional): a failure from the
# trap below, a success at the end — unless REPORT_SUCCESS=0 (with S3 the upload step reports the outcome).
export STARTED_AT="${STARTED_AT:-$(date +%s)}"
# shellcheck source=backup-report.sh
. "$(dirname "$0")/backup-report.sh"
LAST_STEP="starting"; LAST_ERROR=""
on_exit() {
  local rc=$?
  rm -rf "${WORK:-/nonexistent}"
  [ "$rc" = 0 ] || report_backup failed dump "" "" "${DESTINATION:-}" "backup.sh exited with $rc while $LAST_STEP${LAST_ERROR:+: $LAST_ERROR}"
}
trap on_exit EXIT
# Connection: PGHOST/PGUSER/PGPASSWORD (bundled Postgres), or DATABASE_URL (external): postgresql://user:pass@host[:port]/db[?…]
if [ -z "${PGHOST:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  rest="${DATABASE_URL#*://}"; rest="${rest%%\?*}"
  creds="${rest%%@*}"; hostdb="${rest#*@}"
  export PGUSER="${creds%%:*}" PGPASSWORD="${creds#*:}"
  hostport="${hostdb%%/*}"; export PGHOST="${hostport%%:*}"
  case "$hostport" in *:*) export PGPORT="${hostport##*:}";; esac
  DATABASES="${DATABASES:-${hostdb#*/}}"
fi
: "${PGHOST:?PGHOST or DATABASE_URL is required}" "${PGUSER:?PGUSER is required}" "${PGPASSWORD:?PGPASSWORD is required}"
DATABASES="${DATABASES:-platform keycloak}"
OUT_DIR="${OUT_DIR:-/backups}"
SECRETS_DIR="${SECRETS_DIR:-/secrets}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
CELL="${CELL:-cell}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="$CELL-$STAMP"
WORK="$(mktemp -d)"
mkdir -p "$WORK/$NAME/db" "$WORK/$NAME/secrets" "$OUT_DIR"

# Postgres may not be there yet: right after a node or cluster restart the CronJob fires before the Service's DNS
# record and the database are back ("could not translate host name"), so wait for both — up to WAIT_SECONDS (120) —
# and report the last error (the reason goes to the API, so BackupFailed carries it) when they do not come.
LAST_STEP="waiting for postgres at $PGHOST"
deadline=$(( $(date +%s) + ${WAIT_SECONDS:-120} ))
until LAST_ERROR="$(pg_isready -h "$PGHOST" ${PGPORT:+-p "$PGPORT"} -U "$PGUSER" -t 5 2>&1)"; do
  if ! getent hosts "$PGHOST" > /dev/null 2>&1; then LAST_ERROR="could not resolve host name \"$PGHOST\" (${LAST_ERROR:-no answer})"; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "postgres at $PGHOST not reachable after ${WAIT_SECONDS:-120}s: $LAST_ERROR" >&2; exit 1; fi
  echo "postgres at $PGHOST not ready yet ($LAST_ERROR); retrying"
  sleep 5
done
LAST_ERROR=""

for db in $DATABASES; do
  LAST_STEP="dumping database $db"
  echo "dumping database $db"
  pg_dump --format=custom --no-owner --no-privileges --file "$WORK/$NAME/db/$db.dump" "$db" 2> "$WORK/pg_dump.err" || { LAST_ERROR="$(tail -c 400 "$WORK/pg_dump.err" | tr '\n' ' ')"; cat "$WORK/pg_dump.err" >&2; exit 1; }
  [ -s "$WORK/pg_dump.err" ] && cat "$WORK/pg_dump.err" >&2   # warnings
done

# Secrets: one directory per Secret (mounted by name), each key a file. Kubernetes mounts keys through a ..data symlink
# directory; the glob skips those dot entries and cp -L follows the links.
n=0
if [ -d "$SECRETS_DIR" ]; then
  for dir in "$SECRETS_DIR"/*/; do
    [ -d "$dir" ] || continue
    secret="$(basename "$dir")"
    mkdir -p "$WORK/$NAME/secrets/$secret"
    for f in "$dir"*; do [ -f "$f" ] && cp -L "$f" "$WORK/$NAME/secrets/$secret/"; done
    n=$((n + 1))
  done
fi
echo "secrets: $n"

# Registry image blobs (Docker Compose cells set REGISTRY_DIR; the Kubernetes CronJob does not: blobs stay on their PVC)
if [ -n "${REGISTRY_DIR:-}" ] && [ -d "$REGISTRY_DIR" ]; then
  echo "archiving registry blobs from $REGISTRY_DIR"
  tar -C "$REGISTRY_DIR" -cf "$WORK/$NAME/registry.tar" . 2> /dev/null || tar -C "$REGISTRY_DIR" -cf "$WORK/$NAME/registry.tar" --ignore-failed-read .
fi

{
  echo "cell=$CELL"
  echo "created=$STAMP"
  echo "databases=$DATABASES"
  echo "secrets=$(ls "$WORK/$NAME/secrets" | tr '\n' ' ')"
  echo "registry=$([ -f "$WORK/$NAME/registry.tar" ] && echo included || echo excluded)"
  echo "pg_dump=$(pg_dump --version)"
  echo "server=$(psql -d postgres -Atc 'select version()')"
} > "$WORK/$NAME/manifest.txt"

LAST_STEP="writing the archive"
tar -C "$WORK" -czf "$OUT_DIR/$NAME.tar.gz.part" "$NAME"
mv "$OUT_DIR/$NAME.tar.gz.part" "$OUT_DIR/$NAME.tar.gz"
( cd "$OUT_DIR" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
ln -sfn "$NAME.tar.gz" "$OUT_DIR/latest.tar.gz"
echo "wrote $OUT_DIR/$NAME.tar.gz ($(du -h "$OUT_DIR/$NAME.tar.gz" | cut -f1))"

if [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$OUT_DIR" -maxdepth 1 -type f -name "$CELL-*.tar.gz*" -mtime +"$RETENTION_DAYS" -print -delete | sed 's/^/pruned /'
fi
echo "backup done: $NAME"
[ "${REPORT_SUCCESS:-1}" = 0 ] || report_backup succeeded dump "$NAME.tar.gz" "$(stat -c %s "$OUT_DIR/$NAME.tar.gz")" "${DESTINATION:-}"
