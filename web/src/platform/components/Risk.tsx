import type { RiskFactors, RiskGrade } from "@/platform/api/types";
import { cn } from "@/utils";
import { muted } from "./ui";

export const GRADE_COLOR: Record<RiskGrade, string> = { A: "bg-success-500", B: "bg-success-400", C: "bg-warning-400", D: "bg-warning-500", E: "bg-error-400", F: "bg-error-600" };

/** Grade tile: big letter on a colored square with the score underneath. */
export function RiskGradeTile({ grade, score, size = "md", className }: { grade: RiskGrade | null; score: number | null; size?: "sm" | "md" | "lg"; className?: string }) {
  const dims = size === "lg" ? "size-16 text-3xl" : size === "sm" ? "size-8 text-sm" : "size-11 text-xl";
  return (
    <span className={cn("inline-flex flex-col items-center", className)} title={score !== null ? `Risk score ${score}/100` : "Not computed yet"}>
      <span className={cn("flex items-center justify-center rounded-xl font-bold text-white", dims, grade ? GRADE_COLOR[grade] : "bg-gray-300 dark:bg-gray-700")}>{grade ?? "–"}</span>
      {size !== "sm" && <span className={`mt-1 text-[11px] ${muted}`}>{score !== null ? `${score}/100` : "n/a"}</span>}
    </span>
  );
}

/** Horizontal score bar, colored by grade. */
export function RiskBar({ score, grade }: { score: number | null; grade: RiskGrade | null }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 w-28 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"><span className={cn("block h-full rounded-full", grade ? GRADE_COLOR[grade] : "bg-gray-300")} style={{ width: `${score ?? 0}%` }} /></span>
      <span className="w-8 text-end font-mono text-xs text-gray-800 dark:text-white/90">{score ?? "–"}</span>
    </span>
  );
}

/** Why a score is what it is. */
export function RiskFactorList({ factors }: { factors: RiskFactors }) {
  const c = factors.counts;
  return (
    <div className="space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <div><p className={`text-xs ${muted}`}>Findings pressure</p><p className="font-mono text-gray-800 dark:text-white/90">{factors.findingsPressure}</p><p className={`text-[11px] ${muted}`}>{c.critical} crit · {c.high} high · {c.medium} med · {c.low} low</p></div>
        <div><p className={`text-xs ${muted}`}>Exposure</p><p className="font-mono text-gray-800 dark:text-white/90">×{factors.exposureMultiplier}</p><p className={`text-[11px] ${muted}`}>{c.inProduction} in production · {c.internetFacing} internet-facing</p></div>
        <div><p className={`text-xs ${muted}`}>Criticality</p><p className="font-mono text-gray-800 dark:text-white/90">×{factors.criticalityMultiplier}</p><p className={`text-[11px] ${muted}`}>{c.kev} KEV · {c.fixable} fixable · {c.stale} older than 30 d</p></div>
        <div><p className={`text-xs ${muted}`}>Hygiene penalty</p><p className="font-mono text-gray-800 dark:text-white/90">+{factors.hygienePenalty}</p></div>
      </div>
      {factors.notes.length > 0 && <ul className={`list-disc space-y-0.5 ps-5 text-xs ${muted}`}>{factors.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}
