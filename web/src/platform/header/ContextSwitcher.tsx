import { useProjects, useServices, useWorkspaces } from "@/platform/api/hooks";
import { setSelectedServiceId, useSelectedServiceId } from "@/platform/state/service-selection";
import { SelectField } from "@/platform/components/ui";
import { useRouteContext } from "@/platform/state/context";
import { useCurrentOrganization } from "@/platform/state/useCurrentOrganization";
import { useNavigate } from "react-router";

/** Navbar: organization (if several) → workspace → project. Selecting navigates to that context. */
export function ContextSwitcher() {
  const navigate = useNavigate();
  const { organization } = useCurrentOrganization();
  const workspaces = useWorkspaces(organization?.id);
  const projects = useProjects(organization?.id);
  const ctx = useRouteContext(organization?.id);
  const services = useServices(ctx.projectId ?? undefined);
  const serviceId = useSelectedServiceId(ctx.projectId ?? undefined);
  if (!organization) return null;

  const wsOptions = [{ value: "", label: "All workspaces" }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))];
  const projectOptions = [{ value: "", label: "All projects" }, ...(projects.data ?? []).filter((p) => !ctx.workspaceId || p.workspaceId === ctx.workspaceId).map((p) => ({ value: p.id, label: `${p.teamName} / ${p.name}` }))];

  return (
    <div className="flex items-center gap-2">
      <SelectField ariaLabel="Workspace" value={ctx.workspaceId ?? ""} onChange={(v) => void navigate(v ? `/workspaces/${v}` : "/overview")} options={wsOptions} className="min-w-40 max-w-72 shrink-0" />
      <span className="text-gray-300 dark:text-gray-700">/</span>
      <SelectField ariaLabel="Project" value={ctx.projectId ?? ""} onChange={(v) => void navigate(v ? `/projects/${v}` : ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/projects` : "/projects")} options={projectOptions} className="min-w-48 max-w-96 shrink-0" />
      {ctx.projectId && (services.data ?? []).length > 0 && (
        <>
          <span className="text-gray-300 dark:text-gray-700">/</span>
          <SelectField ariaLabel="Service" value={(services.data ?? []).some((s) => s.id === serviceId) ? serviceId : ""} onChange={(v) => setSelectedServiceId(ctx.projectId!, v)} options={[{ value: "", label: "All services" }, ...(services.data ?? []).map((s) => ({ value: s.id, label: s.name }))]} className="min-w-36 max-w-56 shrink-0" />
        </>
      )}
    </div>
  );
}
