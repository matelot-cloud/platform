import { useCreatePipeline, usePipelineTemplates } from "@/platform/api/hooks";
import { cn } from "@/utils";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ErrorNotice, primaryButton } from "./ui";


/** "Run pipeline ▾": pick a template; navigates to the new pipeline. */
export function RunPipelineButton({ projectId, serviceId, repositoryId, disabled, className }: { projectId: string; serviceId: string; repositoryId?: string; disabled?: boolean; className?: string }) {
  const templates = usePipelineTemplates();
  const create = useCreatePipeline(projectId);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);
  const run = (template: string) => {
    setOpen(false);
    create.mutate({ serviceId, template, repositoryId }, { onSuccess: (p) => void navigate(`/projects/${projectId}/pipelines/${p.id}`) });
  };
  return (
    <div ref={ref} className={cn("relative", className)}>
      <button type="button" className={primaryButton} disabled={disabled || create.isPending} onClick={() => setOpen((o) => !o)}>{create.isPending ? "Starting…" : "Run pipeline"} <span aria-hidden>▾</span></button>
      {open && (
        <div className="absolute end-0 z-50 mt-2 w-80 rounded-xl border border-gray-200 bg-white p-2 shadow-theme-lg dark:border-gray-800 dark:bg-gray-900">
          {(templates.data ?? []).map((t) => (
            <button key={t.key} type="button" onClick={() => run(t.key)} className="block w-full rounded-lg px-3 py-2 text-start hover:bg-gray-50 dark:hover:bg-white/5">
              <span className="block text-sm font-medium text-gray-800 dark:text-white/90">{t.name}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">{t.description}</span>
              <span className="mt-1 block text-xs text-gray-400">{t.stages.map((s) => s.name).join(" → ")}</span>
            </button>
          ))}
        </div>
      )}
      {create.error ? <div className="absolute end-0 mt-2 w-80"><ErrorNotice error={create.error} /></div> : null}
    </div>
  );
}
