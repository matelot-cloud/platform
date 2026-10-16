import PageMeta from "@/components/common/PageMeta";
import { useWorkspaces } from "@/platform/api/hooks";
import type { Organization, Workspace } from "@/platform/api/types";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, EmptyState, muted } from "@/platform/components/ui";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { Outlet, useOutletContext, useParams } from "react-router";

export interface WorkspaceContext {
  organization: Organization;
  workspace: Workspace;
}

export function useWorkspace(): WorkspaceContext {
  return useOutletContext<WorkspaceContext>();
}

function Shell({ organization, workspaceId }: { organization: Organization; workspaceId: string }) {
  const workspaces = useWorkspaces(organization.id);
  const workspace = (workspaces.data ?? []).find((w) => w.id === workspaceId);
  if (workspaces.isLoading) return <p className={`text-sm ${muted}`}>Loading…</p>;
  if (!workspace) return <Card flush><EmptyState title="Workspace not found">It may be archived or outside your access.</EmptyState></Card>;
  return (
    // the breadcrumb, heading and sidebar card come from the app layout (platform/navigation)
    <Outlet context={{ organization, workspace } satisfies WorkspaceContext} />
  );
}

export default function WorkspaceLayout() {
  const { productName } = useRuntimeConfig();
  const { workspaceId = "" } = useParams();
  return (
    <>
      <PageMeta title={`Workspace · ${productName}`} description="Workspace" />
      <OrganizationGate>{(organization) => <Shell key={workspaceId} organization={organization} workspaceId={workspaceId} />}</OrganizationGate>
    </>
  );
}
