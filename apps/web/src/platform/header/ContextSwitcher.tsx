import { ChevronDownIcon } from "@/icons";
import { useProjects, useServices, useTeams, useWorkspaces } from "@/platform/api/hooks";
import { teamPath, useScopeLocation } from "@/platform/navigation/scope";
import { setSelectedServiceId } from "@/platform/state/service-selection";
import { cn } from "@/utils";
import { useNavigate } from "react-router";

/**
 * Header location switcher: "Workspace: Platform ▾ › Team: Payments ▾ › Project: … ▾" — inside a project
 * "Workspace: Platform ▾ › Project: checkout-api ▾ › Service: … ▾" (its team is in the breadcrumb and sidebar).
 * It shows where you are and choosing a value goes there (the URL changes) — it is not a filter. "All …" appears
 * only on organization-wide pages. Styled as location pills so it never looks like a page's filter dropdown.
 */
export function ContextSwitcher() {
  const navigate = useNavigate();
  const loc = useScopeLocation();
  const orgId = loc.organization?.id;
  const workspaces = useWorkspaces(orgId);
  const teams = useTeams(orgId);
  const projects = useProjects(orgId);
  const services = useServices(loc.projectId);
  if (!loc.organization) return null;
  const orgWide = !loc.workspaceId;

  const wsOptions = [{ value: "", label: "All workspaces" }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))];
  const teamOptions = [{ value: "", label: "Select…" }, ...(teams.data ?? []).filter((t) => t.workspaceId === loc.workspaceId).map((t) => ({ value: t.id, label: t.name }))];
  const inScope = (projects.data ?? []).filter((p) => (!loc.workspaceId || p.workspaceId === loc.workspaceId) && (!loc.teamId || p.teamId === loc.teamId));
  const projectOptions = [{ value: "", label: orgWide ? "All projects" : "Select…" }, ...inScope.map((p) => ({ value: p.id, label: loc.teamId ? p.name : `${p.teamName} / ${p.name}` }))];
  const up = loc.teamId && loc.workspaceId ? teamPath({ id: loc.teamId, workspaceId: loc.workspaceId }) : loc.workspaceId ? `/workspaces/${loc.workspaceId}` : "/projects";

  return (
    <nav aria-label="Location" className="flex min-w-0 flex-wrap items-center gap-1.5 xl:flex-nowrap">
      <LocationSelect kind="Workspace" value={loc.workspaceId ?? ""} options={wsOptions} onChange={(v) => void navigate(v ? `/workspaces/${v}` : "/overview")} />
      {loc.workspaceId && !loc.projectId && (
        <>
          <Sep />
          <LocationSelect kind="Team" value={loc.teamId ?? ""} options={teamOptions} onChange={(v) => void navigate(v ? teamPath({ id: v, workspaceId: loc.workspaceId! }) : `/workspaces/${loc.workspaceId}`)} />
        </>
      )}
      <Sep />
      <LocationSelect kind="Project" value={loc.projectId ?? ""} options={projectOptions} onChange={(v) => void navigate(v ? `/projects/${v}` : up)} />
      {loc.projectId && (services.data ?? []).length > 0 && (
        <>
          <Sep />
          <LocationSelect kind="Service" compact value={loc.service?.id ?? ""} options={[{ value: "", label: "All" }, ...(services.data ?? []).map((s) => ({ value: s.id, label: s.name }))]} onChange={(v) => setSelectedServiceId(loc.projectId!, v)} />
        </>
      )}
    </nav>
  );
}

function Sep() {
  return <span aria-hidden="true" className="text-gray-300 dark:text-gray-600">›</span>;
}

/** A location pill: "Kind: current ▾" over a native select (keyboard and screen readers keep working). */
function LocationSelect({ kind, value, options, onChange, compact }: { kind: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; compact?: boolean }) {
  const current = options.find((o) => o.value === value) ?? options[0];
  const placeholder = !value;
  return (
    <label
      data-location={kind}
      title={`${kind}: ${current?.label ?? ""}`}
      className={cn("relative inline-flex h-9 min-w-16 items-center", compact || placeholder ? "max-w-40 shrink-0" : "max-w-56 shrink 2xl:max-w-64", " gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 text-sm transition hover:border-brand-300 hover:bg-white focus-within:border-brand-300 focus-within:ring-3 focus-within:ring-brand-500/10 dark:border-gray-800 dark:bg-white/3 dark:hover:border-brand-500/60")}
    >
      <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{kind}:</span>{" "}
      <span className={cn("min-w-0 truncate", placeholder ? "text-gray-500 dark:text-gray-400" : "font-medium text-gray-800 dark:text-white/90")}>{current?.label}</span>
      <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-gray-400" />
      <select aria-label={kind} value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer appearance-none opacity-0">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
