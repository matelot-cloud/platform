import type { Pipeline, PipelineJobSummary } from "@/platform/api/types";
import { humanize, titleCase } from "@/platform/format";
import { cn } from "@/utils";
import { Link } from "react-router";
import { StatusIcon } from "./StatusIcon";

/** Stage columns with job cards, GitLab-style. `compact` renders the mini graph used in lists. */
export function PipelineGraph({ pipeline, projectId, compact = false, selectedJobId, onSelect }: { pipeline: Pipeline; projectId: string; compact?: boolean; selectedJobId?: string; onSelect?: (jobId: string) => void }) {
  const stages = pipeline.stages.map((stage, order) => ({ ...stage, order, jobs: (pipeline.jobs as PipelineJobSummary[]).filter((j) => j.stageOrder === order) }));
  if (compact) {
    return (
      <div className="flex items-center gap-1">
        {stages.map((stage, i) => {
          const statuses = stage.jobs.map((j) => j.status);
          const status = statuses.some((s) => s === "failed" || s === "timed_out") ? "failed" : statuses.some((s) => s === "running" || s === "assigned") ? "running" : statuses.some((s) => s === "queued") ? "queued" : statuses.every((s) => s === "pending") ? "pending" : statuses.some((s) => s === "cancelled") ? "cancelled" : statuses.every((s) => s === "skipped") ? "skipped" : "succeeded";
          return (
            <span key={stage.name} className="flex items-center gap-1" title={`${stage.name}: ${statuses.join(", ")}`}>
              <StatusIcon status={status} size="sm" />
              {i < stages.length - 1 && <span className="h-px w-2 bg-gray-300 dark:bg-gray-700" />}
            </span>
          );
        })}
      </div>
    );
  }
  return (
    <div className="flex items-start gap-0 overflow-x-auto pb-2">
      {stages.map((stage, i) => (
        <div key={stage.name} className="flex items-start">
          <div className="min-w-56">
            <p className="mb-3 text-center text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">{stage.name}</p>
            <div className="space-y-2">
              {stage.jobs.map((job) => {
                const inner = (
                  <>
                    <StatusIcon status={job.status} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-gray-800 dark:text-white/90">{job.name ?? titleCase(humanize(job.type))}</span>
                      <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{humanize(job.type)}</span>
                    </span>
                  </>
                );
                const cls = cn("flex w-full items-center gap-3 rounded-xl border bg-white px-3 py-2.5 text-start transition hover:border-brand-300 hover:shadow-theme-xs dark:bg-white/3", job.status === "skipped" ? "border-dashed border-gray-300 opacity-70 dark:border-gray-700" : job.status === "failed" ? "border-error-200 dark:border-error-500/40" : "border-gray-200 dark:border-gray-800", selectedJobId === job.id && "border-brand-300 ring-2 ring-brand-500/30 dark:border-brand-500/50");
                return onSelect ? <button key={job.id} type="button" className={cls} onClick={() => onSelect(job.id)}>{inner}</button> : <Link key={job.id} to={`/projects/${projectId}/jobs/${job.id}`} className={cls}>{inner}</Link>;
              })}
            </div>
          </div>
          {i < stages.length - 1 && <div className="mt-9 h-px w-8 shrink-0 bg-gray-300 dark:bg-gray-700" />}
        </div>
      ))}
    </div>
  );
}
