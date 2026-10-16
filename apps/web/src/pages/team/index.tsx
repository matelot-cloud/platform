import { PlusIcon } from "@/icons";
import { useCreateProject, useMembers, useMeta, useProjects } from "@/platform/api/hooks";
import { Kpi } from "@/platform/components/Dashboard";
import { NextStep } from "@/platform/components/NextStep";
import { NodeDialog } from "@/platform/components/NodeDialog";
import { Card, CriticalityBadge, muted, primaryButton, td, th, trBorder } from "@/platform/components/ui";
import { relativeTime } from "@/platform/format";
import { teamPath } from "@/platform/navigation/scope";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTeam } from "./layout";

/** Team overview: its projects, and the next step when it has none. */
export default function TeamOverviewPage() {
  const { organization, workspace, team } = useTeam();
  const navigate = useNavigate();
  const meta = useMeta();
  const projects = (useProjects(organization.id).data ?? []).filter((p) => p.teamId === team.id);
  const create = useCreateProject(organization.id);
  const members = useMembers({ type: "TEAM", id: team.id });
  const [open, setOpen] = useState(false);
  const critical = projects.filter((p) => p.criticality === "CRITICAL" || p.criticality === "HIGH").length;
  const newProject = <button type="button" className={primaryButton} onClick={() => setOpen(true)}><PlusIcon className="size-5" /> New project</button>;
  return (
    <div className="space-y-6">
      {projects.length === 0 ? (
        <NextStep title="Create the first project of this team" actions={newProject}>
          A project is one product or application of {team.name}: its services, repositories, pipelines and findings live there.
        </NextStep>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4">
          <Kpi label="Projects" value={projects.length} />
          <Kpi label="High / critical" value={critical} caption="business criticality" />
          <Kpi label="Members" value={members.data ? members.data.members.length : "—"} to={`${teamPath(team)}/members`} caption="direct and inherited" />
        </div>
      )}
      {projects.length > 0 && (
        <Card title="Projects" description={`Projects of ${team.name} in ${workspace.name}.`} flush actions={newProject}>
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Project</th><th className={th}>Criticality</th><th className={th}>Updated</th></tr></thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className={trBorder}>
                  <td className={td}><Link to={`/projects/${p.id}`} className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{p.name}</Link> <span className={`text-xs ${muted}`}>{p.slug}</span></td>
                  <td className={td}><CriticalityBadge value={p.criticality} /></td>
                  <td className={`${td} ${muted}`}>{relativeTime(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {open && (
        <NodeDialog title={`New project in ${team.name}`} submitLabel="Create project" withCriticality criticalities={meta.data?.criticalities ?? ["LOW", "MEDIUM", "HIGH", "CRITICAL"]} pending={create.isPending} error={create.error} onClose={() => setOpen(false)}
          onSubmit={(d) => create.mutate({ teamId: team.id, slug: d.slug, name: d.name, description: d.description || undefined, criticality: d.criticality }, { onSuccess: (p) => { setOpen(false); void navigate(`/projects/${p.id}`); } })} />
      )}
    </div>
  );
}
