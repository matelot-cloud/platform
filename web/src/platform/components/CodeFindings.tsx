import { CodeBlock } from "./CodeBlock";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { useCodeFindings, useCodeFindingSummary, useSetCodeFindingStatus, type CodeFindingQuery } from "@/platform/api/hooks";
import type { CodeFindingRow, FindingStatus, Severity } from "@/platform/api/types";
import { relativeTime } from "@/platform/format";
import { cn } from "@/utils";
import { useMemo, useState } from "react";
import { Kpi } from "./Dashboard";
import { FindingCounts } from "./FindingCounts";
import { SeverityBadge, STATUS_LABEL } from "./Findings";
import { EmptyState, ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField } from "./ui";

const KIND_LABEL = { secret: "Secret", iac: "IaC", sast: "Code" } as const;
const ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

function CodeFindingDialog({ f, onClose }: { f: CodeFindingRow; onClose: () => void }) {
  const set = useSetCodeFindingStatus();
  const [status, setStatus] = useState<FindingStatus | "">("");
  const [note, setNote] = useState("");
  return (
    <Modal isOpen onClose={onClose} className="max-w-200 p-6 pe-20 lg:p-8 lg:pe-24">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={f.severity} /><Badge size="sm" color="light">{KIND_LABEL[f.kind]}</Badge><Badge size="sm" color={f.status === "open" ? "warning" : f.status === "fixed" ? "success" : "light"}>{STATUS_LABEL[f.status]}</Badge></div>
        <h4 className="text-lg font-semibold text-gray-800 dark:text-white/90">{f.title}</h4>
        <p className={`text-sm ${muted}`}><span className="font-mono">{f.ruleId}</span>{f.category ? ` · ${f.category}` : ""} · {f.serviceName} · {f.projectName}</p>
        <p className="text-sm"><span className={muted}>Location </span>{f.fileUrl ? <a href={f.fileUrl} target="_blank" rel="noreferrer" className="font-mono text-brand-500 hover:underline">{f.file}{f.startLine ? `:${f.startLine}` : ""}</a> : <span className="font-mono text-gray-800 dark:text-white/90">{f.file}{f.startLine ? `:${f.startLine}` : ""}</span>}{f.repository ? <span className={muted}> in {f.repository}{f.ref ? ` @ ${f.ref.slice(0, 12)}` : ""}</span> : null}</p>
        {f.evidence && <div><p className={`text-xs ${muted}`}>{f.kind === "secret" ? "Evidence (redacted — the value never leaves the runner)" : "Finding"}</p><CodeBlock className="mt-1" wrap code={f.evidence} /></div>}
        {f.resolution && <div><p className="text-sm font-medium text-gray-800 dark:text-white/90">How to fix</p><p className={`text-sm ${muted}`}>{f.resolution}</p></div>}
        {f.references.length > 0 && <p className={`text-xs ${muted}`}>References: {f.references.map((r) => <a key={r} href={r} target="_blank" rel="noreferrer" className="me-2 text-brand-500 hover:underline">{r.replace(/^https?:\/\//, "").slice(0, 50)}</a>)}</p>}
        <p className={`text-xs ${muted}`}>First seen {relativeTime(f.firstSeenAt)} · last seen {relativeTime(f.lastSeenAt)}{f.note ? ` · note: "${f.note}"` : ""}</p>
        <div className="border-t border-gray-100 pt-4 dark:border-gray-800">
          <p className={`text-xs ${muted}`}>"Fixed" is set by the platform when a scan no longer reports it.{f.kind === "secret" ? " For a leaked secret, rotating it is the fix — removing the line alone leaves it in the git history." : ""}</p>
          <form onSubmit={(e) => { e.preventDefault(); if (status) set.mutate({ id: f.id, status, note: note || undefined }, { onSuccess: onClose }); }} className="mt-2 flex flex-wrap items-end gap-3">
            <div className="w-48"><SelectField value={status} onChange={(v) => setStatus(v as FindingStatus | "")} options={[{ value: "", label: "— change status —" }, { value: "open", label: "Open" }, { value: "accepted", label: "Accepted (risk accepted)" }, { value: "false_positive", label: "False positive" }]} /></div>
            <input className={`${inputClass} min-w-60 flex-1`} placeholder="Reason (kept in the audit trail)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="submit" className={primaryButton} disabled={!status || set.isPending}>{set.isPending ? "Saving…" : "Save"}</button>
            <button type="button" className={outlineButton} onClick={onClose}>Close</button>
          </form>
          {set.error ? <div className="mt-2"><ErrorNotice error={set.error} /></div> : null}
        </div>
      </div>
    </Modal>
  );
}

/** Secrets and IaC findings: KPIs, filters, grouped by file. */
export function CodeFindingsPanel({ organizationId, projectId, serviceId }: { organizationId: string; projectId?: string; serviceId?: string }) {
  const [query, setQuery] = useState<CodeFindingQuery>({ status: ["open"] });
  const findings = useCodeFindings(organizationId, query, projectId);
  const summary = useCodeFindingSummary(organizationId, projectId);
  const [open, setOpen] = useState<CodeFindingRow | null>(null);
  const rows = useMemo(() => (findings.data ?? []).filter((f) => !serviceId || f.serviceId === serviceId), [findings.data, serviceId]);
  const byFile = useMemo(() => {
    const m = new Map<string, CodeFindingRow[]>();
    for (const f of rows) { const k = `${f.serviceName}::${f.file}`; m.set(k, [...(m.get(k) ?? []), f]); }
    return [...m.entries()].map(([k, list]) => ({ key: k, service: list[0].serviceName, file: list[0].file, kind: list[0].kind, list: list.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.startLine ?? 0) - (b.startLine ?? 0)) })).sort((a, b) => ORDER[a.list[0].severity] - ORDER[b.list[0].severity] || (a.kind === "secret" ? -1 : 0) - (b.kind === "secret" ? -1 : 0));
  }, [rows]);
  const s = summary.data;
  const total = (k: "secret" | "iac" | "sast") => (s ? Object.values(s[k]).reduce((a, b) => a + b, 0) : 0);
  const toggle = (key: "kind" | "severity" | "status", v: string) => { const list = query[key] ?? []; setQuery({ ...query, [key]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] }); };
  const chip = (active: boolean) => cn("rounded-full border px-2.5 py-1 text-xs font-medium transition", active ? "border-brand-500 bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400" : "border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-700 dark:text-gray-400");
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 px-6 pt-4 md:grid-cols-4">
        <Kpi label="Secrets in code" value={s ? total("secret") : "…"} tone={s && total("secret") ? "bad" : "good"} caption="rotate, then remove" />
        <Kpi label="IaC · critical/high" value={s ? s.iac.critical + s.iac.high : "…"} tone={s && s.iac.critical + s.iac.high ? "warn" : "good"} />
        <Kpi label="IaC · medium/low" value={s ? s.iac.medium + s.iac.low : "…"} />
        <Kpi label="Code (SAST) · critical/high" value={s ? (s.sast?.critical ?? 0) + (s.sast?.high ?? 0) : "…"} tone={s && (s.sast?.critical ?? 0) + (s.sast?.high ?? 0) ? "warn" : "good"} caption="Semgrep, from the pipeline's code job" />
        <Kpi label="Files affected" value={byFile.length} caption={`${rows.length} findings shown`} />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-6 py-3">
        <span className={`text-xs ${muted}`}>Type</span>
        {(["secret", "iac"] as const).map((k) => <button key={k} type="button" className={chip(!!query.kind?.includes(k))} onClick={() => toggle("kind", k)}>{KIND_LABEL[k]}</button>)}
        <span className={`ms-2 text-xs ${muted}`}>Severity</span>
        {(["critical", "high", "medium", "low"] as Severity[]).map((v) => <button key={v} type="button" className={chip(!!query.severity?.includes(v))} onClick={() => toggle("severity", v)}>{v}</button>)}
        <span className={`ms-2 text-xs ${muted}`}>Status</span>
        {(["open", "accepted", "fixed", "false_positive"] as FindingStatus[]).map((v) => <button key={v} type="button" className={chip(!!query.status?.includes(v))} onClick={() => toggle("status", v)}>{STATUS_LABEL[v]}</button>)}
        <input className={`${inputClass} ms-auto w-56`} placeholder="File, rule or title" value={query.q ?? ""} onChange={(e) => setQuery({ ...query, q: e.target.value || undefined })} aria-label="Search code findings" />
      </div>
      {findings.error ? <div className="p-4"><ErrorNotice error={findings.error} /></div> : byFile.length === 0 ? <EmptyState title="No code findings">Secrets and IaC checks run in the pipeline stages "secrets" and "iac" (runner with Trivy).</EmptyState> : (
        <div className="space-y-3 px-6 pb-6">
          {byFile.map((g) => (
            <div key={g.key} className="rounded-xl border border-gray-200 dark:border-gray-800">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5 dark:border-gray-800">
                <span className="min-w-0"><span className="font-mono text-sm font-medium text-gray-800 dark:text-white/90">{g.file}</span><span className={`ms-2 text-xs ${muted}`}>{g.service}</span></span>
                <FindingCounts counts={g.list.reduce<Record<Severity, number>>((a, f) => ({ ...a, [f.severity]: a[f.severity] + 1 }), { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 })} />
              </div>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {g.list.map((f) => (
                  <li key={f.id} className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-2 text-sm hover:bg-gray-50 dark:hover:bg-white/3" onClick={() => setOpen(f)}>
                    <span className="w-20 shrink-0"><SeverityBadge severity={f.severity} /></span>
                    <Badge size="sm" color={f.kind === "secret" ? "error" : "light"}>{KIND_LABEL[f.kind]}</Badge>
                    <span className="w-14 shrink-0 font-mono text-xs text-gray-500">{f.startLine ? `L${f.startLine}` : "—"}</span>
                    <span className="min-w-0 flex-1 truncate text-gray-800 dark:text-white/90" title={f.title}>{f.title}</span>
                    <span className={`font-mono text-[11px] ${muted}`}>{f.ruleId}</span>
                    <Badge size="sm" color={f.status === "open" ? "warning" : f.status === "fixed" ? "success" : "light"}>{STATUS_LABEL[f.status]}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {open && <CodeFindingDialog f={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
