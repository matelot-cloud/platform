import Label from "@/components/form/Label";
import { Modal } from "@/components/ui/modal";
import { useAddMembers, useMemberCandidates, useMemberRoles, useMeta } from "@/platform/api/hooks";
import type { AddMembersResult, MemberCandidate, MemberScopeRef } from "@/platform/api/types";
import { personName } from "@/platform/people";
import { useMemo, useState, type FormEvent } from "react";
import { ErrorNotice, inputClass, muted, outlineButton, primaryButton } from "../ui";
import { OneTimeSecret, PersonCell, RolePicker, tomorrow } from "./shared";

const LEVEL: Record<MemberScopeRef["type"], string> = { ORGANIZATION: "organization", WORKSPACE: "workspace", TEAM: "team", PROJECT: "project" };
const splitEmails = (text: string) => text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/**
 * GitLab's "Invite members": search existing people (and this scope's service accounts) and/or paste e-mail addresses
 * (several at once), pick a role — only the ones that make sense here, the ones above your own disabled — and an
 * optional expiry. Unknown addresses are invited: a Keycloak user and a one-time setup link (e-mailed when the cell
 * has SMTP, otherwise shown here once to copy), or, with an external identity provider, access at first sign-in.
 */
export function InviteMembersDialog({ scope, onClose }: { scope: MemberScopeRef; onClose: () => void }) {
  const meta = useMeta();
  const features = meta.data?.features ?? {};
  const roles = useMemberRoles(scope);
  const add = useAddMembers();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<MemberCandidate[]>([]);
  const [emailText, setEmailText] = useState("");
  const [role, setRole] = useState("DEVELOPER");
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<AddMembersResult | null>(null);
  const candidates = useMemberCandidates(scope, q, !result);

  const emails = useMemo(() => splitEmails(emailText), [emailText]);
  const bad = emails.filter((e) => !isEmail(e));
  const count = picked.length + emails.length;
  const bulkOff = features.bulk_invite === false;
  const offered = roles.data ?? [];
  const roleOk = offered.some((r) => r.role === role && r.grantable !== false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate({ scopeType: scope.type, scopeId: scope.id, role, userIds: picked.map((p) => p.id), emails, expiresAt: expiresAt || undefined, reason: reason || undefined }, { onSuccess: setResult });
  };

  if (result) {
    return (
      <Modal isOpen onClose={onClose} className="max-w-170 p-5 sm:p-6" title="Members added" description={`${LEVEL[scope.type]} ${scope.name}`}>
        <div className="space-y-4 text-sm">
          <p className="text-gray-700 dark:text-gray-300">{result.added.length} added{result.added.some((a) => a.updated) ? ` (${result.added.filter((a) => a.updated).length} already members: role changed)` : ""}.</p>
          {result.invited.length > 0 && (
            <div className="space-y-3">
              <p className="font-medium text-gray-800 dark:text-white/90">Invited</p>
              {result.invited.map((i) => (
                <div key={i.email} className="rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                  <p className="font-medium text-gray-800 dark:text-white/90">{i.email}</p>
                  {i.viaIdentityProvider ? <p className={`text-xs ${muted}`}>Gets access at the first sign-in through your identity provider.</p>
                    : i.emailed ? <p className={`text-xs ${muted}`}>A setup link was e-mailed (valid 7 days).</p>
                    : i.setupLink ? (<><p className="mb-2 text-xs text-warning-600">No e-mail on this cell: send this one-time setup link yourself. It is shown only now.</p><OneTimeSecret value={i.setupLink} label="Copy link" /></>) : null}
                </div>
              ))}
            </div>
          )}
          {result.skipped.length > 0 && (
            <div>
              <p className="font-medium text-gray-800 dark:text-white/90">Not added</p>
              <ul className="mt-1 list-disc space-y-1 ps-5">{result.skipped.map((s) => <li key={s.email}><span className="font-medium">{s.email}</span> — {s.reason}</li>)}</ul>
            </div>
          )}
          <div className="flex justify-end"><button type="button" className={primaryButton} onClick={onClose}>Done</button></div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen onClose={onClose} className="max-w-190 p-5 sm:p-6" title="Invite members" description={<>To the {LEVEL[scope.type]} <strong className="text-gray-800 dark:text-white/90">{scope.name}</strong> — the role also applies to everything below it.</>}>
      <form onSubmit={submit} className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-5">
          <div>
            <Label htmlFor="inv-search">Find people</Label>
            <input id="inv-search" autoFocus className={inputClass} placeholder="Name or e-mail" value={q} onChange={(e) => setQ(e.target.value)} />
            {q.trim() && (
              <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-800">
                {(candidates.data ?? []).filter((c) => !picked.some((p) => p.id === c.id)).map((c) => (
                  <button key={c.id} type="button" disabled={bulkOff && count >= 1} onClick={() => { setPicked([...picked, c]); setQ(""); }} className="flex w-full items-center px-3 py-2 text-start hover:bg-gray-50 disabled:opacity-50 dark:hover:bg-white/5">
                    <PersonCell user={c} />
                  </button>
                ))}
                {candidates.data && candidates.data.length === 0 && <p className={`px-3 py-2 text-sm ${muted}`}>Nobody matches — type the e-mail below to invite them.</p>}
                {candidates.error ? <div className="p-2"><ErrorNotice error={candidates.error} /></div> : null}
              </div>
            )}
            {picked.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {picked.map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 py-1 ps-3 pe-1 text-xs text-gray-700 dark:bg-white/10 dark:text-gray-200">
                    {personName(p)}
                    <button type="button" aria-label={`Remove ${personName(p)}`} className="rounded-full px-1.5 hover:bg-gray-200 dark:hover:bg-white/10" onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}>×</button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div>
            <Label htmlFor="inv-emails">{bulkOff ? "Or invite by e-mail" : "Or invite by e-mail (several: one per line or comma-separated)"}</Label>
            <textarea id="inv-emails" rows={3} className={`${inputClass} h-auto py-2`} placeholder="jane@company.com, sam@company.com" value={emailText} onChange={(e) => setEmailText(e.target.value)} />
            {bad.length > 0 && <p className="mt-1 text-xs text-error-500">Not an e-mail address: {bad.join(", ")}</p>}
            {bulkOff && count > 1 && <p className="mt-1 text-xs text-error-500">This cell invites one person at a time.</p>}
          </div>
          {features.member_expiry !== false && (
            <div>
              <Label htmlFor="inv-exp">Access expires (optional)</Label>
              <input id="inv-exp" type="date" min={tomorrow()} className={inputClass} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              <p className={`mt-1 text-xs ${muted}`}>The role stops applying at the end of that day — useful for consultants and temporary help.</p>
            </div>
          )}
          <div>
            <Label htmlFor="inv-reason">Reason (audit trail)</Label>
            <input id="inv-reason" className={inputClass} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <div className="space-y-3">
          <Label>Role</Label>
          {roles.error ? <ErrorNotice error={roles.error} /> : <RolePicker roles={offered} value={role} onChange={setRole} />}
        </div>
        <div className="flex flex-col-reverse gap-3 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between lg:col-span-2 dark:border-gray-800">
          <div className="min-w-0">{add.error ? <ErrorNotice error={add.error} /> : <p className={`text-xs ${muted}`}>{count} {count === 1 ? "person" : "people"} selected</p>}</div>
          <div className="flex justify-end gap-3">
            <button type="button" className={outlineButton} onClick={onClose}>Cancel</button>
            <button type="submit" className={primaryButton} disabled={add.isPending || count === 0 || bad.length > 0 || !roleOk || (bulkOff && count > 1)}>{add.isPending ? "Inviting…" : count > 1 ? `Invite ${count}` : "Invite"}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
