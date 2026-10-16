import { BoltIcon, BoxCubeIcon, CheckCircleIcon, DataBaseIcon, DocsIcon, FolderIcon, GridIcon, GroupIcon, ListIcon, LockIcon, MultiUserIcon, PieChartIcon, PlugInIcon, SettingsAltIcon, ShootingStarIcon, TaskIcon, UserCircleIcon } from "@/icons";
import { useMe, useMeta, useProjects, useServices, useTeams, useWorkspaces } from "@/platform/api/hooks";
import type { Organization, ProjectRow, Service, TeamRow, Workspace } from "@/platform/api/types";
import { docsUrl, useRuntimeConfig } from "@/platform/runtime-config";
import { useSelectedServiceId } from "@/platform/state/service-selection";
import { useCurrentOrganization } from "@/platform/state/useCurrentOrganization";
import type { ReactNode } from "react";
import { useLocation, useMatch } from "react-router";

/**
 * Where am I? — the one place that turns the URL into a location (GitLab-style: the URL is the context).
 * The sidebar (context card + menu), the breadcrumb, the page heading, the browser tab title and the header
 * location switcher all read it, so they can never disagree.
 */

export type ScopeLevel = "organization" | "workspace" | "team" | "project" | "account" | "administration";
export type NavItem = { name: string; icon: ReactNode; path: string; exact?: boolean; external?: boolean; soon?: boolean };
export type NavGroup = { title: string; items: NavItem[] };
export interface Crumb { label: string; to?: string; kind?: string }

export const LEVEL_LABEL: Record<ScopeLevel, string> = {
  organization: "Organization", workspace: "Workspace", team: "Team", project: "Project", account: "Your account", administration: "Administration",
};

export const teamPath = (t: { id: string; workspaceId: string }) => `/workspaces/${t.workspaceId}/teams/${t.id}`;

export function organizationGroups(isAdmin: boolean, docs: string): NavGroup[] {
  return [
    {
      title: "Organization",
      items: [
        { name: "Overview", icon: <GridIcon fontSize={24} />, path: "/overview" },
        { name: "Projects", icon: <FolderIcon fontSize={24} />, path: "/projects", exact: true },
        { name: "Coverage", icon: <CheckCircleIcon fontSize={24} />, path: "/coverage" },
        { name: "Repositories", icon: <DataBaseIcon fontSize={24} />, path: "/repositories" },
        { name: "Connections", icon: <PlugInIcon fontSize={24} />, path: "/connections" },
        { name: "Runners", icon: <BoltIcon fontSize={24} />, path: "/runners" },
        { name: "Members", icon: <GroupIcon fontSize={24} />, path: "/members" },
        { name: "Audit trail", icon: <DocsIcon fontSize={24} />, path: "/audit" },
        { name: "Usage", icon: <PieChartIcon fontSize={24} />, path: "/usage" },
        { name: "Documentation", icon: <DocsIcon fontSize={24} />, path: docs, external: true }, // the public site (config.json docsUrl)
      ],
    },
    ...(isAdmin ? [{ title: "Administration", items: [{ name: "Users", icon: <UserCircleIcon fontSize={24} />, path: "/admin/users" }] }] : []),
  ];
}

export function workspaceGroups(id: string): NavGroup[] {
  const base = `/workspaces/${id}`;
  return [
    {
      title: "Workspace",
      items: [
        { name: "Overview", icon: <GridIcon fontSize={24} />, path: base, exact: true },
        { name: "Teams", icon: <MultiUserIcon fontSize={24} />, path: `${base}/teams`, exact: true },
        { name: "Projects", icon: <FolderIcon fontSize={24} />, path: `${base}/projects` },
        { name: "Members", icon: <GroupIcon fontSize={24} />, path: `${base}/members` },
      ],
    },
    {
      title: "Security",
      items: [
        { name: "Vulnerabilities", icon: <ShootingStarIcon fontSize={24} />, path: `${base}/vulnerabilities` },
        { name: "Risk", icon: <PieChartIcon fontSize={24} />, path: `${base}/risk` },
        { name: "Components", icon: <BoxCubeIcon fontSize={24} />, path: `${base}/components` },
        { name: "Policies", icon: <LockIcon fontSize={24} />, path: `${base}/policies` },
        { name: "Remediation", icon: <TaskIcon fontSize={24} />, path: `${base}/remediation` },
        { name: "CRA evidence", icon: <DocsIcon fontSize={24} />, path: `${base}/cra` },
        { name: "Notifications", icon: <BoltIcon fontSize={24} />, path: `${base}/notifications` },
      ],
    },
    {
      title: "Setup",
      items: [
        { name: "Repositories", icon: <DataBaseIcon fontSize={24} />, path: `${base}/repositories` },
        { name: "Integrations", icon: <PlugInIcon fontSize={24} />, path: `${base}/integrations` },
        { name: "Issue tracking", icon: <TaskIcon fontSize={24} />, path: `${base}/issue-tracking` },
        { name: "Runners", icon: <BoltIcon fontSize={24} />, path: `${base}/runners` },
        { name: "Settings", icon: <SettingsAltIcon fontSize={24} />, path: `${base}/settings` },
      ],
    },
  ];
}

export function teamGroups(team: { id: string; workspaceId: string }): NavGroup[] {
  const base = teamPath(team);
  return [
    {
      title: "Team",
      items: [
        { name: "Overview", icon: <GridIcon fontSize={24} />, path: base, exact: true },
        { name: "Members", icon: <GroupIcon fontSize={24} />, path: `${base}/members` },
        { name: "Settings", icon: <SettingsAltIcon fontSize={24} />, path: `${base}/settings` },
      ],
    },
  ];
}

export function projectGroups(id: string): NavGroup[] {
  const base = `/projects/${id}`;
  return [
    { title: "Project", items: [{ name: "Overview", icon: <GridIcon fontSize={24} />, path: base, exact: true }] },
    {
      title: "Delivery",
      items: [
        { name: "Releases & images", icon: <BoxCubeIcon fontSize={24} />, path: `${base}/inventory` },
        { name: "Environments", icon: <TaskIcon fontSize={24} />, path: `${base}/environments` },
        { name: "Pipelines", icon: <ListIcon fontSize={24} />, path: `${base}/pipelines` },
        { name: "Jobs", icon: <TaskIcon fontSize={24} />, path: `${base}/jobs` },
      ],
    },
    {
      title: "Security",
      items: [
        { name: "Vulnerabilities", icon: <ShootingStarIcon fontSize={24} />, path: `${base}/vulnerabilities` },
        { name: "Security graph", icon: <PieChartIcon fontSize={24} />, path: `${base}/graph` },
        { name: "Policies", icon: <LockIcon fontSize={24} />, path: `${base}/policies` },
        { name: "Remediation", icon: <TaskIcon fontSize={24} />, path: `${base}/remediation` },
        { name: "Coverage", icon: <CheckCircleIcon fontSize={24} />, path: `${base}/coverage` },
        { name: "CRA evidence", icon: <DocsIcon fontSize={24} />, path: `${base}/cra` },
        { name: "Notifications", icon: <BoltIcon fontSize={24} />, path: `${base}/notifications` },
      ],
    },
    {
      title: "Setup",
      items: [
        { name: "Services", icon: <BoxCubeIcon fontSize={24} />, path: `${base}/services` },
        { name: "Repositories", icon: <DataBaseIcon fontSize={24} />, path: `${base}/repositories` },
        { name: "Integrations", icon: <PlugInIcon fontSize={24} />, path: `${base}/integrations` },
        { name: "Issue tracking", icon: <TaskIcon fontSize={24} />, path: `${base}/issue-tracking` },
        { name: "Runners", icon: <BoltIcon fontSize={24} />, path: `${base}/runners` },
        { name: "Members", icon: <GroupIcon fontSize={24} />, path: `${base}/members` },
        { name: "Settings", icon: <SettingsAltIcon fontSize={24} />, path: `${base}/settings` },
      ],
    },
  ];
}

/** Pages that are not menu entries: the label of the page and, for detail pages, of the list they belong to. */
const DETAIL: { match: RegExp; parent?: string; label: string }[] = [
  { match: /^\/projects\/[^/]+\/pipelines\/[^/]+/, parent: "Pipelines", label: "Pipeline" },
  { match: /^\/projects\/[^/]+\/jobs\/[^/]+/, parent: "Jobs", label: "Job" },
  { match: /^\/projects\/[^/]+\/sboms\/[^/]+/, parent: "Releases & images", label: "SBOM" },
];
const EXTRA_PAGES: Record<string, string> = { "/notifications": "Notifications", "/integrations": "Connections", "/account/tokens": "Access tokens" };

export function isActive(item: NavItem, pathname: string): boolean {
  return item.exact ? pathname === item.path : pathname === item.path || pathname.startsWith(`${item.path}/`);
}

export interface ScopeLocation {
  level: ScopeLevel;
  organization: Organization | undefined;
  workspace: Workspace | undefined;
  team: TeamRow | undefined;
  project: ProjectRow | undefined;
  service: Service | null;
  workspaceId: string | undefined;
  teamId: string | undefined;
  projectId: string | undefined;
  /** The menu of the current scope. */
  groups: NavGroup[];
  /** "Members", "Pipeline", … */
  page: string;
  /** The deepest scope's name ("checkout-api") and kind ("project"). */
  scopeName: string | undefined;
  /** Org › Workspace › Team › Project › (Service) › [list ›] Page */
  crumbs: Crumb[];
  /** "Members · checkout-api · Globex" */
  documentTitle: string;
  /** Where "← Back to …" goes, with the parent's name. */
  parent: { label: string; to: string } | null;
  loading: boolean;
}

export function useScopeLocation(): ScopeLocation {
  const { pathname } = useLocation();
  const config = useRuntimeConfig();
  const me = useMe();
  const meta = useMeta();
  const { organization } = useCurrentOrganization();
  const teamMatch = useMatch("/workspaces/:workspaceId/teams/:teamId/*");
  const wsMatch = useMatch("/workspaces/:workspaceId/*");
  const projectMatch = useMatch("/projects/:projectId/*");
  const workspaces = useWorkspaces(organization?.id);
  const teams = useTeams(organization?.id);
  const projects = useProjects(organization?.id);

  const projectId = projectMatch?.params.projectId;
  const project = projectId ? (projects.data ?? []).find((p) => p.id === projectId) : undefined;
  const teamId = project?.teamId ?? teamMatch?.params.teamId;
  const team = teamId ? (teams.data ?? []).find((t) => t.id === teamId) : undefined;
  const workspaceId = project?.workspaceId ?? team?.workspaceId ?? teamMatch?.params.workspaceId ?? wsMatch?.params.workspaceId;
  const workspace = workspaceId ? (workspaces.data ?? []).find((w) => w.id === workspaceId) : undefined;
  const services = useServices(projectId);
  const serviceId = useSelectedServiceId(projectId ?? "");
  const service = projectId ? (services.data ?? []).find((s) => s.id === serviceId) ?? null : null;

  const rootSlug = meta.data?.rootOrganizationSlug;
  const isAdmin = me.data?.user.platformRole === "admin" || (me.data?.memberships ?? []).some((m) => m.role === "ORG_ADMIN" && m.scopeType === "ORGANIZATION" && !!rootSlug && m.scope?.slug === rootSlug);

  const level: ScopeLevel = projectId ? "project" : teamMatch ? "team" : wsMatch ? "workspace" : pathname.startsWith("/admin/") ? "administration" : pathname.startsWith("/account/") ? "account" : "organization";
  const groups =
    level === "project" ? projectGroups(projectId!)
    : level === "team" ? teamGroups({ id: teamId!, workspaceId: workspaceId! })
    : level === "workspace" ? workspaceGroups(workspaceId!)
    : organizationGroups(isAdmin, docsUrl(config));

  // the page: the longest menu entry the path is in, plus a detail page under it
  const items = groups.flatMap((g) => g.items).filter((i) => !i.external);
  const item = items.filter((i) => isActive(i, pathname)).sort((a, b) => b.path.length - a.path.length)[0];
  const detail = DETAIL.find((d) => d.match.test(pathname));
  const listItem = detail?.parent ? items.find((i) => i.name === detail.parent) : undefined;
  const page = detail?.label ?? item?.name ?? EXTRA_PAGES[pathname] ?? (level === "team" ? "Overview" : "");

  const orgName = organization?.name ?? "Organization";
  const crumbs: Crumb[] = [];
  if (level === "administration") crumbs.push({ label: "Administration", kind: "Cell" });
  else if (level === "account") crumbs.push({ label: "Your account" });
  else crumbs.push({ label: orgName, to: "/overview", kind: "Organization" });
  if (workspaceId) crumbs.push({ label: workspace?.name ?? "…", to: `/workspaces/${workspaceId}`, kind: "Workspace" });
  if (teamId && workspaceId) crumbs.push({ label: team?.name ?? project?.teamName ?? "…", to: teamPath({ id: teamId, workspaceId }), kind: "Team" });
  if (projectId) crumbs.push({ label: project?.name ?? "…", to: `/projects/${projectId}`, kind: "Project" });
  if (projectId && service) crumbs.push({ label: service.name, to: `/projects/${projectId}/services?service=${service.id}`, kind: "Service" });
  if (listItem) crumbs.push({ label: listItem.name, to: listItem.path });
  if (page) crumbs.push({ label: page });

  const scopeName =
    level === "project" ? project?.name
    : level === "team" ? team?.name
    : level === "workspace" ? workspace?.name
    : level === "organization" ? organization?.name
    : undefined;
  const titleParts = [page || LEVEL_LABEL[level], ...(level === "organization" || level === "account" || level === "administration" ? [] : [scopeName ?? "…"]), level === "administration" ? "Administration" : orgName];
  const parent =
    level === "project" && teamId && workspaceId ? { label: team?.name ?? project?.teamName ?? "Team", to: teamPath({ id: teamId, workspaceId }) }
    : level === "team" && workspaceId ? { label: workspace?.name ?? "Workspace", to: `/workspaces/${workspaceId}` }
    : level === "workspace" ? { label: orgName, to: "/overview" }
    : level === "account" || level === "administration" ? { label: orgName, to: "/overview" }
    : null;

  return {
    level, organization, workspace, team, project, service, workspaceId, teamId, projectId, groups, page, scopeName, crumbs,
    documentTitle: titleParts.join(" · "), parent,
    loading: workspaces.isLoading || teams.isLoading || projects.isLoading,
  };
}
