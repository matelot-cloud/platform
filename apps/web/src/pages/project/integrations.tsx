import { useProjectIntegrations, useProjectRepositories } from "@/platform/api/hooks";
import { IntegrationsPanel } from "@/platform/components/IntegrationsPanel";
import { useProject } from "./layout";

export default function ProjectIntegrationsPage() {
  const { organization, project } = useProject();
  const integrations = useProjectIntegrations(project.id);
  const repositories = useProjectRepositories(project.id);
  return (
    <IntegrationsPanel
      organizationId={organization.id}
      scopeType="PROJECT"
      scopeId={project.id}
      scopeName={project.name}
      integrations={integrations.data ?? []}
      error={integrations.error}
      repoCount={(id) => (repositories.data ?? []).filter((r) => r.integrationId === id).length}
      title="Connected sources for this project"
      inheritedRepositories={(repositories.data ?? []).filter((r) => r.integrationScope && !(r.integrationScope.type === "PROJECT" && r.integrationScope.id === project.id)).length}
    />
  );
}
