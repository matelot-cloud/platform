import { useProjectJobs } from "@/platform/api/hooks";
import type { Job, JobStatus } from "@/platform/api/types";
import { humanize, relativeTime, titleCase } from "@/platform/format";
import { useState } from "react";
import { Link } from "react-router";
import { StatusIcon, statusLabel } from "./StatusIcon";
import { Card, EmptyState, ErrorNotice, muted, SelectField, td, th, trBorder } from "./ui";

const FILTERS: { value: string; label: string; statuses?: JobStatus[] }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active", statuses: ["queued", "assigned", "running", "pending"] },
  { value: "finished", label: "Finished", statuses: ["succeeded", "failed", "cancelled", "timed_out", "skipped"] },
  { value: "failed", label: "Failed", statuses: ["failed", "timed_out"] },
];

export function JobsPanel({ projectId }: { projectId: string }) {
  const jobs = useProjectJobs(projectId);
  const [filter, setFilter] = useState("all");
  const f = FILTERS.find((x) => x.value === filter)!;
  const rows = (jobs.data ?? []).filter((j) => !f.statuses || f.statuses.includes(j.status));
  return (
    <Card title="Jobs" description="Every job of this project, across pipelines. Open one for its log and result." flush actions={<SelectField ariaLabel="Filter" value={filter} onChange={setFilter} options={FILTERS.map((x) => ({ value: x.value, label: x.label }))} className="w-40" />}>
      {jobs.error ? <div className="p-4"><ErrorNotice error={jobs.error} /></div> : rows.length === 0 ? (
        <EmptyState title={filter === "all" ? "No jobs yet" : "Nothing matches the filter"}>{filter === "all" ? <>Jobs are created by pipelines: <Link to={`/projects/${projectId}/pipelines`} className="text-brand-500 hover:underline">run one</Link>.</> : ""}</EmptyState>
      ) : (
        <table className="min-w-full">
          <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Status</th><th className={th}>Job</th><th className={th}>Stage</th><th className={th}>Service</th><th className={th}>Runner</th><th className={th}>When</th></tr></thead>
          <tbody>
            {rows.map((j: Job) => (
              <tr key={j.id} className={`${trBorder} hover:bg-gray-50 dark:hover:bg-white/2`}>
                <td className={td}><span className="inline-flex items-center gap-2"><StatusIcon status={j.status} /><span className="text-sm text-gray-700 dark:text-gray-300">{statusLabel(j.status)}</span></span></td>
                <td className={td}><Link to={`/projects/${projectId}/jobs/${j.id}`} className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{j.name ?? titleCase(humanize(j.type))}</Link><span className={`block text-xs ${muted}`}>{humanize(j.type)}{j.repositoryName ? ` · ${j.repositoryName}` : ""}{j.requiredTags.length ? ` · needs ${j.requiredTags.join(", ")}` : ""}</span></td>
                <td className={`${td} ${muted}`}>{j.pipelineId ? <Link to={`/projects/${projectId}/pipelines/${j.pipelineId}`} className="hover:text-brand-500">{j.stage}</Link> : "—"}</td>
                <td className={`${td} ${muted}`}>{j.serviceName ?? "—"}</td>
                <td className={`${td} ${muted}`}>{j.runnerName ?? "—"}</td>
                <td className={`${td} ${muted}`}>{relativeTime(j.finishedAt ?? j.startedAt ?? j.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
