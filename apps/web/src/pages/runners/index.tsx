import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { RunnersPanel } from "@/platform/components/RunnersPanel";
import { useRuntimeConfig } from "@/platform/runtime-config";

export default function RunnersPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Runners · ${productName}`} description="Runner pools and runners" />
      <PageBreadcrumb pageTitle="Runners" />
      <OrganizationGate>{(organization) => <RunnersPanel key={organization.id} organizationId={organization.id} scopeType="ORGANIZATION" scopeId={organization.id} scopeName={organization.name} chainRefs={[{ type: "ORGANIZATION", id: organization.id }]} />}</OrganizationGate>
    </>
  );
}
