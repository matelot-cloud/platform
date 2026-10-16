import Label from "@/components/form/Label";
import { useArchiveTeam, useUpdateTeam } from "@/platform/api/hooks";
import { Card, ErrorNotice, inputClass, primaryButton } from "@/platform/components/ui";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useTeam } from "./layout";

export default function TeamSettingsPage() {
  const { organization, workspace, team } = useTeam();
  const navigate = useNavigate();
  const update = useUpdateTeam(organization.id);
  const archive = useArchiveTeam(organization.id);
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const submit = (e: FormEvent) => { e.preventDefault(); update.mutate({ teamId: team.id, name, description }); };
  return (
    <div className="space-y-6">
      <Card title="General" description="Name and description are editable; the slug is permanent.">
        <form onSubmit={submit} className="max-w-xl space-y-5">
          <div><Label htmlFor="t-name">Name</Label><input id="t-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></div>
          <div><Label htmlFor="t-slug">Slug</Label><input id="t-slug" className={`${inputClass} bg-gray-50 dark:bg-gray-800`} value={team.slug} readOnly /></div>
          <div><Label htmlFor="t-desc">Description</Label><textarea id="t-desc" rows={3} className="w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></div>
          {update.error ? <ErrorNotice error={update.error} /> : null}
          {update.isSuccess ? <p className="text-sm text-success-600">Saved.</p> : null}
          <button type="submit" className={primaryButton} disabled={update.isPending}>{update.isPending ? "Saving…" : "Save changes"}</button>
        </form>
      </Card>
      <Card title="Archive team" description="Hides the team and its projects from lists; nothing is deleted.">
        {archive.error ? <ErrorNotice error={archive.error} /> : null}
        <button type="button" className="rounded-lg px-4 py-2.5 text-sm font-medium text-error-500 ring-1 ring-error-500/40 ring-inset hover:bg-error-50 dark:hover:bg-error-500/10" disabled={archive.isPending} onClick={() => { if (window.confirm(`Archive ${team.name}?`)) archive.mutate(team.id, { onSuccess: () => void navigate(`/workspaces/${workspace.id}/teams`) }); }}>Archive team</button>
      </Card>
    </div>
  );
}
