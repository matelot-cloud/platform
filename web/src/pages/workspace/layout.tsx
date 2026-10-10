import PageMeta from "@/components/common/PageMeta";
import { useWorkspaces } from "@/platform/api/hooks";
import type { Organization, Workspace } from "@/platform/api/types";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, EmptyState, muted } from "@/platform/components/ui";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { Link, Outlet, useOutletContext, useParams } from "react-router";

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
    <div className="space-y-6">
      <div>
        <p className={`text-sm ${muted}`}><Link to="/overview" className="hover:text-brand-500">{organization.name}</Link> / workspace</p>
        <h2 className="mt-1 text-xl font-semibold text-gray-800 dark:text-white/90">{workspace.name}</h2>
        {workspace.description && <p className={`mt-1 text-sm ${muted}`}>{workspace.description}</p>}
      </div>
      <Outlet context={{ organization, workspace } satisfies WorkspaceContext} />
    </div>
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
