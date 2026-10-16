import { useTeams } from "@/platform/api/hooks";
import { ScopeMembers } from "@/platform/components/members/ScopeMembers";
import { useTeam } from "./layout";

/** Team → Members. */
export default function TeamMembersPage() {
  const { organization, team } = useTeam();
  const teams = useTeams(organization.id);
  return <ScopeMembers key={team.id} scope={{ type: "TEAM", id: team.id, name: team.name }} workspaceOfTeam={(id) => (teams.data ?? []).find((t) => t.id === id)?.workspaceId} />;
}
