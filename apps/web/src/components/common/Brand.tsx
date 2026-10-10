import { useRuntimeConfig } from "@/platform/runtime-config";
import { cn } from "@/utils";

/** The platform mark (captain's cap, /logo.png). */
export function BrandMark({ className }: { className?: string }) {
  return <img src="/logo.png" alt="" aria-hidden="true" className={cn("size-8 shrink-0 select-none", className)} draggable={false} />;
}

/** Logo: mark plus the product name from runtime config. */
export function Brand({ compact = false }: { compact?: boolean }) {
  const { productName } = useRuntimeConfig();
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark />
      {!compact && <span className="text-lg font-semibold whitespace-nowrap text-gray-800 dark:text-white/90">{productName}</span>}
    </span>
  );
}
