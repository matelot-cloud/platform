import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { isForbidden } from "@/platform/api/client";
import { useRecomputeRisk, useRiskRanking } from "@/platform/api/hooks";
import type { Organization, RiskGrade } from "@/platform/api/types";
import { Kpi } from "@/platform/components/Dashboard";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { RiskBar, RiskFactorList, RiskGradeTile } from "@/platform/components/Risk";
import { Card, CriticalityBadge, EmptyState, ErrorNotice, muted, outlineButton, td, th, trBorder } from "@/platform/components/ui";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { useState } from "react";
import { Link } from "react-router";

export function RiskPage({ organization, scope }: { organization: Organization; scope?: string }) {
  const ranking = useRiskRanking(organization.id, scope);
  const recompute = useRecomputeRisk(organization.id);
  const [open, setOpen] = useState<string | null>(null);
  const rows = ranking.data ?? [];
  const scored = rows.filter((r) => r.score !== null);
  const avg = scored.length ? Math.round(scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length) : null;
  const grades = scored.reduce<Record<RiskGrade, number>>((acc, r) => ({ ...acc, [r.grade!]: (acc[r.grade!] ?? 0) + 1 }), { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 });
  const worst = scored[0] ?? null;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Kpi label="Average risk" value={avg ?? "…"} tone={avg === null ? "default" : avg >= 50 ? "bad" : avg >= 30 ? "warn" : "good"} caption={`${scored.length} of ${rows.length} services scored`} />
        <Kpi label="Services at D–F" value={grades.D + grades.E + grades.F} tone={grades.D + grades.E + grades.F ? "bad" : "good"} caption={`A ${grades.A} · B ${grades.B} · C ${grades.C}`} />
        <Kpi label="Highest risk" value={worst ? `${worst.grade} · ${worst.score}` : "…"} tone={worst && worst.score! >= 50 ? "bad" : "default"} caption={worst ? `${worst.serviceName} · ${worst.projectName}` : undefined} />
        <Kpi label="Improving / worsening (7 d)" value={`${scored.filter((r) => (r.delta7d ?? 0) < 0).length} / ${scored.filter((r) => (r.delta7d ?? 0) > 0).length}`} caption="services with a lower / higher score than a week ago" />
      </div>
      <Card title="Services by risk" description="Score 0–100 from open findings (severity, KEV, EPSS, fix available, age), their exposure (production, internet-facing), project criticality and scanning hygiene. Click a row for the breakdown." flush actions={<button type="button" className={outlineButton} disabled={recompute.isPending} onClick={() => recompute.mutate()}>{recompute.isPending ? "Computing…" : "Recompute now"}</button>}>
        {isForbidden(ranking.error) ? <EmptyState title="Not visible with your role" /> : ranking.error ? <div className="p-4"><ErrorNotice error={ranking.error} /></div> : rows.length === 0 ? <EmptyState title="No services yet" /> : (
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Grade</th><th className={th}>Service</th><th className={th}>Score</th><th className={th}>7 days</th><th className={th}>Open findings</th><th className={th}>Exposure</th></tr></thead>
            <tbody>
              {rows.map((r) => [
                <tr key={r.serviceId} className={`${trBorder} cursor-pointer hover:bg-gray-50 dark:hover:bg-white/2`} onClick={() => setOpen(open === r.serviceId ? null : r.serviceId)}>
                  <td className={td}><RiskGradeTile grade={r.grade} score={r.score} size="sm" /></td>
                  <td className={td}><Link to={`/projects/${r.projectId}/graph?service=${r.serviceId}`} className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90" onClick={(e) => e.stopPropagation()}>{r.serviceName}</Link><span className={`block text-xs ${muted}`}>{r.projectName} · {r.teamName} <CriticalityBadge value={r.serviceCriticality ?? r.projectCriticality} /></span></td>
                  <td className={td}><RiskBar score={r.score} grade={r.grade} /></td>
                  <td className={td}>{r.delta7d === null ? <span className={`text-xs ${muted}`}>—</span> : <Badge size="sm" color={r.delta7d > 0 ? "error" : r.delta7d < 0 ? "success" : "light"}>{r.delta7d > 0 ? `+${r.delta7d}` : r.delta7d}</Badge>}</td>
                  <td className={`${td} text-xs ${muted}`}>{r.factors ? `${r.factors.counts.critical} crit · ${r.factors.counts.high} high · ${r.factors.counts.medium} med${r.factors.counts.kev ? ` · ${r.factors.counts.kev} KEV` : ""}` : "not scored"}</td>
                  <td className={`${td} text-xs ${muted}`}>{r.factors ? `${r.factors.counts.inProduction} in prod · ${r.factors.counts.internetFacing} internet-facing` : "—"}</td>
                </tr>,
                open === r.serviceId && r.factors && <tr key={`${r.serviceId}-x`} className={trBorder}><td colSpan={6} className="bg-gray-50/60 px-6 py-4 dark:bg-white/2"><RiskFactorList factors={r.factors} /></td></tr>,
              ])}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export default function RiskIndexPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Risk · ${productName}`} description="Risk across services" />
      <PageBreadcrumb pageTitle="Risk" />
      <OrganizationGate>{(organization) => <RiskPage key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
