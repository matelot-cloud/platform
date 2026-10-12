#!/usr/bin/env bash
# Backup and restore of a Docker Compose cell (deploy/compose, published as matelot-cloud/matelot → docker/).
# Sourced by scripts/cell-backup.sh and scripts/cell-restore.sh for their --compose mode. Archives have the same
# layout as the Kubernetes backups (db/*.dump, secrets/<name>/<KEY>, manifest.txt) plus registry.tar, so a backup of
# one kind of install restores into the other (the registry blobs are only restored into Compose cells).
# Requires: docker (compose v2) and the compose project directory (compose.yaml + .env).

compose_dir() { # compose_dir [DIR] → cd into the project, fail when it is not one
  local dir="${1:-${COMPOSE_DIR:-.}}"
  [ -f "$dir/compose.yaml" ] || { echo "no compose.yaml in $dir (use --compose DIR, or run from the docker/ folder)" >&2; return 1; }
  cd "$dir" || return 1
}
DC=(docker compose)

compose_backup() { # compose_backup DIR DOWNLOAD_DIR LIST
  compose_dir "$1"; local download="$2" list="$3"
  if [ "$list" = 1 ]; then "${DC[@]}" --profile backup run --rm --no-deps --entrypoint sh backup -c 'ls -lh /backups | grep -v "^total"'; return 0; fi
  echo "running the backup job (postgres, secrets, registry blobs → backups volume)"
  "${DC[@]}" --profile backup run --rm backup | sed 's/^/  /'
  if [ -n "$download" ]; then
    mkdir -p "$download"; download="$(cd "$download" && pwd)"
    "${DC[@]}" --profile backup run --rm --no-deps --entrypoint sh -v "$download:/out" backup -c 'n="$(basename "$(readlink -f /backups/latest.tar.gz)")"; cp "/backups/$n" "/backups/$n.sha256" /out/ && echo "$n"' | tail -1 | { read -r name; ( cd "$download" && sha256sum -c "$name.sha256" ); echo "downloaded $download/$name"; }
  fi
}

compose_restore() { # compose_restore DIR ARCHIVE MODE(all|secrets|databases) YES
  local archive="$2" mode="$3" yes="$4"
  [ -f "$archive" ] || { echo "no such file: $archive" >&2; return 1; }
  archive="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")"
  compose_dir "$1"
  if [ -f "$archive.sha256" ]; then ( cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256" ); fi
  local work; work="$(mktemp -d)"; trap 'rm -rf "$work"' RETURN
  tar -xzf "$archive" -C "$work"
  local root; root="$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -f "$root/manifest.txt" ] || { echo "not a cell backup (no manifest.txt)" >&2; return 1; }
  echo "archive:"; sed 's/^/  /' "$root/manifest.txt"
  if [ "$yes" != 1 ]; then
    echo; echo "This restores into the Compose cell in $(pwd) ($mode). Existing data there is replaced."
    read -r -p "Continue? [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || return 1
  fi
  # secrets → config volume (init's restore-secrets mode maps Kubernetes names such as acme-cell-key to cell-key),
  # then init regenerates the derived configuration from the restored values
  if [ "$mode" != databases ]; then
    "${DC[@]}" run --rm --no-deps -v "$root/secrets:/restore:ro" init restore-secrets /restore | sed 's/^/  /'
    [ "$mode" = secrets ] && { echo "secrets done. Now: docker compose up -d, then run again with --databases-only."; return 0; }
  fi
  # databases: postgres up, everything that holds a connection stopped, dumps restored inside the postgres container
  "${DC[@]}" up -d --wait postgres
  "${DC[@]}" stop api worker keycloak runner > /dev/null 2>&1 || true
  echo "restoring databases"
  "${DC[@]}" exec -T postgres sh -c 'rm -rf /tmp/restore && mkdir -p /tmp/restore'
  "${DC[@]}" cp "$root/db/." postgres:/tmp/restore/
  "${DC[@]}" cp backup/restore-db.sh postgres:/tmp/restore/restore-db.sh
  "${DC[@]}" exec -T postgres bash -c 'set -e; export PGHOST=localhost PGUSER="$(cat /matelot/secrets/postgres/POSTGRES_USER)" PGPASSWORD="$(cat /matelot/secrets/postgres/POSTGRES_PASSWORD)"; bash /tmp/restore/restore-db.sh /tmp/restore; rm -rf /tmp/restore' | sed 's/^/  /'
  if [ -f "$root/registry.tar" ]; then
    echo "restoring registry blobs"
    "${DC[@]}" run --rm --no-deps -v "$root:/restore:ro" --entrypoint sh registry -c 'rm -rf /var/lib/registry/* && tar -C /var/lib/registry -xf /restore/registry.tar && echo "  $(find /var/lib/registry -type f | wc -l) files"'
  fi
  "${DC[@]}" up -d
  echo "restore done from $(basename "$archive"): docker compose logs -f welcome"
}
