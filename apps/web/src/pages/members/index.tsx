import PageMeta from "@/components/common/PageMeta";
import { useTeams } from "@/platform/api/hooks";
import type { Organization } from "@/platform/api/types";
import { ScopeMembers } from "@/platform/components/members/ScopeMembers";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { useRuntimeConfig } from "@/platform/runtime-config";

function OrganizationMembers({ organization }: { organization: Organization }) {
  const teams = useTeams(organization.id);
  return <ScopeMembers scope={{ type: "ORGANIZATION", id: organization.id, name: organization.name }} workspaceOfTeam={(id) => (teams.data ?? []).find((t) => t.id === id)?.workspaceId} />;
}

export default function MembersPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Members · ${productName}`} description="Who has which role" />
      <OrganizationGate>{(organization) => <OrganizationMembers key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
