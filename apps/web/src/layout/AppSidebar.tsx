import { Brand } from "@/components/common/Brand";
import { Mascot } from "@/components/common/Mascot";
import { useSidebar } from "@/context/SidebarContext";
import { BoltIcon, BoxCubeIcon, CheckCircleIcon, ChevronLeftIcon, DataBaseIcon, DocsIcon, FolderIcon, GridIcon, GroupIcon, HorizontaLDots, ListIcon, LockIcon, PieChartIcon, PlugInIcon, SettingsAltIcon, ShootingStarIcon, TaskIcon, UserCircleIcon } from "@/icons";
import { useMe, useMeta } from "@/platform/api/hooks";
import { docsUrl, useRuntimeConfig } from "@/platform/runtime-config";
import { CriticalityBadge } from "@/platform/components/ui";
import { useRouteContext } from "@/platform/state/context";
import { useCurrentOrganization } from "@/platform/state/useCurrentOrganization";
import { cn } from "@/utils";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";

type NavItem = { name: string; icon: ReactNode; path: string; soon?: boolean; exact?: boolean; external?: boolean };
type NavGroup = { title: string; items: NavItem[] };


function organizationGroups(isAdmin: boolean, docs: string): NavGroup[] {
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

function workspaceGroups(id: string): NavGroup[] {
  const base = `/workspaces/${id}`;
  return [
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
      title: "Workspace",
      items: [
        { name: "Overview", icon: <GridIcon fontSize={24} />, path: base, exact: true },
        { name: "Teams & projects", icon: <FolderIcon fontSize={24} />, path: `${base}/projects` },
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

function projectGroups(id: string): NavGroup[] {
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

const AppSidebar: React.FC = () => {
  const { isExpanded, isMobileOpen, isHovered, setIsHovered, setIsMobileOpen } = useSidebar();
  const location = useLocation();
  const me = useMe();
  const { organization } = useCurrentOrganization();
  const ctx = useRouteContext(organization?.id);
  const showText = isExpanded || isHovered || isMobileOpen;

  useEffect(() => {
    if (isMobileOpen) setIsMobileOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const config = useRuntimeConfig();
  const meta = useMeta();
  // Administration → Users: cell administrators and the admins of the root organization (the API enforces the same)
  const rootSlug = meta.data?.rootOrganizationSlug;
  const isAdmin = me.data?.user.platformRole === "admin" || (me.data?.memberships ?? []).some((m) => m.role === "ORG_ADMIN" && m.scopeType === "ORGANIZATION" && !!rootSlug && m.scope?.slug === rootSlug);
  const groups = ctx.projectId ? projectGroups(ctx.projectId) : ctx.workspaceId ? workspaceGroups(ctx.workspaceId) : organizationGroups(isAdmin, docsUrl(config));
  const isActive = (item: NavItem) => (item.exact ? location.pathname === item.path : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`));

  const contextCard = ctx.projectId ? (
    <div className="mb-4 rounded-xl border border-gray-200 p-3 dark:border-gray-800">
      <p className="text-xs text-gray-500 dark:text-gray-400">Project · {ctx.project?.workspaceName} / {ctx.project?.teamName}</p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-gray-800 dark:text-white/90">{ctx.project?.name ?? "…"}</span>
        {ctx.project && <CriticalityBadge value={ctx.project.criticality} />}
      </div>
      <Link to={ctx.workspaceId ? `/workspaces/${ctx.workspaceId}` : "/projects"} className="mt-2 inline-flex items-center gap-1 text-xs text-brand-500 hover:underline">
        <ChevronLeftIcon className="size-3" /> {ctx.workspace?.name ?? "Workspace"}
      </Link>
    </div>
  ) : ctx.workspaceId ? (
    <div className="mb-4 rounded-xl border border-gray-200 p-3 dark:border-gray-800">
      <p className="text-xs text-gray-500 dark:text-gray-400">Workspace</p>
      <span className="mt-1 block truncate text-sm font-semibold text-gray-800 dark:text-white/90">{ctx.workspace?.name ?? "…"}</span>
      <Link to="/overview" className="mt-2 inline-flex items-center gap-1 text-xs text-brand-500 hover:underline">
        <ChevronLeftIcon className="size-3" /> {organization?.name ?? "Organization"}
      </Link>
    </div>
  ) : null;

  return (
    <aside
      className={cn(
        "fixed top-0 start-0 z-99999 mt-16 flex h-screen flex-col border-gray-200 bg-white px-5 text-gray-900 transition-all duration-300 ease-in-out xl:mt-0 xl:border-e dark:border-gray-800 dark:bg-gray-900",
        isExpanded || isMobileOpen ? "w-72.5" : isHovered ? "w-72.5" : "w-22.5",
        isMobileOpen ? "translate-x-0" : "-translate-x-full",
        "xl:translate-x-0",
      )}
      onMouseEnter={() => !isExpanded && setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className={cn("flex py-8", !isExpanded && !isHovered ? "xl:justify-center" : "justify-start")}>
        <Link to="/overview" aria-label="Go to overview">
          <Brand compact={!showText} />
        </Link>
      </div>
      <div className="no-scrollbar flex flex-col overflow-y-auto duration-300 ease-linear">
        {showText && contextCard}
        <nav className="mb-6">
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <div key={group.title}>
                <h2 className={cn("mb-4 flex text-xs leading-5 text-gray-400 uppercase", !isExpanded && !isHovered ? "xl:justify-center" : "justify-start")}>
                  {showText ? group.title : <HorizontaLDots className="size-6" />}
                </h2>
                <ul className="flex flex-col gap-1">
                  {group.items.map((item) => (
                    <li key={item.name}>
                      {item.soon ? (
                        <span className="group menu-item menu-item-inactive cursor-not-allowed opacity-60" title="Arrives in a later step">
                          <span className="menu-item-icon-size menu-item-icon-inactive">{item.icon}</span>
                          {showText && <span className="menu-item-text">{item.name}</span>}
                          {showText && <span className="menu-dropdown-badge menu-dropdown-badge-inactive ms-auto">soon</span>}
                        </span>
                      ) : item.external ? (
                        <a href={item.path} target="_blank" rel="noopener" className="group menu-item menu-item-inactive">
                          <span className="menu-item-icon-size menu-item-icon-inactive">{item.icon}</span>
                          {showText && <span className="menu-item-text">{item.name}</span>}
                        </a>
                      ) : (
                        <Link to={item.path} className={cn("group menu-item", isActive(item) ? "menu-item-active" : "menu-item-inactive")}>
                          <span className={cn("menu-item-icon-size", isActive(item) ? "menu-item-icon-active" : "menu-item-icon-inactive")}>{item.icon}</span>
                          {showText && <span className="menu-item-text">{item.name}</span>}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        {showText && (
          <div className="mt-auto flex items-center gap-3 px-4 pt-6 pb-2">
            <Mascot size={44} />
            <span className="text-xs leading-tight text-gray-400 dark:text-gray-500">Matelot keeps watch:<br />what ships, where it runs, how exposed it is.</span>
          </div>
        )}
      </div>
    </aside>
  );
};

export default AppSidebar;
