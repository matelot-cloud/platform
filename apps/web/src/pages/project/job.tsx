import { useCancelJob, useJob, useJobLogs, useRetryJob } from "@/platform/api/hooks";
import { jobStatusLabel, StatusIcon, statusLabel } from "@/platform/components/StatusIcon";
import { TerminalLog } from "@/platform/components/TerminalLog";
import { Card, ErrorNotice, muted, outlineButton } from "@/platform/components/ui";
import { humanize, relativeTime, titleCase } from "@/platform/format";
import { Link, useParams } from "react-router";
import { useProject } from "./layout";

const ACTIVE = ["queued", "assigned", "running"];
const FINISHED = ["succeeded", "failed", "cancelled", "timed_out", "skipped"];

export default function JobPage() {
  const { project } = useProject();
  const { jobId = "" } = useParams();
  const job = useJob(jobId);
  const live = !!job.data && ACTIVE.includes(job.data.status);
  const logs = useJobLogs(jobId, live);
  const cancel = useCancelJob(project.id);
  const retry = useRetryJob(project.id);
  const j = job.data;
  if (job.error) return <ErrorNotice error={job.error} />;
  if (!j) return <p className={`text-sm ${muted}`}>Loading…</p>;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={`text-sm ${muted}`}>
            <Link to={`/projects/${project.id}/jobs`} className="hover:text-brand-500">Jobs</Link>
            {j.pipelineId && <> / <Link to={`/projects/${project.id}/pipelines/${j.pipelineId}`} className="hover:text-brand-500">pipeline</Link> / stage <span className="font-medium">{j.stage}</span></>}
          </p>
          <h3 className="mt-1 flex items-center gap-3 text-lg font-semibold text-gray-800 dark:text-white/90"><StatusIcon status={j.status} size="lg" /> {j.name ?? titleCase(humanize(j.type))} <span className={`text-sm font-normal ${muted}`}>{jobStatusLabel(j, j.platformWorkerSeenAt)}</span></h3>
          <p className={`mt-1 text-sm ${muted}`}>{humanize(j.type)}{j.repositoryName ? ` · ${j.repositoryName}` : ""}{j.runnerName ? ` · runner ${j.runnerName}` : ""} · attempt {j.attempts}/{j.maxAttempts} · created {relativeTime(j.createdAt)}{j.finishedAt ? ` · finished ${relativeTime(j.finishedAt)}` : ""}</p>
        </div>
        <div className="flex gap-3">
          {ACTIVE.includes(j.status) && <button type="button" className={outlineButton} disabled={cancel.isPending} onClick={() => cancel.mutate(j.id)}>Cancel job</button>}
          {FINISHED.includes(j.status) && <button type="button" className={outlineButton} disabled={retry.isPending} onClick={() => retry.mutate(j.id)}>Retry</button>}
        </div>
      </div>
      {(cancel.error || retry.error) ? <ErrorNotice error={cancel.error ?? retry.error} /> : null}
      {j.error && j.status !== "skipped" && <ErrorNotice error={j.error} />}
      {j.status === "skipped" && <div className="rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:bg-white/3 dark:text-gray-400">{j.error ?? "Skipped."}</div>}
      {j.result && (
        <Card title="Result">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
            {Object.entries(j.result).map(([k, v]) => <div key={k}><dt className={`text-xs ${muted}`}>{humanize(k)}</dt><dd className="break-all text-gray-800 dark:text-white/90">{String(v)}</dd></div>)}
          </dl>
        </Card>
      )}
      <TerminalLog chunks={logs.data ?? []} live={live} title={`${j.name ?? humanize(j.type)} · ${statusLabel(j.status)}`} empty={live ? "Waiting for a runner…" : j.status === "pending" ? "Waits for the previous stage." : "No output."} />
    </div>
  );
}
