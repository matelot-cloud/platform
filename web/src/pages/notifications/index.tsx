import { CodeBlock } from "@/platform/components/CodeBlock";
import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { useChannelAction, useNotificationCapabilities, useNotificationChannels, useNotificationEvents, useProjects, useSaveChannel } from "@/platform/api/hooks";
import type { NotificationChannel, Organization } from "@/platform/api/types";
import { BrandIcon } from "@/platform/components/EnvironmentManager";
import { OrganizationGate } from "@/platform/components/OrganizationGate";
import { Card, ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField } from "@/platform/components/ui";
import { relativeTime } from "@/platform/format";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { cn } from "@/utils";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

type Kind = "slack" | "teams" | "email" | "webhook";
const KINDS: { id: Kind; label: string; hint: string; placeholder: string; field: string }[] = [
  { id: "slack", label: "Slack", hint: "Incoming webhook", placeholder: "https://hooks.slack.com/services/…", field: "Incoming-webhook URL" },
  { id: "teams", label: "Microsoft Teams", hint: "Incoming webhook or Workflows", placeholder: "https://….webhook.office.com/webhookb2/…", field: "Incoming-webhook URL" },
  { id: "email", label: "E-mail", hint: "Via the cell's SMTP", placeholder: "security@company.com, oncall@company.com", field: "Recipients" },
  { id: "webhook", label: "Webhook", hint: "JSON POST to your endpoint", placeholder: "https://example.com/hooks/matelot", field: "HTTPS endpoint" },
];
const GROUPS: { title: string; blurb: string; events: string[] }[] = [
  { title: "Releases & gates", blurb: "What happens when something ships", events: ["gate.fail", "deployment.rejected", "deployment.production"] },
  { title: "Hygiene", blurb: "Things that need a human, on a schedule", events: ["sla.overdue", "kev.production", "exception.expiring", "secret.detected"] },
];
const SEVERITY: Record<string, "error" | "warning" | "info"> = { "gate.fail": "warning", "deployment.rejected": "error", "deployment.production": "info", "sla.overdue": "warning", "kev.production": "error", "exception.expiring": "warning", "secret.detected": "error" };

function KindMark({ kind, className }: { kind: Kind; className?: string }) {
  return kind === "webhook" ? <span className={cn("inline-flex items-center justify-center rounded-xl bg-gray-100 font-mono text-sm font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-300", className)}>{"{ }"}</span> : <BrandIcon name={kind} className={className} />;
}

function EventChip({ id, on, onToggle, description }: { id: string; on: boolean; onToggle?: () => void; description?: string }) {
  const tone = SEVERITY[id] ?? "info";
  return (
    <button type="button" onClick={onToggle} title={description} className={cn("group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition", onToggle && "cursor-pointer", on ? (tone === "error" ? "border-error-300 bg-error-50 text-error-700 dark:border-error-500/40 dark:bg-error-500/10 dark:text-error-400" : tone === "warning" ? "border-warning-300 bg-warning-50 text-warning-700 dark:border-warning-500/40 dark:bg-warning-500/10 dark:text-warning-400" : "border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-400") : "border-dashed border-gray-300 text-gray-400 dark:border-gray-700 dark:text-gray-500")}>
      <span className={cn("size-1.5 rounded-full", on ? "bg-current" : "bg-gray-300 dark:bg-gray-600")} />
      {id}
    </button>
  );
}

function ChannelDialog({ organization, channel, onClose, scope, initialKind }: { organization: Organization; channel: NotificationChannel | null; onClose: () => void; scope?: string; initialKind?: Kind }) {
  const events = useNotificationEvents();
  const caps = useNotificationCapabilities();
  const projects = useProjects(organization.id);
  const save = useSaveChannel(organization.id, scope);
  const [name, setName] = useState(channel?.name ?? "");
  const [kind, setKind] = useState<Kind>(channel?.kind ?? initialKind ?? "slack");
  const [url, setUrl] = useState("");
  const all = (events.data ?? []).map((e) => e.id);
  const [selected, setSelected] = useState<string[]>(channel?.events ?? all);
  const [projectId, setProjectId] = useState(channel?.projectId ?? "");
  const desc = Object.fromEntries((events.data ?? []).map((e) => [e.id, e.description]));
  const k = KINDS.find((x) => x.id === kind)!;
  const toggle = (e: string) => setSelected((v) => (v.includes(e) ? v.filter((x) => x !== e) : [...v, e]));
  const emailOff = kind === "email" && caps.data && !caps.data.email;
  return (
    <Modal isOpen onClose={onClose} className="max-w-190 p-0">
      <form onSubmit={(ev) => { ev.preventDefault(); save.mutate({ id: channel?.id, name, kind, url: url || undefined, events: selected, projectId: projectId || null }, { onSuccess: onClose }); }}>
        <div className="border-b border-gray-100 px-8 py-5 dark:border-gray-800">
          <h4 className="text-lg font-semibold text-gray-800 dark:text-white/90">{channel ? `Edit ${channel.name}` : "New notification channel"}</h4>
          <p className={`mt-0.5 text-sm ${muted}`}>Pick where messages go, then which events should reach it.</p>
        </div>
        <div className="grid grid-cols-1 gap-8 px-8 py-6 lg:grid-cols-5">
          <div className="space-y-5 lg:col-span-3">
            <div>
              <Label>Destination</Label>
              <div className="grid grid-cols-2 gap-2">
                {KINDS.map((x) => (
                  <button key={x.id} type="button" disabled={!!channel} onClick={() => setKind(x.id)} className={cn("flex items-center gap-3 rounded-2xl border p-3 text-start transition", kind === x.id ? "border-brand-500 bg-brand-50/60 shadow-theme-xs ring-2 ring-brand-500/15 dark:bg-brand-500/5" : "border-gray-200 hover:border-gray-300 dark:border-gray-800 dark:hover:border-gray-700", channel && "cursor-default opacity-90")}>
                    <KindMark kind={x.id} className="size-9 shrink-0" />
                    <span className="min-w-0"><span className="block text-sm font-semibold text-gray-800 dark:text-white/90">{x.label}</span><span className={`block truncate text-[11px] ${muted}`}>{x.id === "email" && emailOff ? "SMTP not configured on this cell" : x.hint}</span></span>
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="md:col-span-2"><Label htmlFor="ch-name">Name</Label><input id="ch-name" required autoFocus className={inputClass} placeholder={kind === "email" ? "Security on-call" : "#security-alerts"} value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="md:col-span-2">
                <Label htmlFor="ch-url">{k.field}</Label>
                <input id="ch-url" type={kind === "email" ? "text" : "url"} required={!channel} className={`${inputClass} font-mono text-sm`} placeholder={k.placeholder} value={url} onChange={(e) => setUrl(e.target.value)} />
                <p className={`mt-1 text-xs ${muted}`}>{kind === "email" ? "Comma-separated. Sent from the SMTP server configured on the cell." : "Stored encrypted; shown masked afterwards."}{channel ? " Leave empty to keep the current value." : ""}</p>
              </div>
              {!scope && <div className="md:col-span-2"><Label>Scope</Label><SelectField value={projectId} onChange={setProjectId} options={[{ value: "", label: `Whole organization · ${organization.name}` }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: `Only project · ${p.name}` }))]} /></div>}
            </div>
          </div>
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between"><Label>Events</Label><button type="button" className="text-xs font-medium text-brand-500 hover:underline" onClick={() => setSelected(selected.length === all.length ? [] : all)}>{selected.length === all.length ? "Clear all" : "Select all"}</button></div>
            <div className="space-y-4 rounded-2xl border border-gray-200 p-4 dark:border-gray-800">
              {GROUPS.map((g) => (
                <div key={g.title}>
                  <p className="text-sm font-medium text-gray-800 dark:text-white/90">{g.title}</p>
                  <p className={`mb-2 text-xs ${muted}`}>{g.blurb}</p>
                  <div className="flex flex-wrap gap-2">{g.events.filter((e) => all.includes(e)).map((e) => <EventChip key={e} id={e} on={selected.includes(e)} onToggle={() => toggle(e)} description={desc[e]} />)}</div>
                </div>
              ))}
              <p className={`text-xs ${muted}`}>{selected.length} of {all.length} events selected. Hover a chip for what it means.</p>
            </div>
          </div>
        </div>
        {save.error ? <div className="px-8 pb-2"><ErrorNotice error={save.error} /></div> : null}
        <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-8 py-4 dark:border-gray-800">
          <button type="button" className={outlineButton} onClick={onClose}>Cancel</button>
          <button type="submit" className={primaryButton} disabled={save.isPending || !name.trim() || (!channel && !url) || !!emailOff || selected.length === 0}>{save.isPending ? "Saving…" : channel ? "Save changes" : "Create channel"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ChannelCard({ c, onEdit, onToggle, onTest, onDelete, busy }: { c: NotificationChannel & { inherited?: boolean; scopeType?: string }; onEdit: () => void; onToggle: () => void; onTest: () => void; onDelete: () => void; busy: boolean }) {
  const label = KINDS.find((k) => k.id === c.kind)?.label ?? c.kind;
  const health = c.lastError ? { color: "error" as const, text: "delivery failing" } : !c.enabled ? { color: "light" as const, text: "paused" } : c.lastSentAt ? { color: "success" as const, text: `last sent ${relativeTime(c.lastSentAt)}` } : { color: "warning" as const, text: "never sent yet" };
  return (
    <div className={cn("flex flex-col rounded-2xl border bg-white p-5 shadow-theme-xs transition dark:bg-white/3", c.enabled ? "border-gray-200 dark:border-gray-800" : "border-dashed border-gray-300 opacity-75 dark:border-gray-700")}>
      <div className="flex items-start gap-4">
        <KindMark kind={c.kind} className="size-11 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2"><span className="truncate text-base font-semibold text-gray-800 dark:text-white/90">{c.name}</span>{c.inherited && <Badge size="sm" color="light">inherited</Badge>}</p>
          <p className={`mt-0.5 text-xs ${muted}`}>{label} · <span className="font-mono">{c.url}</span></p>
          <p className="mt-2 flex items-center gap-2 text-xs"><span className={cn("size-2 rounded-full", health.color === "success" ? "bg-success-500" : health.color === "error" ? "bg-error-500" : health.color === "warning" ? "bg-warning-500" : "bg-gray-400")} /><span className={health.color === "error" ? "text-error-500" : muted}>{health.text}</span></p>
          {c.lastError && <p className="mt-1 rounded-lg bg-error-50 px-2 py-1 font-mono text-[11px] text-error-700 dark:bg-error-500/10 dark:text-error-400">{c.lastError}</p>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">{c.events.map((e) => <EventChip key={e} id={e} on />)}</div>
      {!c.inherited && (
        <div className="mt-4 flex items-center gap-1 border-t border-gray-100 pt-3 text-sm dark:border-gray-800">
          <button type="button" className="rounded-lg px-2.5 py-1.5 font-medium text-brand-500 hover:bg-brand-50 dark:hover:bg-brand-500/10" disabled={busy} onClick={onTest}>Send test</button>
          <button type="button" className="rounded-lg px-2.5 py-1.5 font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5" onClick={onEdit}>Edit</button>
          <button type="button" className="rounded-lg px-2.5 py-1.5 font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5" onClick={onToggle}>{c.enabled ? "Pause" : "Resume"}</button>
          <span className="flex-1" />
          <button type="button" className="rounded-lg px-2.5 py-1.5 font-medium text-error-500 hover:bg-error-50 dark:hover:bg-error-500/10" onClick={onDelete}>Delete</button>
        </div>
      )}
    </div>
  );
}

export function Channels({ organization, scope, scopeLabel }: { organization: Organization; scope?: string; scopeLabel?: string }) {
  const channels = useNotificationChannels(organization.id, scope);
  const events = useNotificationEvents();
  const action = useChannelAction(organization.id);
  const save = useSaveChannel(organization.id, scope);
  const [dialog, setDialog] = useState<{ channel: NotificationChannel | null; kind?: Kind } | null>(null);
  const [params, setParams] = useSearchParams();
  useEffect(() => { const k = params.get("new"); if (k && ["slack", "teams", "email", "webhook"].includes(k)) { setDialog({ channel: null, kind: k as Kind }); setParams((p) => { p.delete("new"); return p; }, { replace: true }); } }, [params, setParams]);
  const rows = (channels.data ?? []) as (NotificationChannel & { inherited?: boolean })[];
  const own = rows.filter((c) => !c.inherited);
  const inherited = rows.filter((c) => c.inherited);
  const covered = new Set(rows.filter((c) => c.enabled).flatMap((c) => c.events));
  const all = (events.data ?? []).map((e) => e.id);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold text-gray-800 dark:text-white/90">Notifications{scopeLabel ? <span className={`ms-2 text-base font-normal ${muted}`}>· {scopeLabel}</span> : null}</h3>
          <p className={`mt-1 max-w-2xl text-sm ${muted}`}>Where Matelot reaches people when a decision is needed: a failed gate, a rejected or production deployment, findings past their SLA, a known-exploited vulnerability in production, an expiring exception, a committed secret.{scopeLabel ? " Channels created here receive only events from this scope." : ""}</p>
        </div>
        <button type="button" className={primaryButton} onClick={() => setDialog({ channel: null })}>New channel</button>
      </div>

      {channels.error ? <ErrorNotice error={channels.error} /> : (
        <>
          {/* coverage strip */}
          {all.length > 0 && (
            <div className="rounded-2xl border border-gray-200 bg-gray-50/60 px-5 py-4 dark:border-gray-800 dark:bg-white/2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-gray-800 dark:text-white/90">Coverage <span className={`font-normal ${muted}`}>· {covered.size} of {all.length} events reach at least one active channel</span></p>
                <p className={`text-xs ${muted}`}>{own.length} channel{own.length === 1 ? "" : "s"} here{inherited.length ? ` · ${inherited.length} inherited` : ""}</p>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">{all.map((e) => <EventChip key={e} id={e} on={covered.has(e)} description={events.data?.find((x) => x.id === e)?.description} />)}</div>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-300 p-10 text-center dark:border-gray-700">
              <div className="mx-auto mb-4 flex items-center justify-center gap-3"><KindMark kind="slack" className="size-10" /><KindMark kind="teams" className="size-10" /><KindMark kind="email" className="size-10" /><KindMark kind="webhook" className="size-10" /></div>
              <p className="text-base font-semibold text-gray-800 dark:text-white/90">No channel yet</p>
              <p className={`mx-auto mt-1 max-w-md text-sm ${muted}`}>Add a Slack or Teams webhook, an e-mail list, or your own endpoint. You can test it right away.</p>
              <button type="button" className={`${primaryButton} mt-5`} onClick={() => setDialog({ channel: null })}>Add your first channel</button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {own.map((c) => <ChannelCard key={c.id} c={c} busy={action.isPending} onEdit={() => setDialog({ channel: c })} onTest={() => action.mutate({ id: c.id, action: "test" })} onToggle={() => save.mutate({ id: c.id, name: c.name, events: c.events, enabled: !c.enabled })} onDelete={() => { if (window.confirm(`Remove "${c.name}"?`)) action.mutate({ id: c.id, action: "delete" }); }} />)}
              </div>
              {inherited.length > 0 && (
                <div>
                  <p className={`mb-3 text-xs font-medium uppercase tracking-wide ${muted}`}>Inherited from above</p>
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{inherited.map((c) => <ChannelCard key={c.id} c={c} busy onEdit={() => undefined} onTest={() => undefined} onToggle={() => undefined} onDelete={() => undefined} />)}</div>
                </div>
              )}
            </>
          )}
          {action.error ? <ErrorNotice error={action.error} /> : null}
          {action.data && "sent" in action.data && action.data.sent ? <p className="text-sm text-success-600">Test message delivered.</p> : null}
        </>
      )}

      <Card title="Webhook payload" description="For the Webhook kind. Slack and Teams receive native cards; e-mail gets a text and HTML version.">
        <CodeBlock code={`POST <your endpoint>  ·  Content-Type: application/json
{ "source": "matelot", "event": "gate.fail", "severity": "warning",
  "title": "Gate failed · demo → prod", "text": "• Production baseline: 7 open critical/high vulnerabilities …",
  "url": null, "fields": { "subject": "v1.9.8", "by": "token release" },
  "organizationId": "…", "projectId": "…", "sentAt": "…" }`} />
      </Card>
      {dialog && <ChannelDialog organization={organization} channel={dialog.channel} initialKind={dialog.kind} onClose={() => setDialog(null)} scope={scope} />}
    </div>
  );
}

export default function NotificationsPage() {
  const { productName } = useRuntimeConfig();
  return (
    <>
      <PageMeta title={`Notifications · ${productName}`} description="Notification channels" />
      <PageBreadcrumb pageTitle="Notifications" />
      <OrganizationGate>{(organization) => <Channels key={organization.id} organization={organization} />}</OrganizationGate>
    </>
  );
}
