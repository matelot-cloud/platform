import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { PlusIcon } from "@/icons";
import { isForbidden } from "@/platform/api/client";
import { useArchiveEnvironment, useAttachRepository, useCreateEnvironment, useDetachRepository, useEnvironments, useProjectPipelines, useProjectRepositories, useServiceRepositories } from "@/platform/api/hooks";
import { PipelineGraph } from "./PipelineGraph";
import { RunPipelineButton } from "./RunPipelineButton";
import { StatusIcon } from "./StatusIcon";
import { relativeTime } from "@/platform/format";
import type { EnvironmentKind, Organization, ProjectRow, Service } from "@/platform/api/types";
import { dangerLink, EmptyState, ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField, td, th, trBorder } from "@/platform/components/ui";
import { Card } from "@/platform/components/ui";
import { SLUG_PATTERN, slugify, titleCase } from "@/platform/format";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";


export const ENV_COLOR: Record<EnvironmentKind, "light" | "info" | "warning" | "error"> = { development: "light", testing: "info", staging: "warning", production: "error" };

export function EnvironmentDialog({ kinds, pending, error, onSubmit, onClose }: { kinds: EnvironmentKind[]; pending: boolean; error: unknown; onSubmit: (d: { slug: string; name: string; kind: EnvironmentKind; internetFacing: boolean }) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [kind, setKind] = useState<EnvironmentKind>("production");
  const [internetFacing, setInternetFacing] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ slug, name, kind, internetFacing });
  };
  return (
    <Modal isOpen title="New environment" onClose={onClose} className="max-w-150 p-6 lg:p-10">
      <form onSubmit={submit}>
        <div className="space-y-5">
          <div>
            <Label htmlFor="env-name">Name</Label>
            <input id="env-name" autoFocus required maxLength={120} className={inputClass} value={name} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} />
          </div>
          <div>
            <Label htmlFor="env-slug">Slug</Label>
            <input id="env-slug" required pattern={SLUG_PATTERN} maxLength={63} className={inputClass} value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
          </div>
          <div>
            <Label>Kind</Label>
            <SelectField value={kind} onChange={(v) => setKind(v as EnvironmentKind)} options={kinds.map((k) => ({ value: k, label: titleCase(k) }))} />
          </div>
          <label className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-400">
            <input type="checkbox" className="size-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500/20" checked={internetFacing} onChange={(e) => setInternetFacing(e.target.checked)} />
            Reachable from the internet <span className={`text-xs ${muted}`}>(raises risk for findings in this environment)</span>
          </label>
          {error ? <ErrorNotice error={error} /> : null}
        </div>
        <div className="mt-8 flex justify-end gap-3">
          <button type="button" onClick={onClose} className={outlineButton}>Cancel</button>
          <button type="submit" disabled={pending} className={primaryButton}>{pending ? "Creating…" : "Create environment"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ServicePanel({ organization, project, service, environmentKinds }: { organization: Organization; project: ProjectRow; service: Service; environmentKinds: EnvironmentKind[] }) {
  const environments = useEnvironments(service.id);
  const repos = useServiceRepositories(service.id);
  const inventory = useProjectRepositories(project.id);
  const createEnv = useCreateEnvironment(service.id);
  const archiveEnv = useArchiveEnvironment(service.id);
  const attach = useAttachRepository(organization.id, service.id);
  const detach = useDetachRepository(organization.id, service.id);
  const [envDialog, setEnvDialog] = useState(false);
  const [picker, setPicker] = useState(false);
  const [pick, setPick] = useState("");
  const pipelines = useProjectPipelines(project.id);
  const servicePipelines = (pipelines.data ?? []).filter((p) => p.serviceId === service.id).slice(0, 5);

  const attachedIds = new Set((repos.data ?? []).map((r) => r.repository.id));
  const candidates = (inventory.data ?? []).filter((r) => !attachedIds.has(r.id) && !r.archived);

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-2">
      <Card title="Environments" flush actions={<button type="button" className={outlineButton} onClick={() => setEnvDialog(true)}><PlusIcon className="size-4" /> New environment</button>}>
        {environments.error ? (
          <div className="p-4"><ErrorNotice error={environments.error} /></div>
        ) : (environments.data ?? []).length === 0 ? (
          <EmptyState title="No environments yet">Environments tell the risk engine where a service runs and whether it is exposed. Production comes first.</EmptyState>
        ) : (
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Environment</th><th className={th}>Kind</th><th className={th}>Exposure</th><th className={th} /></tr></thead>
            <tbody>
              {(environments.data ?? []).map((e) => (
                <tr key={e.id} className={trBorder}>
                  <td className={td}><span className="font-medium text-gray-800 dark:text-white/90">{e.name}</span> <span className={`text-xs ${muted}`}>{e.slug}</span></td>
                  <td className={td}><Badge size="sm" color={ENV_COLOR[e.kind]}>{e.kind}</Badge></td>
                  <td className={`${td} ${muted}`}>{e.internetFacing ? "internet-facing" : "internal"}</td>
                  <td className={`${td} text-end`}><button type="button" className={dangerLink} onClick={() => { if (window.confirm(`Archive environment ${e.name}?`)) archiveEnv.mutate(e.id); }}>Archive</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Repositories"
        description="Source code of this service, from connected integrations."
        flush
        actions={
          <>
            {(repos.data ?? []).length > 0 && <RunPipelineButton projectId={project.id} serviceId={service.id} />}
            <button type="button" className={outlineButton} onClick={() => setPicker(true)} disabled={isForbidden(inventory.error)}><PlusIcon className="size-4" /> Attach repository</button>
          </>
        }
      >
        {repos.error ? (
          <div className="p-4"><ErrorNotice error={repos.error} /></div>
        ) : (repos.data ?? []).length === 0 ? (
          <EmptyState title="No repository attached">
            {(inventory.data ?? []).length === 0 ? (
              <>No repositories available to this project yet — connect a source below or at the <Link to={`/projects/${project.id}/integrations`} className="text-brand-500 hover:underline">project, team, workspace or organization level</Link>.</>
            ) : (
              "Attach the repository that builds this service."
            )}
          </EmptyState>
        ) : (
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Repository</th><th className={th}>Branch</th><th className={th}>Protection</th><th className={th} /></tr></thead>
            <tbody>
              {(repos.data ?? []).map(({ repository: r, role }) => (
                <tr key={r.id} className={trBorder}>
                  <td className={td}>
                    <a href={r.htmlUrl ?? "#"} target="_blank" rel="noreferrer" className="font-medium text-gray-800 hover:text-brand-500 dark:text-white/90">{r.fullName}</a>
                    <span className={`ms-2 text-xs ${muted}`}>{role}</span>
                  </td>
                  <td className={`${td} ${muted}`}>{r.defaultBranch ?? "—"}</td>
                  <td className={td}>{r.branchProtection ? <Badge size="sm" color="success">protected</Badge> : <Badge size="sm" color="warning">unprotected</Badge>}</td>
                  <td className={`${td} text-end`}><button type="button" className={dangerLink} onClick={() => detach.mutate(r.id)}>Detach</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {servicePipelines.length > 0 && (
          <div className="border-t border-gray-100 px-6 py-3 dark:border-gray-800">
            <p className={`mb-2 text-xs font-medium uppercase ${muted}`}>Recent pipelines</p>
            <ul className="space-y-1.5">
              {servicePipelines.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                  <Link to={`/projects/${project.id}/pipelines/${p.id}`} className="flex items-center gap-2 text-gray-800 hover:text-brand-500 dark:text-white/90"><StatusIcon status={p.status} size="sm" /> #{p.number} {p.name}</Link>
                  <span className="flex items-center gap-3"><PipelineGraph pipeline={p} projectId={project.id} compact /><span className={`text-xs ${muted}`}>{relativeTime(p.createdAt)}</span></span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      {envDialog && (
        <EnvironmentDialog kinds={environmentKinds} pending={createEnv.isPending} error={createEnv.error} onClose={() => setEnvDialog(false)} onSubmit={(d) => createEnv.mutate(d, { onSuccess: () => setEnvDialog(false) })} />
      )}
      {picker && (
        <Modal isOpen title={<>Attach a repository to {service.name}</>} description={<>Project {project.name} · repositories from this project's connections and the inherited ones.</>} onClose={() => setPicker(false)} className="max-w-150 p-6 lg:p-10">
          {candidates.length === 0 ? (
            <EmptyState title="Nothing left to attach">Every synced repository is already attached, or none is synced yet.</EmptyState>
          ) : (
            <div className="space-y-5">
              <SelectField ariaLabel="Repository" value={pick || candidates[0]!.id} onChange={setPick} options={candidates.map((r) => ({ value: r.id, label: `${r.fullName} · via ${r.integrationScope ? `${r.integrationScope.type.toLowerCase()} ${r.integrationScope.name}` : r.integrationName}${r.services.length ? ` · also in ${r.services.map((s) => s.serviceName).join(", ")}` : ""}` }))} />
              {attach.error ? <ErrorNotice error={attach.error} /> : null}
              <div className="flex justify-end gap-3">
                <button type="button" className={outlineButton} onClick={() => setPicker(false)}>Cancel</button>
                <button type="button" className={primaryButton} disabled={attach.isPending} onClick={() => attach.mutate({ repositoryId: pick || candidates[0]!.id }, { onSuccess: () => setPicker(false) })}>{attach.isPending ? "Attaching…" : "Attach"}</button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

