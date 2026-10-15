import { useTeams } from "@/platform/api/hooks";
import { ScopeMembers } from "@/platform/components/members/ScopeMembers";
import { useWorkspace } from "./layout";

export default function WorkspaceMembersPage() {
  const { organization, workspace } = useWorkspace();
  const teams = useTeams(organization.id);
  return <ScopeMembers key={workspace.id} scope={{ type: "WORKSPACE", id: workspace.id, name: workspace.name }} workspaceOfTeam={(id) => (teams.data ?? []).find((t) => t.id === id)?.workspaceId} />;
}
