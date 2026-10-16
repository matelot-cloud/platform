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
    <span className="flex min-w-0 items-center gap-2.5">
      <BrandMark />
      {/* long names ("Globex Corporation Security Platform") end in an ellipsis on one line; full name on hover */}
      {!compact && <span className="min-w-0 truncate text-lg font-semibold text-gray-800 dark:text-white/90" title={productName}>{productName}</span>}
    </span>
  );
}
