import { Link } from "react-router";
import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { useCreateIssue, useCreateRemediation, useRemediationQueue, useRemediations, useEffectiveRemediationSettings, useRemediationSettings, useUpdateRemediation, useUpdateRemediationSettings } from "@/platform/api/hooks";
import type { EffectiveRemediationSettings, QueueItem, Remediation } from "@/platform/api/types";
import { ENV_COLOR } from "@/platform/components/ServicePanel";
import { SEVERITY_COLOR } from "@/platform/components/Findings";
import { Card, EmptyState, ErrorNotice, inputClass, linkButton, muted, outlineButton, primaryButton, Tabs, td, th, trBorder } from "@/platform/components/ui";
import { formatDate } from "@/platform/format";
import { cn } from "@/utils";
import { useState } from "react";
import { useProject } from "./layout";

function TrackDialog({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const create = useCreateRemediation();
  const [ownerEmail, setOwnerEmail] = useState("");
  const [dueAt, setDueAt] = useState(item.dueAt.slice(0, 10));
  const [notes, setNotes] = useState("");
  return (
    <Modal isOpen onClose={onClose} className="max-w-140 p-6 pe-20 lg:p-8 lg:pe-24">
      <form onSubmit={(e) => { e.preventDefault(); create.mutate({ serviceId: item.serviceId, kind: item.kind, matchId: item.matchId, componentName: item.kind === "code" ? undefined : item.componentName, ownerEmail: ownerEmail || undefined, dueAt: dueAt ? `${dueAt}T23:59:59Z` : undefined, notes: notes || undefined }, { onSuccess: onClose }); }} className="space-y-4">
        <h4 className="text-lg font-semibold text-gray-800 dark:text-white/90">Track as work</h4>
        <p className={`text-sm ${muted}`}>{item.matchId}{item.componentName ? ` · ${item.componentName}` : ""} in {item.serviceName} — {item.findingIds.length} finding{item.findingIds.length === 1 ? "" : "s"}. Closes itself when they are all fixed.</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div><Label htmlFor="rem-owner">Owner (e-mail)</Label><input id="rem-owner" type="email" className={inputClass} placeholder="dev@company.com" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} /></div>
          <div><Label htmlFor="rem-due">Due</Label><input id="rem-due" type="date" className={inputClass} value={dueAt} onChange={(e) => setDueAt(e.target.value)} /><p className={`mt-1 text-xs ${muted}`}>SLA suggests {item.dueAt.slice(0, 10)}</p></div>
        </div>
        <div><Label htmlFor="rem-notes">Notes</Label><textarea id="rem-notes" rows={2} className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={item.fixVersion ? `Bump to ${item.fixVersion}` : ""} /></div>
        {create.error ? <ErrorNotice error={create.error} /> : null}
        <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={onClose}>Cancel</button><button type="submit" className={primaryButton} disabled={create.isPending}>{create.isPending ? "Tracking…" : "Track"}</button></div>
      </form>
    </Modal>
  );
}

export function Queue({ projectId }: { projectId: string }) {
  const queue = useRemediationQueue(projectId);
  const update = useUpdateRemediation();
  const issue = useCreateIssue();
  const [track, setTrack] = useState<QueueItem | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const items = (queue.data ?? []).filter((i) => !onlyOpen || !i.remediation);
  const overdue = (queue.data ?? []).filter((i) => i.overdue).length;
  return (
    <Card title="Fix first" description="Open findings grouped by advisory and service, ranked by where they run (production first), severity, known exploitation, fix availability and SLA. Track an item to give it an owner, a due date and a ticket." flush actions={<label className={`flex items-center gap-2 text-sm ${muted}`}><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />untracked only</label>}>
      {queue.error ? <div className="p-4"><ErrorNotice error={queue.error} /></div> : items.length === 0 ? <EmptyState title="Nothing to fix">No open findings in this project.</EmptyState> : (
        <>
          {overdue > 0 && <p className="border-b border-error-200 bg-error-50 px-6 py-2 text-sm text-error-700 dark:border-error-500/30 dark:bg-error-500/10 dark:text-error-400">{overdue} item{overdue === 1 ? " is" : "s are"} past the SLA.</p>}
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>#</th><th className={th}>What</th><th className={th}>Service</th><th className={th}>Runs in</th><th className={th}>Fix</th><th className={th}>Due (SLA)</th><th className={th}>Tracking</th><th className={th} /></tr></thead>
            <tbody>
              {items.map((i, n) => (
                <tr key={i.key} className={trBorder}>
                  <td className={`${td} ${muted}`}>{n + 1}</td>
                  <td className={td}><span className="flex items-center gap-2"><Badge size="sm" color={SEVERITY_COLOR[i.severity] ?? "light"}>{i.severity}</Badge><span className="font-mono text-sm text-gray-800 dark:text-white/90">{i.matchId}</span>{i.kev && <Badge size="sm" color="error">KEV</Badge>}</span><span className={`block text-xs ${muted}`}>{i.kind === "vulnerability" ? `${i.componentName}${i.componentVersion ? ` ${i.componentVersion}` : ""} · ${i.findingIds.length} finding${i.findingIds.length === 1 ? "" : "s"}` : `${i.componentName} rule · ${i.findingIds.length} file${i.findingIds.length === 1 ? "" : "s"}`}{i.epss != null ? ` · EPSS ${(i.epss * 100).toFixed(0)}%` : ""}</span></td>
                  <td className={`${td} text-sm`}>{i.serviceName}</td>
                  <td className={td}>{i.runsIn.length ? i.runsIn.map((k) => <Badge key={k} size="sm" color={(ENV_COLOR as Record<string, "error" | "light" | "warning" | "info">)[k] ?? "light"}>{k}</Badge>) : <span className={`text-xs ${muted}`}>not deployed</span>}{i.internetFacing && <span className="block text-[11px] text-error-500">internet-facing</span>}</td>
                  <td className={`${td} text-xs ${muted}`}>{i.fixVersion ? <span className="text-success-600">{i.fixVersion}</span> : i.kind === "code" ? "—" : "no fix yet"}</td>
                  <td className={td}><span className={cn("text-sm", i.overdue ? "font-medium text-error-500" : "text-gray-700 dark:text-gray-300")}>{formatDate(i.dueAt)}</span><span className={`block text-xs ${muted}`}>{i.overdue ? `${-i.daysLeft} days overdue` : `${i.daysLeft} days left`}</span></td>
                  <td className={td}>{i.remediation ? <><Badge size="sm" color={i.remediation.status === "in_progress" ? "primary" : "light"}>{i.remediation.status.replace("_", " ")}</Badge><span className={`block text-xs ${muted}`}>{i.remediation.ownerName ?? "unassigned"}{i.remediation.issueUrl && <> · <a href={i.remediation.issueUrl} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline">{i.remediation.issueKey}</a></>}</span></> : <span className={`text-xs ${muted}`}>untracked</span>}</td>
                  <td className={`${td} text-end whitespace-nowrap`}>
                    {!i.remediation ? <button type="button" className={linkButton} onClick={() => setTrack(i)}>Track</button> : (
                      <span className="inline-flex gap-3">
                        {!i.remediation.issueUrl && <button type="button" className={linkButton} disabled={issue.isPending} onClick={() => issue.mutate({ id: i.remediation!.id })}>Create issue</button>}
                        {i.remediation.status !== "done" && <button type="button" className={linkButton} onClick={() => update.mutate({ id: i.remediation!.id, status: "done" })}>Done</button>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(issue.error || update.error) ? <div className="p-4"><ErrorNotice error={issue.error ?? update.error} /></div> : null}
        </>
      )}
      {track && <TrackDialog item={track} onClose={() => setTrack(null)} />}
    </Card>
  );
}

export function Tracked({ projectId }: { projectId: string }) {
  const list = useRemediations(projectId);
  const update = useUpdateRemediation();
  const issue = useCreateIssue();
  const rows = list.data ?? [];
  const color = (s: Remediation["status"]) => (s === "done" ? "success" : s === "in_progress" ? "primary" : s === "wont_fix" ? "light" : "warning");
  return (
    <Card title="Tracked remediations" description="Work items with an owner, a due date and (optionally) a Jira or GitHub issue. They close automatically when all their findings are fixed." flush>
      {list.error ? <div className="p-4"><ErrorNotice error={list.error} /></div> : rows.length === 0 ? <EmptyState title="Nothing tracked yet">Use Track on a queue item.</EmptyState> : (
        <table className="min-w-full">
          <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Remediation</th><th className={th}>Status</th><th className={th}>Owner</th><th className={th}>Due</th><th className={th}>Issue</th><th className={th} /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={trBorder}>
                <td className={td}><span className="flex items-center gap-2"><Badge size="sm" color={SEVERITY_COLOR[r.severity] ?? "light"}>{r.severity}</Badge><span className="text-sm text-gray-800 dark:text-white/90">{r.title}</span></span>{r.notes && <span className={`block text-xs ${muted}`}>{r.notes}</span>}</td>
                <td className={td}><Badge size="sm" color={r.stillPresent ? "warning" : color(r.status)}>{r.status.replace("_", " ")}</Badge>{r.stillPresent && <span className={`ms-1 text-[11px] ${muted}`} title="Marked done, but the finding is still open in an image that runs. It stays flagged until a scan no longer finds it.">— still present</span>}</td>
                <td className={`${td} text-sm`}>{r.ownerName ?? <span className={muted}>unassigned</span>}</td>
                <td className={td}><span className={cn("text-sm", r.overdue ? "font-medium text-error-500" : muted)}>{r.dueAt ? formatDate(r.dueAt) : "—"}</span></td>
                <td className={td}>{r.issueUrl ? <a href={r.issueUrl} target="_blank" rel="noreferrer" className="text-sm text-brand-500 hover:underline">{r.issueKey}</a> : ["open", "in_progress"].includes(r.status) ? <button type="button" className={linkButton} disabled={issue.isPending} onClick={() => issue.mutate({ id: r.id })}>Create issue</button> : <span className={muted}>—</span>}</td>
                <td className={`${td} text-end whitespace-nowrap`}>{["open", "in_progress"].includes(r.status) && <span className="inline-flex gap-3">{r.status === "open" && <button type="button" className={linkButton} onClick={() => update.mutate({ id: r.id, status: "in_progress" })}>Start</button>}<button type="button" className={linkButton} onClick={() => update.mutate({ id: r.id, status: "done" })}>Done</button><button type="button" className={linkButton} onClick={() => { if (window.confirm("Mark as won't fix? Its findings are recorded as accepted.")) update.mutate({ id: r.id, status: "wont_fix" }); }}>Won't fix</button></span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(issue.error || update.error) ? <div className="p-4"><ErrorNotice error={issue.error ?? update.error} /></div> : null}
    </Card>
  );
}

/**
 * SLAs & issue tracker for one scope. Each scope stores only what it overrides; blank = inherited from the parent
 * (team → workspace → organization). For a project the effective values and their origin are shown.
 */
export function Settings({ scope, scopeLabel, projectId }: { scope: string; scopeLabel: string; projectId?: string }) {
  const settings = useRemediationSettings(scope);
  const effective = useEffectiveRemediationSettings(projectId);
  const save = useUpdateRemediationSettings(scope);
  const [sla, setSla] = useState<Record<string, string> | null>(null);
  const s = settings.data;
  if (!s) return null;
  const isOrg = s.scopeType === "ORGANIZATION";
  const eff = effective.data;
  const base = s.slaDays ?? eff?.slaDays ?? null;
  const cur = sla ?? Object.fromEntries((["critical", "high", "medium", "low"] as const).map((k) => [k, s.slaDays ? String(s.slaDays[k]) : ""]));
  const from = (k: keyof EffectiveRemediationSettings["sources"]) => { const src = eff?.sources[k]; return src ? `${src.scopeType.toLowerCase()} ${src.name}` : "built-in default"; };
  return (
    <Card title="SLAs" description={`Days to fix by severity at the ${scopeLabel}. ${isOrg ? "These are the organization defaults." : "Leave a field blank to inherit from the parent scope (team → workspace → organization)."} Due dates and 'overdue' in the fix-first queue come from these.`}>
      <form onSubmit={(e) => { e.preventDefault(); const entries = Object.entries(cur).filter(([, v]) => v !== ""); save.mutate({ slaDays: entries.length ? Object.fromEntries(entries.map(([k, v]) => [k, Number(v)])) : (isOrg ? undefined : null) }); }} className="flex flex-wrap items-end gap-4">
        {(["critical", "high", "medium", "low"] as const).map((k) => <div key={k} className="w-28"><Label htmlFor={`sla-${k}`}>{k} (days)</Label><input id={`sla-${k}`} type="number" min={1} max={3650} className={inputClass} placeholder={base ? String(base[k]) : "inherit"} value={cur[k]} onChange={(e) => setSla({ ...cur, [k]: e.target.value })} /></div>)}
        <button type="submit" className={primaryButton} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
        {!isOrg && s.slaDays && <button type="button" className={outlineButton} onClick={() => { setSla(Object.fromEntries(["critical", "high", "medium", "low"].map((k) => [k, ""]))); save.mutate({ slaDays: null }); }}>Inherit</button>}
        {save.error ? <ErrorNotice error={save.error} /> : null}
      </form>
      {eff && (
        <p className={`mt-4 text-xs ${muted}`}>Effective for this project: {eff.slaDays.critical} / {eff.slaDays.high} / {eff.slaDays.medium} / {eff.slaDays.low} days (from {from("slaDays")}).</p>
      )}
    </Card>
  );
}

export default function ProjectRemediationPage() {
  const { project } = useProject();
  const [tab, setTab] = useState<"queue" | "tracked" | "settings">("queue");
  return (
    <div className="space-y-6">
      <Card flush><Tabs value={tab} onChange={setTab} items={[{ value: "queue", label: "Fix first" }, { value: "tracked", label: "Tracked" }, { value: "settings", label: "SLAs" }]} /></Card>
      {tab === "queue" && <Queue projectId={project.id} />}
      {tab === "tracked" && <Tracked projectId={project.id} />}
      {tab === "settings" && <div className="space-y-4"><Settings scope={`projects/${project.id}`} scopeLabel={`project ${project.name}`} projectId={project.id} /><p className={`text-sm ${muted}`}>Where issues are opened is configured under <Link to={`/projects/${project.id}/issue-tracking`} className="text-brand-500 hover:underline">Setup → Issue tracking</Link>.</p></div>}
    </div>
  );
}
