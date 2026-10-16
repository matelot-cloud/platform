import PageMeta from "@/components/common/PageMeta";
import type { Organization, ProjectRow, Service } from "@/platform/api/types";
import { useProjects, useServices } from "@/platform/api/hooks";
import { useEffect, useMemo } from "react";
import { setSelectedServiceId, useSelectedServiceId } from "@/platform/state/service-selection";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, EmptyState, muted } from "@/platform/components/ui";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { Outlet, useOutletContext, useParams, useSearchParams } from "react-router";

export interface ProjectContext {
  organization: Organization;
  project: ProjectRow;
  /** All services of the project. */
  services: Service[];
  /** The globally selected service (null = "all services" where a page supports it; pages needing one fall back to the first). */
  service: Service | null;
  /** The selected service, or the first one when "all" is chosen — for pages that always work on one service. */
  focusService: Service | null;
  setServiceId: (id: string) => void;
}

export function useProject(): ProjectContext {
  return useOutletContext<ProjectContext>();
}

function Shell({ organization, projectId }: { organization: Organization; projectId: string }) {
  const projects = useProjects(organization.id);
  const [params] = useSearchParams();
  const project = (projects.data ?? []).find((p) => p.id === projectId);
  const servicesQuery = useServices(projectId);
  const services = useMemo(() => servicesQuery.data ?? [], [servicesQuery.data]);
  const serviceId = useSelectedServiceId(projectId);
  const setServiceId = (id: string) => setSelectedServiceId(projectId, id);
  // ?service=<id> in a link pre-selects; a remembered id that no longer exists falls back to "all".
  useEffect(() => { const fromUrl = params.get("service"); if (fromUrl && fromUrl !== serviceId) setSelectedServiceId(projectId, fromUrl); }, [params, projectId, serviceId]);
  useEffect(() => { if (serviceId && services.length && !services.some((s) => s.id === serviceId)) setSelectedServiceId(projectId, ""); }, [serviceId, services, projectId]);
  const service = services.find((s) => s.id === serviceId) ?? null;
  const focusService = service ?? services[0] ?? null;
  if (projects.isLoading) return <p className={`text-sm ${muted}`}>Loading…</p>;
  if (!project) return <Card flush><EmptyState title="Project not found">It may be archived, in another organization, or outside your access.</EmptyState></Card>;
  return (
    <div className="space-y-6">
      {params.get("connected") && <div className="rounded-xl border border-success-500/30 bg-success-50 px-4 py-3 text-sm text-success-600 dark:bg-success-500/15 dark:text-success-500">GitHub connected to this project. Repositories are being synced; attach them to a service.</div>}
      <Outlet context={{ organization, project, services, service, focusService, setServiceId } satisfies ProjectContext} />
    </div>
  );
}

export default function ProjectLayout() {
  const { productName } = useRuntimeConfig();
  const { projectId = "" } = useParams();
  return (
    <>
      <PageMeta title={`Project · ${productName}`} description="Project" />
      <OrganizationGate>{(organization) => <Shell key={projectId} organization={organization} projectId={projectId} />}</OrganizationGate>
    </>
  );
}
