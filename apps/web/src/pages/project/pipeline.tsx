import { useCancelPipeline, useJobLogs, usePipeline, useRetryJob } from "@/platform/api/hooks";
import { PipelineGraph } from "@/platform/components/PipelineGraph";
import { jobStatusLabel, StatusIcon, statusLabel } from "@/platform/components/StatusIcon";
import { TerminalLog } from "@/platform/components/TerminalLog";
import { Card, ErrorNotice, muted, outlineButton } from "@/platform/components/ui";
import { humanize, relativeTime } from "@/platform/format";
import { cn } from "@/utils";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useProject } from "./layout";

const ACTIVE = ["queued", "assigned", "running"];
const FINISHED = ["succeeded", "failed", "cancelled", "timed_out", "skipped"];

function duration(a: string | null, b: string | null) {
  if (!a) return "—";
  const s = Math.max(0, Math.round(((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function PipelinePage() {
  const { project } = useProject();
  const { pipelineId = "" } = useParams();
  const pipeline = usePipeline(pipelineId);
  const cancel = useCancelPipeline(project.id);
  const retry = useRetryJob(project.id);
  const p = pipeline.data;
  const [jobId, setJobId] = useState<string | null>(null);
  // Follow the pipeline: select the running job, else the first failed one, else the first job.
  useEffect(() => {
    if (!p) return;
    const jobs = p.jobs;
    const chosen = jobs.find((j) => ACTIVE.includes(j.status)) ?? jobs.find((j) => j.status === "failed") ?? jobs[0];
    setJobId((current) => (current && jobs.some((j) => j.id === current) && !jobs.some((j) => ACTIVE.includes(j.status)) ? current : (chosen?.id ?? null)));
  }, [p]);
  const job = p?.jobs.find((j) => j.id === jobId) ?? null;
  const live = !!job && ACTIVE.includes(job.status);
  const logs = useJobLogs(job?.id, live);
  if (pipeline.error) return <ErrorNotice error={pipeline.error} />;
  if (!p) return <p className={`text-sm ${muted}`}>Loading…</p>;
  const counts = p.jobs.reduce<Record<string, number>>((acc, j) => ({ ...acc, [j.status]: (acc[j.status] ?? 0) + 1 }), {});
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${statusLabel(k as never).toLowerCase()}`).join(" · ");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className={`text-sm ${muted}`}><Link to={`/projects/${project.id}/pipelines`} className="hover:text-brand-500">Pipelines</Link> / #{p.number}</p>
          <h3 className="mt-1 flex items-center gap-3 text-lg font-semibold text-gray-800 dark:text-white/90"><StatusIcon status={p.status} size="lg" /> {p.name} #{p.number} <span className={`text-sm font-normal ${muted}`}>{statusLabel(p.status)}</span></h3>
          <p className={`mt-1 text-sm ${muted}`}>{p.serviceName ?? ""}{p.repositoryName ? ` · ${p.repositoryName}` : ""}{p.ref ? ` @ ${p.ref.length > 12 ? p.ref.slice(0, 10) : p.ref}` : ""} · {p.trigger} · started {relativeTime(p.createdAt)} · {duration(p.startedAt, p.finishedAt)} · {summary}</p>
        </div>
        {["created", "running"].includes(p.status) && <button type="button" className={outlineButton} disabled={cancel.isPending} onClick={() => cancel.mutate(p.id)}>Cancel pipeline</button>}
      </div>
      {cancel.error ? <ErrorNotice error={cancel.error} /> : null}

      <Card title="Stages" description="Click a job to read its log below." >
        <PipelineGraph pipeline={p} projectId={project.id} selectedJobId={jobId ?? undefined} onSelect={setJobId} />
      </Card>

      {job && (
        <Card
          title={<span className="flex items-center gap-2"><StatusIcon status={job.status} /> {job.name ?? humanize(job.type)} <span className={`text-sm font-normal ${muted}`}>· {job.stage} · {jobStatusLabel(job, p.platformWorkerSeenAt)}</span></span>}
          flush
          actions={<div className="flex gap-2">{FINISHED.includes(job.status) && <button type="button" className={outlineButton} disabled={retry.isPending} onClick={() => retry.mutate(job.id)}>Retry job</button>}<Link to={`/projects/${project.id}/jobs/${job.id}`} className={cn(outlineButton)}>Open job</Link></div>}
        >
          <div className="p-4">
            {"error" in job && job.error && job.status !== "skipped" ? <div className="mb-3"><ErrorNotice error={job.error} /></div> : null}
            <TerminalLog chunks={logs.data ?? []} live={live} title={`${p.name} #${p.number} · ${job.name ?? humanize(job.type)}`} empty={live ? "Waiting for a runner…" : job.status === "pending" ? "Waits for the previous stage." : job.status === "skipped" ? ("error" in job && job.error ? String(job.error) : "Skipped.") : "No output."} />
          </div>
        </Card>
      )}
    </div>
  );
}
