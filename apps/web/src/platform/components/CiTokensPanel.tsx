import { CreatedToken, EnvironmentPicker, envChoices } from "./CiTokenParts";
import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { PlusIcon } from "@/icons";
import { isForbidden } from "@/platform/api/client";
import { useApiTokens, useCreateApiToken, useRevokeApiToken, useServices, useTokenPresets, useServiceEnvironmentsMap } from "@/platform/api/hooks";
import type { ApiToken, ScopeType } from "@/platform/api/types";
import { relativeTime } from "@/platform/format";
import { useState, type FormEvent } from "react";
import { Card, dangerLink, EmptyState, ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField, td, th, trBorder } from "./ui";

const LEVEL: Record<ScopeType, string> = { ORGANIZATION: "organization", WORKSPACE: "workspace", TEAM: "team", PROJECT: "project", SERVICE: "service", ENVIRONMENT: "environment" };

const platformUrl = window.location.hostname === "localhost" ? "http://localhost:3000" : window.location.origin;

/** CI tokens at a level: signed machine credentials for pipelines. */
export function CiTokensPanel({ organizationId, scopeType, scopeId, scopeName }: { organizationId: string; scopeType: ScopeType; scopeId: string; scopeName: string }) {
  const tokens = useApiTokens(organizationId);
  const presets = useTokenPresets();
  const create = useCreateApiToken(organizationId);
  const revoke = useRevokeApiToken(organizationId);
  const [dialog, setDialog] = useState(false);
  const [created, setCreated] = useState<ApiToken | null>(null);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("deploy");
  const [expires, setExpires] = useState("90");
  const [allowed, setAllowed] = useState<string[]>([]);
  const services = useServices(scopeType === "PROJECT" ? scopeId : undefined);
  const envMap = useServiceEnvironmentsMap((services.data ?? []).map((s) => s.id));
  const choices = envChoices(envMap);
  const list = (tokens.data ?? []).filter((t) => t.scope.type === scopeType && t.scope.id === scopeId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ name, scopeType, scopeId, preset, expiresInDays: expires ? Number(expires) : undefined, environments: allowed }, { onSuccess: (t) => { setDialog(false); setCreated(t); setName(""); setAllowed([]); } });
  };
  return (
    <Card
      title="CI tokens"
      description={`Machine credentials for pipelines of this ${LEVEL[scopeType]} (${scopeName}). Requests are signed with the secret (HMAC), never carry it, and cannot be replayed. The secret is shown once.`}
      flush
      actions={<button type="button" className={primaryButton} onClick={() => setDialog(true)} disabled={isForbidden(tokens.error)}><PlusIcon className="size-5" /> New token</button>}
    >
      {isForbidden(tokens.error) ? <EmptyState title="Not visible with your role">Tokens are managed by whoever can manage members at this level.</EmptyState> : list.length === 0 ? (
        <EmptyState title="No CI token yet">Create one for your deploy job; it reports releases and deployments, or runs security pipelines, depending on the preset.</EmptyState>
      ) : (
        <table className="min-w-full">
          <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Token</th><th className={th}>Key id</th><th className={th}>Permissions</th><th className={th}>Expires</th><th className={th}>Last used</th><th className={th} /></tr></thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} className={`${trBorder} ${t.revokedAt ? "opacity-60" : ""}`}>
                <td className={td}><span className="font-medium text-gray-800 dark:text-white/90">{t.name}</span>{t.revokedAt && <Badge size="sm" color="light">revoked</Badge>}</td>
                <td className={`${td} font-mono text-xs ${muted}`}>{t.keyId}</td>
                <td className={td}>{t.permissions.map((p) => <Badge key={p} size="sm" color="light">{p}</Badge>)}{t.environments?.length ? <span className={`block text-xs ${muted}`}>deploys to: {t.environments.join(", ")}</span> : null}</td>
                <td className={`${td} ${muted}`}>{t.expiresAt ? relativeTime(t.expiresAt) : "never"}</td>
                <td className={`${td} ${muted}`}>{t.lastUsedAt ? `${relativeTime(t.lastUsedAt)}${t.lastUsedFrom ? ` from ${t.lastUsedFrom}` : ""}` : "never"}</td>
                <td className={`${td} text-end`}>{!t.revokedAt && <button type="button" className={dangerLink} onClick={() => { if (window.confirm(`Revoke ${t.name}? Pipelines using it fail immediately.`)) revoke.mutate(t.id); }}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(create.error || revoke.error) ? <div className="p-4"><ErrorNotice error={create.error ?? revoke.error} /></div> : null}

      {dialog && (
        <Modal isOpen title="New CI token" onClose={() => setDialog(false)} className="max-w-170 p-5 sm:p-6 lg:p-8">
          <form onSubmit={submit} className="space-y-5">
            <div><Label htmlFor="tk-name">Name</Label><input id="tk-name" required autoFocus className={inputClass} placeholder="github-actions deploy" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div>
              <Label>What it may do</Label>
              <SelectField value={preset} onChange={setPreset} options={Object.entries(presets.data?.presets ?? {}).map(([k, v]) => ({ value: k, label: v.label }))} />
              <p className={`mt-1.5 text-xs ${muted}`}>{presets.data?.presets[preset]?.description} Permissions: {presets.data?.presets[preset]?.permissions.join(", ")}.</p>
            </div>
            <div><Label>Expires</Label><SelectField value={expires} onChange={setExpires} options={[{ value: "30", label: "in 30 days" }, { value: "90", label: "in 90 days" }, { value: "365", label: "in a year" }, { value: "", label: "never (rotate manually)" }]} /></div>
            {choices.length > 0 && <EnvironmentPicker choices={choices} value={allowed} onChange={setAllowed} preset={preset} />}
            <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={() => setDialog(false)}>Cancel</button><button type="submit" className={primaryButton} disabled={create.isPending}>{create.isPending ? "Creating…" : "Create token"}</button></div>
          </form>
        </Modal>
      )}
      {created?.secret && (
        <Modal isOpen title={<>Token "{created.name}" created</>} description={<span className="text-warning-600">Copy the secret now — it is not stored in readable form and cannot be shown again.</span>} onClose={() => setCreated(null)} className="max-w-200 p-5 sm:p-6 xl:max-w-300 xl:p-8">
          <CreatedToken token={created} secret={created.secret} url={platformUrl} />
          <div className="mt-6 flex justify-end gap-3">
            <button type="button" className={primaryButton} onClick={() => setCreated(null)}>I saved it</button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
