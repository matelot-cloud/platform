import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { isForbidden } from "@/platform/api/client";
import { useAuditEvents, useFindingSummary, useMe, useOrganizationOverview, useProjects, useRiskRanking } from "@/platform/api/hooks";
import type { Criticality, Organization } from "@/platform/api/types";
import { Kpi, PipelineBar, PipelineLine, RunningCell } from "@/platform/components/Dashboard";
import { CoverageSummaryCard } from "@/platform/components/Coverage";
import { GetStarted } from "@/platform/components/GetStarted";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, EmptyState, ErrorNotice, linkButton, muted, RoleBadge, td, th, trBorder } from "@/platform/components/ui";
import { relativeTime, titleCase } from "@/platform/format";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { Link } from "react-router";

const CRITICALITIES: Criticality[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const CRIT_COLOR: Record<Criticality, "error" | "warning" | "primary" | "success"> = { CRITICAL: "error", HIGH: "warning", MEDIUM: "primary", LOW: "success" };

function Overview({ organization }: { organization: Organization }) {
  const overview = useOrganizationOverview(organization.id);
  const projects = useProjects(organization.id);
  const audit = useAuditEvents(organization.id, 8);
  const me = useMe();
  const vuln = useFindingSummary(organization.id);
  const risk = useRiskRanking(organization.id);
  const worst = (risk.data ?? []).find((r) => r.score !== null) ?? null;
  const o = overview.data;
  const projectRows = projects.data ?? [];
  const byCrit = CRITICALITIES.map((c) => ({ c, n: projectRows.filter((p) => p.criticality === c).length }));
  const myAccess = (me.data?.memberships ?? []).filter((m) => m.scope);
  const prodNoSbom = (o?.production ?? []).filter((d) => !d.hasSbom).length;

  return (
    <div className="space-y-6">
      {overview.error && !isForbidden(overview.error) ? <ErrorNotice error={overview.error} /> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6 md:gap-4">
        <Kpi label="Projects" value={o?.counts.projects ?? "…"} to="/projects" caption={o ? `${o.counts.workspaces} workspaces · ${o.counts.teams} teams` : undefined} />
        <Kpi label="Services" value={o?.counts.services ?? "…"} caption={o ? `${o.counts.environments} environments` : undefined} />
        <Kpi label="In production" value={o?.production.length ?? "…"} tone={prodNoSbom ? "warn" : "default"} caption={o ? `${o.counts.internetFacing} internet-facing${prodNoSbom ? ` · ${prodNoSbom} without SBOM` : ""}` : undefined} />
        <Kpi label="SBOM coverage" value={o ? `${o.sbom.coverage}%` : "…"} tone={o ? (o.sbom.coverage >= 80 ? "good" : o.sbom.coverage >= 40 ? "warn" : o.counts.services ? "bad" : "default") : "default"} to="/components" caption={o ? `${o.sbom.services} of ${o.counts.services} services · ${o.sbom.documents} documents` : undefined} />
        <Kpi label="Highest risk" value={worst ? `${worst.grade} · ${worst.score}` : risk.isLoading ? "…" : "—"} tone={worst && worst.score !== null ? (worst.score >= 60 ? "bad" : worst.score >= 30 ? "warn" : "good") : "default"} to="/risk" caption={worst ? `${worst.serviceName} · ${worst.projectName}` : "no scored service yet"} />
        <Kpi label="Critical/high in production" value={vuln.data ? vuln.data.production.critical + vuln.data.production.high : "…"} tone={vuln.data ? (vuln.data.production.critical + vuln.data.production.high ? "bad" : "good") : "default"} to="/vulnerabilities" caption={vuln.data ? `${vuln.data.open.critical + vuln.data.open.high} open critical/high · ${vuln.data.kev} known exploited` : undefined} />
      </div>

      <GetStarted organizationId={organization.id} />
      <CoverageSummaryCard organizationId={organization.id} />

      <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <Card title="Production right now" description="Every production environment in the organization and what runs there." flush>
            {!o ? <p className={`p-6 text-sm ${muted}`}>Loading…</p> : o.production.length === 0 ? (
              <EmptyState title="Nothing deployed to production yet">Deployments arrive from CI (<code>matelot promote</code>, <code>matelot deploy</code>), from the registry, or from Kubernetes.</EmptyState>
            ) : (
              <table className="min-w-full">
                <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Service</th><th className={th}>Project</th><th className={th}>Running</th><th className={th}>Exposure</th></tr></thead>
                <tbody>
                  {o.production.map((d) => (
                    <tr key={d.deploymentId} className={trBorder}>
                      <td className={td}><Link to={`/projects/${d.projectId}/inventory`} className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{d.serviceName}</Link><span className={`block text-xs ${muted}`}>{d.environmentName}</span></td>
                      <td className={td}><Link to={`/projects/${d.projectId}`} className="text-sm text-gray-700 hover:text-brand-500 dark:text-gray-300">{d.projectName}</Link> <Badge size="sm" color={CRIT_COLOR[d.projectCriticality]}>{titleCase(d.projectCriticality)}</Badge></td>
                      <td className={td}><RunningCell current={{ version: d.version, imageRef: d.imageRef, deployedAt: d.deployedAt, source: d.source, hasSbom: d.hasSbom }} /></td>
                      <td className={td}>{d.internetFacing ? <Badge size="sm" color="warning">internet-facing</Badge> : <span className={`text-xs ${muted}`}>internal</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
        <div className="space-y-4 md:space-y-6 xl:col-span-5">
          <Card title="Pipelines" description={o ? `last 24 hours · ${o.pipelines24h.running} running` : undefined} flush>
            <div className="px-6 pt-4 pb-2"><PipelineBar succeeded={o?.pipelines24h.succeeded ?? 0} failed={o?.pipelines24h.failed ?? 0} running={o?.pipelines24h.running ?? 0} total={o?.pipelines24h.total ?? 0} /></div>
            {!o || o.recentPipelines.length === 0 ? <EmptyState title="No pipeline yet" /> : <div className="divide-y divide-gray-100 dark:divide-gray-800">{o.recentPipelines.slice(0, 6).map((x) => <PipelineLine key={x.id} p={x} to={`/projects/${x.projectId}/pipelines/${x.id}`} />)}</div>}
          </Card>
          <Card title="Projects by criticality" flush>
            {projectRows.length === 0 ? <EmptyState title="No projects yet" /> : (
              <ul className="px-6 py-3">
                {byCrit.map(({ c, n }) => (
                  <li key={c} className="flex items-center gap-3 py-1.5 text-sm">
                    <span className="w-16"><Badge size="sm" color={CRIT_COLOR[c]}>{titleCase(c)}</Badge></span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"><span className={`block h-full ${{ CRITICAL: "bg-error-500", HIGH: "bg-warning-500", MEDIUM: "bg-brand-500", LOW: "bg-success-500" }[c]}`} style={{ width: `${projectRows.length ? (n / projectRows.length) * 100 : 0}%` }} /></span>
                    <span className={`w-6 text-end ${muted}`}>{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-12">
        <div className="xl:col-span-5">
          <Card title="Your access" flush>
            {myAccess.length === 0 ? <EmptyState title="No roles yet">Someone with member management on this organization can grant you a role.</EmptyState> : (
              <ul className="px-6 py-2">
                {myAccess.map((m) => <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-sm"><span><RoleBadge role={m.role} /> <span className={`ms-2 capitalize ${muted}`}>{m.scopeType.toLowerCase()}</span></span><span className="text-gray-800 dark:text-white/90">{m.scope?.name}</span></li>)}
              </ul>
            )}
          </Card>
        </div>
        <div className="xl:col-span-7">
          <Card title="Recent activity" flush actions={(audit.data ?? []).length > 0 && <Link to="/audit" className={linkButton}>Full audit trail</Link>}>
            {isForbidden(audit.error) ? <EmptyState title="Not visible with your role">The audit trail is available to organization administrators, security administrators and auditors.</EmptyState> : audit.error ? <div className="p-4"><ErrorNotice error={audit.error} /></div> : (audit.data ?? []).length === 0 ? <EmptyState title="Nothing recorded yet" /> : (
              <ul>
                {(audit.data ?? []).map((e) => (
                  <li key={e.id} className={`px-6 py-2.5 ${trBorder}`}>
                    <p className="text-sm text-gray-800 dark:text-white/90"><span className="font-medium">{e.action}</span> <span className={`text-xs ${muted}`}>· {e.actorType === "USER" ? e.actorLabel : e.actorLabel ?? e.actorType.toLowerCase()} · {relativeTime(e.createdAt)}{e.reason ? ` · ${e.reason}` : ""}</span></p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Overview · ${productName}`} description="Organization overview" />
      <OrganizationGate>{(organization) => <Overview organization={organization} />}</OrganizationGate>
    </>
  );
}
