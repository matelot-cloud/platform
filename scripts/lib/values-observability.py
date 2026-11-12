#!/usr/bin/env python3
"""Writes the `observability:` block of a cell's values file (deploy/cells/<slug>.values.yaml) — the file is the
source of truth for `apply`, so settings made here survive upgrades like every other cell setting (`helm upgrade
--reuse-values` does not: the next apply drops them). Standard library only: the top-level block is replaced when
present, appended when absent; everything else in the file is left byte for byte.

  values-observability.py <values.yaml> <endpoint> [protocol]          traces only (kind-jaeger); empty endpoint = off
  values-observability.py <values.yaml> <endpoint> [protocol] --stack [--label release=kube-prometheus-stack] [--logs]
      the whole delivery (kind-observability): ServiceMonitor and PrometheusRule with the labels the Prometheus selects,
      the exporters (postgres / redis sidecars, Keycloak and registry metrics), the dashboards and the OTLP endpoint;
      --logs also sends the audit / security events as OTLP log records (observability.otlp.logs) — only to a
      collector that takes logs (Alloy, the OpenTelemetry Collector), never to Tempo
"""
import re
import sys


def _q(v: str) -> str:
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render(endpoint: str, protocol: str, stack: bool = False, labels: dict | None = None, logs: bool = False) -> str:
    out = "observability:\n"
    if stack:
        out += (
            "  metrics:\n"
            "    serviceMonitor:\n"
            "      enabled: true   # needs the prometheus-operator CRDs (kube-prometheus-stack)\n"
            "      labels:" + ("\n" + "".join(f"        {k}: {_q(v)}\n" for k, v in (labels or {}).items()) if labels else " {}\n")
            + "    exporters:\n"
            "      enabled: true   # postgres_exporter / redis_exporter sidecars, Keycloak and registry metrics\n"
            "  prometheusRules:\n"
            "    enabled: true   # the alert rules as a PrometheusRule (the same labels select it)\n"
            "    labels:" + ("\n" + "".join(f"      {k}: {_q(v)}\n" for k, v in (labels or {}).items()) if labels else " {}\n")
            + "  grafana:\n"
            "    dashboards:\n"
            "      enabled: true   # the four dashboards as ConfigMaps for Grafana's sidecar\n"
        )
    out += (
        "  otlp:\n"
        f"    endpoint: {_q(endpoint)}   # OTLP traces (docs/observability.md); empty = tracing off\n"
        f"    protocol: {protocol}\n"
    )
    if logs:
        out += "    logs: true   # the audit / security events as OTLP log records too (the endpoint must take logs)\n"
    return out


def set_observability(text: str, endpoint: str, protocol: str = "http/protobuf", stack: bool = False, labels: dict | None = None, logs: bool = False) -> str:
    if logs and re.search(r"(?i)tempo", endpoint):
        raise ValueError(f"--logs with {endpoint}: Tempo takes no logs (404 on /v1/logs); point the cell at a collector that forwards logs")
    block = render(endpoint, protocol, stack, labels, logs)
    m = re.search(r"(?m)^observability:\n(?:(?:[ \t]+[^\n]*|[ \t]*#[^\n]*|)\n)*", text)
    if m:
        return text[: m.start()] + block + text[m.end():]
    return text.rstrip("\n") + "\n\n" + block


def main(argv: list[str]) -> None:
    stack = "--stack" in argv
    logs = "--logs" in argv
    labels: dict = {}
    rest: list[str] = []
    it = iter(argv)
    for a in it:
        if a in ("--stack", "--logs"):
            continue
        if a == "--label":
            k, _, v = next(it).partition("=")
            if not k or not re.fullmatch(r"[A-Za-z0-9._/-]+", k):
                sys.exit(f"bad --label {k}={v}")
            labels[k] = v
            continue
        rest.append(a)
    if len(rest) < 2:
        sys.exit(__doc__)
    path, endpoint = rest[0], rest[1]
    protocol = rest[2] if len(rest) > 2 else "http/protobuf"
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        new = set_observability(text, endpoint, protocol, stack, labels, logs)
    except ValueError as e:
        sys.exit(str(e))
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    print(f"{path}: observability.otlp.endpoint = {endpoint or '(off)'}" + (f"; ServiceMonitor + PrometheusRule on (labels {labels or '{}'}), exporters on, dashboards on" if stack else "") + ("; OTLP log records on" if logs else ""))


if __name__ == "__main__":
    main(sys.argv[1:])
