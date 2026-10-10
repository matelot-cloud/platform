#!/usr/bin/env bash
# Generates the key pair the API signs registry tokens with and the certificate the registry trusts.
set -euo pipefail
out="${1:-deploy/registry/certs}"
mkdir -p "$out"
if [[ -f "$out/registry.key" && -f "$out/registry.crt" ]]; then echo "keys already exist in $out"; exit 0; fi
if [[ -d "$out" && ! -w "$out" ]]; then echo "cannot write to $out (owned by $(stat -c %U "$out")); run: sudo chown -R $(id -un) $out" >&2; exit 1; fi
openssl req -x509 -newkey rsa:3072 -nodes -keyout "$out/registry.key" -out "$out/registry.crt" -days 3650 -subj "/CN=secops-registry-token" 2>/dev/null || { echo "openssl failed (is openssl installed?)" >&2; exit 1; }
chmod 600 "$out/registry.key"
echo "created $out/registry.key and $out/registry.crt"
