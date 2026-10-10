import Label from "@/components/form/Label";
import { useArchiveWorkspace, useUpdateWorkspace } from "@/platform/api/hooks";
import { CiTokensPanel } from "@/platform/components/CiTokensPanel";
import { Card, ErrorNotice, inputClass, primaryButton } from "@/platform/components/ui";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useWorkspace } from "./layout";


export default function WorkspaceSettingsPage() {
  const { organization, workspace } = useWorkspace();
  const navigate = useNavigate();
  const update = useUpdateWorkspace(organization.id);
  const archive = useArchiveWorkspace(organization.id);
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? "");
  const submit = (e: FormEvent) => { e.preventDefault(); update.mutate({ workspaceId: workspace.id, name, description }); };
  return (
    <div className="space-y-6">
      <Card title="General" description="Name and description are editable; the slug is permanent.">
        <form onSubmit={submit} className="max-w-xl space-y-5">
          <div><Label htmlFor="w-name">Name</Label><input id="w-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></div>
          <div><Label htmlFor="w-slug">Slug</Label><input id="w-slug" className={`${inputClass} bg-gray-50 dark:bg-gray-800`} value={workspace.slug} readOnly /></div>
          <div><Label htmlFor="w-desc">Description</Label><textarea id="w-desc" rows={3} className="w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></div>
          {update.error ? <ErrorNotice error={update.error} /> : null}
          {update.isSuccess ? <p className="text-sm text-success-600">Saved.</p> : null}
          <button type="submit" className={primaryButton} disabled={update.isPending}>{update.isPending ? "Saving…" : "Save changes"}</button>
        </form>
      </Card>
      <CiTokensPanel organizationId={organization.id} scopeType="WORKSPACE" scopeId={workspace.id} scopeName={workspace.name} />
      <Card title="Archive workspace" description="Hides the workspace and everything in it from lists; nothing is deleted.">
        {archive.error ? <ErrorNotice error={archive.error} /> : null}
        <button type="button" className="rounded-lg px-4 py-2.5 text-sm font-medium text-error-500 ring-1 ring-error-500/40 ring-inset hover:bg-error-50 dark:hover:bg-error-500/10" disabled={archive.isPending} onClick={() => { if (window.confirm(`Archive ${workspace.name}?`)) archive.mutate(workspace.id, { onSuccess: () => void navigate("/projects") }); }}>Archive workspace</button>
      </Card>
    </div>
  );
}
