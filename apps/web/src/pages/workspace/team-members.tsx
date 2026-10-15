import { useTeams } from "@/platform/api/hooks";
import { ScopeMembers } from "@/platform/components/members/ScopeMembers";
import { Card, EmptyState, muted } from "@/platform/components/ui";
import { Link, useParams } from "react-router";
import { useWorkspace } from "./layout";

/** Team → Members (teams have no layout of their own: the page lives under its workspace). */
export default function TeamMembersPage() {
  const { organization, workspace } = useWorkspace();
  const { teamId = "" } = useParams();
  const teams = useTeams(organization.id);
  const team = (teams.data ?? []).find((t) => t.id === teamId && t.workspaceId === workspace.id);
  if (teams.isLoading) return <p className={`text-sm ${muted}`}>Loading…</p>;
  if (!team) return <Card flush><EmptyState title="Team not found">It may be archived or outside your access.</EmptyState></Card>;
  return (
    <div className="space-y-3">
      <p className={`text-sm ${muted}`}><Link to={`/workspaces/${workspace.id}/projects`} className="hover:text-brand-500">Teams & projects</Link> / team <span className="font-medium text-gray-800 dark:text-white/90">{team.name}</span></p>
      <ScopeMembers key={team.id} scope={{ type: "TEAM", id: team.id, name: team.name }} workspaceOfTeam={(id) => (teams.data ?? []).find((t) => t.id === id)?.workspaceId} />
    </div>
  );
}
