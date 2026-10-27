import importlib.util, pathlib, yaml
spec = importlib.util.spec_from_file_location("vt", pathlib.Path(__file__).with_name("values-image-tag.py"))
vt = importlib.util.module_from_spec(spec); spec.loader.exec_module(vt)

template = pathlib.Path(__file__).resolve().parents[2].joinpath("deploy/cells/_template.values.yaml").read_text()
out, changed = vt.set_tag(template, "0.1.0-rc.21")
d = yaml.safe_load(out.replace("__ISSUER__", "x").replace("__ADMINS__", "a@b"))
assert d["image"]["tag"] == "0.1.0-rc.21" and d["worker"]["image"]["tag"] == "0.1.0-rc.21" and d["web"]["image"]["tag"] == "0.1.0-rc.21" and d["managedRunners"]["image"]["tag"] == "0.1.0-rc.21", changed
assert d["managedRunners"]["replicas"] == 1 and d["image"]["repository"] == "ghcr.io/matelot-cloud/api", "the rest of the blocks is untouched"
assert "# all four images move together" in out, "comments survive"
assert len(changed) == 4 and all("→ 0.1.0-rc.21" in c for c in changed), changed
# idempotent, and a second tag replaces the first
again, c2 = vt.set_tag(out, "0.1.0-rc.21"); assert again == out
third, _ = vt.set_tag(out, "0.2.0"); assert yaml.safe_load(third.replace("__ISSUER__", "x").replace("__ADMINS__", "a@b"))["web"]["image"]["tag"] == "0.2.0"
# a minimal file without image blocks: they are added, in a shape the chart accepts
mini = "tenant:\n  slug: acme\n  name: Acme\n"
added, c3 = vt.set_tag(mini, "0.3.0")
m = yaml.safe_load(added)
assert m["tenant"]["slug"] == "acme" and m["image"]["tag"] == "0.3.0" and m["worker"]["image"]["tag"] == "0.3.0" and m["managedRunners"]["image"]["tag"] == "0.3.0", added
assert all("(added)" in c for c in c3), c3
# block-form nested image, and a flow map without a tag
blocky = "worker:\n  replicas: 2\n  image:\n    repository: r\n    pullPolicy: Always\nweb:\n  image: { repository: w }\nimage:\n  repository: a\n"
b, c4 = vt.set_tag(blocky, "9.9.9")
bd = yaml.safe_load(b)
assert bd["worker"]["image"] == {"repository": "r", "pullPolicy": "Always", "tag": "9.9.9"} and bd["worker"]["replicas"] == 2, b
assert bd["web"]["image"] == {"repository": "w", "tag": "9.9.9"} and bd["image"] == {"repository": "a", "tag": "9.9.9"}, b
assert bd["managedRunners"]["image"]["tag"] == "9.9.9"
print("values-image-tag ok")
