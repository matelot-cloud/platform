import Badge from "@/components/ui/badge/Badge";
import type { RoleInfo } from "@/platform/api/types";
import { personInitials, personName, personSubtitle } from "@/platform/people";
import { cn } from "@/utils";
import { useState } from "react";
import { muted, outlineButton } from "../ui";

/** Avatar initials + name + e-mail (or bot username), with a "bot" badge for service accounts. */
export function PersonCell({ user }: { user: { email: string; displayName: string | null; kind?: string; disabled?: boolean } }) {
  const bot = user.kind === "service_account";
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold", bot ? "bg-gray-200 text-gray-700 dark:bg-white/10 dark:text-gray-200" : "bg-brand-500 text-white")} aria-hidden="true">
        {bot ? "BOT" : personInitials(user)}
      </span>
      <div className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-gray-800 dark:text-white/90">{personName(user)}</span>
          {bot && <Badge size="sm" color="light">bot</Badge>}
          {user.disabled && <Badge size="sm" color="error">disabled</Badge>}
        </span>
        {!bot && personSubtitle(user) && <span className={`block truncate text-xs ${muted}`}>{personSubtitle(user)}</span>}
        {bot && <span className={`block truncate font-mono text-[11px] ${muted}`} title={user.email}>{user.email}</span>}
      </div>
    </div>
  );
}

const GITLAB_COLOR: Record<RoleInfo["gitlab"], "primary" | "success" | "warning" | "light" | "info"> = { Owner: "warning", Maintainer: "primary", Developer: "success", Reporter: "info", Guest: "light" };

/** Role choice as a list: label, one-line description, the GitLab equivalent; roles the caller cannot grant are disabled. */
export function RolePicker({ roles, value, onChange, name = "role" }: { roles: RoleInfo[]; value: string; onChange: (role: string) => void; name?: string }) {
  return (
    <div className="space-y-2" role="radiogroup" aria-label="Role">
      {roles.map((r) => {
        const disabled = r.grantable === false;
        return (
          <label key={r.role} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3", value === r.role ? "border-brand-400 bg-brand-50/40 dark:border-brand-500/60 dark:bg-brand-500/5" : "border-gray-200 hover:border-gray-300 dark:border-gray-800", disabled && "cursor-not-allowed opacity-50")}>
            <input type="radio" name={name} className="mt-1" value={r.role} checked={value === r.role} disabled={disabled} onChange={() => onChange(r.role)} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-800 dark:text-white/90">
                {r.label}
                <Badge size="sm" color={GITLAB_COLOR[r.gitlab]}>GitLab {r.gitlab}</Badge>
              </span>
              <span className={`mt-0.5 block text-xs ${muted}`}>{r.description}{disabled ? " — above your own role here" : ""}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** A secret shown once (token, setup link): monospace, wraps, copy button. */
export function OneTimeSecret({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <code className="block min-w-0 flex-1 rounded-lg bg-gray-900 px-3 py-2 font-mono text-xs break-all text-gray-100">{value}</code>
      <button type="button" className={outlineButton} onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : label}</button>
    </div>
  );
}

export const tomorrow = () => new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
