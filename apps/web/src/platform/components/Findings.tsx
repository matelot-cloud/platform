import { CodeBlock } from "./CodeBlock";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { useFinding, useSetFindingStatus, type FindingQuery } from "@/platform/api/hooks";
import { ExceptionDialog } from "./ExceptionsPanel";
import type { FindingRow, FindingStatus, Severity } from "@/platform/api/types";
import { formatDate, relativeTime } from "@/platform/format";
import { cn } from "@/utils";
import { useState } from "react";
import { Link } from "react-router";
import { EnvironmentBadge } from "./Dashboard";
import { EmptyState, ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField, td, th, trBorder } from "./ui";

export const SEVERITY_COLOR: Record<Severity, "error" | "warning" | "primary" | "success" | "light"> = { critical: "error", high: "warning", medium: "primary", low: "success", unknown: "light" };
export const STATUS_LABEL: Record<FindingStatus, string> = { open: "Open", fixed: "Fixed", accepted: "Accepted", false_positive: "False positive", not_affected: "Not affected" };

export function SeverityBadge({ severity, score }: { severity: Severity; score?: number | null }) {
  return <span className="inline-flex items-center gap-1.5"><Badge size="sm" color={SEVERITY_COLOR[severity]}>{severity}</Badge>{typeof score === "number" && <span className={`text-xs ${muted}`}>{score.toFixed(1)}</span>}</span>;
}

/** Filter bar shared by the organization and project pages. */
export function FindingFilters({ value, onChange, showRunning = true }: { value: FindingQuery; onChange: (q: FindingQuery) => void; showRunning?: boolean }) {
  const toggle = (key: "severity" | "status", v: string) => { const list = value[key] ?? []; onChange({ ...value, [key]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] }); };
  const chip = (active: boolean) => cn("rounded-full border px-2.5 py-1 text-xs font-medium transition", active ? "border-brand-500 bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400" : "border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-700 dark:text-gray-400");
  return (
    <div className="flex flex-wrap items-center gap-2 px-6 py-3">
      <span className={`text-xs ${muted}`}>Severity</span>
      {(["critical", "high", "medium", "low"] as Severity[]).map((s) => <button key={s} type="button" className={chip(!!value.severity?.includes(s))} onClick={() => toggle("severity", s)}>{s}</button>)}
      <span className={`ms-2 text-xs ${muted}`}>Status</span>
      {(["open", "accepted", "fixed", "false_positive", "not_affected"] as FindingStatus[]).map((s) => <button key={s} type="button" className={chip(!!value.status?.includes(s))} onClick={() => toggle("status", s)}>{STATUS_LABEL[s]}</button>)}
      <button type="button" className={chip(!!value.kev)} onClick={() => onChange({ ...value, kev: !value.kev })}>Known exploited</button>
      {showRunning && <button type="button" className={chip(!!value.running)} onClick={() => onChange({ ...value, running: !value.running })}>Running somewhere</button>}
      <input className={`${inputClass} ms-auto w-56`} placeholder="CVE, GHSA or package" value={value.q ?? ""} onChange={(e) => onChange({ ...value, q: e.target.value || undefined })} aria-label="Search findings" />
    </div>
  );
}

export function FindingsTable({ rows, onOpen, showProject = true }: { rows: FindingRow[]; onOpen: (id: string) => void; showProject?: boolean }) {
  if (!rows.length) return <EmptyState title="No findings match">Findings appear once SBOMs exist and the correlation has run (every 10 minutes, and right after each SBOM).</EmptyState>;
  return (
    <table className="min-w-full">
      <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Severity</th><th className={th}>Advisory</th><th className={th}>Component</th><th className={th}>Service</th><th className={th}>Runs in</th><th className={th}>Fix</th><th className={th}>Status</th></tr></thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f.id} className={`${trBorder} cursor-pointer hover:bg-gray-50 dark:hover:bg-white/2`} onClick={() => onOpen(f.id)}>
            <td className={td}><span title={[f.severitySource ? `severity from ${f.severitySource}` : null, f.severityNote].filter(Boolean).join(" · ") || undefined}><SeverityBadge severity={f.severity} score={f.severitySource === "distro" ? null : f.advisory.cvssScore} /></span>{f.severitySource === "distro" && <span className={`ms-1 text-[11px] ${muted}`}>{f.severityNote}{f.advisory.cvssScore ? ` (CVSS ${f.advisory.cvssScore.toFixed(1)})` : ""}</span>}{f.advisory.kev && <Badge size="sm" color="error">KEV</Badge>}{typeof f.advisory.epssScore === "number" && f.advisory.epssScore >= 0.1 && <span className={`block text-[11px] ${muted}`}>EPSS {(f.advisory.epssScore * 100).toFixed(0)}%</span>}</td>
            <td className={td}><span className="font-mono text-sm text-gray-800 dark:text-white/90">{f.advisory.aliases.find((a) => a.startsWith("CVE-")) ?? f.advisory.id}</span><span className={`block max-w-md truncate text-xs ${muted}`} title={f.advisory.summary ?? ""}>{f.advisory.summary ?? f.advisory.id}</span></td>
            <td className={td}><span className="font-medium text-gray-800 dark:text-white/90">{f.component.namespace ? `${f.component.namespace}/` : ""}{f.component.name}</span><span className={`block font-mono text-xs ${muted}`}>{f.component.version} · {f.component.type}</span></td>
            <td className={td}><span className="text-sm text-gray-800 dark:text-white/90">{f.serviceName}</span>{showProject && <span className={`block text-xs ${muted}`}>{f.projectName}</span>}</td>
            <td className={td}>{f.environments.length ? <span className="flex flex-wrap gap-1">{f.environments.map((e) => <EnvironmentBadge key={e.id} name={e.name} kind={e.kind} internetFacing={e.internetFacing} />)}</span> : <span className={`text-xs ${muted}`}>not running</span>}</td>
            <td className={`${td} font-mono text-xs`}>{f.fixedVersion ? <span className="text-success-600">{f.fixedVersion}</span> : <span className={muted}>no fix known</span>}</td>
            <td className={td}><Badge size="sm" color={f.status === "open" ? "warning" : f.status === "fixed" ? "success" : "light"}>{STATUS_LABEL[f.status]}</Badge></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Finding window: advisory, exposure, affected releases/images, status with note. */
export function FindingDialog({ findingId, onClose }: { findingId: string; onClose: () => void }) {
  const finding = useFinding(findingId);
  const setStatus = useSetFindingStatus();
  const [status, setStatusValue] = useState<FindingStatus | "">("");
  const [note, setNote] = useState("");
  const [exception, setException] = useState(false);
  const f = finding.data;
  return (
    <Modal isOpen onClose={onClose} className="max-w-240 p-6 lg:p-8" title={f ? <span className="font-mono">{f.advisory.id}</span> : "Finding"} description={f && f.advisory.aliases.length ? f.advisory.aliases.join(" · ") : undefined}>
      {finding.error ? <ErrorNotice error={finding.error} /> : !f ? <p className={`text-sm ${muted}`}>Loading…</p> : (
        <div className="space-y-5">
          <div>
            <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={f.severity} score={f.severitySource === "distro" ? null : f.advisory.cvssScore} />{f.severitySource && <span className={`text-xs ${muted}`}>{f.severitySource === "distro" ? `${f.severityNote ?? "distribution rating"}${f.advisory.cvssScore ? ` (CVSS ${f.advisory.cvssScore.toFixed(1)})` : ""}` : f.severitySource === "cvss" ? "from CVSS" : f.severitySource === "database" ? "from the advisory rating" : f.severitySource === "alias" ? "from the CVE / GHSA alias CVSS" : "not rated"}{f.severitySource !== "distro" && f.severityNote ? ` · ${f.severityNote}` : ""}</span>}{f.advisory.kev && <Badge size="sm" color="error">Known exploited{f.advisory.kevDueDate ? ` · due ${formatDate(f.advisory.kevDueDate)}` : ""}</Badge>}<Badge size="sm" color={f.status === "open" ? "warning" : f.status === "fixed" ? "success" : "light"}>{STATUS_LABEL[f.status]}</Badge></div>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{f.advisory.summary}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><p className={`text-xs ${muted}`}>Component</p><p className="font-medium text-gray-800 dark:text-white/90">{f.component.namespace ? `${f.component.namespace}/` : ""}{f.component.name}</p><p className={`font-mono text-xs ${muted}`}>{f.component.version}</p></div>
            <div><p className={`text-xs ${muted}`}>Fixed in</p><p className="font-mono text-gray-800 dark:text-white/90">{f.fixedVersion ?? "no fix known"}</p></div>
            <div><p className={`text-xs ${muted}`}>EPSS</p><p className="text-gray-800 dark:text-white/90">{typeof f.advisory.epssScore === "number" ? `${(f.advisory.epssScore * 100).toFixed(1)}% (p${Math.round((f.advisory.epssPercentile ?? 0) * 100)})` : "—"}</p></div>
            <div><p className={`text-xs ${muted}`}>Seen</p><p className="text-gray-800 dark:text-white/90">{relativeTime(f.firstSeenAt)}{f.resolvedAt ? ` → resolved ${relativeTime(f.resolvedAt)}` : ""}</p></div>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-white/90">Where it runs</p>
            {f.environments.length ? <div className="mt-1 flex flex-wrap gap-2">{f.environments.map((e) => <EnvironmentBadge key={e.id} name={e.name} kind={e.kind} internetFacing={e.internetFacing} />)}</div> : <p className={`text-sm ${muted}`}>Not running in any environment right now ({f.serviceName}, {f.projectName}).</p>}
          </div>
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-white/90">Affected releases and images</p>
            <ul className={`mt-1 flex flex-wrap gap-2 text-xs ${muted}`}>{f.affected.map((a) => <li key={a.sbomId}><Link to={`/projects/${f.projectId}/sboms/${a.sbomId}`} className="rounded-md bg-gray-100 px-2 py-1 font-mono text-gray-700 hover:text-brand-500 dark:bg-white/5 dark:text-gray-300">{a.releaseVersion ? `release ${a.releaseVersion}` : a.targetRef.length > 40 ? "…" + a.targetRef.slice(-38) : a.targetRef}</Link></li>)}</ul>
          </div>
          {f.advisory.details && <details><summary className={`cursor-pointer text-sm font-medium text-gray-800 dark:text-white/90`}>Details</summary><p className={`mt-1 text-sm whitespace-pre-wrap ${muted}`}>{f.advisory.details.slice(0, 3000)}</p></details>}
          {f.advisory.cvssVector && <CodeBlock code={f.advisory.cvssVector} lines={false} />}
          {f.advisory.references.length > 0 && <p className={`text-xs ${muted}`}>References: {f.advisory.references.slice(0, 6).map((r) => <a key={r.url} href={r.url} target="_blank" rel="noreferrer" className="me-2 text-brand-500 hover:underline">{r.type.toLowerCase()}</a>)}</p>}
          <div className="border-t border-gray-100 pt-4 dark:border-gray-800">
            <p className="text-sm font-medium text-gray-800 dark:text-white/90">Decision</p>
            <p className={`text-xs ${muted}`}>"Fixed" is set by the platform when the vulnerable version disappears from current builds and deployments. Decisions are audited{f.note ? ` · current note: "${f.note}"` : ""}.</p>
            <form onSubmit={(e) => { e.preventDefault(); if (status) setStatus.mutate({ findingId, status, note: note || undefined }, { onSuccess: () => { setStatusValue(""); setNote(""); } }); }} className="mt-2 flex flex-wrap items-end gap-3">
              <div className="w-48"><SelectField value={status} onChange={(v) => setStatusValue(v as FindingStatus | "")} options={[{ value: "", label: "— change status —" }, { value: "open", label: "Open" }, { value: "accepted", label: "Accepted (risk accepted)" }, { value: "false_positive", label: "False positive" }, { value: "not_affected", label: "Not affected (VEX)" }]} /></div>
              <input className={`${inputClass} min-w-60 flex-1`} placeholder="Reason (kept in the audit trail)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="submit" className={primaryButton} disabled={!status || setStatus.isPending}>{setStatus.isPending ? "Saving…" : "Save"}</button>
              <button type="button" className={outlineButton} onClick={onClose}>Close</button>
            </form>
            {setStatus.error ? <div className="mt-2"><ErrorNotice error={setStatus.error} /></div> : null}
            <p className={`mt-3 text-xs ${muted}`}>Prefer a decision that ends on its own? <button type="button" className="text-brand-500 hover:underline" onClick={() => setException(true)}>Create a time-boxed exception</button> for this advisory in this service — it reopens automatically on the date and shows up in the audit trail with the reason.</p>
            {exception && <ExceptionDialog scope={{ type: "service", id: f.serviceId, name: f.serviceName ?? "service" }} initial={{ kind: "vulnerability", matchId: f.advisory.id, matchComponent: f.component.name }} onClose={() => setException(false)} />}
          </div>
        </div>
      )}
    </Modal>
  );
}
