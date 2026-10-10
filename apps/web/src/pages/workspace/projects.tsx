import { ProjectsExplorer } from "@/pages/projects";
import { useWorkspace } from "./layout";

export default function WorkspaceProjectsPage() {
  const { organization, workspace } = useWorkspace();
  return <ProjectsExplorer key={workspace.id} organization={organization} workspaceId={workspace.id} />;
}
