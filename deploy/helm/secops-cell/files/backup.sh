#!/usr/bin/env bash
# Cell backup (runs in the postgres image from the chart's CronJob): pg_dump --format=custom of every database in
# $DATABASES plus the cell's Secrets mounted under $SECRETS_DIR, as one <cell>-<UTC stamp>.tar.gz in $OUT_DIR, with a
# .sha256 next to it and a "latest.tar.gz" symlink; archives older than $RETENTION_DAYS days are pruned.
# Restore with scripts/cell-restore.sh from https://github.com/matelot-cloud/helm-charts (docs: backup-restore).
set -euo pipefail
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
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/$NAME/db" "$WORK/$NAME/secrets" "$OUT_DIR"

for db in $DATABASES; do
  echo "dumping database $db"
  pg_dump --format=custom --no-owner --no-privileges --file "$WORK/$NAME/db/$db.dump" "$db"
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

{
  echo "cell=$CELL"
  echo "created=$STAMP"
  echo "databases=$DATABASES"
  echo "secrets=$(ls "$WORK/$NAME/secrets" | tr '\n' ' ')"
  echo "pg_dump=$(pg_dump --version)"
  echo "server=$(psql -d postgres -Atc 'select version()')"
} > "$WORK/$NAME/manifest.txt"

tar -C "$WORK" -czf "$OUT_DIR/$NAME.tar.gz.part" "$NAME"
mv "$OUT_DIR/$NAME.tar.gz.part" "$OUT_DIR/$NAME.tar.gz"
( cd "$OUT_DIR" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
ln -sfn "$NAME.tar.gz" "$OUT_DIR/latest.tar.gz"
echo "wrote $OUT_DIR/$NAME.tar.gz ($(du -h "$OUT_DIR/$NAME.tar.gz" | cut -f1))"

if [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$OUT_DIR" -maxdepth 1 -type f -name "$CELL-*.tar.gz*" -mtime +"$RETENTION_DAYS" -print -delete | sed 's/^/pruned /'
fi
echo "backup done: $NAME"
