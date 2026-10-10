import type { JobLogChunk } from "@/platform/api/types";
import { cn } from "@/utils";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Terminal-style log viewer: black panel, line numbers, coloured streams, optional timestamps,
 * follow-tail while live, wrap toggle, copy/download. Chunks are split into lines so numbering is per line.
 */
export function TerminalLog({ chunks, live, empty, title, className, maxHeight = "36rem" }: { chunks: JobLogChunk[]; live?: boolean; empty?: string; title?: string; className?: string; maxHeight?: string }) {
  const [wrap, setWrap] = useState(false);
  const [times, setTimes] = useState(false);
  const [follow, setFollow] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const out: { n: number; stream: JobLogChunk["stream"]; text: string; at: string }[] = [];
    for (const c of chunks) for (const text of c.content.replace(/\n$/, "").split("\n")) out.push({ n: out.length + 1, stream: c.stream, text, at: c.at });
    return out;
  }, [chunks]);
  useEffect(() => { if (live && follow) end.current?.scrollIntoView({ block: "end" }); }, [lines.length, live, follow]);
  const plain = () => lines.map((l) => (times ? `${new Date(l.at).toISOString()} ` : "") + l.text).join("\n");
  const download = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([plain()], { type: "text/plain" })); a.download = `${(title ?? "log").replace(/[^\w.-]+/g, "_")}.log`; a.click(); };
  return (
    <div className={cn("overflow-hidden rounded-xl border border-gray-800 bg-gray-950", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-800 bg-gray-900 px-3 py-1.5 text-xs text-gray-400">
        <span className="flex items-center gap-2"><span className="flex gap-1"><span className="size-2.5 rounded-full bg-red-500/70" /><span className="size-2.5 rounded-full bg-yellow-500/70" /><span className="size-2.5 rounded-full bg-green-500/70" /></span>{title && <span className="ms-1 font-medium text-gray-300">{title}</span>}<span>· {lines.length} lines{live ? " · live" : ""}</span></span>
        <span className="flex items-center gap-3">
          {live && <button type="button" className={cn("hover:text-gray-200", follow && "text-emerald-400")} onClick={() => setFollow((v) => !v)}>follow</button>}
          <button type="button" className={cn("hover:text-gray-200", times && "text-gray-200")} onClick={() => setTimes((v) => !v)}>timestamps</button>
          <button type="button" className={cn("hover:text-gray-200", wrap && "text-gray-200")} onClick={() => setWrap((v) => !v)}>wrap</button>
          <button type="button" className="hover:text-gray-200" onClick={() => void navigator.clipboard?.writeText(plain())}>copy</button>
          <button type="button" className="hover:text-gray-200" onClick={download}>download</button>
        </span>
      </div>
      <div className="overflow-auto font-mono text-xs leading-5" style={{ maxHeight }}>
        {lines.length === 0 ? <p className="px-4 py-3 text-gray-500">{empty ?? "No output."}</p> : (
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((l) => (
                <tr key={l.n} className="align-top hover:bg-white/3">
                  <td className="w-12 select-none pe-3 ps-3 text-end text-gray-600">{l.n}</td>
                  {times && <td className="w-24 select-none pe-3 text-gray-600">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</td>}
                  <td className={cn("pe-4", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre", l.stream === "system" ? "text-sky-300" : l.stream === "stderr" ? "text-orange-300" : "text-gray-100")}>{l.text || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div ref={end} />
      </div>
    </div>
  );
}
