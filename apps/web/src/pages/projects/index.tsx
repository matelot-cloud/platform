import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { ChevronDownIcon, FolderIcon, PlusIcon } from "@/icons";
import { useCreateProject, useCreateTeam, useCreateWorkspace, useMeta, useProjects, useTeams, useWorkspaces } from "@/platform/api/hooks";
import type { Organization, ProjectRow, TeamRow, Workspace } from "@/platform/api/types";
import { NodeDialog } from "@/platform/components/NodeDialog";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, CriticalityBadge, EmptyState, ErrorNotice, inputClass, muted, outlineButton, primaryButton } from "@/platform/components/ui";
import { humanize, relativeTime } from "@/platform/format";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { cn } from "@/utils";
import { useMemo, useState } from "react";
import { Link } from "react-router";

type Dialog = { kind: "workspace" } | { kind: "team"; workspace: Workspace } | { kind: "project"; team: TeamRow } | null;
type Selection = { type: "all" } | { type: "workspace"; id: string } | { type: "team"; id: string };


export function ProjectsExplorer({ organization, workspaceId }: { organization: Organization; workspaceId?: string }) {
  const workspaces = useWorkspaces(organization.id);
  const teams = useTeams(organization.id);
  const projects = useProjects(organization.id);
  const meta = useMeta();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selection, setSelection] = useState<Selection>(workspaceId ? { type: "workspace", id: workspaceId } : { type: "all" });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const createWorkspace = useCreateWorkspace(organization.id);
  const createTeam = useCreateTeam(organization.id);
  const createProject = useCreateProject(organization.id);
  const criticalities = meta.data?.criticalities ?? ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

  const teamsByWorkspace = useMemo(() => {
    const m = new Map<string, TeamRow[]>();
    for (const t of teams.data ?? []) m.set(t.workspaceId, [...(m.get(t.workspaceId) ?? []), t]);
    return m;
  }, [teams.data]);
  const countByTeam = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of projects.data ?? []) m.set(p.teamId, (m.get(p.teamId) ?? 0) + 1);
    return m;
  }, [projects.data]);
  const countByWorkspace = (wsId: string) => (teamsByWorkspace.get(wsId) ?? []).reduce((n, t) => n + (countByTeam.get(t.id) ?? 0), 0);

  const needle = filter.trim().toLowerCase();
  const visible = (projects.data ?? []).filter((p) => {
    if (selection.type === "workspace" && p.workspaceId !== selection.id) return false;
    if (selection.type === "team" && p.teamId !== selection.id) return false;
    return !needle || `${p.name} ${p.slug} ${p.teamName} ${p.workspaceName}`.toLowerCase().includes(needle);
  });

  const selectedTeam = selection.type === "team" ? (teams.data ?? []).find((t) => t.id === selection.id) : undefined;
  const selectedWorkspace = selection.type === "workspace" ? (workspaces.data ?? []).find((w) => w.id === selection.id) : selectedTeam ? (workspaces.data ?? []).find((w) => w.id === selectedTeam.workspaceId) : undefined;
  const title = selectedTeam ? `${selectedWorkspace?.name ?? ""} / ${selectedTeam.name}` : selectedWorkspace ? selectedWorkspace.name : "All projects";
  const toggle = (id: string) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const close = () => setDialog(null);
  const isSel = (s: Selection) => JSON.stringify(s) === JSON.stringify(selection);

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-12">
      {/* ---------- structure tree ---------- */}
      <div className="xl:col-span-4 2xl:col-span-3">
        <Card
          title="Structure"
          description={`${(workspaces.data ?? []).length} workspaces · ${(teams.data ?? []).length} teams · ${(projects.data ?? []).length} projects`}
          flush
          actions={workspaceId ? undefined : <button type="button" className={outlineButton} onClick={() => setDialog({ kind: "workspace" })}><PlusIcon className="size-4" /> Workspace</button>}
        >
          {workspaces.error && <div className="p-4"><ErrorNotice error={workspaces.error} /></div>}
          <ul className="py-2">
            <li className={workspaceId ? "hidden" : ""}>
              <button type="button" onClick={() => setSelection({ type: "all" })} className={cn("flex w-full items-center justify-between px-5 py-2 text-sm", isSel({ type: "all" }) ? "bg-brand-50 font-medium text-brand-600 dark:bg-brand-500/10 dark:text-brand-400" : "text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/3")}>
                <span>All projects</span>
                <span className={`text-xs ${muted}`}>{(projects.data ?? []).length}</span>
              </button>
            </li>
            {(workspaces.data ?? []).filter((ws) => !workspaceId || ws.id === workspaceId).map((ws) => {
              const wsTeams = teamsByWorkspace.get(ws.id) ?? [];
              const open = !collapsed.has(ws.id);
              return (
                <li key={ws.id} className="mt-1">
                  <div className={cn("group flex items-center gap-1 px-3 py-1.5", isSel({ type: "workspace", id: ws.id }) ? "bg-brand-50 dark:bg-brand-500/10" : "hover:bg-gray-50 dark:hover:bg-white/3")}>
                    <button type="button" aria-label={open ? "Collapse" : "Expand"} onClick={() => toggle(ws.id)} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                      <ChevronDownIcon className={cn("size-4 transition-transform", !open && "-rotate-90")} />
                    </button>
                    <button type="button" onClick={() => setSelection({ type: "workspace", id: ws.id })} className={cn("flex flex-1 items-center justify-between text-sm", isSel({ type: "workspace", id: ws.id }) ? "font-medium text-brand-600 dark:text-brand-400" : "text-gray-800 dark:text-white/90")}>
                      <span className="truncate font-medium">{ws.name}</span>
                      <span className={`ms-2 text-xs ${muted}`}>{wsTeams.length} teams · {countByWorkspace(ws.id)}</span>
                    </button>
                    <button type="button" title="New team" aria-label={`New team in ${ws.name}`} onClick={() => setDialog({ kind: "team", workspace: ws })} className="rounded p-1 text-gray-400 opacity-0 hover:text-brand-500 group-hover:opacity-100 focus:opacity-100">
                      <PlusIcon className="size-4" />
                    </button>
                  </div>
                  {open && (
                    <ul className="mb-1">
                      {wsTeams.length === 0 && <li className={`px-12 py-1.5 text-xs ${muted}`}>no teams yet</li>}
                      {wsTeams.map((t) => (
                        <li key={t.id}>
                          <button type="button" onClick={() => setSelection({ type: "team", id: t.id })} className={cn("flex w-full items-center justify-between py-1.5 pe-5 ps-12 text-sm", isSel({ type: "team", id: t.id }) ? "bg-brand-50 font-medium text-brand-600 dark:bg-brand-500/10 dark:text-brand-400" : "text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/3")}>
                            <span className="truncate">{t.name}</span>
                            <span className={`text-xs ${muted}`}>{countByTeam.get(t.id) ?? 0}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
            {(workspaces.data ?? []).length === 0 && !workspaces.isLoading && (
              <li><EmptyState title="No workspaces yet">A workspace groups the teams of a business unit or product line.</EmptyState></li>
            )}
          </ul>
        </Card>
      </div>

      {/* ---------- projects ---------- */}
      <div className="xl:col-span-8 2xl:col-span-9">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-medium text-gray-800 dark:text-white/90">{title}</h3>
            <p className={`text-sm ${muted}`}>{visible.length} {visible.length === 1 ? "project" : "projects"}{selectedTeam ? "" : selectedWorkspace ? " across its teams" : " in the organization"}</p>
          </div>
          <div className="flex items-center gap-3 sm:shrink-0">
            <input className={`${inputClass} w-full sm:w-56`} placeholder="Filter projects" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter projects" />
            {selectedTeam && <Link className={outlineButton} to={`/workspaces/${selectedTeam.workspaceId}/teams/${selectedTeam.id}/members`}>Team members</Link>}
            {selectedTeam ? (
              <button type="button" className={primaryButton} onClick={() => setDialog({ kind: "project", team: selectedTeam })}><PlusIcon className="size-5" /> New project</button>
            ) : selectedWorkspace ? (
              <button type="button" className={primaryButton} onClick={() => setDialog({ kind: "team", workspace: selectedWorkspace })}><PlusIcon className="size-5" /> New team</button>
            ) : (
              <button type="button" className={primaryButton} onClick={() => setDialog({ kind: "workspace" })}><PlusIcon className="size-5" /> New workspace</button>
            )}
          </div>
        </div>

        {projects.error ? (
          <ErrorNotice error={projects.error} />
        ) : visible.length === 0 ? (
          <Card flush>
            <EmptyState title={needle ? "No project matches the filter" : selectedTeam ? "This team has no projects yet" : selectedWorkspace ? "No projects in this workspace yet" : "No projects yet"}>
              {!needle && (selectedTeam ? "Create the first project for this team." : selectedWorkspace ? "Select a team on the left to add a project, or add a team first." : "Expand a workspace on the left, pick a team and create a project.")}
            </EmptyState>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {visible.map((p: ProjectRow) => (
              <Link key={p.id} to={`/projects/${p.id}`} className="group rounded-2xl border border-gray-200 bg-white p-5 transition hover:border-brand-300 hover:shadow-theme-md dark:border-gray-800 dark:bg-white/3 dark:hover:border-brand-500/60">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800">
                    <FolderIcon className="size-5 text-gray-700 dark:text-white/80" />
                  </div>
                  <CriticalityBadge value={p.criticality} />
                </div>
                <h4 className="mt-4 truncate text-base font-medium text-gray-800 group-hover:text-brand-500 dark:text-white/90">{p.name}</h4>
                <p className={`truncate text-xs ${muted}`}>{p.slug}</p>
                <p className={`mt-3 truncate text-sm ${muted}`}>{p.workspaceName} / {p.teamName}</p>
                <div className="mt-3 flex items-center justify-between">
                  <Badge size="sm" color="light">{humanize(p.criticality)} criticality</Badge>
                  <span className={`text-xs ${muted}`}>updated {relativeTime(p.updatedAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {dialog?.kind === "workspace" && (
        <NodeDialog title="New workspace" submitLabel="Create workspace" criticalities={criticalities} pending={createWorkspace.isPending} error={createWorkspace.error} onClose={close}
          onSubmit={(d) => createWorkspace.mutate({ slug: d.slug, name: d.name, description: d.description || undefined }, { onSuccess: (ws) => { close(); setSelection({ type: "workspace", id: ws.id }); } })} />
      )}
      {dialog?.kind === "team" && (
        <NodeDialog title={`New team in ${dialog.workspace.name}`} submitLabel="Create team" criticalities={criticalities} pending={createTeam.isPending} error={createTeam.error} onClose={close}
          onSubmit={(d) => createTeam.mutate({ workspaceId: dialog.workspace.id, slug: d.slug, name: d.name, description: d.description || undefined }, { onSuccess: (t) => { close(); setSelection({ type: "team", id: t.id }); } })} />
      )}
      {dialog?.kind === "project" && (
        <NodeDialog title={`New project in ${dialog.team.name}`} submitLabel="Create project" withCriticality criticalities={criticalities} pending={createProject.isPending} error={createProject.error} onClose={close}
          onSubmit={(d) => createProject.mutate({ teamId: dialog.team.id, slug: d.slug, name: d.name, description: d.description || undefined, criticality: d.criticality }, { onSuccess: close })} />
      )}
    </div>
  );
}

export default function ProjectsPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Projects · ${productName}`} description="Workspaces, teams and projects" />
      <PageBreadcrumb pageTitle="Projects" />
      <OrganizationGate>{(organization) => <ProjectsExplorer key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
