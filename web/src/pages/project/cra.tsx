import Badge from "@/components/ui/badge/Badge";
import { useEvidenceDownload, useProjectReadiness, useReleases } from "@/platform/api/hooks";
import type { Readiness, ReadinessCheck } from "@/platform/api/types";
import { Card, EmptyState, ErrorNotice, muted, outlineButton, td, th, trBorder } from "@/platform/components/ui";
import { formatDate, relativeTime } from "@/platform/format";
import { cn } from "@/utils";
import { useState } from "react";
import { useProject } from "./layout";

const STATUS: Record<ReadinessCheck["status"], { color: "success" | "warning" | "error" | "light"; label: string }> = { pass: { color: "success", label: "pass" }, warn: { color: "warning", label: "attention" }, fail: { color: "error", label: "fail" }, na: { color: "light", label: "n/a" } };
const GRADE: Record<Readiness["grade"], { color: "success" | "warning" | "error"; label: string }> = { ready: { color: "success", label: "ready" }, almost: { color: "warning", label: "almost ready" }, not_ready: { color: "error", label: "not ready" } };

function ServiceReadiness({ r }: { r: Readiness }) {
  const [open, setOpen] = useState(r.grade !== "ready");
  return (
    <Card flush>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-4 px-6 py-4 text-start">
        <span className="flex items-center gap-3"><span className="text-base font-semibold text-gray-800 dark:text-white/90">{r.serviceName}</span><Badge size="sm" color={GRADE[r.grade].color}>{GRADE[r.grade].label}</Badge></span>
        <span className="flex items-center gap-4"><span className={`text-sm ${muted}`}>{r.checks.filter((c) => c.status === "pass").length} of {r.checks.filter((c) => c.status !== "na").length} checks pass</span><span className={cn("text-2xl font-semibold", r.grade === "ready" ? "text-success-600" : r.grade === "almost" ? "text-warning-600" : "text-error-500")}>{r.score}</span><span className={muted}>{open ? "▾" : "▸"}</span></span>
      </button>
      {open && (
        <ul className="divide-y divide-gray-100 border-t border-gray-100 dark:divide-gray-800 dark:border-gray-800">
          {r.checks.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start gap-4 px-6 py-3">
              <Badge size="sm" color={STATUS[c.status].color}>{STATUS[c.status].label}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-800 dark:text-white/90">{c.title}</span>
                <span className={`block text-xs ${muted}`}>{c.requirement}</span>
                <span className="mt-1 block text-sm text-gray-700 dark:text-gray-300">{c.detail}</span>
                {c.fix && c.status !== "pass" && <span className="mt-1 block text-sm text-brand-500">→ {c.fix}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Evidence({ serviceId, serviceName }: { serviceId: string; serviceName: string }) {
  const releases = useReleases(serviceId);
  const download = useEvidenceDownload();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const rows = (releases.data ?? []).slice(0, 10);
  if (!rows.length) return null;
  return (
    <Card title={`Evidence · ${serviceName}`} description="One signed bundle per release: what shipped (images, SBOMs), what was known (findings, KEV/EPSS), what was decided (statuses, exceptions), what was enforced (policies, gate evaluations), where it ran. Verify with `matelot evidence verify`." flush>
      <table className="min-w-full">
        <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Release</th><th className={th}>Commit</th><th className={th}>When</th><th className={th} /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={trBorder}>
              <td className={td}><span className="font-medium text-gray-800 dark:text-white/90">{r.version}</span>{r.tag && <span className={`ms-2 text-xs ${muted}`}>{r.tag}</span>}</td>
              <td className={`${td} font-mono text-xs ${muted}`}>{r.commitSha?.slice(0, 10) ?? "—"}</td>
              <td className={`${td} text-xs ${muted}`}>{r.releasedAt ? `${formatDate(r.releasedAt)} · ${relativeTime(r.releasedAt)}` : relativeTime(r.createdAt)}</td>
              <td className={`${td} text-end`}><button type="button" className={outlineButton} disabled={busy === r.id} onClick={async () => { setBusy(r.id); setError(null); try { await download(r.id, `evidence-${serviceName.toLowerCase().replace(/\s+/g, "-")}-${r.version}.zip`); } catch (e) { setError(e); } finally { setBusy(null); } }}>{busy === r.id ? "Preparing…" : "Download evidence"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <div className="p-4"><ErrorNotice error={error} /></div> : null}
    </Card>
  );
}

export function CraBody({ scope, focusServiceId }: { scope: string; focusServiceId?: string | null }) {
  const readiness = useProjectReadiness(scope);
  const list = (readiness.data ?? []).filter((r) => !focusServiceId || r.serviceId === focusServiceId);
  return (
    <div className="space-y-6">
      <Card title="CRA readiness" description="Does the evidence the Cyber Resilience Act expects exist, and is the product in a shippable state? Each check names the requirement it maps to and what to do. Scores: pass = 1, attention = ½, fail = 0.">
        {readiness.error ? <ErrorNotice error={readiness.error} /> : list.length === 0 ? <EmptyState title="No services yet" /> : <div className="space-y-4">{list.map((r) => <ServiceReadiness key={r.serviceId} r={r} />)}</div>}
      </Card>
      {list.map((r) => <Evidence key={r.serviceId} serviceId={r.serviceId} serviceName={r.serviceName} />)}
    </div>
  );
}

export default function ProjectCraPage() {
  const { project, services, focusService } = useProject();
  return <CraBody scope={project.id} focusServiceId={focusService && services.length > 1 ? focusService.id : null} />;
}
