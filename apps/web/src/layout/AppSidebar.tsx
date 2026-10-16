import { Brand } from "@/components/common/Brand";
import { Mascot } from "@/components/common/Mascot";
import { useSidebar } from "@/context/SidebarContext";
import { ChevronLeftIcon, HorizontaLDots } from "@/icons";
import { CriticalityBadge } from "@/platform/components/ui";
import { isActive as itemActive, LEVEL_LABEL, useScopeLocation, type NavItem } from "@/platform/navigation/scope";
import { cn } from "@/utils";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";

const AppSidebar: React.FC = () => {
  const { isExpanded, isMobileOpen, isHovered, setIsHovered, setIsMobileOpen } = useSidebar();
  const location = useLocation();
  const loc = useScopeLocation();
  const showText = isExpanded || isHovered || isMobileOpen;

  useEffect(() => {
    if (isMobileOpen) setIsMobileOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const groups = loc.groups;
  const isActive = (item: NavItem) => itemActive(item, location.pathname);
  const card =
    loc.level === "project" ? { kind: "project" as const, name: loc.project?.name, to: `/projects/${loc.projectId}`, extra: loc.project ? <CriticalityBadge value={loc.project.criticality} /> : null }
    : loc.level === "team" ? { kind: "team" as const, name: loc.team?.name, to: loc.crumbs.find((c) => c.kind === "Team")?.to ?? "/projects", extra: null }
    : loc.level === "workspace" ? { kind: "workspace" as const, name: loc.workspace?.name, to: `/workspaces/${loc.workspaceId}`, extra: null }
    : { kind: "organization" as const, name: loc.organization?.name, to: "/overview", extra: null };

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
        <Link to="/overview" aria-label="Go to overview" className="min-w-0">
          <Brand compact={!showText} />
        </Link>
      </div>
      <div className="no-scrollbar flex flex-col overflow-y-auto duration-300 ease-linear">
        <ScopeCard kind={card.kind} name={card.name} to={card.to} extra={card.extra} parent={loc.parent} compact={!showText} />
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

/**
 * "You are here": the current scope as a card at the top of the sidebar (initial + name + type), with
 * "← Back to <parent>" above it. Long names are cut with an ellipsis; the full name is on hover.
 */
function ScopeCard({ kind, name, to, extra, parent, compact }: { kind: "organization" | "workspace" | "team" | "project"; name: string | undefined; to: string; extra: React.ReactNode; parent: { label: string; to: string } | null; compact: boolean }) {
  const label = LEVEL_LABEL[kind];
  const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  const tone = kind === "project" ? "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400" : kind === "team" ? "bg-success-50 text-success-600 dark:bg-success-500/15 dark:text-success-500" : kind === "workspace" ? "bg-warning-50 text-warning-600 dark:bg-warning-500/15 dark:text-orange-400" : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  const avatar = <span aria-hidden="true" className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold", tone)}>{initial}</span>;
  if (compact) return <Link to={to} title={`${label}: ${name ?? ""}`} className="mb-4 flex justify-center xl:justify-center">{avatar}</Link>;
  return (
    <div className="mb-5" data-testid="scope-card">
      {parent && (
        <Link to={parent.to} title={parent.label} className="mb-2 flex min-w-0 items-center gap-1 text-xs text-gray-500 hover:text-brand-500 dark:text-gray-400">
          <ChevronLeftIcon className="size-3 shrink-0" /> <span className="truncate">Back to {parent.label}</span>
        </Link>
      )}
      <Link to={to} className="flex min-w-0 items-center gap-3 rounded-xl border border-gray-200 p-3 hover:border-brand-300 dark:border-gray-800 dark:hover:border-brand-500/60">
        {avatar}
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-gray-500 dark:text-gray-400">{label}</span>
          <span className="block truncate text-sm font-semibold text-gray-800 dark:text-white/90" title={name}>{name ?? "…"}</span>
        </span>
        {extra}
      </Link>
    </div>
  );
}

export default AppSidebar;
