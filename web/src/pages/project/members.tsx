import { MembersPanel } from "@/platform/components/MembersPanel";
import { useProject } from "./layout";

export default function ProjectMembersPage() {
  const { organization, project } = useProject();
  return <MembersPanel key={project.id} organization={organization} initialScope={{ type: "PROJECT", id: project.id }} />;
}
