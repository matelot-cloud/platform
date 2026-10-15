import Label from "@/components/form/Label";
import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { isForbidden } from "@/platform/api/client";
import { useAdminCapabilities, useAdminUser, useAdminUserActions, useAdminUsers, useMe, useMeta, useUpdateAdminUser } from "@/platform/api/hooks";
import type { AdminUser, IssuedLink, PlatformRole } from "@/platform/api/types";
import { membersPath } from "@/platform/components/members/ScopeMembers";
import { OneTimeSecret, PersonCell } from "@/platform/components/members/shared";
import { Card, dangerButton, EmptyState, ErrorNotice, inputClass, linkButton, muted, outlineButton, primaryButton, SelectField, Tabs, td, th, Toolbar, trBorder } from "@/platform/components/ui";
import { formatDate } from "@/platform/format";
import { personName } from "@/platform/people";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";

const ROLE_OPTIONS = [
  { value: "user", label: "User" },
  { value: "admin", label: "Administrator" },
];
const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 55]).join("");

/**
 * Administration → Users (cell administrators and admins of the root organization): everyone who can sign in, the
 * service accounts, and what each one holds. Create people (temporary password or one-time setup link), reset
 * passwords, disable / enable, delete, see their roles across scopes and their tokens.
 */
export default function AdminUsersPage() {
  const { productName } = useRuntimeConfig();
  const me = useMe();
  const meta = useMeta();
  const caps = useAdminCapabilities(!!me.data);
  const allowed = !!caps.data;
  const users = useAdminUsers(allowed);
  const update = useUpdateAdminUser();
  const [tab, setTab] = useState<"human" | "service_account">("human");
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<AdminUser | null>(null);
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (users.data ?? []).filter((u) => (u.kind ?? "human") === tab && (!needle || u.email.includes(needle) || (u.displayName ?? "").toLowerCase().includes(needle)));
  }, [users.data, tab, filter]);
  const userAdmin = meta.data?.features?.user_admin !== false && !!caps.data?.keycloak;

  return (
    <>
      <PageMeta title={`Users · ${productName}`} description="Cell administration: users" />
      <PageBreadcrumb pageTitle="Users" />
      <Card
        title="Users of this cell"
        description="Everyone who can sign in or has been invited, and the service accounts. Administrators see and can do everything; users only where they hold a role."
        flush
        actions={allowed && tab === "human" && userAdmin ? <button type="button" className={primaryButton} onClick={() => setCreating(true)}>New user</button> : undefined}
      >
        {isForbidden(caps.error) || (me.data && caps.isError) ? (
          <EmptyState title="Administrators only">This area is for cell administrators and administrators of the root organization.</EmptyState>
        ) : users.error ? (
          <div className="p-4"><ErrorNotice error={users.error} /></div>
        ) : (
          <>
            <Tabs value={tab} onChange={setTab} items={[{ value: "human", label: "People" }, { value: "service_account", label: "Service accounts" }]} />
            <Toolbar actions={<input className={`${inputClass} w-full sm:w-64`} placeholder="Filter by name or e-mail" aria-label="Filter users" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
              {caps.data && !caps.data.keycloak ? "Users come from the identity provider on this cell (no Keycloak admin access): creating users and password resets are not available." : caps.data && !caps.data.email ? "No e-mail on this cell: setup and reset links are shown once to copy." : `${rows.length} ${tab === "human" ? "people" : "service accounts"}`}
            </Toolbar>
            {rows.length === 0 && !users.isLoading ? (
              <EmptyState title={filter ? "Nobody matches" : tab === "human" ? "No users yet" : "No service accounts yet"}>{tab === "service_account" ? "Service accounts are created on a scope's Members page." : undefined}</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full">
                  <thead className="border-b border-gray-100 dark:border-gray-800">
                    <tr><th className={th}>{tab === "human" ? "User" : "Service account"}</th>{tab === "human" && <th className={th}>Cell role</th>}<th className={th}>Roles held</th><th className={th}>Last sign-in</th><th className={th}>Status</th><th className={th}><span className="sr-only">Actions</span></th></tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => {
                      const self = u.id === me.data?.user.id;
                      return (
                        <tr key={u.id} className={trBorder}>
                          <td className={td}><div className="flex items-center gap-2"><PersonCell user={{ ...u, disabled: !!u.disabledAt }} />{self && <span className={`text-xs ${muted}`}>(you)</span>}</div></td>
                          {tab === "human" && (
                            <td className={td}>
                              {caps.data?.canChangeCellRole ? (
                                <SelectField ariaLabel={`Cell role of ${u.email}`} value={u.platformRole} onChange={(v) => update.mutate({ userId: u.id, platformRole: v as PlatformRole })} options={ROLE_OPTIONS} className="w-40" />
                              ) : <span className="text-gray-700 dark:text-gray-300">{u.platformRole === "admin" ? "Administrator" : "User"}</span>}
                            </td>
                          )}
                          <td className={`${td} ${muted}`}>{u.membershipCount}</td>
                          <td className={`${td} ${muted}`}>{u.lastLoginAt ? formatDate(u.lastLoginAt) : u.kind === "service_account" ? "tokens only" : u.signInReady === false ? "invited" : "never"}</td>
                          <td className={td}>{u.disabledAt ? <Badge size="sm" color="error">disabled</Badge> : <Badge size="sm" color="success">active</Badge>}</td>
                          <td className={`${td} text-end`}><button type="button" className={linkButton} onClick={() => setManaging(u)}>Manage</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {update.error ? <div className="p-4"><ErrorNotice error={update.error} /></div> : null}
          </>
        )}
      </Card>
      {creating && <NewUserDialog emailOn={!!caps.data?.email} onClose={() => setCreating(false)} />}
      {managing && <ManageUserDialog user={managing} self={managing.id === me.data?.user.id} userAdmin={userAdmin} onClose={() => setManaging(null)} />}
    </>
  );
}

function LinkResult({ result, who }: { result: IssuedLink; who: string }) {
  if (result.temporaryPassword) return <p className="text-sm text-gray-700 dark:text-gray-300">Temporary password set for {who}: they choose their own at the next sign-in. Hand it over through a safe channel.</p>;
  if (result.emailed) return <p className="text-sm text-gray-700 dark:text-gray-300">A one-time link was e-mailed to {who} (valid 7 days).</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-warning-600">Send this one-time link to {who} yourself — it is shown only now and expires in 7 days.</p>
      {result.setupLink && <OneTimeSecret value={result.setupLink} label="Copy link" />}
    </div>
  );
}

function NewUserDialog({ emailOn, onClose }: { emailOn: boolean; onClose: () => void }) {
  const { create } = useAdminUserActions();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [mode, setMode] = useState<"link" | "password">("link");
  const [password, setPassword] = useState(randomPassword);
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate({ email, firstName: firstName || undefined, lastName: lastName || undefined, temporaryPassword: mode === "password" ? password : undefined }); };
  return (
    <Modal isOpen onClose={onClose} className="max-w-170 p-5 sm:p-6" title="New user" description="Creates the sign-in account. Give them roles afterwards on the Members page of a scope (or invite them from there directly).">
      {create.data ? (
        <div className="space-y-4">
          <LinkResult result={create.data} who={create.data.user.email} />
          {create.data.temporaryPassword && <OneTimeSecret value={password} label="Copy password" />}
          <div className="flex justify-end"><button type="button" className={primaryButton} onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <div><Label htmlFor="nu-email">E-mail</Label><input id="nu-email" type="email" required autoFocus className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><Label htmlFor="nu-first">First name (optional)</Label><input id="nu-first" maxLength={100} className={inputClass} value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
            <div><Label htmlFor="nu-last">Last name (optional)</Label><input id="nu-last" maxLength={100} className={inputClass} value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium text-gray-700 dark:text-gray-400">First sign-in</legend>
            <label className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300"><input type="radio" name="nu-mode" className="mt-1" checked={mode === "link"} onChange={() => setMode("link")} /><span>One-time setup link {emailOn ? "(e-mailed to them)" : "(shown to you once to send them)"} — they choose their password</span></label>
            <label className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300"><input type="radio" name="nu-mode" className="mt-1" checked={mode === "password"} onChange={() => setMode("password")} /><span>Temporary password — changed at their first sign-in</span></label>
          </fieldset>
          {mode === "password" && <div><Label htmlFor="nu-pw">Temporary password</Label><div className="flex gap-3"><input id="nu-pw" required minLength={12} className={`${inputClass} font-mono`} value={password} onChange={(e) => setPassword(e.target.value)} /><button type="button" className={outlineButton} onClick={() => setPassword(randomPassword())}>Generate</button></div></div>}
          {create.error ? <ErrorNotice error={create.error} /> : null}
          <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={onClose}>Cancel</button><button type="submit" className={primaryButton} disabled={create.isPending}>{create.isPending ? "Creating…" : "Create user"}</button></div>
        </form>
      )}
    </Modal>
  );
}

function ManageUserDialog({ user, self, userAdmin, onClose }: { user: AdminUser; self: boolean; userAdmin: boolean; onClose: () => void }) {
  const detail = useAdminUser(user.id);
  const update = useUpdateAdminUser();
  const { reset, remove } = useAdminUserActions();
  const [tempPassword, setTempPassword] = useState("");
  const d = detail.data;
  const bot = user.kind === "service_account";
  const active = (d?.tokens ?? []).filter((t) => !t.revokedAt && !t.expired);
  return (
    <Modal isOpen onClose={onClose} className="max-w-240 p-5 sm:p-6" title={personName(user)} description={<span className={bot ? "font-mono text-xs" : undefined}>{user.email}{bot && d?.user.ownerScopeType ? ` · service account of a ${d.user.ownerScopeType.toLowerCase()}` : ""}</span>} headerExtra={user.disabledAt ? <span className="pt-1.5"><Badge size="sm" color="error">disabled</Badge></span> : undefined}>
      {detail.error ? <ErrorNotice error={detail.error} /> : !d ? <p className={`text-sm ${muted}`}>Loading…</p> : remove.data ? (
        <div className="space-y-4"><p className="text-sm text-gray-700 dark:text-gray-300">Deleted {user.email}: {remove.data.memberships} role{remove.data.memberships === 1 ? "" : "s"} and {remove.data.tokens} token{remove.data.tokens === 1 ? "" : "s"} removed. The audit trail keeps what they did.</p><div className="flex justify-end"><button type="button" className={primaryButton} onClick={onClose}>Done</button></div></div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <div className="space-y-5 lg:col-span-3">
            <section>
              <h5 className="mb-2 text-sm font-semibold text-gray-800 dark:text-white/90">Roles ({d.memberships.length})</h5>
              {d.memberships.length === 0 ? <p className={`text-sm ${muted}`}>No role anywhere: they can sign in but see nothing until someone adds them on a Members page.</p> : (
                <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                  {d.memberships.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span><Badge size="sm" color={m.expired ? "light" : "primary"}>{m.role.replace(/_/g, " ").toLowerCase()}</Badge> <span className={muted}>on {m.scopeType.toLowerCase()}</span> {m.scope ? <Link className="text-brand-500 hover:underline" to={membersPath({ type: m.scopeType, id: m.scopeId })} onClick={onClose}>{m.scope.name}</Link> : m.scopeId}</span>
                      <span className={`text-xs ${muted}`}>{m.expiresAt ? `${m.expired ? "expired" : "until"} ${formatDate(m.expiresAt)}` : `since ${formatDate(m.grantedAt)}`}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h5 className="mb-2 text-sm font-semibold text-gray-800 dark:text-white/90">Tokens ({active.length} active)</h5>
              {d.tokens.length === 0 ? <p className={`text-sm ${muted}`}>No tokens.</p> : (
                <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                  {d.tokens.map((t) => <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"><span><span className="font-medium text-gray-800 dark:text-white/90">{t.name}</span> <span className={`font-mono text-xs ${muted}`}>{t.prefix}…</span> <Badge size="sm" color="light">{t.scope}</Badge> <span className={`text-xs ${muted}`}>{t.source}</span></span><span className={`text-xs ${muted}`}>{t.revokedAt ? "revoked" : t.expired ? "expired" : `until ${formatDate(t.expiresAt)}`} · last used {t.lastUsedAt ? formatDate(t.lastUsedAt) : "never"}</span></li>)}
                </ul>
              )}
            </section>
          </div>
          <div className="space-y-5 lg:col-span-2">
            {!bot && userAdmin && (
              <section className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                <h5 className="text-sm font-semibold text-gray-800 dark:text-white/90">Password</h5>
                {reset.data ? <LinkResult result={reset.data} who={user.email} /> : (
                  <>
                    <button type="button" className={outlineButton} disabled={reset.isPending} onClick={() => reset.mutate({ id: user.id })}>Send a reset link</button>
                    <div><Label htmlFor="mu-pw">or set a temporary password</Label><div className="flex gap-2"><input id="mu-pw" minLength={12} className={`${inputClass} font-mono`} value={tempPassword} onChange={(e) => setTempPassword(e.target.value)} placeholder="at least 12 characters" /><button type="button" className={outlineButton} onClick={() => setTempPassword(randomPassword())}>Generate</button></div></div>
                    <button type="button" className={primaryButton} disabled={reset.isPending || tempPassword.length < 12} onClick={() => reset.mutate({ id: user.id, temporaryPassword: tempPassword })}>Set temporary password</button>
                  </>
                )}
                {reset.data?.temporaryPassword && <OneTimeSecret value={tempPassword} label="Copy password" />}
                {reset.error ? <ErrorNotice error={reset.error} /> : null}
              </section>
            )}
            {!self && (
              <section className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                <h5 className="text-sm font-semibold text-gray-800 dark:text-white/90">Access</h5>
                <p className={`text-xs ${muted}`}>{user.disabledAt ? "Disabled: roles kept, no sign-in, tokens refused." : "Disabling keeps their roles but blocks sign-in and every token, and ends their open sessions."}</p>
                <button type="button" className={user.disabledAt ? outlineButton : dangerButton} disabled={update.isPending} onClick={() => update.mutate({ userId: user.id, enabled: !!user.disabledAt }, { onSuccess: onClose })}>{user.disabledAt ? "Enable" : "Disable"}</button>
                {update.error ? <ErrorNotice error={update.error} /> : null}
              </section>
            )}
            {!self && userAdmin && (
              <section className="space-y-3 rounded-xl border border-error-200 p-4 dark:border-error-500/30">
                <h5 className="text-sm font-semibold text-error-600 dark:text-error-400">Delete</h5>
                <p className={`text-xs ${muted}`}>Removes the sign-in account{bot ? "" : " (Keycloak)"}, {d.memberships.length} role{d.memberships.length === 1 ? "" : "s"} and {d.tokens.length} token{d.tokens.length === 1 ? "" : "s"} ({active.length} active — anything using them stops working). Audit events keep their e-mail. A sole organization admin cannot be deleted.</p>
                <button type="button" className={dangerButton} disabled={remove.isPending} onClick={() => { if (window.confirm(`Delete ${user.email} for good?`)) remove.mutate(user.id); }}>Delete user</button>
                {remove.error ? <ErrorNotice error={remove.error} /> : null}
              </section>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
