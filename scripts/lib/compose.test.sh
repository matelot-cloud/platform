#!/usr/bin/env bash
# Unit test of the Compose backup/restore helpers without Docker: a `docker` shim on PATH runs the `sh -c` script that
# compose.sh hands to `compose run` locally, with the container paths mapped to a temp dir. It checks what broke in CI:
# the copy-out of an archive and the copy-in of secrets never bind-mount a host directory (they stream through stdout /
# stdin), the sha256 is verified after the copy, and the restore reaches compose-init.sh's restore-secrets mode.
# Runs as whoever invokes it (CI: the unprivileged runner user). Run: bash scripts/lib/compose.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/backups" "$T/project" "$T/config" "$T/registry"
touch "$T/project/compose.yaml"
export FAKE_ROOT="$T" PATH="$T/bin:$PATH" LOG="$T/docker.log"
# the shim: records every invocation; for `run … --entrypoint sh <service> -c SCRIPT [sh ARGS…]` runs SCRIPT with container
# paths rewritten (/backups, /tmp/restore, /init/compose-init.sh, /var/lib/registry); refuses bind mounts (-v) — that was the bug
cat > "$T/bin/docker" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$LOG"; echo >> "$LOG"
for a in "$@"; do [ "$a" = "-v" ] && { echo "shim: bind mount used ($*)" >&2; exit 97; }; done
[ "${1:-}" = compose ] || { echo "shim: expected docker compose, got $*" >&2; exit 98; }
shift
sub=""; script=""; svc=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    run) sub=run; shift; continue;;
    -c) script="$2"; shift 2; args=("$@"); break;;
    --entrypoint) shift 2; svc="$1"; shift; continue;;
    up|stop|exec|cp) echo "shim: $1 not simulated"; exit 0;;
  esac; shift
done
[ "$sub" = run ] || { echo "shim: unexpected: $*" >&2; exit 99; }
case "$script" in *"-T "*) ;; esac
script="${script//\/backups/$FAKE_ROOT/backups}"
script="${script//\/tmp\/restore/$FAKE_ROOT/restore}"
script="${script//\/init\/compose-init.sh/$FAKE_ROOT/compose-init.sh}"
script="${script//\/var\/lib\/registry/$FAKE_ROOT/registry}"
export MATELOT_CONFIG_DIR="$FAKE_ROOT/config" MATELOT_VOLUMES_DIR="$FAKE_ROOT/volumes"
exec sh -c "$script" "${args[@]}"
SHIM
chmod +x "$T/bin/docker"
# compose-init.sh: deploy/compose/init in the platform checkout, ../../init in the published docker/ folder
INIT="$HERE/../../deploy/compose/init/compose-init.sh"; [ -f "$INIT" ] || INIT="$HERE/../../init/compose-init.sh"
cp "$INIT" "$T/compose-init.sh"
# shellcheck source=compose.sh
. "$HERE/compose.sh"

# 1. an archive in the "backups volume" with latest.tar.gz pointing at it
mkdir -p "$T/src/main-x/secrets/cell-key" "$T/src/main-x/db"; printf 'k3y' > "$T/src/main-x/secrets/cell-key/CELL_ENCRYPTION_KEY"; echo "cell: main" > "$T/src/main-x/manifest.txt"
tar -C "$T/src" -czf "$T/backups/main-x.tar.gz" main-x
( cd "$T/backups" && sha256sum main-x.tar.gz > main-x.tar.gz.sha256 && ln -s main-x.tar.gz latest.tar.gz )

# 2. copy-out: streamed, verified, printed with the host path
out="$(compose_download "$T/down")"
case "$out" in "downloaded $T/down/main-x.tar.gz ("*"sha256 "*) ;; *) echo "FAIL: download message: $out" >&2; exit 1;; esac
cmp "$T/backups/main-x.tar.gz" "$T/down/main-x.tar.gz" || { echo "FAIL: archive differs after the copy" >&2; exit 1; }
grep -q -- ' -T ' "$LOG" || { echo "FAIL: compose run without -T (a TTY would corrupt the stream)" >&2; exit 1; }
# a corrupted copy is caught
cp "$T/backups/main-x.tar.gz" "$T/good.tar.gz"; printf 'x' >> "$T/backups/main-x.tar.gz"
if compose_download "$T/down2" > /dev/null 2>&1; then echo "FAIL: sha256 mismatch not detected" >&2; exit 1; fi
cp "$T/good.tar.gz" "$T/backups/main-x.tar.gz"

# 3. copy-in: secrets stream into compose-init.sh restore-secrets (then its init mode runs against the fake config dir)
: > "$LOG"
compose_restore "$T/project" "$T/down/main-x.tar.gz" secrets 1 > "$T/restore.out" 2>&1 || { cat "$T/restore.out" >&2; echo "FAIL: compose_restore" >&2; exit 1; }
[ "$(cat "$T/config/secrets/cell-key/CELL_ENCRYPTION_KEY")" = "k3y" ] || { cat "$T/restore.out" >&2; echo "FAIL: secret not restored" >&2; exit 1; }
grep -q "restored secrets/cell-key" "$T/restore.out" || { cat "$T/restore.out" >&2; echo "FAIL: restore-secrets output missing" >&2; exit 1; }
grep -q -- '-v' "$LOG" && { echo "FAIL: bind mount in restore" >&2; exit 1; }
echo "compose-lib ok (copy-out streamed + verified, copy-in streamed into restore-secrets, no bind mounts, uid $(id -u))"
