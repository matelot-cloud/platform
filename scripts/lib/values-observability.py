#!/usr/bin/env python3
"""Sets observability.otlp.{endpoint,protocol} in a cell's values file (deploy/cells/<slug>.values.yaml) — the file is
the source of truth for `apply`, so a tracing endpoint set here survives upgrades like every other cell setting
(`helm upgrade --reuse-values` does not: the next apply drops it). Standard library only: the `observability:`
top-level block is replaced when present, appended when absent; everything else in the file is left byte for byte.

  values-observability.py <values.yaml> <endpoint> [protocol]      (an empty endpoint turns tracing off)
"""
import re
import sys


def render(endpoint: str, protocol: str) -> str:
    return (
        "observability:\n"
        "  otlp:\n"
        f"    endpoint: {endpoint!r}".replace("'", '"') + "   # OTLP traces (docs/observability.md); empty = tracing off\n"
        f"    protocol: {protocol}\n"
    )


def set_observability(text: str, endpoint: str, protocol: str = "http/protobuf") -> str:
    block = render(endpoint, protocol)
    m = re.search(r"(?m)^observability:\n(?:(?:[ \t]+[^\n]*|[ \t]*#[^\n]*|)\n)*", text)
    if m:
        return text[: m.start()] + block + text[m.end():]
    return text.rstrip("\n") + "\n\n" + block


if __name__ == "__main__":
    path, endpoint = sys.argv[1], sys.argv[2]
    protocol = sys.argv[3] if len(sys.argv) > 3 else "http/protobuf"
    with open(path, encoding="utf-8") as f:
        text = f.read()
    with open(path, "w", encoding="utf-8") as f:
        f.write(set_observability(text, endpoint, protocol))
    print(f"{path}: observability.otlp.endpoint = {endpoint or '(off)'}")
