import PageMeta from "@/components/common/PageMeta";
import { useApi } from "@/platform/api/client";
import { useMe } from "@/platform/api/hooks";
import { ErrorNotice, muted, outlineButton, primaryButton } from "@/platform/components/ui";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";

const SCOPES: { value: "read" | "write" | "sudo"; title: string; text: string }[] = [
  // Exactly the scope × action matrix asserted by apps/api/src/rbac/token-scope-matrix.spec.ts — keep them in sync.
  { value: "read", title: "Read only", text: "See everything you can see in the app — findings, gates, queues, readiness, evidence. Nothing is changed." },
  { value: "write", title: "Read & write", text: "Everything your roles allow for day-to-day work: create workspaces, teams and projects, run pipelines, push to the registry, decide on findings, remediations and issues, request exceptions. Not: approving exceptions, policies, SLAs, channels, memberships, integrations, organization settings, runner pools — and nothing is archived or deleted (those need the app or an administrator token)." },
  { value: "sudo", title: "Administrator", text: "Everything your account can do, including approving exceptions, policies, memberships and archiving. Only for platform administrators." },
];

/**
 * OAuth consent: an app (claude.ai connector, matelot CLI, …) asks to act as you. You pick how far, the API mints a code,
 * the app exchanges it for a personal access token you can revoke under Account → Access tokens.
 */
export default function OauthConsentPage() {
  const { productName } = useRuntimeConfig();
  const [params] = useSearchParams();
  const api = useApi();
  const clientName = params.get("client_name") ?? "an application";
  const requested = (params.get("scope") ?? "read").split(" ").filter(Boolean);
  const me = useMe();
  const isAdmin = me.data?.user.platformRole === "admin";
  // Default = what the app asked for, never silently narrower; sudo only when the signed-in user may hold it.
  const requestedTop: "read" | "write" | "sudo" = requested.includes("sudo") ? "sudo" : requested.includes("write") ? "write" : "read";
  const [scope, setScope] = useState<"read" | "write" | "sudo">(requestedTop === "sudo" ? "write" : requestedTop);
  const [initialised, setInitialised] = useState(false);
  if (!initialised && me.data) { setInitialised(true); if (requestedTop === "sudo" && isAdmin) setScope("sudo"); }
  const narrowed = requestedTop === "sudo" && !isAdmin;
  const redirect = params.get("redirect_uri") ?? "";
  const approve = useMutation({
    mutationFn: () => api<{ redirect: string }>("/oauth/approve", { method: "POST", json: { client_id: params.get("client_id"), redirect_uri: redirect, scope, state: params.get("state") || undefined, code_challenge: params.get("code_challenge"), resource: params.get("resource") || undefined } }),
    onSuccess: ({ redirect: to }) => window.location.assign(to),
  });
  const deny = () => { try { const u = new URL(redirect); u.searchParams.set("error", "access_denied"); if (params.get("state")) u.searchParams.set("state", params.get("state")!); window.location.assign(u.toString()); } catch { window.location.assign("/"); } };
  let host = redirect; try { host = new URL(redirect).host; } catch { /* keep raw */ }
  return (
    <>
      <PageMeta title={`Authorize ${clientName} · ${productName}`} description="OAuth consent" />
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-theme-xs dark:border-gray-800 dark:bg-white/3">
          <p className={`text-xs tracking-wide uppercase ${muted}`}>Authorize</p>
          <h1 className="mt-1 text-2xl font-semibold text-gray-800 dark:text-white/90">{clientName} wants to use {productName} as you</h1>
          <p className={`mt-2 text-sm ${muted}`}>It will act with your permissions, audited under your name. After approving, you return to <code>{host}</code>. You can revoke this at any time under Account → Access tokens.</p>
          <div className="mt-6 space-y-3">
            {narrowed && <p className="rounded-lg bg-warning-50 p-3 text-xs text-warning-700 dark:bg-warning-500/15 dark:text-warning-400">The application asked for administrator access, which only platform administrators can grant. You can allow read & write instead; the application will be told it received less than it asked for.</p>}
            {SCOPES.filter((s) => s.value !== "sudo" || (requested.includes("sudo") && isAdmin)).map((s) => (
              <button key={s.value} type="button" onClick={() => setScope(s.value)} className={`flex w-full items-start gap-3 rounded-xl border p-4 text-start ${scope === s.value ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-500/10" : "border-gray-200 hover:border-gray-300 dark:border-gray-800"}`}>
                <span className={`mt-1 size-4 shrink-0 rounded-full border ${scope === s.value ? "border-brand-500 bg-brand-500" : "border-gray-400"}`} />
                <span><span className="block text-sm font-semibold text-gray-800 dark:text-white/90">{s.title}{requested.includes(s.value) && <span className={`ms-2 text-xs font-normal ${muted}`}>requested</span>}</span><span className={`block text-xs ${muted}`}>{s.text}</span></span>
              </button>
            ))}
          </div>
          {approve.error ? <div className="mt-4"><ErrorNotice error={approve.error} /></div> : null}
          <div className="mt-6 flex justify-end gap-3">
            <button type="button" className={outlineButton} onClick={deny}>Deny</button>
            <button type="button" className={primaryButton} disabled={approve.isPending} onClick={() => approve.mutate()}>{approve.isPending ? "Authorizing…" : `Allow ${SCOPES.find((s) => s.value === scope)!.title.toLowerCase()}`}</button>
          </div>
        </div>
      </div>
    </>
  );
}
