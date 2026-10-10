import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import { MembersPanel } from "@/platform/components/MembersPanel";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { useRuntimeConfig } from "@/platform/runtime-config";

export default function MembersPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Members · ${productName}`} description="Who has which role" />
      <PageBreadcrumb pageTitle="Members" />
      <OrganizationGate>{(organization) => <MembersPanel key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
