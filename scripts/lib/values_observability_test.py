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
print("values-observability ok")
