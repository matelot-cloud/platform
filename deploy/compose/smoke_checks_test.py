#!/usr/bin/env python3
"""The smoke tests' checks, without Docker (run by init/compose-init.test.sh, CI job `layout`):

1. every subcommand of smoke_checks.py against recorded answers (test-fixtures/, see its README): the passing answer
   passes, the failing one fails with a readable reason — no traceback, no SyntaxError;
2. every Python snippet still embedded in a shell script of the Compose stack (and the operator scripts) compiles as
   bash would hand it to Python: `python3 -c '…'`, `python3 -c "…"`, `python3 - <<'PY' … PY`, and every expression
   passed to smoke.sh's cli_json. A `\\"` inside bash single quotes reaches Python as a backslash — the bug that made
   the "every target up" step a SyntaxError 24 times in CI while the targets were never checked.

  python3 deploy/compose/smoke_checks_test.py
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIX = HERE / "test-fixtures"
CHECKS = HERE / "smoke_checks.py"
failures: list[str] = []


def run(check, stdin_text, *args):
    r = subprocess.run([sys.executable, str(CHECKS), check, *args], input=stdin_text, capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def expect(check, fixture_or_text, *args, ok=True, contains=None):
    is_file = isinstance(fixture_or_text, str) and fixture_or_text.endswith(".json") and "/" not in fixture_or_text and "\n" not in fixture_or_text and not fixture_or_text.lstrip().startswith(("{", "[", "<"))
    text = (FIX / fixture_or_text).read_text() if is_file else fixture_or_text
    rc, out, err = run(check, text, *args)
    label = f"{check} {' '.join(args)} < {fixture_or_text if isinstance(fixture_or_text, str) and len(fixture_or_text) < 60 else '…'}"
    if "Traceback" in err or "SyntaxError" in err:
        failures.append(f"{label}: crashed instead of a verdict:\n{err}")
    elif ok and rc != 0:
        failures.append(f"{label}: expected pass, got rc={rc}: {err or out}")
    elif not ok and rc != 1:
        failures.append(f"{label}: expected a failure (rc 1), got rc={rc}: {out}")
    elif contains and contains not in (out if ok else err):
        failures.append(f"{label}: expected {contains!r} in {'stdout' if ok else 'stderr'}: {out if ok else err}")
    return out, err


def grafana_answers():
    """Grafana's API answers built from the provisioning files compose-init renders (no Grafana binary here)."""
    import yaml
    with tempfile.TemporaryDirectory() as t:
        env = {"MATELOT_CONFIG_DIR": f"{t}/m", "MATELOT_VOLUMES_DIR": f"{t}/v", "MATELOT_PROFILES": "observability", "MATELOT_ORG_NAME": "Acme", "PATH": "/usr/bin:/bin"}
        subprocess.run(["bash", str(HERE / "init/compose-init.sh")], env=env, check=True, capture_output=True)
        o = pathlib.Path(t) / "m/observability/grafana"
        ds = yaml.safe_load((o / "datasources/datasources.yaml").read_text())["datasources"]
        datasources = [{"id": i + 1, "orgId": 1, "readOnly": True, "typeName": d["type"].title(), "basicAuth": False, "isDefault": d.get("isDefault", False), **d} for i, d in enumerate(ds)]
        boards = {p.stem: json.loads(p.read_text()) for p in (o / "dashboards").glob("*.json")}
    search = [{"id": i + 10, "uid": b["uid"], "title": b["title"], "uri": f"db/{b['uid']}", "url": f"/grafana/d/{b['uid']}", "type": "dash-db", "tags": b["tags"], "isStarred": False, "folderId": 3, "folderUid": "matelot", "folderTitle": "Matelot", "folderUrl": "/grafana/dashboards/f/matelot/"} for i, b in enumerate(boards.values())]
    dashboard = {"dashboard": boards["cell-overview"], "meta": {"type": "db", "provisioned": True, "folderTitle": "Matelot"}}
    return datasources, search, dashboard


def check_fixtures():
    # smoke.sh
    expect("oauth-discovery", "oauth-discovery.json", "http://localhost:80", contains="discovery ok: endpoints on http://localhost")
    expect("oauth-discovery", "oauth-discovery-wrong-origin.json", "http://localhost", ok=False, contains="API_PUBLIC_URL is wrong")
    expect("access-token", "keycloak-token.json", contains="eyJhbGciOi.fixture.token")
    expect("access-token", '{"error":"invalid_grant"}', ok=False, contains="no access_token")
    expect("field", "cli-service-account.json", "serviceAccount.id", contains="sa-1")
    expect("field", "cli-service-account.json", "token.token", contains="mlt_fixture")
    expect("field", "cli-service-account.json", "redirect", contains="callback?code=abc")
    rc, out, _ = run("approve-body", "", "http://localhost/oauth/consent?client_id=matelot-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcb&scope=write&state=s1&code_challenge=c1&x=y")
    if rc != 0 or json.loads(out) != {"client_id": "matelot-cli", "redirect_uri": "http://127.0.0.1:5/cb", "scope": "write", "state": "s1", "code_challenge": "c1"}:
        failures.append(f"approve-body: {rc} {out}")
    # Grafana
    datasources, search, dashboard = grafana_answers()
    expect("grafana-datasources", json.dumps(datasources), contains="loki, prometheus, tempo")
    expect("grafana-datasources", json.dumps([d for d in datasources if d["uid"] != "loki"]), ok=False, contains="datasources:")
    expect("grafana-dashboards", json.dumps(search), contains="Matelot · Cell overview")
    expect("grafana-dashboards", json.dumps([dict(x, folderTitle="General") for x in search]), ok=False, contains="folders:")
    expect("grafana-dashboard-inputs", json.dumps(dashboard), contains="datasource inputs resolved")
    unresolved = json.loads(json.dumps(dashboard).replace('"uid": "prometheus"', '"uid": "${DS_PROMETHEUS}"'))
    expect("grafana-dashboard-inputs", json.dumps(unresolved), ok=False, contains="unresolved")
    expect("grafana-datasources", "<!DOCTYPE html><html lang=\"en\">…", ok=False, contains="not JSON")   # the web app's index.html
    # Prometheus
    expect("prometheus-rules", "prometheus-rules.json", contains="none in error")
    rules = json.loads((FIX / "prometheus-rules.json").read_text())
    rules["data"]["groups"][0]["rules"][0].update(health="err", lastError="bad expr")
    expect("prometheus-rules", json.dumps(rules), ok=False, contains="rules in error")
    expect("prometheus-targets", "prometheus-targets-up.json", contains="missing: none; not up: none")
    expect("prometheus-targets", "prometheus-targets-registry-down.json", ok=False, contains="matelot-registry")
    gone = json.loads((FIX / "prometheus-targets-up.json").read_text())
    gone["data"]["activeTargets"] = [t for t in gone["data"]["activeTargets"] if t["labels"]["job"] != "matelot-keycloak"]
    expect("prometheus-targets", json.dumps(gone), ok=False, contains="missing: ['matelot-keycloak']")
    expect("build-info", "prometheus-query-build-info.json", contains="matelot-api, matelot-runner, matelot-worker")
    expect("build-info", "prometheus-query-pg-up.json", ok=False, contains="matelot_build_info from")
    for f, q in [("prometheus-query-pg-up.json", 'pg_up{job="matelot-postgres"} == 1'), ("prometheus-query-up-count.json", 'count(up{cell="main"}) >= 7'), ("prometheus-query-zero-series.json", 'matelot_pipeline_jobs_total{status="failed",kind="sbom"} == 0')]:
        expect("series-present", f, q, contains="present")
    expect("series-present", "prometheus-query-empty.json", "x", ok=False, contains="no series for x")
    expect("backup-gauge", "prometheus-query-backup-gauge.json", contains="backup gauge")
    expect("backup-gauge", "prometheus-query-empty.json", ok=False)
    # the pipeline, its trace, its logs
    out, _ = expect("pipeline-trace-id", "cli-pipeline-succeeded.json")
    if out != "83a0a354d529136f29e45fe1a889baf1":
        failures.append(f"pipeline-trace-id printed {out!r}")
    expect("pipeline-trace-id", "cli-pipeline-failed.json", ok=False, contains="pipeline status failed")
    expect("tempo-trace", "tempo-trace.json", contains="matelot-pipeline")
    expect("tempo-trace", "tempo-trace-v2.json", contains="matelot-runner")
    partial = json.loads((FIX / "tempo-trace.json").read_text())
    partial["batches"] = [b for b in partial["batches"] if not any(a["value"].get("stringValue") == "matelot-runner" for a in b["resource"]["attributes"])]
    expect("tempo-trace", json.dumps(partial), ok=False, contains="tempo:")
    expect("loki-lines", "loki-query-range.json", contains="from ['api', 'runner']")
    expect("loki-lines", "loki-query-range-empty.json", ok=False, contains="loki: 0 lines")
    expect("caddy-routes", "caddy-servers.json", contains="'/grafana*'")


# ---- snippets still embedded in shell scripts ----------------------------------------------------------------------
def bash_single(text, i):
    """text[i] is an opening '; returns (content, index after the closing ') with '\\'' joins, as bash concatenates."""
    out, j = [], i + 1
    while True:
        k = text.index("'", j)
        out.append(text[j:k])
        if text.startswith("\\''", k + 1):   # '…'\''…' → a literal quote in between
            out.append("'")
            j = k + 4
            continue
        return "".join(out), k + 1


def bash_double(text, i):
    """text[i] is an opening "; bash keeps \\ before anything but $ ` " \\ newline."""
    out, j = [], i + 1
    while text[j] != '"':
        if text[j] == "\\" and text[j + 1] in '$`"\\\n':
            out.append(text[j + 1] if text[j + 1] != "\n" else "")
            j += 2
            continue
        out.append(text[j])
        j += 1
    return "".join(out), j + 1


def bash_word(text, i):
    """A word made of adjacent quoted pieces ('…'"$VAR"'…'): each piece as bash reads it, a variable inside a
    double-quoted piece that sits between single-quoted ones replaced by X (it is a value spliced into the code)."""
    out = []
    while i < len(text) and text[i] in "'\"":
        if text[i] == "'":
            piece, i = bash_single(text, i)
        else:
            piece, i = bash_double(text, i)
            piece = re.sub(r"\$\{?[A-Za-z_0-9][A-Za-z0-9_]*\}?", "X", piece)
        out.append(piece)
    return "".join(out), i


def snippets(path):
    text = path.read_text()
    for m in re.finditer(r"python3 -c (['\"])", text):
        start = m.end() - 1
        if m.group(1) == "'":
            src, _ = bash_word(text, start)
        else:   # a whole double-quoted snippet: a variable in it (smoke.sh's cli_json: `…; $expr`) is a statement
            src, _ = bash_double(text, start)
            src = re.sub(r"\$\{?[A-Za-z_0-9][A-Za-z0-9_]*\}?", "pass", src)
        line = text.count("\n", 0, m.start()) + 1
        yield f"{path.relative_to(ROOT)}:{line} (python3 -c)", src
    for m in re.finditer(r"python3 (?:-I )?-[^\n<]*<<-?\s*'?(\w+)'?[^\n]*\n", text):
        end = re.search(rf"^\s*{m.group(1)}\s*$", text[m.end():], re.M)
        if end:
            yield f"{path.relative_to(ROOT)}:{text.count(chr(10), 0, m.start()) + 1} (heredoc)", text[m.end():m.end() + end.start()]
    for m in re.finditer(r"cli_json '", text):
        src, _ = bash_word(text, m.end() - 1)
        yield f"{path.relative_to(ROOT)}:{text.count(chr(10), 0, m.start()) + 1} (cli_json expression)", "import sys, json\nd = None\n" + src


def check_snippets():
    files = sorted({*HERE.glob("*.sh"), *HERE.glob("*/*.sh"), *(ROOT / "scripts").glob("*.sh"), *(ROOT / "scripts/lib").glob("*.sh"), *(ROOT / ".github/scripts").glob("*.sh")})
    n = 0
    for f in files:
        for where, src in snippets(f):
            n += 1
            try:
                compile(src, where, "exec")
            except SyntaxError as e:
                failures.append(f"{where}: the Python bash hands over does not compile: {e.msg} (line {e.lineno}: {(e.text or '').strip()!r})")
    if n < 10:
        failures.append(f"only {n} snippets found: the extractor is broken")
    return n, len(files)


def check_extractor():
    """The extractor must see what bash sees — the CI bug, reproduced: a \\" inside single quotes."""
    bad = "x | python3 -c 'print(f\"{a.get(\\\"k\\\")}\")'\n"
    (src, _), = [(s, None) for _, s in snippets_from_text(bad)]
    try:
        compile(src, "bad", "exec")
        failures.append("the extractor did not reproduce the backslash-in-single-quotes SyntaxError")
    except SyntaxError:
        pass
    good = "x | python3 -c \"import sys; print(\\\"ok\\\"); $expr\"\n"
    (src, _), = [(s, None) for _, s in snippets_from_text(good)]
    compile(src, "good", "exec")


def snippets_from_text(text):
    with tempfile.NamedTemporaryFile("w", suffix=".sh", dir=HERE, delete=False) as f:
        f.write(text)
    p = pathlib.Path(f.name)
    try:
        return list(snippets(p))
    finally:
        p.unlink()


if __name__ == "__main__":
    check_fixtures()
    check_extractor()
    n, nfiles = check_snippets()
    if failures:
        print("smoke checks FAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print(f"smoke checks ok (every smoke_checks.py check passes its recorded answer and fails the broken one; {n} Python snippets in {nfiles} shell scripts compile as bash passes them)")
