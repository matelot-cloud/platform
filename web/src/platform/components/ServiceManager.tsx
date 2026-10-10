import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { useArchiveService, useEnvironments, useServiceRegistry, useServiceRepositories, useUpdateService } from "@/platform/api/hooks";
import type { Criticality, Organization, ProjectRow, Service, ServiceKind } from "@/platform/api/types";
import { formatDate, humanize } from "@/platform/format";
import { cn } from "@/utils";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CiSnippetBlock } from "./ci-snippets";
import { CriticalityBadge, dangerButton, ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField } from "./ui";

type Section = "overview" | "settings" | "environments" | "repositories" | "ci" | "danger";

function CopyLine({ label, value, mono = true, icon }: { label: string; value: string; mono?: boolean; icon?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-800">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">{label}</p>
        <p className={cn("truncate text-sm text-gray-800 dark:text-white/90", mono && "font-mono text-xs")}>{value}</p>
      </div>
      <button type="button" className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

function MatelotOff({ loading }: { loading: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-gray-300 px-3 py-2 dark:border-gray-700">
      <img src="/logo.png" alt="Matelot" className="size-7 shrink-0 rounded-md opacity-50 grayscale" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">Matelot Image repository</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{loading ? "Loading…" : "Not enabled on this cell: set REGISTRY_HOST in the API .env and restart."}</p>
      </div>
    </div>
  );
}

const KIND_DOT: Record<string, string> = { production: "bg-error-500", staging: "bg-warning-500", testing: "bg-warning-400", development: "bg-success-500" };

/** Manage a service: identifiers to copy, settings, environments, repositories, CI usage and archive. */
export function ServiceManager({ organization, project, service, kinds, criticalities, onClose, onArchived }: { organization: Organization; project: ProjectRow; service: Service; kinds: ServiceKind[]; criticalities: Criticality[]; onClose: () => void; onArchived?: () => void }) {
  const [section, setSection] = useState<Section>("overview");
  const envs = useEnvironments(service.id);
  const repos = useServiceRepositories(service.id);
  const registry = useServiceRegistry(service.id);
  const update = useUpdateService(project.id);
  const archive = useArchiveService(project.id);
  const [name, setName] = useState(service.name);
  const [description, setDescription] = useState(service.description ?? "");
  const [kind, setKind] = useState<string>(service.kind);
  const [criticality, setCriticality] = useState<string>(service.criticality ?? "");
  const [confirm, setConfirm] = useState("");
  const dirty = name !== service.name || description !== (service.description ?? "") || kind !== service.kind || criticality !== (service.criticality ?? "");
  const envList = envs.data ?? [];
  const repoList = repos.data ?? [];
  const primary = repoList.find((r) => r.role === "primary") ?? repoList[0];
  const imagePath = registry.data ? `${registry.data.host}/${registry.data.repository}` : null;
  const prodEnv = envList.find((e) => e.kind === "production") ?? envList[envList.length - 1];

  const nav: { key: Section; label: string; icon: ReactNode }[] = [
    { key: "overview", label: "Overview & IDs", icon: "#" },
    { key: "settings", label: "Settings", icon: "✎" },
    { key: "environments", label: `Environments (${envList.length})`, icon: "◎" },
    { key: "repositories", label: `Repositories (${repoList.length})`, icon: "⑂" },
    { key: "ci", label: "Use in CI", icon: "▶" },
    { key: "danger", label: "Archive", icon: "!" },
  ];

  return (
    <Modal isOpen onClose={onClose} className="max-w-240 p-0">
      <div className="flex flex-col md:flex-row">
        <aside className="border-b border-gray-100 p-4 md:w-60 md:shrink-0 md:border-e md:border-b-0 dark:border-gray-800">
          <p className="truncate text-base font-semibold text-gray-800 dark:text-white/90">{service.name}</p>
          <p className={`truncate text-xs ${muted}`}>{project.name} · {humanize(service.kind)}</p>
          <nav className="mt-4 flex gap-1 overflow-x-auto md:flex-col">
            {nav.map((n) => (
              <button key={n.key} type="button" onClick={() => setSection(n.key)} className={cn("flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm", section === n.key ? "bg-brand-50 font-medium text-brand-600 dark:bg-brand-500/15 dark:text-brand-400" : "text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-white/5", n.key === "danger" && section !== n.key && "text-error-500")}>
                <span className="inline-flex size-5 items-center justify-center rounded-md bg-gray-100 text-[11px] font-semibold dark:bg-white/10">{n.icon}</span>{n.label}
              </button>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 flex-1 p-5 sm:p-6">
          {section === "overview" && (
            <div className="space-y-4">
              <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Identifiers</h4>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                <CopyLine label="Service ID · MATELOT_SERVICE_ID" value={service.id} />
                <CopyLine label="Slug" value={service.slug} />
                <CopyLine label="Project ID" value={project.id} />
                <CopyLine label="Organization ID" value={organization.id} />
                {imagePath ? <CopyLine icon={<img src="/logo.png" alt="Matelot" className="size-7 shrink-0 rounded-md" />} label="Matelot Image repository · builds" value={imagePath} /> : <MatelotOff loading={registry.isLoading} />}
                {primary && <CopyLine label="Primary repository" value={primary.repository.fullName} mono={false} />}
              </div>
              {envList.length > 0 && (
                <>
                  <h4 className="pt-2 text-base font-semibold text-gray-800 dark:text-white/90">Environment IDs</h4>
                  <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">{envList.map((e) => <CopyLine key={e.id} label={`${e.name} · MATELOT_ENV_${e.slug.toUpperCase().replace(/-/g, "_")}`} value={e.id} />)}</div>
                </>
              )}
              <div className={`flex flex-wrap gap-x-6 gap-y-1 pt-2 text-xs ${muted}`}>
                <span>Criticality: {service.criticality ? <CriticalityBadge value={service.criticality} /> : `inherits ${humanize(project.criticality)}`}</span>
                <span>Created {formatDate(service.createdAt)}</span>
                <span>Updated {formatDate(service.updatedAt)}</span>
              </div>
            </div>
          )}

          {section === "settings" && (
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); update.mutate({ id: service.id, name: name.trim(), description: description.trim() || null, kind: kind as ServiceKind, criticality: (criticality || null) as Criticality | null }); }}>
              <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Settings</h4>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block"><span className="text-sm font-medium text-gray-700 dark:text-gray-400">Name</span><input className={`${inputClass} mt-1`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
                <label className="block"><span className="text-sm font-medium text-gray-700 dark:text-gray-400">Slug</span><input className={`${inputClass} mt-1 opacity-70`} value={service.slug} disabled /><span className={`text-xs ${muted}`}>Fixed: used in image paths and the API.</span></label>
                <div><span className="text-sm font-medium text-gray-700 dark:text-gray-400">Kind</span><SelectField className="mt-1" ariaLabel="Kind" value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: humanize(k) }))} /></div>
                <div><span className="text-sm font-medium text-gray-700 dark:text-gray-400">Criticality</span><SelectField className="mt-1" ariaLabel="Criticality" value={criticality} onChange={setCriticality} options={[{ value: "", label: `Inherit from project (${humanize(project.criticality)})` }, ...criticalities.map((c) => ({ value: c, label: humanize(c) }))]} /><span className={`text-xs ${muted}`}>Weighs the service's findings in risk and the fix-first queue.</span></div>
              </div>
              <label className="block"><span className="text-sm font-medium text-gray-700 dark:text-gray-400">Description</span><textarea rows={3} className={`${inputClass} mt-1`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></label>
              {update.error ? <ErrorNotice error={update.error} /> : null}
              {update.isSuccess && !dirty && <p className="text-sm text-success-600">Saved.</p>}
              <div className="flex justify-end gap-3"><button type="button" className={outlineButton} disabled={!dirty} onClick={() => { setName(service.name); setDescription(service.description ?? ""); setKind(service.kind); setCriticality(service.criticality ?? ""); }}>Reset</button><button type="submit" className={primaryButton} disabled={!dirty || update.isPending}>{update.isPending ? "Saving…" : "Save"}</button></div>
            </form>
          )}

          {section === "environments" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3"><h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Environments</h4><Link to={`/projects/${project.id}/environments`} className="text-sm text-brand-500 hover:underline">Open Environments →</Link></div>
              {imagePath && <p className={`text-xs ${muted}`}>Matelot registry: CI pushes builds to the build repository; <code>matelot promote</code> copies an image that passed the environment's gate into that environment's repository, and the cluster pulls from there. With an external registry (ECR, ACR, Artifact Registry…) there are no environment repositories: CI reports deployments with <code>matelot deploy --image</code>.</p>}
              {envList.length === 0 ? <p className={`text-sm ${muted}`}>No environments yet; add them on the Environments page.</p> : (
                <ul className="space-y-2">
                  {envList.map((e) => {
                    const reg = registry.data?.environments.find((x) => x.id === e.id);
                    return (
                      <li key={e.id} className="rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-800">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("size-2 rounded-full", KIND_DOT[e.kind] ?? "bg-gray-400")} />
                          <span className="text-sm font-semibold text-gray-800 dark:text-white/90">{e.name}</span>
                          <span className={`text-xs ${muted}`}>{e.slug} · {e.kind}</span>
                          {e.internetFacing && <Badge size="sm" color="warning">internet-facing</Badge>}
                          {reg?.protected && <Badge size="sm" color="error">protected</Badge>}
                          {e.settings?.kubernetesNamespace && <Badge size="sm" color="light">ns {String(e.settings.kubernetesNamespace)}</Badge>}
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
                          <CopyLine label="Environment ID" value={e.id} />
                          {reg && registry.data ? <CopyLine icon={<img src="/logo.png" alt="Matelot" className="size-7 shrink-0 rounded-md" />} label="Matelot Image repository" value={`${registry.data.host}/${reg.repository}`} /> : <MatelotOff loading={registry.isLoading} />}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {section === "repositories" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3"><h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Repositories</h4><Link to={`/projects/${project.id}/repositories`} className="text-sm text-brand-500 hover:underline">Attach / detach →</Link></div>
              {repoList.length === 0 ? <p className={`text-sm ${muted}`}>No repository attached. Attach one so pipelines can scan the code and remediation can open issues.</p> : (
                <ul className="space-y-2">
                  {repoList.map((r) => (
                    <li key={r.repository.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-800">
                      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-gray-800 dark:text-white/90">{r.repository.fullName}</p><p className={`text-xs ${muted}`}>default branch {r.repository.defaultBranch ?? "—"} · attached {formatDate(r.attachedAt)}</p></div>
                      <Badge size="sm" color={r.role === "primary" ? "primary" : "light"}>{r.role}</Badge>
                      {r.repository.htmlUrl && <a href={r.repository.htmlUrl} target="_blank" rel="noreferrer" className="text-sm text-brand-500 hover:underline">Open ↗</a>}
                    </li>
                  ))}
                </ul>
              )}
              <p className={`text-xs ${muted}`}>The primary repository decides where pipelines clone from and where GitHub / GitLab / Bitbucket issues open.</p>
            </div>
          )}

          {section === "ci" && (
            <div className="space-y-3">
              <h4 className="text-base font-semibold text-gray-800 dark:text-white/90">Use this service in CI</h4>
              <p className={`text-sm ${muted}`}>The ids are filled in. Create the CI token under project Settings → CI tokens.</p>
              <CiSnippetBlock input={{
                intro: [`Service ${service.name}: build → scan → gate → deploy`],
                vars: { MATELOT_SERVICE_ID: service.id, ...(prodEnv ? { [`MATELOT_ENV_${prodEnv.slug.toUpperCase().replace(/-/g, "_")}`]: prodEnv.id } : {}) },
                docker: !!imagePath, job: service.slug,
                steps: [
                  ...(imagePath ? ["matelot registry login", "IMAGE=$(matelot registry path --service $MATELOT_SERVICE_ID)\ndocker build -t $IMAGE:{sha} . && docker push $IMAGE:{sha}"] : []),
                  "matelot pipeline --service $MATELOT_SERVICE_ID --ref {sha} --wait",
                  ...(prodEnv ? [`matelot gate --env $MATELOT_ENV_${prodEnv.slug.toUpperCase().replace(/-/g, "_")} ${imagePath ? "--image $IMAGE:{sha}" : "--version {ref}"}`, imagePath ? `matelot promote --env $MATELOT_ENV_${prodEnv.slug.toUpperCase().replace(/-/g, "_")} --tag {sha}` : `matelot deploy --env $MATELOT_ENV_${prodEnv.slug.toUpperCase().replace(/-/g, "_")} --version {ref} --image <image>@sha256:...`] : []),
                ],
              }} />
            </div>
          )}

          {section === "danger" && (
            <div className="space-y-4">
              <h4 className="text-base font-semibold text-error-600">Archive service</h4>
              <div className="rounded-xl border border-error-500/30 bg-error-50 p-4 text-sm text-error-700 dark:bg-error-500/10 dark:text-error-400">
                <p>Archiving hides <strong>{service.name}</strong> from lists, dashboards and the fix-first queue, and keeps its history (releases, SBOMs, findings, evidence, audit) for compliance. Stop the CI jobs that report deployments for it first; tokens and repository links are not changed.</p>
              </div>
              <label className="block"><span className="text-sm text-gray-700 dark:text-gray-400">Type <code>{service.slug}</code> to confirm</span><input className={`${inputClass} mt-1 sm:w-80`} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
              {archive.error ? <ErrorNotice error={archive.error} /> : null}
              <button type="button" className={dangerButton} disabled={confirm !== service.slug || archive.isPending} onClick={() => archive.mutate(service.id, { onSuccess: () => { onArchived?.(); onClose(); } })}>{archive.isPending ? "Archiving…" : "Archive service"}</button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
