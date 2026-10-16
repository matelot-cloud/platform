import { PlusIcon } from "@/icons";
import { useIntegrations, useProjects, useTeams } from "@/platform/api/hooks";
import { Kpi } from "@/platform/components/Dashboard";
import { NextStep } from "@/platform/components/NextStep";
import { Card, CriticalityBadge, muted, outlineButton, primaryButton, td, th, trBorder } from "@/platform/components/ui";
import { teamPath } from "@/platform/navigation/scope";
import { useState } from "react";
import { Link } from "react-router";
import { useWorkspace } from "./layout";
import { NewTeamDialog } from "./teams";

export default function WorkspaceOverviewPage() {
  const { organization, workspace } = useWorkspace();
  const teams = (useTeams(organization.id).data ?? []).filter((t) => t.workspaceId === workspace.id);
  const projects = (useProjects(organization.id).data ?? []).filter((p) => p.workspaceId === workspace.id);
  const integrations = (useIntegrations(organization.id).data ?? []).filter((i) => i.scope.type === "WORKSPACE" && i.scope.id === workspace.id);
  const [newTeam, setNewTeam] = useState(false);
  const base = `/workspaces/${workspace.id}`;
  return (
    <div className="space-y-6">
      {teams.length === 0 ? (
        <NextStep title="Create a team" actions={<button type="button" className={primaryButton} onClick={() => setNewTeam(true)}><PlusIcon className="size-5" /> Create a team</button>}>
          {workspace.name} is ready. Teams own the projects; create the first one, then its first project.
        </NextStep>
      ) : projects.length === 0 ? (
        <NextStep title="Create a project" actions={teams.slice(0, 4).map((t) => <Link key={t.id} to={teamPath(t)} className={outlineButton}>Open {t.name}</Link>)}>
          Projects belong to a team: open a team and create its first project there.
        </NextStep>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4">
        <Kpi label="Teams" value={teams.length} to={`${base}/teams`} />
        <Kpi label="Projects" value={projects.length} to={`${base}/projects`} />
        <Kpi label="Connected sources" value={integrations.length} to={`${base}/integrations`} caption="at workspace level" />
      </div>
      {projects.length > 0 && (
        <Card title="Projects" flush>
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Project</th><th className={th}>Team</th><th className={th}>Criticality</th></tr></thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className={trBorder}>
                  <td className={td}><Link to={`/projects/${p.id}`} className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{p.name}</Link> <span className={`text-xs ${muted}`}>{p.slug}</span></td>
                  <td className={td}><Link to={teamPath({ id: p.teamId, workspaceId: p.workspaceId })} className={`${muted} hover:text-brand-500`}>{p.teamName}</Link></td>
                  <td className={td}><CriticalityBadge value={p.criticality} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {newTeam && <NewTeamDialog organizationId={organization.id} workspaceId={workspace.id} workspaceName={workspace.name} onClose={() => setNewTeam(false)} />}
    </div>
  );
}
