import { isForbidden } from "@/platform/api/client";
import { useFindingEnvironments, useFindingSummary, useFindingTrend, useProjectFindings, useServiceDeployments, type FindingQuery } from "@/platform/api/hooks";
import { FindingTrend } from "@/platform/components/FindingTrend";
import { CodeFindingsPanel } from "@/platform/components/CodeFindings";
import { Tabs } from "@/platform/components/ui";
import { EnvironmentManager } from "@/platform/components/EnvironmentManager";
import type { FindingEnvironment } from "@/platform/api/types";
import { Kpi } from "@/platform/components/Dashboard";
import { FindingDialog, FindingFilters } from "@/platform/components/Findings";
import { FindingsGrouped } from "@/platform/components/FindingsGrouped";
import { Card, EmptyState, ErrorNotice, muted } from "@/platform/components/ui";
import { useState } from "react";
import { useProject } from "./layout";

export default function ProjectVulnerabilitiesPage() {
  const { organization, project, service: selected } = useProject();
  const [query, setQuery] = useState<FindingQuery>({ status: ["open"] });
  const findings = useProjectFindings(project.id, query);
  const summary = useFindingSummary(organization.id, project.id);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<"dependencies" | "code">("dependencies");
  const environments = useFindingEnvironments(organization.id, project.id);
  const [days, setDays] = useState(30);
  const trend = useFindingTrend(organization.id, days, project.id);
  const [change, setChange] = useState<FindingEnvironment | null>(null);
  const { services: allServices } = useProject();
  const svc = allServices.find((x) => x.id === change?.serviceId);
  const deployments = useServiceDeployments(change?.serviceId);
  const env = (deployments.data?.environments ?? []).find((e) => e.id === change?.id);
  const s = summary.data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Kpi label="Open · critical" value={s?.open.critical ?? "…"} tone={s?.open.critical ? "bad" : "default"} />
        <Kpi label="Open · high" value={s?.open.high ?? "…"} tone={s?.open.high ? "warn" : "default"} />
        <Kpi label="Known exploited" value={s?.kev ?? "…"} tone={s?.kev ? "bad" : "default"} />
        <Kpi label="Critical/high in production" value={s ? s.production.critical + s.production.high : "…"} tone={s && s.production.critical + s.production.high ? "bad" : "good"} />
      </div>
      {s?.notRunning && (s.notRunning.critical + s.notRunning.high + s.notRunning.medium + s.notRunning.low + s.notRunning.unknown) > 0 && <p className={`text-xs ${muted}`}>Counts above are for images that run somewhere. Open findings of images that run nowhere (still in a registry): {s.notRunning.critical} critical · {s.notRunning.high} high · {s.notRunning.medium} medium · {s.notRunning.low} low — not in totals, map or risk.</p>}
      <Card title="Over time" description="Open findings in what each environment runs, per day." flush>
        <FindingTrend series={(trend.data ?? []).filter((t) => !selected || t.serviceName === selected.name)} days={days} onDays={setDays} showProject={false} />
      </Card>
      <Card flush>
        <Tabs value={tab} onChange={setTab} items={[{ value: "dependencies", label: "Dependencies" }, { value: "code", label: "Code · secrets & IaC" }]} />
      </Card>
      {tab === "code" ? <Card title="Code findings" description="Secrets and infrastructure-as-code misconfigurations in this project's repositories, from the pipeline scans." flush><CodeFindingsPanel organizationId={organization.id} projectId={project.id} serviceId={selected?.id} /></Card> : <>
      <Card title="Findings" description="Vulnerable components in this project's services, with where each one runs." flush>
        <FindingFilters value={query} onChange={setQuery} showRunning={false} />
        {isForbidden(findings.error) ? <EmptyState title="Not visible with your role" /> : findings.error ? <div className="p-4"><ErrorNotice error={findings.error} /></div> : <FindingsGrouped rows={(findings.data ?? []).filter((f) => !selected || f.serviceId === selected.id)} onOpen={setOpen} showProject={false} environments={(environments.data ?? []).filter((e) => !selected || e.serviceId === selected.id)} onChangeImage={setChange} />}
      </Card>
      </>}
      {open && <FindingDialog findingId={open} onClose={() => setOpen(null)} />}
      {change && svc && env && <EnvironmentManager project={project} service={svc} environment={env} current={env.current} projectId={project.id} initial="deploy" onClose={() => setChange(null)} />}
    </div>
  );
}
