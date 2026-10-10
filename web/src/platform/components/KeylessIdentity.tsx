import { useConnectionIdentity, useVerifyIntegration } from "@/platform/api/hooks";
import { relativeTime } from "@/platform/format";
import { useState } from "react";
import { CodeBlock } from "./CodeBlock";
import { ErrorNotice, muted, outlineButton, primaryButton } from "./ui";

export type CloudKind = "gcp" | "aws" | "azure";

export const cloudKindOf = (provider: string, authType: string): CloudKind | null =>
  provider !== "registry" ? null : authType.startsWith("gcp") ? "gcp" : authType.startsWith("aws") ? "aws" : authType.startsWith("azure") ? "azure" : null;

export const isKeylessAuth = (authType: string) => authType === "gcp_wif" || authType === "aws_wif" || authType === "azure_wif";

function CopyCard({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex items-center justify-between gap-2">
        <p className={`text-xs ${muted}`}>{label}</p>
        <button type="button" className="text-xs font-medium text-brand-500 hover:text-brand-600" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <code className="mt-1 block break-all text-xs text-gray-800 dark:text-white/90">{value}</code>
    </div>
  );
}

/**
 * Keyless (workload identity) setup for one registry connection: the exact issuer / subject / audience to trust,
 * the per-cloud steps (CLI commands as copyable blocks), the verification state and a Verify button.
 * Shared by Manage → Identity and the connect wizard's success step.
 */
export function KeylessIdentity({ integrationId, organizationId, cloudKind, keyless, onVerified }: { integrationId: string; organizationId: string; cloudKind: CloudKind; keyless: boolean; onVerified?: () => void }) {
  const identity = useConnectionIdentity(integrationId, true);
  const verify = useVerifyIntegration(organizationId);
  const d = identity.data;
  if (identity.error) return <ErrorNotice error={identity.error} />;
  if (!d) return <p className={`text-sm ${muted}`}>Loading…</p>;
  if (d.disconnected) {
    // credentials are gone: nothing to configure or verify here
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 dark:border-gray-800 dark:bg-white/5 dark:text-gray-300">
          Disconnected — create the connection again to pull from this registry. The new connection gets its own subject, so its trust is configured separately.
        </div>
        {d.params && Object.keys(d.params).length > 0 && (
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            {Object.entries(d.params).map(([k, v]) => <div key={k} className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"><dt className={muted}>{k}</dt><dd className="mt-1 break-all font-mono text-gray-800 dark:text-white/90">{v}</dd></div>)}
          </dl>
        )}
        <p className={`text-xs ${muted}`}>Was: subject <code>{d.subject}</code> at issuer <code>{d.issuer}</code>. You can remove the old trust from the cloud side.</p>
      </div>
    );
  }
  const cloud = d[cloudKind];
  const verified = d.verified || verify.isSuccess;
  return (
    <div className="space-y-4">
      {keyless && (
        verified ? (
          <div className="rounded-xl border border-success-500/30 bg-success-50 px-4 py-3 text-sm text-success-600 dark:bg-success-500/15 dark:text-success-500">
            Verified{d.verifiedAt ? ` ${relativeTime(d.verifiedAt)}` : ""}: the cloud accepted this cell's token for <code>{d.subject}</code>{verify.data?.account ? ` — ${verify.data.account}` : ""}.
          </div>
        ) : (
          <div className="rounded-xl border border-warning-500/30 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:bg-warning-500/10 dark:text-warning-400">
            Not verified yet. Configure the trust below for the exact subject <code>{d.subject}</code>, then Verify. Images are not pulled until it succeeds.
          </div>
        )
      )}
      {d.warning && <p className="rounded-lg bg-warning-50 p-3 text-xs text-warning-700 dark:bg-warning-500/15 dark:text-warning-400">{d.warning}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <CopyCard label="Issuer" value={d.issuer} />
        <CopyCard label="Subject (exact)" value={d.subject} />
        <CopyCard label="Audience" value={cloud.audience} />
        {cloudKind === "gcp" ? <CopyCard label="Principal" value={d.gcp.principal} /> : cloudKind === "aws" ? <CopyCard label="OIDC provider ARN" value={d.aws.providerArn} /> : <CopyCard label="JWKS" value={d.jwksUri} />}
      </div>
      <ol className="list-decimal space-y-2 ps-5 text-sm text-gray-700 dark:text-gray-300">
        {cloud.steps.filter((st) => !st.startsWith("  ")).map((st, n) => {
          // indented steps are the CLI form of the step before them
          const all = cloud.steps;
          const at = all.indexOf(st);
          const command = all[at + 1]?.startsWith("  ") ? all[at + 1]!.trim() : null;
          const isTrust = cloudKind === "aws" && st.startsWith("IAM role trust policy");
          return (
            <li key={n}>
              <span className="break-words">{isTrust ? `IAM role → Trust relationships → Edit (exact subject ${d.subject}):` : st}</span>
              {isTrust && <CodeBlock className="mt-2" code={JSON.stringify(d.aws.trustPolicy, null, 2)} lines={false} />}
              {command && <CodeBlock className="mt-2" code={command} wrap lines={false} />}
            </li>
          );
        })}
      </ol>
      {keyless && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4 dark:border-gray-800">
          <p className={`text-xs ${muted}`}>CLI: <code>matelot connection verify --id {integrationId}</code></p>
          <button type="button" className={verified ? outlineButton : primaryButton} disabled={verify.isPending} onClick={() => verify.mutate(integrationId, { onSuccess: () => onVerified?.() })}>{verify.isPending ? "Verifying…" : verified ? "Verify again" : "Verify"}</button>
        </div>
      )}
      {verify.error ? <ErrorNotice error={verify.error} /> : !verify.isPending && !verified && d.lastError ? <p className="rounded-lg bg-error-50 p-3 text-xs text-error-600 dark:bg-error-500/15 dark:text-error-500">Last check: {d.lastError}</p> : null}
    </div>
  );
}
