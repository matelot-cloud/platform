import { isForbidden } from "@/platform/api/client";
import { useAuditEvents, useFindingSummary, useProjectIntegrations, useProjectOverview, useProjectRepositories } from "@/platform/api/hooks";
import { EnvironmentBadge, Kpi, PipelineBar, PipelineLine, RunningCell } from "@/platform/components/Dashboard";
import { Card, EmptyState, linkButton, muted, td, th, trBorder } from "@/platform/components/ui";
import { relativeTime } from "@/platform/format";
import { Link } from "react-router";
import { useProject } from "./layout";

export default function ProjectOverviewPage() {
  const { organization, project } = useProject();
  const overview = useProjectOverview(project.id);
  const repositories = useProjectRepositories(project.id);
  const integrations = useProjectIntegrations(project.id);
  const audit = useAuditEvents(organization.id, 40);
  const vuln = useFindingSummary(organization.id, project.id);
  const o = overview.data;
  const attached = (repositories.data ?? []).filter((r) => r.services.some((s) => s.projectId === project.id));
  const serviceIds = new Set((o?.services ?? []).map((s) => s.id));
  const activity = (audit.data ?? []).filter((e) => e.resourceId === project.id || serviceIds.has(e.resourceId)).slice(0, 8);
  const p = `/projects/${project.id}`;
  const setupDone = !!o && o.services.length > 0 && attached.length > 0 && o.environments.length > 0;
  const prodEnvs = (o?.environments ?? []).filter((e) => e.kind === "production");
  const prodWithoutSbom = prodEnvs.filter((e) => e.current && !e.current.hasSbom).length;
  const pipeRate = o && o.stats.pipelines.total ? Math.round((o.stats.pipelines.succeeded / o.stats.pipelines.total) * 100) : null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6 md:gap-4">
        <Kpi label="Services" value={o?.stats.services ?? "…"} to={`${p}/services`} caption={`${attached.length} repositories attached`} />
        <Kpi label="Environments" value={o?.stats.environments ?? "…"} to={`${p}/environments`} caption={o ? `${prodEnvs.length} production · ${o.stats.internetFacing} internet-facing` : undefined} />
        <Kpi label="In production" value={o ? prodEnvs.filter((e) => e.current).length : "…"} tone={prodWithoutSbom ? "warn" : "default"} to={`${p}/inventory`} caption={o ? (prodWithoutSbom ? `${prodWithoutSbom} without SBOM` : "all with SBOM") : undefined} />
        <Kpi label="Releases" value={o?.stats.releases ?? "…"} to={`${p}/inventory`} caption={o ? `${o.stats.images} image tags` : undefined} />
        <Kpi label="Vulnerabilities" value={vuln.data ? vuln.data.open.critical + vuln.data.open.high : "…"} tone={vuln.data ? (vuln.data.production.critical + vuln.data.production.high ? "bad" : vuln.data.open.critical + vuln.data.open.high ? "warn" : "good") : "default"} to={`${p}/vulnerabilities`} caption={vuln.data ? `critical/high open · ${vuln.data.production.critical + vuln.data.production.high} in production · ${vuln.data.kev} KEV` : undefined} />
        <Kpi label="Pipeline success" value={pipeRate === null ? "—" : `${pipeRate}%`} tone={pipeRate === null ? "default" : pipeRate >= 90 ? "good" : pipeRate >= 60 ? "warn" : "bad"} to={`${p}/pipelines`} caption={o ? `${o.stats.pipelines.total} runs · ${o.stats.pipelines.failed} failed` : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <Card title="Running now" description="What each environment runs, per service." flush actions={<Link to={`${p}/environments`} className={linkButton}>Environments</Link>}>
            {!o ? <p className={`p-6 text-sm ${muted}`}>Loading…</p> : o.environments.length === 0 ? (
              <EmptyState title="No environment yet"><Link to={`${p}/environments`} className="text-brand-500 hover:underline">Declare where each service runs</Link> — the platform then tracks what is deployed there.</EmptyState>
            ) : (
              <table className="min-w-full">
                <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Service</th><th className={th}>Environment</th><th className={th}>Running</th></tr></thead>
                <tbody>
                  {o.services.map((s) => o.environments.filter((e) => e.serviceId === s.id).map((e, i, arr) => (
                    <tr key={e.id} className={trBorder}>
                      {i === 0 && <td className={`${td} align-top`} rowSpan={arr.length}><Link to={`${p}/inventory`} className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{s.name}</Link><span className={`block text-xs ${muted}`}>{s.kind}</span></td>}
                      <td className={td}><EnvironmentBadge name={e.name} kind={e.kind} internetFacing={e.internetFacing} isProtected={e.protected} /></td>
                      <td className={td}><RunningCell current={e.current} /></td>
                    </tr>
                  )))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
        <div className="space-y-4 md:space-y-6 xl:col-span-5">
          <Card title="Pipelines" description={o ? `${o.stats.pipelines.succeeded} succeeded · ${o.stats.pipelines.failed} failed` : undefined} flush actions={<Link to={`${p}/pipelines`} className={linkButton}>Run pipeline</Link>}>
            <div className="px-6 pt-4 pb-2"><PipelineBar succeeded={o?.stats.pipelines.succeeded ?? 0} failed={o?.stats.pipelines.failed ?? 0} running={(o?.stats.pipelines.total ?? 0) - (o?.stats.pipelines.succeeded ?? 0) - (o?.stats.pipelines.failed ?? 0)} total={o?.stats.pipelines.total ?? 0} /></div>
            {!o || o.pipelines.length === 0 ? <EmptyState title="No pipeline yet">Every push to the default branch runs one when a GitHub App is connected, or from CI with <code>secops pipeline --wait</code>.</EmptyState> : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">{o.pipelines.slice(0, 6).map((x) => <PipelineLine key={x.id} p={x} to={`${p}/pipelines/${x.id}`} />)}</div>
            )}
          </Card>
          {!setupDone && (
            <Card title="Set up this project" flush>
              <ol className="list-decimal space-y-2 px-8 py-5 text-sm text-gray-700 dark:text-gray-400">
                <li className={(o?.services.length ?? 0) ? "line-through opacity-60" : ""}><Link to={`${p}/services`} className="text-brand-500 hover:underline">Add a service</Link> — what gets built and deployed.</li>
                <li className={attached.length ? "line-through opacity-60" : ""}><Link to={`${p}/repositories`} className="text-brand-500 hover:underline">Attach its repository</Link>{(integrations.data ?? []).length ? "" : " — connect a source first"}.</li>
                <li className={(o?.environments.length ?? 0) ? "line-through opacity-60" : ""}><Link to={`${p}/environments`} className="text-brand-500 hover:underline">Declare environments</Link> — mark production protected and internet-facing.</li>
                <li><Link to={`${p}/settings`} className="text-brand-500 hover:underline">Create CI tokens</Link> and paste the CI snippet into the pipeline.</li>
              </ol>
            </Card>
          )}
        </div>
      </div>

      <Card title="Recent activity" flush actions={<Link to="/audit" className={linkButton}>Audit trail</Link>}>
        {isForbidden(audit.error) ? <EmptyState title="Not visible with your role" /> : activity.length === 0 ? <EmptyState title="Nothing recorded yet" /> : (
          <ul className="grid grid-cols-1 md:grid-cols-2">
            {activity.map((e) => (
              <li key={e.id} className={`px-6 py-2.5 ${trBorder}`}>
                <p className="text-sm text-gray-800 dark:text-white/90"><span className="font-medium">{e.action}</span> <span className={`text-xs ${muted}`}>· {e.actorType === "USER" ? e.actorLabel : e.actorLabel ?? e.actorType.toLowerCase()} · {relativeTime(e.createdAt)}</span></p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
