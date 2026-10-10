#!/usr/bin/env python3
"""One status snapshot of a cell for the operator scripts' progress output (scripts/lib/wait.sh).

  cellwait.py cell <namespace> <release>        workloads of the release: Deployments / StatefulSets ready?
  cellwait.py job  <namespace> <job>            one Job: complete / failed / still running?
  cellwait.py pvs  <pv> [<pv> …]                which of these PersistentVolumes still exist?

Prints one JSON object: {"done": bool, "failed": bool, "summary": str, "waiting": [str], "stuck": [str], "info": [str]}.
`waiting` is what is not ready yet, `stuck` ({key, text}) what will not become ready by itself (image pull failures, crash loops, Pending for minutes with no
progress event, a failed Job; one key per pod and condition so the caller warns once), `info` things that are not ready
but do not block (a WaitForFirstConsumer PVC). Only pods of the current revision of each workload count.
Reads kubectl; with CELLWAIT_FIXTURE_DIR set it reads <dir>/<kind>.json instead (tests).
"""
import json, os, subprocess, sys
from datetime import datetime, timezone

# waiting reasons that will not clear by themselves, grouped into one condition each (ErrImagePull and ImagePullBackOff
# alternate on the same pod: one warning, not one per flip)
STUCK_CONDITIONS = {"ImagePullBackOff": "image pull", "ErrImagePull": "image pull", "InvalidImageName": "image pull",
                    "CrashLoopBackOff": "crash loop", "CreateContainerConfigError": "container config", "CreateContainerError": "container start", "RunContainerError": "container start"}
PENDING_STUCK_SECONDS = 180
PROGRESS_EVENT = ("Successfully assigned", "Pulling image", "Successfully pulled", "Created container", "Started container", "Container image", "AttachVolume", "Multi-Attach")


def kget(namespace, kind, *args):
    fixture = os.environ.get("CELLWAIT_FIXTURE_DIR")
    if fixture:
        path = os.path.join(fixture, f"{kind}.json")
        data = json.load(open(path)) if os.path.exists(path) else {"items": []}
        # honour the selectors kubectl would apply
        if "--field-selector" in args:
            field, _, value = args[args.index("--field-selector") + 1].partition("=")
            if field == "involvedObject.name":
                data = {"items": [e for e in data["items"] if e.get("involvedObject", {}).get("name") == value]}
        if "-l" in args:
            key, _, value = args[args.index("-l") + 1].partition("=")
            data = {"items": [i for i in data["items"] if i.get("metadata", {}).get("labels", {}).get(key) == value]}
        elif kind in ("jobs",) and len(args) == 1:
            data = {"items": [i for i in data["items"] if i["metadata"]["name"] == args[0]]}
        return data
    cmd = ["kubectl"] + (["-n", namespace] if namespace else []) + ["get", kind, *args, "-o", "json"]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    except subprocess.CalledProcessError:
        return {"items": []}
    data = json.loads(out or "{}")
    return data if "items" in data else {"items": [data]}


def age_seconds(ts):
    if not ts:
        return 0
    return (datetime.now(timezone.utc) - datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)).total_seconds()


def last_event(namespace, name, prefer_warning=False):
    """The newest event of an object; with prefer_warning the newest Warning (Failed / BackOff…) wins over Normal
    progress events, so a stuck pod is explained by its error, not by the "Pulling image" that preceded it."""
    ev = kget(namespace, "events", "--field-selector", f"involvedObject.name={name}").get("items", [])
    ev = sorted(ev, key=lambda e: e.get("lastTimestamp") or e.get("eventTime") or "")
    if prefer_warning:
        warnings = [e for e in ev if e.get("type") == "Warning"]
        ev = warnings or ev
    return (ev[-1].get("message") or "").strip().replace("\n", " ")[:160] if ev else ""


def pod_stuck(namespace, pod, stuck_reason):
    """A (key, text) pair for a pod that will not become ready by itself, or None when its last event shows progress."""
    name = pod["metadata"]["name"]
    if stuck_reason == "Pending" and any(m in last_event(namespace, name) for m in PROGRESS_EVENT):
        return None  # scheduling / pulling / starting: slow, not stuck
    event = last_event(namespace, name, prefer_warning=True)
    condition = STUCK_CONDITIONS.get(stuck_reason, "pending for minutes" if stuck_reason == "Pending" else stuck_reason)
    return f"{name}|{condition}", f"{name}: {condition} ({stuck_reason}) — {event or 'no event'}"


def pod_state(pod):
    """(ready, label, stuck_reason) for one pod, e.g. ('demo-api', 'Init:0/1'), ('demo-web', 'Running 0/1')."""
    st = pod.get("status", {})
    phase = st.get("phase", "Unknown")
    if phase == "Succeeded":
        return True, "Completed", None
    conds = {c["type"]: c["status"] for c in st.get("conditions", [])}
    ready = phase == "Running" and conds.get("Ready") == "True"
    inits = st.get("initContainerStatuses", []) or []
    conts = st.get("containerStatuses", []) or []
    waiting = [(c["name"], c["state"]["waiting"].get("reason", "")) for c in inits + conts if "waiting" in c.get("state", {})]
    stuck = next((r for _, r in waiting if r in STUCK_CONDITIONS), None)
    # Pending for minutes is suspicious only when nothing runs yet (unschedulable, volume not attaching…); a pod whose
    # init container is running (migrations, waiting for postgres) is Pending too, and that is progress
    init_running = any("running" in c.get("state", {}) for c in inits)
    if phase == "Pending" and not stuck and not init_running and age_seconds(pod["metadata"].get("creationTimestamp")) > PENDING_STUCK_SECONDS:
        stuck = "Pending"
    init_done = sum(1 for c in inits if c.get("state", {}).get("terminated", {}).get("exitCode") == 0)
    if inits and init_done < len(inits):
        label = f"Init:{init_done}/{len(inits)}"
    else:
        label = f"{phase} {sum(1 for c in conts if c.get('ready'))}/{len(conts) or 1}"
    reason = next((r for _, r in waiting if r), None)
    if reason and reason not in label:
        label += f" {reason}"
    restarts = sum(c.get("restartCount", 0) for c in conts)
    if restarts:
        label += f", {restarts} restart{'s' if restarts > 1 else ''}"
    return ready, label, stuck


def current_pods(namespace, release, deploys, stss, pods):
    """Pods that belong to the current revision of their Deployment / StatefulSet: the old ReplicaSet's pods being
    replaced, and anything Failed or Succeeded, are history and must not keep a wait going or trigger a warning."""
    rss = kget(namespace, "replicasets", "-l", f"app.kubernetes.io/instance={release}")["items"]
    current_rs = set()
    for d in deploys:
        rev = d["metadata"].get("annotations", {}).get("deployment.kubernetes.io/revision")
        for rs in rss:
            owners = [o["name"] for o in rs["metadata"].get("ownerReferences", [])]
            if d["metadata"]["name"] in owners and (rev is None or rs["metadata"].get("annotations", {}).get("deployment.kubernetes.io/revision") == rev):
                current_rs.add(rs["metadata"]["name"])
    sts_revision = {s["metadata"]["name"]: s.get("status", {}).get("updateRevision") for s in stss}
    out = []
    for p in pods:
        if p.get("status", {}).get("phase") in ("Failed", "Succeeded"):
            continue
        owners = p["metadata"].get("ownerReferences", [])
        kinds = {o["kind"]: o["name"] for o in owners}
        if "ReplicaSet" in kinds and rss and kinds["ReplicaSet"] not in current_rs:
            continue
        if "StatefulSet" in kinds:
            want = sts_revision.get(kinds["StatefulSet"])
            have = p["metadata"].get("labels", {}).get("controller-revision-hash")
            if want and have and have != want:
                continue
        out.append(p)
    return out


def snapshot_cell(namespace, release):
    sel = f"app.kubernetes.io/instance={release}"
    deploys = kget(namespace, "deployments", "-l", sel)["items"]
    stss = kget(namespace, "statefulsets", "-l", sel)["items"]
    pods = [p for p in kget(namespace, "pods", "-l", sel)["items"] if "job-name" not in p["metadata"].get("labels", {})]
    pods = current_pods(namespace, release, deploys, stss, pods)
    pvcs = kget(namespace, "persistentvolumeclaims")["items"]
    waiting, stuck, info = [], [], []
    for w in deploys + stss:
        spec_n = w["spec"].get("replicas", 1)
        st = w.get("status", {})
        ok = st.get("observedGeneration", 0) >= w["metadata"].get("generation", 0) and st.get("readyReplicas", 0) >= spec_n and st.get("updatedReplicas", 0) >= spec_n
        if not ok:
            waiting.append(w["metadata"]["name"])
    pod_lines, ready_pods = [], 0
    for p in pods:
        ready, label, stuck_reason = pod_state(p)
        name = p["metadata"]["name"]
        if ready:
            ready_pods += 1
            continue
        pod_lines.append(f"{name} ({label})")
        if stuck_reason:
            st = pod_stuck(namespace, p, stuck_reason)
            if st:
                stuck.append({"key": st[0], "text": st[1]})
    for c in pvcs:
        if c.get("status", {}).get("phase") != "Bound":
            msg = last_event(namespace, c["metadata"]["name"])
            line = f"pvc {c['metadata']['name']} ({c.get('status', {}).get('phase', '?')}{', ' + msg if msg else ''})"
            # a WaitForFirstConsumer claim binds when something mounts it (the backups PVC: on the first backup) — not blocking
            (info if "WaitForFirstConsumer" in msg or "waiting for first consumer" in msg else waiting).append(line)
    done = not waiting
    summary = f"pods {ready_pods}/{len(pods)} ready"
    if done:
        summary = f"all workloads ready ({summary})"
    # a workload is listed by its pods; only a workload without any pod yet is named itself
    workloads = [f"{w} (no pod yet)" for w in waiting if not w.startswith("pvc ") and not any(l.startswith(w + "-") for l in pod_lines)]
    return {"done": done, "failed": False, "summary": summary, "waiting": workloads + pod_lines + [w for w in waiting if w.startswith("pvc ")], "stuck": stuck, "info": info}


def snapshot_job(namespace, job):
    items = kget(namespace, "jobs", job)["items"]
    if not items:
        return {"done": True, "failed": True, "summary": f"job {job} not found", "waiting": [], "stuck": [{"key": f"job|{job}", "text": f"job {job} does not exist (deleted? wrong namespace?)"}], "info": []}
    j = items[0]
    conds = {c["type"]: c["status"] for c in j.get("status", {}).get("conditions", [])}
    pods = kget(namespace, "pods", "-l", f"job-name={job}")["items"]
    pod_lines, stuck = [], []
    for p in pods:
        ready, label, stuck_reason = pod_state(p)
        if p.get("status", {}).get("phase") == "Succeeded":
            continue
        pod_lines.append(f"{p['metadata']['name']} ({label})")
        if stuck_reason:
            st = pod_stuck(namespace, p, stuck_reason)
            if st:
                stuck.append({"key": st[0], "text": st[1]})
    if conds.get("Complete") == "True":
        return {"done": True, "failed": False, "summary": f"job {job} complete", "waiting": [], "stuck": [], "info": []}
    if conds.get("Failed") == "True":
        return {"done": True, "failed": True, "summary": f"job {job} FAILED", "waiting": [], "stuck": [{"key": f"job|{job}", "text": l} for l in pod_lines], "info": []}
    return {"done": False, "failed": False, "summary": f"job {job} running", "waiting": pod_lines or [f"job {job} (no pod yet)"], "stuck": stuck, "info": []}


def snapshot_pvs(names):
    existing = {pv["metadata"]["name"] for pv in kget(None, "persistentvolumes")["items"]}
    left = [n for n in names if n in existing]
    return {"done": not left, "failed": False, "summary": f"{len(names) - len(left)}/{len(names)} volumes released", "waiting": [f"pv {n}" for n in left], "stuck": [], "info": []}


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr); return 2
    mode = argv[1]
    if mode == "cell":
        out = snapshot_cell(argv[2], argv[3])
    elif mode == "job":
        out = snapshot_job(argv[2], argv[3])
    elif mode == "pvs":
        out = snapshot_pvs(argv[2:])
    else:
        print(f"unknown mode {mode}", file=sys.stderr); return 2
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
