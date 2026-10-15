import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { isForbidden } from "@/platform/api/client";
import { useCreateScopeAccessToken, useCreateServiceAccount, useDeleteServiceAccount, useMemberRoles, useServiceAccounts, useServiceAccountTokenActions, useServiceAccountTokens, useToggleServiceAccount } from "@/platform/api/hooks";
import type { CreatedToken, MemberScopeRef, ServiceAccount } from "@/platform/api/types";
import { formatDate } from "@/platform/format";
import { useState, type FormEvent } from "react";
import { dangerLink, EmptyState, ErrorNotice, inputClass, linkButton, muted, Note, outlineButton, primaryButton, SelectField, td, th, Toolbar, trBorder } from "../ui";
import { OneTimeSecret, PersonCell, RolePicker } from "./shared";

const LEVEL: Record<MemberScopeRef["type"], string> = { ORGANIZATION: "organization", WORKSPACE: "workspace", TEAM: "team", PROJECT: "project" };

/**
 * Service accounts owned by this scope (GitLab: service accounts / group & project access tokens). A bot has no
 * password and no browser login; it holds a role here (or below) through an ordinary membership and authenticates with
 * read or write tokens — the same mask as personal tokens. "New access token" makes the bot, its role and a token in one
 * step. Different from CI tokens (Settings → CI tokens): those are signed pipeline credentials with deploy presets.
 */
export function ServiceAccountsPanel({ scope, canManage, accessTokens }: { scope: MemberScopeRef; canManage: boolean; accessTokens: boolean }) {
  const list = useServiceAccounts(scope);
  const del = useDeleteServiceAccount();
  const toggle = useToggleServiceAccount();
  const [dialog, setDialog] = useState<null | "new" | "token" | { tokens: ServiceAccount }>(null);
  return (
    <>
      <Toolbar actions={canManage && (<>
        {accessTokens && <button type="button" className={outlineButton} onClick={() => setDialog("token")}>New access token</button>}
        <button type="button" className={primaryButton} onClick={() => setDialog("new")}>New service account</button>
      </>)}>
        Bots owned by this {LEVEL[scope.type]}: no password, no browser login — they sign in with their tokens only and can be members here and below.
      </Toolbar>
      {isForbidden(list.error) ? (
        <EmptyState title="Not visible with your role">Listing service accounts needs member visibility on this scope.</EmptyState>
      ) : list.error ? (
        <div className="p-4"><ErrorNotice error={list.error} /></div>
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState title="No service accounts yet">For integrations and automation that need a role (Jira sync, Renovate, a reporting script). Pipelines use CI tokens instead.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Service account</th><th className={th}>Roles</th><th className={th}>Active tokens</th><th className={th}>Created</th><th className={th} /></tr></thead>
            <tbody>
              {(list.data ?? []).map((sa) => (
                <tr key={sa.id} className={trBorder}>
                  <td className={td}><PersonCell user={{ email: sa.username, displayName: sa.name, kind: "service_account", disabled: sa.disabled }} />{sa.description && <p className={`mt-1 text-xs ${muted}`}>{sa.description}</p>}</td>
                  <td className={td}>{(sa.memberships ?? []).length ? (sa.memberships ?? []).map((m) => <Badge key={`${m.scopeType}${m.scopeId}${m.role}`} size="sm" color="primary">{m.role.replace(/_/g, " ").toLowerCase()}{m.scopeType !== scope.type ? ` · ${m.scopeType.toLowerCase()}` : ""}</Badge>) : <span className={muted}>no role yet</span>}</td>
                  <td className={td}>{sa.activeTokens ?? 0}</td>
                  <td className={`${td} ${muted}`}>{formatDate(sa.createdAt)}</td>
                  <td className={`${td} text-end whitespace-nowrap`}>
                    {canManage && (<span className="inline-flex gap-4">
                      <button type="button" className={linkButton} onClick={() => setDialog({ tokens: sa })}>Tokens</button>
                      <button type="button" className={linkButton} disabled={toggle.isPending} onClick={() => toggle.mutate({ id: sa.id, disabled: !sa.disabled })}>{sa.disabled ? "Enable" : "Disable"}</button>
                      <button type="button" className={dangerLink} disabled={del.isPending} onClick={() => { if (window.confirm(`Delete the service account ${sa.name}? Its roles and tokens go with it; anything using its tokens stops working now.`)) del.mutate(sa.id); }}>Delete</button>
                    </span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {del.error || toggle.error ? <div className="p-4"><ErrorNotice error={del.error ?? toggle.error} /></div> : null}
      {dialog === "new" && <NewServiceAccountDialog scope={scope} onClose={() => setDialog(null)} />}
      {dialog === "token" && <ScopeAccessTokenDialog scope={scope} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && <TokensDialog sa={dialog.tokens} onClose={() => setDialog(null)} />}
    </>
  );
}

function NewServiceAccountDialog({ scope, onClose }: { scope: MemberScopeRef; onClose: () => void }) {
  const roles = useMemberRoles(scope);
  const create = useCreateServiceAccount();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState("DEVELOPER");
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate({ scopeType: scope.type, scopeId: scope.id, name, description: description || undefined, role: role || undefined }, { onSuccess: onClose }); };
  return (
    <Modal isOpen onClose={onClose} className="max-w-170 p-5 sm:p-6" title="New service account" description={`Owned by the ${LEVEL[scope.type]} ${scope.name}. Create tokens for it afterwards (Tokens).`}>
      <form onSubmit={submit} className="space-y-5">
        <div><Label htmlFor="sa-name">Name</Label><input id="sa-name" autoFocus required maxLength={100} className={inputClass} placeholder="Jira sync" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><Label htmlFor="sa-desc">What it is for</Label><input id="sa-desc" maxLength={500} className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div><Label>Role here</Label><RolePicker roles={roles.data ?? []} value={role} onChange={setRole} name="sa-role" /></div>
        {create.error ? <ErrorNotice error={create.error} /> : null}
        <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={onClose}>Cancel</button><button type="submit" className={primaryButton} disabled={create.isPending || !name.trim()}>{create.isPending ? "Creating…" : "Create service account"}</button></div>
      </form>
    </Modal>
  );
}

function TokenForm({ pending, error, onSubmit, submitLabel }: { pending: boolean; error: unknown; onSubmit: (v: { name: string; scope: "read" | "write"; expiresInDays: number }) => void; submitLabel: string }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [days, setDays] = useState("90");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ name, scope, expiresInDays: Number(days) }); }} className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_10rem_8rem_auto] sm:items-end">
      <div><Label htmlFor="tk-name">Token name</Label><input id="tk-name" required maxLength={100} className={inputClass} placeholder="production" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div><Label>Scope</Label><SelectField value={scope} onChange={(v) => setScope(v as "read" | "write")} options={[{ value: "read", label: "read" }, { value: "write", label: "write" }]} /></div>
      <div><Label htmlFor="tk-days">Days</Label><input id="tk-days" type="number" min={1} max={3650} required className={inputClass} value={days} onChange={(e) => setDays(e.target.value)} /></div>
      <button type="submit" className={primaryButton} disabled={pending || !name.trim()}>{pending ? "Creating…" : submitLabel}</button>
      {error ? <div className="sm:col-span-4"><ErrorNotice error={error} /></div> : null}
    </form>
  );
}

function ShownOnce({ token }: { token: CreatedToken }) {
  return (
    <div className="rounded-xl border border-warning-300 bg-warning-50/50 p-3 dark:border-warning-500/40 dark:bg-warning-500/5">
      <p className="mb-2 text-sm text-warning-700 dark:text-warning-400">Token <strong>{token.name}</strong> ({token.scope}, until {formatDate(token.expiresAt)}) — copy it now, it is shown only once.</p>
      <OneTimeSecret value={token.token} label="Copy token" />
      <p className={`mt-2 text-xs ${muted}`}>Use it like a personal token: <code>Authorization: Bearer spt_…</code>, or <code>MATELOT_TOKEN=spt_… matelot …</code>.</p>
    </div>
  );
}

function TokensDialog({ sa, onClose }: { sa: ServiceAccount; onClose: () => void }) {
  const tokens = useServiceAccountTokens(sa.id);
  const { create, rotate, revoke } = useServiceAccountTokenActions(sa.id);
  const [shown, setShown] = useState<CreatedToken | null>(null);
  return (
    <Modal isOpen onClose={onClose} className="max-w-240 p-5 sm:p-6" title={<>Tokens of {sa.name}</>} description={<span className="font-mono text-xs">{sa.username}</span>}>
      <div className="space-y-5">
        {shown && <ShownOnce token={shown} />}
        <TokenForm pending={create.isPending} error={create.error} submitLabel="Create token" onSubmit={(v) => create.mutate(v, { onSuccess: setShown })} />
        {tokens.error ? <ErrorNotice error={tokens.error} /> : (tokens.data ?? []).length === 0 ? <Note>No tokens yet.</Note> : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Name</th><th className={th}>Scope</th><th className={th}>Expires</th><th className={th}>Last used</th><th className={th} /></tr></thead>
              <tbody>
                {(tokens.data ?? []).map((t) => (
                  <tr key={t.id} className={trBorder}>
                    <td className={td}><span className="font-medium text-gray-800 dark:text-white/90">{t.name}</span> <span className={`font-mono text-xs ${muted}`}>{t.prefix}…</span></td>
                    <td className={td}><Badge size="sm" color={t.scope === "write" ? "warning" : "light"}>{t.scope}</Badge></td>
                    <td className={`${td} ${muted}`}>{t.revokedAt ? "revoked" : t.expired ? "expired" : formatDate(t.expiresAt)}</td>
                    <td className={`${td} ${muted}`}>{t.lastUsedAt ? `${formatDate(t.lastUsedAt)}${t.lastUsedIp ? ` · ${t.lastUsedIp}` : ""}` : "never"}</td>
                    <td className={`${td} text-end whitespace-nowrap`}>
                      {!t.revokedAt && !t.expired && (<span className="inline-flex gap-4">
                        <button type="button" className={linkButton} disabled={rotate.isPending} onClick={() => { if (window.confirm(`Rotate ${t.name}? A new token replaces it and the old one stops working now.`)) rotate.mutate(t.id, { onSuccess: setShown }); }}>Rotate</button>
                        <button type="button" className={dangerLink} disabled={revoke.isPending} onClick={() => { if (window.confirm(`Revoke ${t.name}? Anything using it stops working now.`)) revoke.mutate(t.id); }}>Revoke</button>
                      </span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rotate.error || revoke.error ? <ErrorNotice error={rotate.error ?? revoke.error} /> : null}
      </div>
    </Modal>
  );
}

function ScopeAccessTokenDialog({ scope, onClose }: { scope: MemberScopeRef; onClose: () => void }) {
  const roles = useMemberRoles(scope);
  const create = useCreateScopeAccessToken();
  const [role, setRole] = useState("DEVELOPER");
  const [shown, setShown] = useState<CreatedToken | null>(null);
  return (
    <Modal isOpen onClose={onClose} className="max-w-190 p-5 sm:p-6" title={`New ${LEVEL[scope.type]} access token`} description={<>A bot member of {scope.name} with the role below, plus its token — in one step (GitLab: {LEVEL[scope.type]} access token).</>}>
      {shown ? (
        <div className="space-y-4"><ShownOnce token={shown} /><div className="flex justify-end"><button type="button" className={primaryButton} onClick={onClose}>Done</button></div></div>
      ) : (
        <div className="space-y-5">
          <RolePicker roles={roles.data ?? []} value={role} onChange={setRole} name="sat-role" />
          <TokenForm pending={create.isPending} error={create.error} submitLabel="Create" onSubmit={(v) => create.mutate({ scopeType: scope.type, scopeId: scope.id, role, ...v }, { onSuccess: (r) => setShown(r.token) })} />
        </div>
      )}
    </Modal>
  );
}
