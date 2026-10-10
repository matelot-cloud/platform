import { JobsPanel } from "@/platform/components/JobsPanel";
import { useProject } from "./layout";

export default function ProjectJobsPage() {
  const { project } = useProject();
  return <JobsPanel projectId={project.id} />;
}
