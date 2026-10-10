import { Channels } from "@/pages/notifications";
import { useProject } from "./layout";

export default function ProjectNotificationsPage() {
  const { organization, project } = useProject();
  return <Channels organization={organization} scope={`projects/${project.id}`} scopeLabel={`project ${project.name}`} />;
}
