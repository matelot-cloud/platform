import Label from "@/components/form/Label";
import PageMeta from "@/components/common/PageMeta";
import { useCompleteInvite, useInvite } from "@/platform/api/hooks";
import { ErrorNotice, inputClass, muted, primaryButton } from "@/platform/components/ui";
import { formatDate } from "@/platform/format";
import { useRuntimeConfig } from "@/platform/runtime-config";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router";

/**
 * One-time setup link (/invite/<token>): an invited person sets their first password, or someone whose password an
 * administrator reset sets a new one. No sign-in — the link is the credential; it works once and expires.
 */
export default function InvitePage() {
  const { productName } = useRuntimeConfig();
  const { token = "" } = useParams();
  const invite = useInvite(token);
  const complete = useCompleteInvite(token);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const min = invite.data?.minLength ?? 12;
  const mismatch = confirm.length > 0 && confirm !== password;
  const submit = (e: FormEvent) => { e.preventDefault(); complete.mutate(password); };

  return (
    <>
      <PageMeta title={`Set your password · ${productName}`} description="One-time setup link" />
      <div className="mx-auto mt-10 max-w-xl rounded-2xl border border-gray-200 bg-white p-6 sm:p-8 dark:border-gray-800 dark:bg-white/3">
        {invite.isLoading ? (
          <p className={`text-sm ${muted}`}>Checking the link…</p>
        ) : invite.error ? (
          <div className="space-y-3">
            <h1 className="text-lg font-semibold text-gray-800 dark:text-white/90">This link cannot be used</h1>
            <ErrorNotice error={invite.error} />
            <p className={`text-sm ${muted}`}>Setup links work once and expire after 7 days. Ask the person who invited you (or an administrator) for a new one.</p>
          </div>
        ) : complete.data ? (
          <div className="space-y-4">
            <h1 className="text-lg font-semibold text-gray-800 dark:text-white/90">Password set</h1>
            <p className="text-sm text-gray-700 dark:text-gray-300">Sign in as <strong>{complete.data.email}</strong> with your new password.</p>
            <a className={primaryButton} href={complete.data.signInUrl}>Sign in to {productName}</a>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <div>
              <h1 className="text-lg font-semibold text-gray-800 dark:text-white/90">{invite.data?.purpose === "reset" ? "Choose a new password" : `Welcome to ${productName}`}</h1>
              <p className={`mt-1 text-sm ${muted}`}>{invite.data?.purpose === "reset" ? "An administrator reset your password." : "You were invited."} Account <strong className="text-gray-800 dark:text-white/90">{invite.data?.email}</strong> · link valid until {formatDate(invite.data?.expiresAt ?? null)}.</p>
            </div>
            <div><Label htmlFor="pw">Password (at least {min} characters)</Label><input id="pw" type="password" autoComplete="new-password" required minLength={min} autoFocus className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <div><Label htmlFor="pw2">Repeat it</Label><input id="pw2" type="password" autoComplete="new-password" required className={inputClass} value={confirm} onChange={(e) => setConfirm(e.target.value)} />{mismatch && <p className="mt-1 text-xs text-error-500">The two passwords differ.</p>}</div>
            {complete.error ? <ErrorNotice error={complete.error} /> : null}
            <button type="submit" className={primaryButton} disabled={complete.isPending || password.length < min || password !== confirm}>{complete.isPending ? "Saving…" : "Set password"}</button>
          </form>
        )}
      </div>
    </>
  );
}
