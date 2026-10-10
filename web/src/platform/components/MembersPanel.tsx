import Label from "@/components/form/Label";
import { isForbidden } from "@/platform/api/client";
import { useGrantMembership, useMemberships, useMeta, useProjects, useRevokeMembership, useTeams, useWorkspaces } from "@/platform/api/hooks";
import type { Organization, ScopeType } from "@/platform/api/types";
import { Card, dangerLink, EmptyState, ErrorNotice, inputClass, muted, RoleBadge, SelectField, td, th, trBorder } from "@/platform/components/ui";
import { formatDate, humanize } from "@/platform/format";
import { useMemo, useState, type FormEvent } from "react";

interface ScopeOption {
  type: ScopeType;
  id: string;
  label: string;
}

export function MembersPanel({ organization, initialScope }: { organization: Organization; initialScope?: { type: ScopeType; id: string } }) {
  const workspaces = useWorkspaces(organization.id);
  const teams = useTeams(organization.id);
  const projects = useProjects(organization.id);
  const meta = useMeta();

  const scopes = useMemo<ScopeOption[]>(
    () => [
      { type: "ORGANIZATION", id: organization.id, label: `Organization · ${organization.name}` },
      ...(workspaces.data ?? []).map((w): ScopeOption => ({ type: "WORKSPACE", id: w.id, label: `Workspace · ${w.name}` })),
      ...(teams.data ?? []).map((t): ScopeOption => ({ type: "TEAM", id: t.id, label: `Team · ${t.workspaceName} / ${t.name}` })),
      ...(projects.data ?? []).map((p): ScopeOption => ({ type: "PROJECT", id: p.id, label: `Project · ${p.teamName} / ${p.name}` })),
    ],
    [organization, workspaces.data, teams.data, projects.data],
  );

  const [scopeKey, setScopeKey] = useState(initialScope ? `${initialScope.type}:${initialScope.id}` : `ORGANIZATION:${organization.id}`);
  const scope = scopes.find((s) => `${s.type}:${s.id}` === scopeKey) ?? scopes[0]!;

  const memberships = useMemberships(scope.type, scope.id);
  const grant = useGrantMembership(organization.id);
  const revoke = useRevokeMembership(organization.id);

  const roles = meta.data?.roles ?? [];
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("DEVELOPER");
  const [reason, setReason] = useState("");
  const forbidden = isForbidden(memberships.error);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    grant.mutate(
      { email, role, scopeType: scope.type, scopeId: scope.id, reason: reason || undefined },
      {
        onSuccess: () => {
          setEmail("");
          setReason("");
        },
      },
    );
  };

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-12">
      <div className="xl:col-span-8">
        <Card
          title="Members"
          flush
          actions={<SelectField ariaLabel="Scope" value={`${scope.type}:${scope.id}`} onChange={setScopeKey} options={scopes.map((s) => ({ value: `${s.type}:${s.id}`, label: s.label }))} className="w-72" />}
        >
          {forbidden ? (
            <EmptyState title="Not visible with your role">You need member management on this scope to list or change who has access here.</EmptyState>
          ) : memberships.error ? (
            <div className="p-4">
              <ErrorNotice error={memberships.error} />
            </div>
          ) : (memberships.data ?? []).length === 0 ? (
            <EmptyState title="Nobody has a role at this scope">
              Roles granted higher up still apply here: an organization administrator is an administrator of every workspace, team and project.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead className="border-b border-gray-100 dark:border-gray-800">
                  <tr>
                    <th className={th}>Member</th>
                    <th className={th}>Role</th>
                    <th className={th}>Granted</th>
                    <th className={th}>Last sign-in</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {(memberships.data ?? []).map((m) => (
                    <tr key={m.id} className={trBorder}>
                      <td className={td}>
                        <span className="block font-medium text-gray-800 dark:text-white/90">{m.user.displayName ?? m.user.email}</span>
                        {m.user.displayName && <span className={`text-xs ${muted}`}>{m.user.email}</span>}
                      </td>
                      <td className={td}>
                        <RoleBadge role={m.role} />
                      </td>
                      <td className={`${td} ${muted}`}>{formatDate(m.createdAt)}</td>
                      <td className={`${td} ${muted}`}>{m.user.lastLoginAt ? formatDate(m.user.lastLoginAt) : "never"}</td>
                      <td className={`${td} text-end`}>
                        <button
                          type="button"
                          disabled={revoke.isPending}
                          className={dangerLink}
                          onClick={() => {
                            if (window.confirm(`Remove ${humanize(m.role)} from ${m.user.email}?`)) revoke.mutate(m.id);
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {revoke.error ? (
            <div className="p-4">
              <ErrorNotice error={revoke.error} />
            </div>
          ) : null}
        </Card>
      </div>

      <div className="xl:col-span-4">
        <Card title="Grant access">
          <form onSubmit={submit} className="space-y-5">
            <div>
              <Label htmlFor="grant-email">Email</Label>
              <input id="grant-email" type="email" required className={inputClass} placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <Label>Role</Label>
              <SelectField value={role} onChange={setRole} options={roles.map((r) => ({ value: r, label: humanize(r) }))} />
            </div>
            <div>
              <Label htmlFor="grant-scope">At</Label>
              <input id="grant-scope" readOnly className={`${inputClass} bg-gray-50 dark:bg-gray-800`} value={scope.label} />
            </div>
            <div>
              <Label htmlFor="grant-reason">Reason</Label>
              <input id="grant-reason" className={inputClass} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              <p className="mt-1.5 text-xs text-gray-500">Kept in the audit trail.</p>
            </div>
            {grant.error ? <ErrorNotice error={grant.error} /> : null}
            {grant.isSuccess && !grant.error ? <p className="text-sm text-success-600 dark:text-success-500">Access granted.</p> : null}
            <button type="submit" disabled={grant.isPending || forbidden} className="w-full rounded-lg bg-brand-500 px-4 py-3 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 disabled:bg-brand-300">
              {grant.isPending ? "Granting…" : "Grant access"}
            </button>
            <p className={`text-xs ${muted}`}>People who have not signed in yet get their role on first sign-in, matched by email.</p>
          </form>
        </Card>
      </div>
    </div>
  );
}

