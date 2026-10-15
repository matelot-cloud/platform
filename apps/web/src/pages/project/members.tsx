import { useTeams } from "@/platform/api/hooks";
import { ScopeMembers } from "@/platform/components/members/ScopeMembers";
import { useProject } from "./layout";

export default function ProjectMembersPage() {
  const { organization, project } = useProject();
  const teams = useTeams(organization.id);
  return <ScopeMembers key={project.id} scope={{ type: "PROJECT", id: project.id, name: project.name }} workspaceOfTeam={(id) => (teams.data ?? []).find((t) => t.id === id)?.workspaceId} />;
}
