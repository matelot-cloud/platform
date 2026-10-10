import { PoliciesPanel } from "@/platform/components/PoliciesPanel";
import { useProject } from "./layout";

export default function ProjectPoliciesPage() {
  const { organization, project } = useProject();
  return <PoliciesPanel organization={organization} scope={{ type: "project", id: project.id, name: project.name }} />;
}
