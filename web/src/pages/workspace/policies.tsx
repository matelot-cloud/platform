import { useTeams } from "@/platform/api/hooks";
import { PoliciesPanel } from "@/platform/components/PoliciesPanel";
import { useWorkspace } from "./layout";

export default function WorkspacePoliciesPage() {
  const { organization, workspace } = useWorkspace();
  const teams = (useTeams(organization.id).data ?? []).filter((t) => t.workspaceId === workspace.id);
  return <PoliciesPanel organization={organization} scope={{ type: "workspace", id: workspace.id, name: workspace.name }} teamChoices={teams.map((t) => ({ id: t.id, name: t.name }))} />;
}
