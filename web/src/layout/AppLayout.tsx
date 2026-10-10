import { SidebarProvider, useSidebar } from "@/context/SidebarContext";
import { cn } from "@/utils";
import { Outlet } from "react-router";
import AppHeader from "./AppHeader";
import AppSidebar from "./AppSidebar";
import Backdrop from "./Backdrop";
import { useMeta } from "@/platform/api/hooks";
import { useRuntimeConfig } from "@/platform/runtime-config";

const Footer: React.FC = () => {
  const { productName } = useRuntimeConfig();
  const meta = useMeta();
  return (
    <footer className="mx-auto flex max-w-(--breakpoint-2xl) flex-wrap justify-between gap-2 px-4 pb-6 text-xs text-gray-500 md:px-6 dark:text-gray-400">
      <span>
        {productName}
        {meta.data?.rootOrganizationSlug ? ` · cell ${meta.data.rootOrganizationSlug}` : ""}
      </span>
      <span>
        {meta.data ? `API ${meta.data.version} · ` : ""}web {__APP_VERSION__}
      </span>
    </footer>
  );
};

const LayoutContent: React.FC = () => {
  const { isExpanded, isHovered, isMobileOpen } = useSidebar();

  return (
    <div className="min-h-screen xl:flex">
      <AppSidebar />
      <Backdrop />

      <div
        className={cn(
          "flex-1 transition-[margin] duration-300 ease-in-out",
          isExpanded || isHovered ? "xl:ms-72.5" : "xl:ms-22.5",
          isMobileOpen ? "ms-0" : "",
        )}
      >
        <AppHeader />
        <main className="mx-auto max-w-(--breakpoint-2xl) p-4 md:p-6">
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
};

const AppLayout: React.FC = () => {
  return (
    <SidebarProvider>
      <LayoutContent />
    </SidebarProvider>
  );
};

export default AppLayout;
