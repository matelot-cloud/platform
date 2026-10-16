import { PlusIcon } from "@/icons";
import { useCreateTeam, useMeta, useProjects, useTeams } from "@/platform/api/hooks";
import { NextStep } from "@/platform/components/NextStep";
import { NodeDialog } from "@/platform/components/NodeDialog";
import { Card, muted, primaryButton, td, th, trBorder } from "@/platform/components/ui";
import { teamPath } from "@/platform/navigation/scope";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useWorkspace } from "./layout";

/** Workspace → Teams: every team with its projects; creating one lands inside it. */
export default function WorkspaceTeamsPage() {
  const { organization, workspace } = useWorkspace();
  const teams = (useTeams(organization.id).data ?? []).filter((t) => t.workspaceId === workspace.id);
  const projects = useProjects(organization.id).data ?? [];
  const [open, setOpen] = useState(false);
  const newTeam = <button type="button" className={primaryButton} onClick={() => setOpen(true)}><PlusIcon className="size-5" /> New team</button>;
  return (
    <div className="space-y-6">
      {teams.length === 0 ? (
        <NextStep title="Create a team" actions={newTeam}>Teams own projects and get roles of their own; members of {workspace.name} see every team.</NextStep>
      ) : (
        <Card title="Teams" description={`${teams.length} ${teams.length === 1 ? "team" : "teams"} in ${workspace.name}.`} flush actions={newTeam}>
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Team</th><th className={th}>Projects</th><th className={th}>Description</th></tr></thead>
            <tbody>
              {teams.map((t) => {
                const own = projects.filter((p) => p.teamId === t.id);
                return (
                  <tr key={t.id} className={trBorder}>
                    <td className={td}><Link to={teamPath(t)} className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{t.name}</Link> <span className={`text-xs ${muted}`}>{t.slug}</span></td>
                    <td className={`${td} ${muted}`}>{own.length ? own.map((p) => p.name).join(", ") : "none yet"}</td>
                    <td className={`${td} ${muted} max-w-md truncate`} title={t.description ?? undefined}>{t.description ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {open && <NewTeamDialog organizationId={organization.id} workspaceId={workspace.id} workspaceName={workspace.name} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function NewTeamDialog({ organizationId, workspaceId, workspaceName, onClose }: { organizationId: string; workspaceId: string; workspaceName: string; onClose: () => void }) {
  const navigate = useNavigate();
  const meta = useMeta();
  const create = useCreateTeam(organizationId);
  return (
    <NodeDialog title={`New team in ${workspaceName}`} submitLabel="Create team" criticalities={meta.data?.criticalities ?? ["LOW", "MEDIUM", "HIGH", "CRITICAL"]} pending={create.isPending} error={create.error} onClose={onClose}
      onSubmit={(d) => create.mutate({ workspaceId, slug: d.slug, name: d.name, description: d.description || undefined }, { onSuccess: (t) => { onClose(); void navigate(teamPath(t)); } })} />
  );
}
