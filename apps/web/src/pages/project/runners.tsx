import { RunnersPanel } from "@/platform/components/RunnersPanel";
import { useProject } from "./layout";

export default function ProjectRunnersPage() {
  const { organization, project } = useProject();
  return (
    <RunnersPanel
      organizationId={organization.id}
      scopeType="PROJECT"
      scopeId={project.id}
      scopeName={project.name}
      chainRefs={[{ type: "ORGANIZATION", id: organization.id }, { type: "WORKSPACE", id: project.workspaceId }, { type: "TEAM", id: project.teamId }, { type: "PROJECT", id: project.id }]}
    />
  );
}
