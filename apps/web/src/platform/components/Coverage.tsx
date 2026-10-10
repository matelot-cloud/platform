import Badge from "@/components/ui/badge/Badge";
import { useOrganizationCoverage } from "@/platform/api/hooks";
import type { CoverageCheck, CoverageCheckId, CoverageSummary, ServiceCoverage } from "@/platform/api/types";
import { CheckLineIcon } from "@/icons";
import { Fragment } from "react";
import { Link } from "react-router";
import { Card, codeBlock, EmptyState, ErrorNotice, linkButton, muted, td, th, trBorder } from "./ui";

export const COVERAGE_CHECKS: CoverageCheckId[] = ["repository", "pipeline", "sbom", "policy", "deployment"];
export const CHECK_LABEL: Record<CoverageCheckId, string> = { repository: "Repository", pipeline: "Security pipeline", sbom: "SBOM", policy: "Policy", deployment: "Deployment" };

/** One check of one service: a green check, or the gap with what was found and where to fix it. */
export function CoverageCell({ check }: { check: CoverageCheck }) {
  if (check.state === "ok") {
    return (
      <span className="flex items-start gap-1.5" data-state="ok">
        <CheckLineIcon className="mt-0.5 size-4 shrink-0 text-success-500" aria-label="covered" />
        <span className={`text-xs ${muted}`}>{check.detail}</span>
      </span>
    );
  }
  return (
    <span className="flex flex-col items-start gap-1" data-state={check.state}>
      <Badge size="sm" color={check.state === "stale" ? "warning" : "error"}>{check.state === "stale" ? "stale" : "gap"}</Badge>
      <span className="text-xs text-gray-700 dark:text-gray-300">{check.detail}</span>
      {check.href && <Link to={check.href} className="text-xs font-medium text-brand-500 hover:text-brand-600">Fix →</Link>}
    </span>
  );
}

/** One row per service (with the project when listing across projects); under each uncovered row, the CLI commands that close its gaps. */
export function CoverageTable({ services, showProject }: { services: ServiceCoverage[]; showProject?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead className="border-b border-gray-100 dark:border-gray-800">
          <tr>
            <th className={th}>{showProject ? "Project / service" : "Service"}</th>
            {COVERAGE_CHECKS.map((id) => <th key={id} className={th}>{CHECK_LABEL[id]}</th>)}
          </tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const gaps = s.checks.filter((c) => c.state !== "ok" && c.cli);
            return (
              <Fragment key={s.serviceId}>
                <tr className={trBorder} data-service={s.serviceSlug}>
                  <td className={`${td} align-top`}>
                    {showProject && <Link to={`/projects/${s.projectId}/coverage`} className={`block text-xs ${muted} hover:text-brand-500`}>{s.projectName}</Link>}
                    <span className="font-medium text-gray-800 dark:text-white/90">{s.serviceName}</span>
                    <span className={`block text-xs ${s.covered ? "text-success-600" : muted}`}>{s.covered ? "covered" : `${s.gaps.length} gap${s.gaps.length === 1 ? "" : "s"}`}</span>
                  </td>
                  {COVERAGE_CHECKS.map((id) => <td key={id} className={`${td} align-top`}><CoverageCell check={s.checks.find((c) => c.id === id)!} /></td>)}
                </tr>
                {gaps.length > 0 && (
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    <td colSpan={COVERAGE_CHECKS.length + 1} className="px-6 pb-4">
                      <code className={codeBlock}>{gaps.map((c) => `# ${CHECK_LABEL[c.id].toLowerCase()}: ${c.detail}\n${c.cli}`).join("\n")}</code>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "day" or "N days", after "in the last". */
export const lastDays = (n: number) => (n === 1 ? "day" : `${n} days`);

/** "3/4 with a repository" — the phrase for each check in summaries. */
export function coveragePhrase(id: CoverageCheckId, s: CoverageSummary): string {
  const c = s.checks[id];
  const of = `${c.ok}/${s.services}`;
  switch (id) {
    case "repository": return `${of} with a repository`;
    case "pipeline": return `${of} scanned in the last ${lastDays(s.days)}`;
    case "sbom": return `${of} with an SBOM`;
    case "policy": return `${of} under a policy`;
    case "deployment": return `${of} with a deployment recorded`;
  }
}

/**
 * Organization Overview: per-service coverage across the projects the viewer can read — permanent, for everyone (not a
 * setup step that completes). Each number links to the services missing it.
 */
export function CoverageSummaryCard({ organizationId }: { organizationId: string }) {
  const coverage = useOrganizationCoverage(organizationId);
  const d = coverage.data;
  if (coverage.error) return <Card title="Service coverage"><ErrorNotice error={coverage.error} /></Card>;
  if (!d || d.summary.services === 0) return null;
  const s = d.summary;
  return (
    <Card
      title={<span className="flex items-center gap-3">Service coverage <span className={`text-sm font-normal ${muted}`}>{s.covered} of {s.services} services fully covered</span></span>}
      description={`Is every service under watch: a repository, a security pipeline in the last ${lastDays(s.days)}, an SBOM, a policy that applies, a deployment recorded.`}
      actions={d.uncoveredTotal > 0 && <Link to="/coverage" className={linkButton}>{d.uncoveredTotal} service{d.uncoveredTotal === 1 ? "" : "s"} with gaps</Link>}
    >
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {COVERAGE_CHECKS.map((id) => {
          const c = s.checks[id];
          const gaps = c.missing + c.stale;
          const pct = s.services ? Math.round((c.ok / s.services) * 100) : 0;
          return (
            <li key={id} data-check={id}>
              <Link to={gaps ? `/coverage?gap=${id}` : "/coverage"} className="block rounded-lg border border-gray-100 px-4 py-3 hover:border-brand-300 dark:border-gray-800">
                <span className={`block text-xs ${muted}`}>{CHECK_LABEL[id]}</span>
                <span className="block text-sm font-medium text-gray-800 dark:text-white/90">{coveragePhrase(id, s)}</span>
                <span className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-white/5"><span className={`block h-full rounded-full ${pct === 100 ? "bg-success-500" : pct >= 50 ? "bg-warning-500" : "bg-error-500"}`} style={{ width: `${pct}%` }} /></span>
                {gaps > 0 && <span className={`mt-1 block text-xs ${muted}`}>{c.missing ? `${c.missing} missing` : ""}{c.missing && c.stale ? " · " : ""}{c.stale ? `${c.stale} stale` : ""}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function CoverageEmpty() {
  return <EmptyState title="No services yet">Coverage is computed per service once a project has services.</EmptyState>;
}
