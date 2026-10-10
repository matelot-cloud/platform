import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { isForbidden } from "@/platform/api/client";
import { useUsage, useUsageCsv } from "@/platform/api/hooks";
import type { Organization, UsageMetrics } from "@/platform/api/types";
import { Kpi } from "@/platform/components/Dashboard";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, EmptyState, ErrorNotice, inputClass, muted, outlineButton, td, th, trBorder } from "@/platform/components/ui";
import { formatDate } from "@/platform/format";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { useState } from "react";

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 1 }));
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function Tiles({ m }: { m: UsageMetrics }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <Kpi label="Active seats" value={n(m.seats.active)} caption={m.seats.active === null ? "not tracked yet that month" : `of ${n(m.seats.members)} members used the platform`} />
      <Kpi label="Runner minutes" value={n(m.runnerMinutes)} caption={`${n(m.jobs)} jobs finished${m.runnerMinutesManaged ? ` · ${n(m.runnerMinutesManaged)} on managed runners` : ""}`} />
      <Kpi label="Pipelines" value={n(m.pipelines)} caption="started this month" />
      <Kpi label="SBOMs" value={n(m.sboms)} caption="generated or uploaded" />
      <Kpi label="Projects" value={n(m.projects)} caption="not archived" />
      <Kpi label="Services" value={n(m.services)} />
      <Kpi label="Environments" value={n(m.environments)} />
      <Kpi label="Members" value={n(m.seats.members)} caption="with a role in this organization" />
    </div>
  );
}

function Usage({ organization }: { organization: Organization }) {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const usage = useUsage(organization.id, month);
  const csv = useUsageCsv(organization.id);
  if (isForbidden(usage.error)) return <Card flush><EmptyState title="Not visible with your role">Usage is available to organization administrators, security administrators, compliance officers and auditors.</EmptyState></Card>;
  if (usage.error) return <ErrorNotice error={usage.error} />;
  if (!usage.data) return <p className={`text-sm ${muted}`}>Loading…</p>;
  const r = usage.data;
  const byType = Object.entries(r.metrics.runnerMinutesByType).sort((a, b) => b[1] - a[1]);
  const download = () => csv.mutate(r.month, { onSuccess: (blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `usage-${r.month}.csv`; a.click(); URL.revokeObjectURL(a.href); } });

  return (
    <div className="space-y-6">
      <Card
        title={<span className="flex items-center gap-2">Usage · {monthLabel(r.month)} {r.live ? <Badge size="sm" color="info">live</Badge> : <Badge size="sm" color="light">snapshot</Badge>}</span>}
        description={`Calendar month in UTC. ${r.live ? "Computed now" : `Snapshot of ${formatDate(r.computedAt)}`}. Seats are members who used the platform this month; CI tokens and runners are not seats.`}
        actions={
          <div className="flex items-center gap-2">
            <select aria-label="Month" className={`${inputClass} w-44`} value={r.month} onChange={(e) => setMonth(e.target.value)}>
              {r.history.map((h) => <option key={h.month} value={h.month}>{monthLabel(h.month)}</option>)}
            </select>
            <button type="button" className={outlineButton} disabled={csv.isPending} onClick={download}>{csv.isPending ? "Preparing…" : "Download CSV"}</button>
          </div>
        }
      >
        <Tiles m={r.metrics} />
        {csv.error ? <div className="mt-4"><ErrorNotice error={csv.error} /></div> : null}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Runner minutes by job type" description="Jobs run by a runner: finished minus started." flush className="lg:col-span-1">
          {byType.length === 0 ? <EmptyState title="No runner time this month" /> : (
            <table className="min-w-full">
              <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Job type</th><th className={`${th} text-end`}>Minutes</th></tr></thead>
              <tbody>{byType.map(([type, minutes]) => <tr key={type} className={trBorder}><td className={td}>{type}</td><td className={`${td} text-end tabular-nums`}>{n(minutes)}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
        <Card title="History" description="Past months are kept as snapshots (final once the month is over)." flush className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="border-b border-gray-100 dark:border-gray-800">
                <tr>{["Month", "Active seats", "Members", "Runner min", "Pipelines", "Jobs", "SBOMs", "Services"].map((h, i) => <th key={h} className={`${th} ${i ? "text-end" : ""}`}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {r.history.map((h) => (
                  <tr key={h.month} className={`${trBorder} cursor-pointer hover:bg-gray-50 dark:hover:bg-white/2 ${h.month === r.month ? "bg-brand-50/50 dark:bg-brand-500/5" : ""}`} onClick={() => setMonth(h.month)}>
                    <td className={td}>{monthLabel(h.month)} {!h.final && h.month !== r.month && <span className={`text-xs ${muted}`}>(in progress)</span>}</td>
                    {[h.metrics.seats.active, h.metrics.seats.members, h.metrics.runnerMinutes, h.metrics.pipelines, h.metrics.jobs, h.metrics.sboms, h.metrics.services].map((v, i) => <td key={i} className={`${td} text-end tabular-nums`}>{n(v)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function UsagePage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Usage · ${productName}`} description="Seats, runner minutes and activity per month" />
      <PageBreadcrumb pageTitle="Usage" />
      <OrganizationGate>{(organization) => <Usage key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
