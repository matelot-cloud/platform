import Label from "@/components/form/Label";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { useCreateException, useExceptions, useApproveException, useRevokeException } from "@/platform/api/hooks";
import type { Organization, SecurityException } from "@/platform/api/types";
import { formatDate, relativeTime } from "@/platform/format";
import { useState } from "react";
import { Card, dangerLink, EmptyState, ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField, td, th, trBorder } from "./ui";

const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

/** Dialog: accept CVE-… / rule … in a scope until a date, with a reason. Prefill from a finding. */
export function ExceptionDialog({ scope, initial, onClose }: { scope: { type: "organization" | "project" | "service"; id: string; name: string }; initial?: { kind: "vulnerability" | "code"; matchId: string; matchComponent?: string }; onClose: () => void }) {
  const create = useCreateException();
  const [kind, setKind] = useState<"vulnerability" | "code">(initial?.kind ?? "vulnerability");
  const [matchId, setMatchId] = useState(initial?.matchId ?? "");
  const [matchComponent, setMatchComponent] = useState(initial?.matchComponent ?? "");
  const [status, setStatus] = useState("accepted");
  const [reason, setReason] = useState("");
  const [ticketUrl, setTicketUrl] = useState("");
  const [expiresAt, setExpiresAt] = useState(inDays(30));
  return (
    <Modal isOpen onClose={onClose} className="max-w-160 p-6 pe-20 lg:p-8 lg:pe-24">
      <form onSubmit={(e) => { e.preventDefault(); create.mutate({ scope: { type: scope.type, id: scope.id }, kind, matchId, matchComponent: matchComponent || undefined, status: status as "accepted", reason, ticketUrl: ticketUrl || undefined, expiresAt: new Date(`${expiresAt}T23:59:59Z`).toISOString() }, { onSuccess: onClose }); }} className="space-y-4">
        <h4 className="text-lg font-semibold text-gray-800 dark:text-white/90">New exception · {scope.name}</h4>
        <p className={`text-sm ${muted}`}>Time-boxed acceptance. Matching open findings in this scope take the chosen status until the date; then they reopen automatically. The gate and the risk score honour it, and the audit log records who, why and until when.</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div><Label>What</Label><SelectField value={kind} onChange={(v) => setKind(v as "vulnerability" | "code")} options={[{ value: "vulnerability", label: "Vulnerability (CVE / GHSA)" }, { value: "code", label: "Code rule (secret / IaC)" }]} /></div>
          <div><Label htmlFor="ex-id">{kind === "vulnerability" ? "Advisory id" : "Rule id"}</Label><input id="ex-id" required className={inputClass} placeholder={kind === "vulnerability" ? "CVE-2024-12345" : "DS-0026"} value={matchId} onChange={(e) => setMatchId(e.target.value)} /></div>
          <div><Label htmlFor="ex-comp">{kind === "vulnerability" ? "Only this component (optional)" : "Only files under (optional)"}</Label><input id="ex-comp" className={inputClass} placeholder={kind === "vulnerability" ? "openssl" : "deploy/"} value={matchComponent} onChange={(e) => setMatchComponent(e.target.value)} /></div>
          <div><Label>Status while active</Label><SelectField value={status} onChange={setStatus} options={[{ value: "accepted", label: "Accepted (risk accepted)" }, { value: "not_affected", label: "Not affected (VEX)" }, { value: "false_positive", label: "False positive" }]} /></div>
          <div><Label htmlFor="ex-until">Until</Label><input id="ex-until" type="date" required className={inputClass} value={expiresAt} min={inDays(1)} max={inDays(365)} onChange={(e) => setExpiresAt(e.target.value)} /><p className={`mt-1 text-xs ${muted}`}>Max one year; renew instead of extending.</p></div>
          <div><Label htmlFor="ex-ticket">Ticket (optional)</Label><input id="ex-ticket" className={inputClass} placeholder="https://jira/SEC-42" value={ticketUrl} onChange={(e) => setTicketUrl(e.target.value)} /></div>
        </div>
        <div><Label htmlFor="ex-reason">Reason</Label><textarea id="ex-reason" required rows={3} className={inputClass} placeholder="Why this is acceptable — reachability, compensating control, vendor timeline…" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        {create.error ? <ErrorNotice error={create.error} /> : null}
        <div className="flex justify-end gap-3"><button type="button" className={outlineButton} onClick={onClose}>Cancel</button><button type="submit" className={primaryButton} disabled={create.isPending || !matchId.trim() || !reason.trim()}>{create.isPending ? "Creating…" : "Create exception"}</button></div>
      </form>
    </Modal>
  );
}

export function ExceptionsPanel({ organization, scope }: { organization: Organization; scope: { type: "organization" | "project" | "service"; id: string; name: string } }) {
  const list = useExceptions(organization.id);
  const revoke = useRevokeException();
  const approve = useApproveException();
  const [dialog, setDialog] = useState(false);
  const rows = (list.data ?? []).filter((e) => scope.type === "organization" || (e.scopeType === scope.type.toUpperCase() && e.scopeId === scope.id) || e.scopeType === "ORGANIZATION");
  const state = (e: SecurityException) => (e.state === "active" ? <Badge size="sm" color="success">active</Badge> : e.state === "pending" ? <Badge size="sm" color="warning">pending approval</Badge> : e.state === "expired" ? <Badge size="sm" color="warning">expired</Badge> : <Badge size="sm" color="light">revoked</Badge>);
  return (
    <Card title="Exceptions" description="Time-boxed, approved acceptances of a vulnerability or a code rule. They expire on their own and are reverted; everything is in the audit log." flush actions={<button type="button" className={primaryButton} onClick={() => setDialog(true)}>New exception</button>}>
      {list.error ? <div className="p-4"><ErrorNotice error={list.error} /></div> : rows.length === 0 ? <EmptyState title="No exceptions">Accept a finding for a limited time instead of forever: pick the advisory or rule, a reason and a date.</EmptyState> : (
        <table className="min-w-full">
          <thead className="border-b border-gray-100 dark:border-gray-800"><tr><th className={th}>Match</th><th className={th}>Scope</th><th className={th}>Status</th><th className={th}>Until</th><th className={th}>Covers</th><th className={th}>State</th><th className={th} /></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className={trBorder}>
                <td className={td}><span className="font-mono text-sm text-gray-800 dark:text-white/90">{e.matchId}</span>{e.matchComponent && <span className={`block text-xs ${muted}`}>{e.kind === "vulnerability" ? "component" : "files"} {e.matchComponent}</span>}<span className={`block max-w-md truncate text-xs ${muted}`} title={e.reason}>{e.reason}</span>{e.ticketUrl && <a href={e.ticketUrl} target="_blank" rel="noreferrer" className="text-xs text-brand-500 hover:underline">ticket</a>}</td>
                <td className={`${td} text-xs ${muted}`}>{e.scopeType.toLowerCase()}</td>
                <td className={td}><Badge size="sm" color="light">{e.status.replace("_", " ")}</Badge></td>
                <td className={`${td} text-xs ${muted}`}>{formatDate(e.expiresAt)}<span className="block">{e.state === "active" ? `in ${Math.max(0, Math.ceil((new Date(e.expiresAt).getTime() - Date.now()) / 86400_000))} days` : relativeTime(e.expiresAt)}</span></td>
                <td className={td}>{e.applied} finding{e.applied === 1 ? "" : "s"}</td>
                <td className={td}>{state(e)}</td>
                <td className={`${td} text-end`}>{e.state === "pending" && <button type="button" className="me-3 text-sm font-medium text-brand-500 hover:text-brand-600" disabled={approve.isPending} title="Needs exception:approve (security admin, compliance officer, CISO, org admin)" onClick={() => approve.mutate(e.id)}>Approve</button>}{(e.state === "active" || e.state === "pending") && <button type="button" className={dangerLink} onClick={() => { if (window.confirm(e.state === "pending" ? "Withdraw this exception request?" : "Revoke this exception? Its findings reopen immediately.")) revoke.mutate(e.id); }}>{e.state === "pending" ? "Withdraw" : "Revoke"}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dialog && <ExceptionDialog scope={scope} onClose={() => setDialog(false)} />}
    </Card>
  );
}
