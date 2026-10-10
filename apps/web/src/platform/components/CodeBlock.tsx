import { cn } from "@/utils";
import { useState } from "react";

/**
 * Terminal-style code block: black background, line numbers, optional copy. Used for every snippet in the app
 * (CI jobs, tokens, keys, webhook payloads, evidence) so they all look and behave the same.
 */
export function CodeBlock({ code, className, wrap, copy = true, lines = true, maxHeight }: { code: string; className?: string; wrap?: boolean; copy?: boolean; lines?: boolean; maxHeight?: string }) {
  const [copied, setCopied] = useState(false);
  const rows = code.replace(/\n$/, "").split("\n");
  const width = String(rows.length).length;
  return (
    <div className={cn("group relative overflow-hidden rounded-lg border border-gray-800 bg-black text-gray-100 shadow-theme-xs", className)}>
      {copy && (
        <button type="button" aria-label="Copy" onClick={() => { void navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="absolute end-2 top-2 z-10 rounded-md border border-gray-700 bg-gray-900/90 px-2 py-1 text-[11px] font-medium text-gray-300 opacity-0 transition hover:bg-gray-800 hover:text-white group-hover:opacity-100 focus:opacity-100">
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      <div className={cn("overflow-auto", maxHeight)} style={maxHeight ? undefined : undefined}>
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {rows.map((line, i) => (
              <tr key={i} className="align-top hover:bg-white/5">
                {lines && <td className="select-none border-e border-gray-800 bg-gray-950 px-3 text-end text-gray-500" style={{ minWidth: `${width + 2}ch` }}>{i + 1}</td>}
                <td className={cn("px-4", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre", i === 0 && "pt-2", i === rows.length - 1 && "pb-2", line.trimStart().startsWith("#") && "text-emerald-400/80")}>{line || " "}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
