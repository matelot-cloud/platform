import { useProjectCoverage } from "@/platform/api/hooks";
import { CoverageEmpty, CoverageTable, coveragePhrase, COVERAGE_CHECKS } from "@/platform/components/Coverage";
import { Card, ErrorNotice, muted } from "@/platform/components/ui";
import { useProject } from "./layout";

/** Project coverage: one row per service, a check or a gap with the link and CLI command to close it. Permanent, for everyone who can read the project. */
export default function ProjectCoveragePage() {
  const { project, services, focusService } = useProject();
  const coverage = useProjectCoverage(project.id);
  const d = coverage.data;
  const focus = focusService && services.length > 1 ? focusService.id : null;
  const rows = (d?.services ?? []).filter((s) => !focus || s.serviceId === focus);
  return (
    <Card
      title={<span className="flex items-center gap-3">Service coverage {d && <span className={`text-sm font-normal ${muted}`}>{d.summary.covered} of {d.summary.services} services fully covered</span>}</span>}
      description={d ? COVERAGE_CHECKS.map((id) => coveragePhrase(id, d.summary)).join(" · ") : "Is every service under watch: repository, recent security pipeline, SBOM, policy, deployment."}
      flush
    >
      {coverage.error ? <div className="p-6"><ErrorNotice error={coverage.error} /></div> : !d ? <p className={`p-6 text-sm ${muted}`}>Loading…</p> : rows.length === 0 ? <div className="p-6"><CoverageEmpty /></div> : <CoverageTable services={rows} />}
    </Card>
  );
}
