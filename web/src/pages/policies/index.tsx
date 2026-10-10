import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { PoliciesPanel } from "@/platform/components/PoliciesPanel";
import { useRuntimeConfig } from "@/platform/runtime-config";

export default function PoliciesPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Policies · ${productName}`} description="Security policies and gates" />
      <PageBreadcrumb pageTitle="Policies" />
      <OrganizationGate>{(organization) => <PoliciesPanel key={organization.id} organization={organization} scope={{ type: "organization", id: organization.id, name: organization.name }} showCi />}</OrganizationGate>
    </>
  );
}
