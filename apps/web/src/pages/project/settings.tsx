import Label from "@/components/form/Label";
import { useArchiveProject, useMeta, usePipelineTemplates, useUpdateProject } from "@/platform/api/hooks";
import type { Criticality } from "@/platform/api/types";
import { CiTokensPanel } from "@/platform/components/CiTokensPanel";
import { Card, ErrorNotice, inputClass, muted, primaryButton, SelectField } from "@/platform/components/ui";
import { titleCase } from "@/platform/format";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useProject } from "./layout";


export default function ProjectSettingsPage() {
  const { organization, project } = useProject();
  const navigate = useNavigate();
  const meta = useMeta();
  const update = useUpdateProject(organization.id);
  const archive = useArchiveProject(organization.id);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [criticality, setCriticality] = useState<Criticality>(project.criticality);
  const templates = usePipelineTemplates();
  const automationUpdate = useUpdateProject(organization.id);
  const [onPush, setOnPush] = useState<"default_branch" | "all" | "off">(project.settings?.automation?.pipelineOnPush ?? "default_branch");
  const [template, setTemplate] = useState(project.settings?.automation?.template ?? "security");
  const submit = (e: FormEvent) => { e.preventDefault(); update.mutate({ projectId: project.id, name, description, criticality }); };
  return (
    <div className="space-y-6">
      <Card title="General" description="Name and description are editable; the slug is permanent.">
        <form onSubmit={submit} className="max-w-xl space-y-5">
          <div><Label htmlFor="s-name">Name</Label><input id="s-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></div>
          <div><Label htmlFor="s-slug">Slug</Label><input id="s-slug" className={`${inputClass} bg-gray-50 dark:bg-gray-800`} value={project.slug} readOnly /></div>
          <div><Label htmlFor="s-desc">Description</Label><textarea id="s-desc" rows={3} className="w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></div>
          <div><Label>Business criticality</Label><SelectField value={criticality} onChange={(v) => setCriticality(v as Criticality)} options={(meta.data?.criticalities ?? ["LOW", "MEDIUM", "HIGH", "CRITICAL"]).map((c) => ({ value: c, label: titleCase(c) }))} /><p className={`mt-1.5 text-xs ${muted}`}>Feeds the risk engine: the same vulnerability is riskier in a critical project.</p></div>
          {update.error ? <ErrorNotice error={update.error} /> : null}
          {update.isSuccess ? <p className="text-sm text-success-600">Saved.</p> : null}
          <button type="submit" className={primaryButton} disabled={update.isPending}>{update.isPending ? "Saving…" : "Save changes"}</button>
        </form>
      </Card>
      <Card title="Automation" description="What the platform does by itself when code moves. Every push becomes a build that is checked out and scanned; tags become releases.">
        <form onSubmit={(e) => { e.preventDefault(); automationUpdate.mutate({ projectId: project.id, automation: { pipelineOnPush: onPush, template } }); }} className="max-w-xl space-y-5">
          <div>
            <Label>Run the security pipeline on push</Label>
            <SelectField value={onPush} onChange={(v) => setOnPush(v as typeof onPush)} options={[{ value: "default_branch", label: "Pushes to the default branch (recommended)" }, { value: "all", label: "Every push, every branch" }, { value: "off", label: "Off — only manual or from CI" }]} />
            <p className={`mt-1.5 text-xs ${muted}`}>Needs a GitHub App connection for the push webhook. Without it, add <code>matelot pipeline --service … --ref $GITHUB_SHA --wait</code> to your CI.</p>
          </div>
          <div>
            <Label>Pipeline to run</Label>
            <SelectField value={template} onChange={setTemplate} options={(templates.data ?? []).map((t) => ({ value: t.key, label: t.name }))} />
          </div>
          {automationUpdate.error ? <ErrorNotice error={automationUpdate.error} /> : null}
          {automationUpdate.isSuccess ? <p className="text-sm text-success-600">Saved.</p> : null}
          <button type="submit" className={primaryButton} disabled={automationUpdate.isPending}>{automationUpdate.isPending ? "Saving…" : "Save automation"}</button>
        </form>
      </Card>
      <CiTokensPanel organizationId={organization.id} scopeType="PROJECT" scopeId={project.id} scopeName={project.name} />
      <Card title="Archive project" description="The project disappears from lists but stays in the audit trail. Services and environments are kept.">
        {archive.error ? <ErrorNotice error={archive.error} /> : null}
        <button type="button" className="rounded-lg px-4 py-2.5 text-sm font-medium text-error-500 ring-1 ring-error-500/40 ring-inset hover:bg-error-50 dark:hover:bg-error-500/10" disabled={archive.isPending} onClick={() => { if (window.confirm(`Archive ${project.name}?`)) archive.mutate(project.id, { onSuccess: () => void navigate(`/workspaces/${project.workspaceId}/projects`) }); }}>Archive project</button>
      </Card>
    </div>
  );
}
