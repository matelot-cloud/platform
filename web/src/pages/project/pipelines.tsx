import { useProjectPipelines, useServiceRepositories } from "@/platform/api/hooks";
import { PipelineGraph } from "@/platform/components/PipelineGraph";
import { RunPipelineButton } from "@/platform/components/RunPipelineButton";
import { StatusIcon, statusLabel } from "@/platform/components/StatusIcon";
import { Card, EmptyState, ErrorNotice, muted, td, th, trBorder } from "@/platform/components/ui";
import { relativeTime } from "@/platform/format";
import { Link } from "react-router";
import { useProject } from "./layout";

function duration(p: { startedAt: string | null; finishedAt: string | null }) {
  if (!p.startedAt) return "—";
  const ms = (p.finishedAt ? new Date(p.finishedAt).getTime() : Date.now()) - new Date(p.startedAt).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function ProjectPipelinesPage() {
  const { project } = useProject();
  const pipelines = useProjectPipelines(project.id);
  const { focusService: current, service: selected, services } = useProject();
  const repos = useServiceRepositories(current?.id);
  const canRun = !!current && (repos.data ?? []).length > 0;

  return (
    <div className="space-y-6">
      <Card
        title="Pipelines"
        description="A pipeline runs stages of jobs on a service's repository: checkout, inventory, scans, policy. Jobs a runner cannot execute yet are skipped."
        flush
        actions={
          <div className="flex items-center gap-3">
            {!selected && services.length > 1 && <span className={`text-xs ${muted}`}>all services · Run starts on {current?.name} (pick one in the navbar)</span>}
            {current && <RunPipelineButton projectId={project.id} serviceId={current.id} disabled={!canRun} />}
          </div>
        }
      >
        {pipelines.error ? <div className="p-4"><ErrorNotice error={pipelines.error} /></div> : (pipelines.data ?? []).length === 0 ? (
          <EmptyState title="No pipeline has run yet">{canRun ? "Start one with Run pipeline." : current ? "Attach a repository to the service first (Services page)." : "Create a service and attach its repository first."}</EmptyState>
        ) : (
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800">
              <tr><th className={th}>Pipeline</th><th className={th}>Stages</th><th className={th}>Ref</th><th className={th}>Service</th><th className={th}>Duration</th><th className={th}>Started</th></tr>
            </thead>
            <tbody>
              {(pipelines.data ?? []).filter((p) => !selected || p.serviceId === selected.id).map((p) => (
                <tr key={p.id} className={`${trBorder} hover:bg-gray-50 dark:hover:bg-white/2`}>
                  <td className={td}>
                    <Link to={`/projects/${project.id}/pipelines/${p.id}`} className="flex items-center gap-3">
                      <StatusIcon status={p.status} />
                      <span className="min-w-0"><span className="block font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{p.name} <span className={muted}>#{p.number}</span></span><span className={`block text-xs ${muted}`}>{statusLabel(p.status)} · {p.trigger}</span></span>
                    </Link>
                  </td>
                  <td className={td}><PipelineGraph pipeline={p} projectId={project.id} compact /></td>
                  <td className={`${td} font-mono text-xs ${muted}`}>{p.ref ? (p.ref.length > 12 ? p.ref.slice(0, 10) : p.ref) : "—"}{p.repositoryName && <span className="block font-sans">{p.repositoryName}</span>}</td>
                  <td className={`${td} ${muted}`}>{p.serviceName ?? "—"}</td>
                  <td className={`${td} ${muted}`}>{duration(p)}</td>
                  <td className={`${td} ${muted}`}>{relativeTime(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
