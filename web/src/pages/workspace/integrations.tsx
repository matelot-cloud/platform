import { useIntegrations, useOrganizationRepositories } from "@/platform/api/hooks";
import { IntegrationsPanel } from "@/platform/components/IntegrationsPanel";
import { useWorkspace } from "./layout";

export default function WorkspaceIntegrationsPage() {
  const { organization, workspace } = useWorkspace();
  const integrations = useIntegrations(organization.id);
  const repositories = useOrganizationRepositories(organization.id);
  const list = (integrations.data ?? [])
    .filter((i) => (i.scope.type === "WORKSPACE" && i.scope.id === workspace.id) || i.scope.type === "ORGANIZATION")
    .map((i) => ({ ...i, inherited: i.scope.type === "ORGANIZATION" }));
  return (
    <IntegrationsPanel organizationId={organization.id} scopeType="WORKSPACE" scopeId={workspace.id} scopeName={workspace.name} integrations={list} error={integrations.error} repoCount={(id) => (repositories.data ?? []).filter((r) => r.integrationId === id).length} title="Connected sources for this workspace" />
  );
}
