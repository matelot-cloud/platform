#!/usr/bin/env bash
# Restore every <database>.dump of a cell backup into the server PG* points at (run inside the postgres pod by
# scripts/cell-restore.sh, or anywhere pg_restore can reach the server). Each database is dropped and recreated, so
# nothing may be connected to it: the restore script scales the API, worker and Keycloak down first.
#   restore-db.sh <dir with *.dump> [database …]   (default: every dump in the directory)
set -euo pipefail
DIR="${1:?usage: restore-db.sh <dir with *.dump> [database …]}"; shift
: "${PGHOST:?PGHOST is required}" "${PGUSER:?PGUSER is required}" "${PGPASSWORD:?PGPASSWORD is required}"
if [ $# -gt 0 ]; then dbs=("$@"); else dbs=(); for f in "$DIR"/*.dump; do dbs+=("$(basename "$f" .dump)"); done; fi
[ ${#dbs[@]} -gt 0 ] || { echo "no *.dump in $DIR" >&2; exit 1; }
# every dump must be readable before anything is dropped
for db in "${dbs[@]}"; do
  f="$DIR/$db.dump"
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
  pg_restore --list "$f" > /dev/null || { echo "$f is not a valid pg_dump archive; nothing restored" >&2; exit 1; }
done
for db in "${dbs[@]}"; do
  f="$DIR/$db.dump"
  echo "restoring database $db from $(basename "$f")"
  psql -q -d postgres -Atc "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid()" > /dev/null
  dropdb --if-exists --force "$db"
  createdb "$db"
  pg_restore --exit-on-error --no-owner --no-privileges --dbname "$db" "$f"
  echo "  $(psql -d "$db" -Atc "select count(*) || ' tables' from information_schema.tables where table_schema = 'public'")"
done
echo "restore done: ${dbs[*]}"
