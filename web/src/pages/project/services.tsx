import Badge from "@/components/ui/badge/Badge";
import { PlusIcon } from "@/icons";
import { useCreateService, useMeta, useServices } from "@/platform/api/hooks";
import { ServiceManager } from "@/platform/components/ServiceManager";
import type { Criticality, EnvironmentKind, ServiceKind } from "@/platform/api/types";
import { NodeDialog } from "@/platform/components/NodeDialog";
import { ServicePanel } from "@/platform/components/ServicePanel";
import { Card, CriticalityBadge, EmptyState, ErrorNotice, muted, outlineButton, primaryButton, td, th, trBorder } from "@/platform/components/ui";
import { formatDate, humanize } from "@/platform/format";
import { useState } from "react";
import { useProject } from "./layout";


export default function ProjectServicesPage() {
  const { organization, project } = useProject();
  const services = useServices(project.id);
  const list = services.data ?? [];
  const meta = useMeta();
  const createService = useCreateService(organization.id, project.id);
  const [dialog, setDialog] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [manage, setManage] = useState<string | null>(null);
  const managed = list.find((s) => s.id === manage);
  const current = list.find((s) => s.id === selected) ?? list[0];
  const serviceKinds = (meta.data?.serviceKinds ?? ["api", "worker", "web", "library", "firmware", "infrastructure", "other"]) as ServiceKind[];
  const environmentKinds = (meta.data?.environmentKinds ?? ["development", "testing", "staging", "production"]) as EnvironmentKind[];
  const criticalities = meta.data?.criticalities ?? (["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Criticality[]);

  return (
    <div className="space-y-6">
      <Card title="Services" description="Deployable parts of this project: APIs, workers, web apps, firmware…" flush actions={<button type="button" className={primaryButton} onClick={() => setDialog(true)}><PlusIcon className="size-5" /> New service</button>}>
        {services.error ? <div className="p-4"><ErrorNotice error={services.error} /></div> : list.length === 0 ? (
          <EmptyState title="No services yet">A service is what gets built and deployed — the level where repositories, SBOMs and findings attach.</EmptyState>
        ) : (
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Service</th><th className={th}>Kind</th><th className={th}>Criticality</th><th className={th}>Updated</th><th className={th} /></tr></thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className={`${trBorder} cursor-pointer ${current?.id === s.id ? "bg-brand-50/60 dark:bg-brand-500/10" : "hover:bg-gray-50 dark:hover:bg-white/2"}`} onClick={() => setSelected(s.id)}>
                  <td className={td}>
                    <span className="font-medium text-gray-800 dark:text-white/90">{s.name}</span> <span className={`text-xs ${muted}`}>{s.slug}</span>
                    <span className={`block font-mono text-xs ${muted}`}>{s.id}</span>
                  </td>
                  <td className={td}><Badge size="sm" color="light">{humanize(s.kind)}</Badge></td>
                  <td className={td}>{s.criticality ? <CriticalityBadge value={s.criticality} /> : <span className={`text-xs ${muted}`}>inherits {humanize(project.criticality)}</span>}</td>
                  <td className={`${td} ${muted}`}>{formatDate(s.updatedAt)}</td>
                  <td className={`${td} text-end`}><button type="button" className={outlineButton} onClick={(e) => { e.stopPropagation(); setManage(s.id); }}>Manage</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {current && (
        <>
          <h3 className="text-base font-medium text-gray-800 dark:text-white/90">{current.name}</h3>
          <ServicePanel organization={organization} project={project} service={current} environmentKinds={environmentKinds} />
        </>
      )}
      {managed && <ServiceManager organization={organization} project={project} service={managed} kinds={serviceKinds} criticalities={criticalities} onClose={() => setManage(null)} onArchived={() => setSelected(null)} />}
      {dialog && (
        <NodeDialog title={`New service in ${project.name}`} submitLabel="Create service" withCriticality criticalities={criticalities} kinds={serviceKinds.map((k) => ({ value: k, label: humanize(k) }))} pending={createService.isPending} error={createService.error} onClose={() => setDialog(false)}
          onSubmit={(d) => createService.mutate({ slug: d.slug, name: d.name, description: d.description || undefined, kind: (d.kind as ServiceKind | undefined) ?? "other", criticality: d.criticality }, { onSuccess: (s) => { setDialog(false); setSelected(s.id); } })} />
      )}
    </div>
  );
}
