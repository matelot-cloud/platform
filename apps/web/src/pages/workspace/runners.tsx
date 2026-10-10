import { RunnersPanel } from "@/platform/components/RunnersPanel";
import { useWorkspace } from "./layout";

export default function WorkspaceRunnersPage() {
  const { organization, workspace } = useWorkspace();
  return <RunnersPanel organizationId={organization.id} scopeType="WORKSPACE" scopeId={workspace.id} scopeName={workspace.name} chainRefs={[{ type: "ORGANIZATION", id: organization.id }, { type: "WORKSPACE", id: workspace.id }]} />;
}
