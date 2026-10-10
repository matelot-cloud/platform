import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import { isForbidden } from "@/platform/api/client";
import { useFindingEnvironments, useFindingSummary, useFindingTrend, useOrganizationFindings, useRecorrelate, useSnapshotNow, type FindingQuery } from "@/platform/api/hooks";
import { FindingTrend } from "@/platform/components/FindingTrend";
import { CodeFindingsPanel } from "@/platform/components/CodeFindings";
import { Tabs } from "@/platform/components/ui";
import type { Organization } from "@/platform/api/types";
import { Kpi } from "@/platform/components/Dashboard";
import { FindingDialog, FindingFilters } from "@/platform/components/Findings";
import { FindingsGrouped } from "@/platform/components/FindingsGrouped";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, EmptyState, ErrorNotice, muted, outlineButton } from "@/platform/components/ui";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { useState } from "react";

export function Vulnerabilities({ organization, scope }: { organization: Organization; scope?: string }) {
  const [query, setQuery] = useState<FindingQuery>({ status: ["open"] });
  const findings = useOrganizationFindings(organization.id, query, scope);
  const summary = useFindingSummary(organization.id, scope);
  const recorrelate = useRecorrelate(organization.id);
  const environments = useFindingEnvironments(organization.id, scope);
  const [days, setDays] = useState(30);
  const trend = useFindingTrend(organization.id, days, scope);
  const snapshot = useSnapshotNow(organization.id);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<"dependencies" | "code">("dependencies");
  const s = summary.data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6 md:gap-4">
        <Kpi label="Open · critical" value={s?.open.critical ?? "…"} tone={s?.open.critical ? "bad" : "default"} />
        <Kpi label="Open · high" value={s?.open.high ?? "…"} tone={s?.open.high ? "warn" : "default"} />
        <Kpi label="Open · medium / low" value={s ? `${s.open.medium} / ${s.open.low}` : "…"} />
        <Kpi label="Known exploited" value={s?.kev ?? "…"} tone={s?.kev ? "bad" : "default"} caption="CISA KEV, open" />
        <Kpi label="Critical/high in production" value={s ? s.production.critical + s.production.high : "…"} tone={s && s.production.critical + s.production.high ? "bad" : "good"} caption={s ? `${s.production.critical} critical · ${s.production.high} high` : undefined} />
        <Kpi label="Fixed" value={s?.fixed ?? "…"} tone="good" caption={s ? `${s.total} findings total` : undefined} />
      </div>
      <Card title="Over time" description="Open findings in what each environment runs, per day. Production is drawn thicker; click a legend entry to hide it." flush actions={<button type="button" className={outlineButton} disabled={snapshot.isPending} onClick={() => snapshot.mutate()}>{snapshot.isPending ? "Computing…" : "Refresh history"}</button>}>
        <FindingTrend series={trend.data ?? []} days={days} onDays={setDays} />
      </Card>
      <Card flush>
        <Tabs value={tab} onChange={setTab} items={[{ value: "dependencies", label: "Dependencies" }, { value: "code", label: "Code · secrets & IaC" }]} />
      </Card>
      {tab === "code" ? <Card title="Code findings" description="Secrets and infrastructure-as-code misconfigurations across your repositories, from the pipeline scans." flush><CodeFindingsPanel organizationId={organization.id} projectId={scope} /></Card> : <>
      <Card title="Findings" description="Grouped by package; pick a source on the left (repository or image per registry) to narrow down. Production exposure first, then severity." flush actions={<button type="button" className={outlineButton} disabled={recorrelate.isPending} onClick={() => recorrelate.mutate()}>{recorrelate.isPending ? "Correlating…" : "Re-correlate now"}</button>}>
        <FindingFilters value={query} onChange={setQuery} />
        {recorrelate.data && <p className={`px-6 pb-2 text-xs ${muted}`}>Checked {recorrelate.data.checked} components · {recorrelate.data.newAdvisories} new advisories · {recorrelate.data.findingsOpened} opened · {recorrelate.data.findingsFixed} fixed.</p>}
        {isForbidden(findings.error) ? <EmptyState title="Not visible with your role" /> : findings.error ? <div className="p-4"><ErrorNotice error={findings.error} /></div> : <FindingsGrouped rows={findings.data ?? []} onOpen={setOpen} environments={environments.data ?? []} />}
      </Card>
      </>}
      {open && <FindingDialog findingId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export default function VulnerabilitiesPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Vulnerabilities · ${productName}`} description="Findings across the organization" />
      <PageBreadcrumb pageTitle="Vulnerabilities" />
      <OrganizationGate>{(organization) => <Vulnerabilities key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
