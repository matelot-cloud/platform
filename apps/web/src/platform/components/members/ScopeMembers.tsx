import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { isForbidden } from "@/platform/api/client";
import { useMe, useMemberRoles, useMembers, useMeta, useRemoveMember, useUpdateMember } from "@/platform/api/hooks";
import type { MemberRow, MemberScopeRef, MemberScopeSummary } from "@/platform/api/types";
import { formatDate } from "@/platform/format";
import { personName } from "@/platform/people";
import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Card, dangerLink, EmptyState, ErrorNotice, inputClass, linkButton, muted, outlineButton, primaryButton, Tabs, td, th, Toolbar, trBorder } from "../ui";
import { InviteMembersDialog } from "./InviteMembersDialog";
import { ServiceAccountsPanel } from "./ServiceAccountsPanel";
import { PersonCell, RolePicker, tomorrow } from "./shared";

const LEVEL: Record<MemberScopeRef["type"], string> = { ORGANIZATION: "organization", WORKSPACE: "workspace", TEAM: "team", PROJECT: "project" };

/** Where an inherited row is managed: the members page of that scope. */
export function membersPath(s: { type: MemberScopeRef["type"]; id: string }, workspaceOfTeam?: (teamId: string) => string | undefined): string {
  switch (s.type) {
    case "ORGANIZATION": return "/members";
    case "WORKSPACE": return `/workspaces/${s.id}/members`;
    case "TEAM": { const ws = workspaceOfTeam?.(s.id); return ws ? `/workspaces/${ws}/teams/${s.id}/members` : "/members"; }
    case "PROJECT": return `/projects/${s.id}/members`;
  }
}

/**
 * Members of one scope, GitLab-style: direct members (editable when you could grant their role) and members inherited
 * from above (read-only, linked to where they are granted), with role, source, who granted it and when, and the optional
 * expiry. "Invite members" adds people or e-mail addresses; the Service accounts tab lists the bots owned here.
 */
export function ScopeMembers({ scope, workspaceOfTeam }: { scope: MemberScopeRef; workspaceOfTeam?: (teamId: string) => string | undefined }) {
  const meta = useMeta();
  const me = useMe();
  const features = meta.data?.features ?? {};
  const members = useMembers(scope);
  const remove = useRemoveMember();
  const [tab, setTab] = useState<"members" | "bots">("members");
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState<"all" | "direct" | "inherited">("all");
  const [invite, setInvite] = useState(false);
  const [editing, setEditing] = useState<MemberRow | null>(null);
  const forbidden = isForbidden(members.error);
  const canManage = !!members.data?.canManage;
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (members.data?.members ?? []).filter((m) => (source === "all" || m.source === source) && (!needle || m.user.email.includes(needle) || (m.user.displayName ?? "").toLowerCase().includes(needle) || m.roleLabel.toLowerCase().includes(needle)));
  }, [members.data, filter, source]);
  const directCount = (members.data?.members ?? []).filter((m) => m.source === "direct").length;
  const inheritedCount = (members.data?.members ?? []).length - directCount;
  const showBots = features.service_accounts !== false;

  return (
    <Card
      title="Members"
      description={<>Who has a role on this {LEVEL[scope.type]}. Roles granted higher up apply here too and are shown as inherited; a direct role can raise them, never lower them.</>}
      flush
      actions={canManage && tab === "members" ? <button type="button" className={primaryButton} onClick={() => setInvite(true)}>Invite members</button> : undefined}
    >
      {showBots && <Tabs value={tab} onChange={setTab} items={[{ value: "members", label: `Members${members.data ? ` (${members.data.members.length})` : ""}` }, { value: "bots", label: "Service accounts" }]} />}
      {tab === "bots" ? (
        <ServiceAccountsPanel scope={scope} canManage={canManage} accessTokens={features.scope_access_tokens !== false} />
      ) : forbidden ? (
        <EmptyState title="Not visible with your role">You need member visibility on this {LEVEL[scope.type]} to see who has access here.</EmptyState>
      ) : members.error ? (
        <div className="p-4"><ErrorNotice error={members.error} /></div>
      ) : (
        <>
          <Toolbar actions={<>
            <input className={`${inputClass} w-full sm:w-56`} placeholder="Filter members" aria-label="Filter members" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {features.inherited_members !== false && (
              <select aria-label="Source" className={`${inputClass} w-auto`} value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
                <option value="all">All ({directCount + inheritedCount})</option>
                <option value="direct">Direct ({directCount})</option>
                <option value="inherited">Inherited ({inheritedCount})</option>
              </select>
            )}
          </>}>
            {members.isLoading ? "Loading…" : `${directCount} direct · ${inheritedCount} inherited`}
          </Toolbar>
          {rows.length === 0 && !members.isLoading ? (
            <EmptyState title={filter || source !== "all" ? "Nobody matches" : "Nobody has a role here yet"}>{canManage && !filter ? "Invite the first members." : undefined}</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead className="border-b border-gray-100 dark:border-gray-800">
                  <tr><th className={th}>Member</th><th className={th}>Role</th><th className={th}>Source</th><th className={th}>Granted</th><th className={th}>Expires</th><th className={th}><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.membershipId} className={trBorder}>
                      <td className={td}><MemberCell row={m} self={m.user.id === me.data?.user.id} /></td>
                      <td className={td}><Badge size="sm" color={m.expired ? "light" : "primary"}>{m.roleLabel}</Badge></td>
                      <td className={td}>{m.source === "direct" ? <span className="text-gray-700 dark:text-gray-300">Direct</span> : <InheritedFrom from={m.inheritedFrom} workspaceOfTeam={workspaceOfTeam} />}</td>
                      <td className={`${td} ${muted}`}><span className="block">{formatDate(m.grantedAt)}</span>{m.grantedBy && <span className="block truncate text-xs">by {m.grantedBy.email}</span>}</td>
                      <td className={td}>{m.expiresAt ? <span className={m.expired ? "text-error-500" : "text-gray-700 dark:text-gray-300"}>{m.expired ? "expired " : ""}{formatDate(m.expiresAt)}</span> : <span className={muted}>—</span>}</td>
                      <td className={`${td} text-end whitespace-nowrap`}>
                        {m.canEdit ? (
                          <span className="inline-flex gap-4">
                            <button type="button" className={linkButton} onClick={() => setEditing(m)}>Edit</button>
                            <button type="button" className={dangerLink} disabled={remove.isPending} onClick={() => { if (window.confirm(`Remove ${personName(m.user)} (${m.roleLabel}) from this ${LEVEL[scope.type]}? Roles they hold higher up still apply.`)) remove.mutate(m.membershipId); }}>Remove</button>
                          </span>
                        ) : m.source === "direct" && m.user.id === me.data?.user.id ? (
                          <button type="button" className={dangerLink} disabled={remove.isPending} onClick={() => { if (window.confirm(`Leave this ${LEVEL[scope.type]}? You lose your direct ${m.roleLabel} role here.`)) remove.mutate(m.membershipId); }}>Leave</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {remove.error ? <div className="p-4"><ErrorNotice error={remove.error} /></div> : null}
        </>
      )}
      {invite && <InviteMembersDialog scope={scope} onClose={() => setInvite(false)} />}
      {editing && <EditMemberDialog scope={scope} row={editing} expiry={features.member_expiry !== false} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function MemberCell({ row, self }: { row: MemberRow; self: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <PersonCell user={row.user} />
      {self && <span className={`text-xs ${muted}`}>(you)</span>}
    </div>
  );
}

function InheritedFrom({ from, workspaceOfTeam }: { from: MemberScopeSummary | null; workspaceOfTeam?: (teamId: string) => string | undefined }) {
  if (!from) return <span className={muted}>Inherited</span>;
  return (
    <span className={muted}>
      Inherited from <Link className="text-brand-500 hover:underline" to={membersPath(from, workspaceOfTeam)}>{LEVEL[from.type]} {from.name}</Link>
    </span>
  );
}

function EditMemberDialog({ scope, row, expiry, onClose }: { scope: MemberScopeRef; row: MemberRow; expiry: boolean; onClose: () => void }) {
  const roles = useMemberRoles(scope);
  const update = useUpdateMember();
  const [role, setRole] = useState(row.role);
  const [expiresAt, setExpiresAt] = useState(row.expiresAt ? row.expiresAt.slice(0, 10) : "");
  const [reason, setReason] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate({ membershipId: row.membershipId, role: role !== row.role ? role : undefined, expiresAt: expiry ? (expiresAt || null) : undefined, reason: reason || undefined }, { onSuccess: onClose });
  };
  return (
    <Modal isOpen onClose={onClose} className="max-w-170 p-5 sm:p-6" title={<>Edit {personName(row.user)}</>} description={`Direct member of the ${LEVEL[scope.type]} ${scope.name}`}>
      <form onSubmit={submit} className="space-y-5">
        <div><Label>Role</Label><RolePicker roles={roles.data ?? []} value={role} onChange={setRole} name="edit-role" /></div>
        {expiry && (
          <div>
            <Label htmlFor="edit-exp">Access expires</Label>
            <div className="flex gap-3"><input id="edit-exp" type="date" min={tomorrow()} className={inputClass} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />{expiresAt && <button type="button" className={outlineButton} onClick={() => setExpiresAt("")}>No expiry</button>}</div>
          </div>
        )}
        <div><Label htmlFor="edit-reason">Reason (audit trail)</Label><input id="edit-reason" className={inputClass} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        {update.error ? <ErrorNotice error={update.error} /> : null}
        <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={onClose}>Cancel</button><button type="submit" className={primaryButton} disabled={update.isPending}>{update.isPending ? "Saving…" : "Save"}</button></div>
      </form>
    </Modal>
  );
}
