import { useRuntimeConfig } from "@/platform/runtime-config";
import { Outlet } from "react-router";

/** Logo + content only: for flows the user must not navigate away from (OAuth consent). No sidebar, no header. */
export default function MinimalLayout() {
  const { productName } = useRuntimeConfig();
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="mx-auto flex max-w-xl items-center gap-2 px-6 pt-8">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">{productName.slice(0, 1).toUpperCase()}</span>
        <span className="text-base font-semibold text-gray-800 dark:text-white/90">{productName}</span>
      </div>
      <main className="px-6"><Outlet /></main>
    </div>
  );
}
