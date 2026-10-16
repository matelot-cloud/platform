import { CodeBlock } from "@/platform/components/CodeBlock";
import PageMeta from "@/components/common/PageMeta";
import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { useCreatePersonalToken, usePersonalTokens, useRevokePersonalToken, type PersonalToken } from "@/platform/api/hooks";
import { Card, dangerLink, EmptyState, ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField, td, th, trBorder } from "@/platform/components/ui";
import { formatDate, relativeTime } from "@/platform/format";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { cn } from "@/utils";
import { useState } from "react";

const SCOPES: { value: PersonalToken["scope"]; title: string; text: string }[] = [
  { value: "read", title: "Read", text: "GET requests only, in the projects, teams and workspaces you are a member of." },
  { value: "write", title: "Write", text: "The full API as you, limited to your memberships. Organization and platform admin rights are not included." },
  { value: "sudo", title: "Sudo", text: "Everything you can do, including organization / platform administration. Administrators only — keep it short-lived." },
];

function CreateDialog({ canSudo, onClose }: { canSudo: boolean; onClose: () => void }) {
  const create = useCreatePersonalToken();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<PersonalToken["scope"]>("write");
  const [days, setDays] = useState("30");
  const [copied, setCopied] = useState(false);
  const origin = window.location.origin;
  if (create.data) {
    const t = create.data.token;
    return (
      <Modal isOpen title="Token created" description={<span className="text-warning-600">Copy it now — it is shown only once. It acts as you ({create.data.scope}), until {formatDate(create.data.expiresAt)}.</span>} onClose={onClose} className="max-w-160 p-6 lg:p-8">
        <div className="space-y-4">
          <CodeBlock code={t} wrap lines={false} />
          <button type="button" className={primaryButton} onClick={() => { void navigator.clipboard?.writeText(t); setCopied(true); }}>{copied ? "Copied" : "Copy token"}</button>
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-white/90">Use it</p>
            <CodeBlock className="mt-1" wrap code={`# API\ncurl -H "Authorization: Bearer ${t.slice(0, 10)}…" ${origin}/api/v1/me\n\n# matelot CLI (as you, instead of a CI token)\nexport MATELOT_URL=${origin}\nexport MATELOT_TOKEN=${t.slice(0, 10)}…\nmatelot whoami`} />
          </div>
          <div className="flex justify-end"><button type="button" className={outlineButton} onClick={onClose}>Done</button></div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal isOpen title="New personal access token" onClose={onClose} className="max-w-160 p-6 lg:p-8">
      <form onSubmit={(e) => { e.preventDefault(); create.mutate({ name, scope, expiresInDays: Number(days) }); }} className="space-y-5">
        <div><Label htmlFor="pat-name">Name</Label><input id="pat-name" required autoFocus className={inputClass} placeholder="laptop · scripts · Jira sync" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div>
          <Label>Scope</Label>
          <div className="space-y-2">
            {SCOPES.map((s) => {
              const disabled = s.value === "sudo" && !canSudo;
              return (
                <label key={s.value} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3", scope === s.value ? "border-brand-500 bg-brand-50/50 dark:bg-brand-500/5" : "border-gray-200 dark:border-gray-800", disabled && "cursor-not-allowed opacity-50")}>
                  <input type="radio" name="scope" className="mt-1" disabled={disabled} checked={scope === s.value} onChange={() => setScope(s.value)} />
                  <span><span className="text-sm font-medium text-gray-800 dark:text-white/90">{s.title}</span>{s.value === "sudo" && <Badge size="sm" color="error">admin</Badge>}<span className={`block text-xs ${muted}`}>{s.text}{disabled ? " (you are not an administrator)" : ""}</span></span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="w-48"><Label>Expires in</Label><SelectField value={days} onChange={setDays} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "1 year" }]} /></div>
        {create.error ? <ErrorNotice error={create.error} /> : null}
        <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={onClose}>Cancel</button><button type="submit" className={primaryButton} disabled={create.isPending || !name.trim()}>{create.isPending ? "Creating…" : "Create token"}</button></div>
      </form>
    </Modal>
  );
}

export default function AccessTokensPage() {
  const { productName } = useRuntimeConfig();
  const tokens = usePersonalTokens();
  const revoke = useRevokePersonalToken();
  const [dialog, setDialog] = useState(false);
  const list = tokens.data?.tokens ?? [];
  const status = (t: PersonalToken) => (t.revokedAt ? <Badge size="sm" color="light">revoked</Badge> : t.expired ? <Badge size="sm" color="warning">expired</Badge> : <Badge size="sm" color="success">active</Badge>);
  return (
    <>
      <PageMeta title={`Access tokens · ${productName}`} description="Personal access tokens" />
      <div className="space-y-6">
        <Card title="Personal access tokens" description="Tokens that act as you for the API and the matelot CLI. Read and write tokens reach only the projects, teams and workspaces you are a member of; sudo tokens (administrators) carry your full rights. For pipelines, prefer project CI tokens (project → Settings → CI tokens)." flush actions={<button type="button" className={primaryButton} onClick={() => setDialog(true)}>New token</button>}>
          {tokens.error ? <div className="p-4"><ErrorNotice error={tokens.error} /></div> : list.length === 0 ? <EmptyState title="No tokens yet">Create one to use the API or the CLI as yourself.</EmptyState> : (
            <table className="min-w-full">
              <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Name</th><th className={th}>Scope</th><th className={th}>Status</th><th className={th}>Expires</th><th className={th}>Last used</th><th className={th} /></tr></thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id} className={trBorder}>
                    <td className={td}><span className="font-medium text-gray-800 dark:text-white/90">{t.name}</span>{t.source === "oauth" && <span className={`ms-2 rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-600 dark:bg-white/10 dark:text-gray-300`} title="Issued through an OAuth consent (claude.ai connector, matelot login); refreshed by that application">oauth</span>}<span className={`block font-mono text-xs ${muted}`}>{t.prefix}…</span></td>
                    <td className={td}><Badge size="sm" color={t.scope === "sudo" ? "error" : t.scope === "write" ? "primary" : "light"}>{t.scope}</Badge></td>
                    <td className={td}>{status(t)}</td>
                    <td className={`${td} ${muted}`}>{formatDate(t.expiresAt)}</td>
                    <td className={`${td} ${muted}`}>{t.lastUsedAt ? <>{relativeTime(t.lastUsedAt)}{t.lastUsedIp ? <span className="block text-xs">{t.lastUsedIp}</span> : null}</> : "never"}</td>
                    <td className={`${td} text-end`}>{!t.revokedAt && !t.expired && <button type="button" className={dangerLink} disabled={revoke.isPending} onClick={() => { if (window.confirm(`Revoke "${t.name}"? Anything using it stops working immediately.`)) revoke.mutate(t.id); }}>Revoke</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {revoke.error ? <div className="p-4"><ErrorNotice error={revoke.error} /></div> : null}
        </Card>
      </div>
      {dialog && <CreateDialog canSudo={!!tokens.data?.canCreateSudo} onClose={() => setDialog(false)} />}
    </>
  );
}
