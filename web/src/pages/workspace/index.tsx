import { useIntegrations, useProjects, useTeams } from "@/platform/api/hooks";
import { Kpi } from "@/platform/components/Dashboard";
import { Card, CriticalityBadge, EmptyState, muted, td, th, trBorder } from "@/platform/components/ui";
import { Link } from "react-router";
import { useWorkspace } from "./layout";

export default function WorkspaceOverviewPage() {
  const { organization, workspace } = useWorkspace();
  const teams = (useTeams(organization.id).data ?? []).filter((t) => t.workspaceId === workspace.id);
  const projects = (useProjects(organization.id).data ?? []).filter((p) => p.workspaceId === workspace.id);
  const integrations = (useIntegrations(organization.id).data ?? []).filter((i) => i.scope.type === "WORKSPACE" && i.scope.id === workspace.id);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4">
        <Kpi label="Teams" value={teams.length} to={`/workspaces/${workspace.id}/projects`} />
        <Kpi label="Projects" value={projects.length} to={`/workspaces/${workspace.id}/projects`} />
        <Kpi label="Connected sources" value={integrations.length} to={`/workspaces/${workspace.id}/integrations`} caption="at workspace level" />
      </div>
      <Card title="Projects" flush>
        {projects.length === 0 ? <EmptyState title="No projects yet"><Link to={`/workspaces/${workspace.id}/projects`} className="text-brand-500 hover:underline">Create a team and the first project</Link>.</EmptyState> : (
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Project</th><th className={th}>Team</th><th className={th}>Criticality</th></tr></thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className={trBorder}>
                  <td className={td}><Link to={`/projects/${p.id}`} className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{p.name}</Link> <span className={`text-xs ${muted}`}>{p.slug}</span></td>
                  <td className={`${td} ${muted}`}>{p.teamName}</td>
                  <td className={td}><CriticalityBadge value={p.criticality} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
