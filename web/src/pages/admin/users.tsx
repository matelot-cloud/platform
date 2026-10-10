import PageBreadcrumb from "@/components/common/PageBreadCrumb";
import PageMeta from "@/components/common/PageMeta";
import Badge from "@/components/ui/badge/Badge";
import { isForbidden } from "@/platform/api/client";
import { useAdminUsers, useMe, useUpdateAdminUser } from "@/platform/api/hooks";
import type { PlatformRole } from "@/platform/api/types";
import { Card, EmptyState, ErrorNotice, muted, SelectField, td, th, trBorder } from "@/platform/components/ui";
import { formatDate } from "@/platform/format";
import { useRuntimeConfig } from "@/platform/runtime-config";

const ROLE_OPTIONS = [
  { value: "user", label: "User" },
  { value: "admin", label: "Administrator" },
];

export default function AdminUsersPage() {
  const { productName } = useRuntimeConfig();
  const me = useMe();
  const isAdmin = me.data?.user.platformRole === "admin";
  const users = useAdminUsers(isAdmin);
  const update = useUpdateAdminUser();

  return (
    <>
      <PageMeta title={`Users · ${productName}`} description="Cell administration: users" />
      <PageBreadcrumb pageTitle="Users" />
      <Card
        title="Users of this cell"
        description="Everyone who has signed in or been invited. Administrators see and can do everything; users only where they hold a role."
        flush
      >
        {!isAdmin || isForbidden(users.error) ? (
          <EmptyState title="Cell administrators only">This area is available to administrators of the platform instance.</EmptyState>
        ) : users.error ? (
          <div className="p-4">
            <ErrorNotice error={users.error} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="border-b border-gray-100 dark:border-gray-800">
                <tr>
                  <th className={th}>User</th>
                  <th className={th}>Cell role</th>
                  <th className={th}>Roles held</th>
                  <th className={th}>Last sign-in</th>
                  <th className={th}>Status</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((u) => {
                  const self = u.id === me.data?.user.id;
                  return (
                    <tr key={u.id} className={trBorder}>
                      <td className={td}>
                        <span className="block font-medium text-gray-800 dark:text-white/90">{u.displayName ?? u.email}</span>
                        {u.displayName && <span className={`text-xs ${muted}`}>{u.email}</span>}
                        {self && <span className={`ms-2 text-xs ${muted}`}>(you)</span>}
                      </td>
                      <td className={td}>
                        <SelectField
                          ariaLabel={`Cell role of ${u.email}`}
                          value={u.platformRole}
                          onChange={(v) => update.mutate({ userId: u.id, platformRole: v as PlatformRole })}
                          options={ROLE_OPTIONS}
                          className="w-40"
                        />
                      </td>
                      <td className={`${td} ${muted}`}>{u.membershipCount}</td>
                      <td className={`${td} ${muted}`}>{u.lastLoginAt ? formatDate(u.lastLoginAt) : "never"}</td>
                      <td className={td}>
                        {u.disabledAt ? (
                          <Badge size="sm" color="error">
                            disabled
                          </Badge>
                        ) : (
                          <Badge size="sm" color="success">
                            active
                          </Badge>
                        )}
                      </td>
                      <td className={`${td} text-end`}>
                        {!self && (
                          <button
                            type="button"
                            disabled={update.isPending}
                            className={`text-sm font-medium ${u.disabledAt ? "text-brand-500 hover:text-brand-600" : "text-error-500 hover:text-error-600"}`}
                            onClick={() => {
                              const enabled = !!u.disabledAt;
                              if (enabled || window.confirm(`Disable ${u.email}? They keep their roles but cannot sign in.`)) update.mutate({ userId: u.id, enabled });
                            }}
                          >
                            {u.disabledAt ? "Enable" : "Disable"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {update.error ? (
          <div className="p-4">
            <ErrorNotice error={update.error} />
          </div>
        ) : null}
      </Card>
    </>
  );
}
