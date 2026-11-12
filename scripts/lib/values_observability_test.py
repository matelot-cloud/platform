import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("vo", pathlib.Path(__file__).with_name("values-observability.py"))
vo = importlib.util.module_from_spec(spec); spec.loader.exec_module(vo)

base = "tenant:\n  slug: acme\nbackup:\n  enabled: true\n"
out = vo.set_observability(base, "http://jaeger.observability:4318")
assert out.startswith(base), "existing content untouched"
assert 'observability:\n  otlp:\n    endpoint: "http://jaeger.observability:4318"' in out and "protocol: http/protobuf" in out
# a second call replaces the block, nothing is duplicated
again = vo.set_observability(out + "ingress:\n  tls: true\n", "http://collector:4317", "grpc")
assert again.count("observability:") == 1 and 'endpoint: "http://collector:4317"' in again and "protocol: grpc" in again and "ingress:\n  tls: true" in again
assert "jaeger" not in again
# a block in the middle of the file, with comments and blank lines inside, is replaced whole
mid = "a: 1\nobservability:\n  # comment\n  otlp:\n    endpoint: \"x\"\n\n    protocol: grpc\n  metrics:\n    enabled: true\nz: 2\n"
rep = vo.set_observability(mid, "")
assert rep.startswith("a: 1\nobservability:\n  otlp:\n    endpoint: \"\"") and rep.rstrip().endswith("z: 2") and "metrics" not in rep
# the whole delivery (kind-observability): ServiceMonitor with its labels, exporters, OTLP — valid YAML with the
# chart's keys, and a later traces-only call replaces it whole (one block, never two)
import yaml, tempfile, os
full = vo.set_observability(base, "http://tempo.monitoring:4318", stack=True, labels={"release": "kube-prometheus-stack"})
o = yaml.safe_load(full)["observability"]
assert o["metrics"]["serviceMonitor"] == {"enabled": True, "labels": {"release": "kube-prometheus-stack"}}, o
assert o["metrics"]["exporters"] == {"enabled": True} and o["otlp"] == {"endpoint": "http://tempo.monitoring:4318", "protocol": "http/protobuf"}, o
assert o["prometheusRules"] == {"enabled": True, "labels": {"release": "kube-prometheus-stack"}} and o["grafana"] == {"dashboards": {"enabled": True}}, o
assert yaml.safe_load(vo.set_observability(base, "x", stack=True))["observability"]["metrics"]["serviceMonitor"]["labels"] == {}
assert vo.set_observability(full, "http://jaeger:4318").count("observability:") == 1
# the CLI: --stack and repeated --label anywhere after the file
d = tempfile.mkdtemp(); f = os.path.join(d, "v.yaml"); open(f, "w").write(base)
vo.main([f, "http://tempo.monitoring:4318", "--stack", "--label", "release=kube-prometheus-stack", "--label", "team=platform"])
assert yaml.safe_load(open(f))["observability"]["metrics"]["serviceMonitor"]["labels"] == {"release": "kube-prometheus-stack", "team": "platform"}
# --logs: observability.otlp.logs: true, to a collector — refused for Tempo (404 on /v1/logs, kind rc.23), file untouched
vo.main([f, "http://alloy.monitoring:4318", "--stack", "--label", "release=kube-prometheus-stack", "--logs"])
assert yaml.safe_load(open(f))["observability"]["otlp"] == {"endpoint": "http://alloy.monitoring:4318", "protocol": "http/protobuf", "logs": True}
assert "logs" not in yaml.safe_load(vo.set_observability(base, "http://alloy.monitoring:4318", stack=True))["observability"]["otlp"]
before = open(f).read()
try:
    vo.main([f, "http://tempo.monitoring:4318", "--stack", "--logs"]); raise AssertionError("--logs to Tempo accepted")
except SystemExit as e:
    assert "Tempo takes no logs" in str(e), e
assert open(f).read() == before, "a refused --logs rewrote the values file"
print("values-observability ok")
