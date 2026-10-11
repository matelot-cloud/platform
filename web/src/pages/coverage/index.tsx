import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import { useOrganizationCoverage } from "@/platform/api/hooks";
import type { CoverageCheckId, Organization } from "@/platform/api/types";
import { CHECK_LABEL, COVERAGE_CHECKS, CoverageTable, coveragePhrase } from "@/platform/components/Coverage";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, EmptyState, ErrorNotice, muted, Tabs } from "@/platform/components/ui";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { useSearchParams } from "react-router";

type Filter = CoverageCheckId | "all";

/** Organization coverage: the services with a gap across the projects you can read, filterable by check (?gap=). */
export function CoveragePage({ organization }: { organization: Organization }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("gap");
  const gap: CoverageCheckId | null = COVERAGE_CHECKS.includes(raw as CoverageCheckId) ? (raw as CoverageCheckId) : null;
  const coverage = useOrganizationCoverage(organization.id, gap);
  const d = coverage.data;
  const s = d?.summary;
  const items: { value: Filter; label: string }[] = [
    { value: "all", label: s ? `All gaps (${s.services - s.covered})` : "All gaps" },
    ...COVERAGE_CHECKS.map((id) => ({ value: id as Filter, label: s ? `${CHECK_LABEL[id]} (${s.checks[id].missing + s.checks[id].stale})` : CHECK_LABEL[id] })),
  ];
  return (
    <Card
      title={<span className="flex items-center gap-3">Service coverage {s && <span className={`text-sm font-normal ${muted}`}>{s.covered} of {s.services} services fully covered</span>}</span>}
      description={s ? COVERAGE_CHECKS.map((id) => coveragePhrase(id, s)).join(" · ") : "Per service: repository, security pipeline in the last 30 days, SBOM, policy, deployment."}
      flush
    >
      <Tabs value={gap ?? "all"} onChange={(v) => setParams(v === "all" ? {} : { gap: v }, { replace: true })} items={items} />
      {coverage.error ? <div className="p-6"><ErrorNotice error={coverage.error} /></div>
        : !d ? <p className={`p-6 text-sm ${muted}`}>Loading…</p>
        : d.uncovered.length === 0 ? <div className="p-6"><EmptyState title={s!.services === 0 ? "No services yet" : gap ? `Every service has: ${CHECK_LABEL[gap].toLowerCase()}` : "Every service is covered"} /></div>
        : (
          <>
            <CoverageTable services={d.uncovered} showProject />
            {d.uncoveredTotal > d.uncovered.length && <p className={`px-6 py-3 text-xs ${muted}`}>Showing {d.uncovered.length} of {d.uncoveredTotal}; use <code>matelot coverage --uncovered --json</code> for the full list.</p>}
          </>
        )}
    </Card>
  );
}

export default function CoverageIndexPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Coverage · ${productName}`} description="Service coverage across the organization" />
      <PageBreadcrumb pageTitle="Coverage" />
      <OrganizationGate>{(organization) => <CoveragePage key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
