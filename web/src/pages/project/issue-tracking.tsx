import { IssueTrackingSetup } from "@/platform/components/IssueTrackingSetup";
import { useProject } from "./layout";

export default function ProjectIssueTrackingPage() {
  const { organization, project } = useProject();
  return <IssueTrackingSetup organizationId={organization.id} scopeType="PROJECT" scopeId={project.id} scopeName={project.name} projectId={project.id} />;
}
