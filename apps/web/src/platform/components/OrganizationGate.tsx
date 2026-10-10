import type { ReactNode } from "react";
import type { Organization } from "../api/types";
import { useCurrentOrganization } from "../state/useCurrentOrganization";
import { Card, EmptyState, ErrorNotice } from "./ui";

/** Renders a page once an organization is selected; explains the "no access yet" state otherwise. */
export function OrganizationGate({ children }: { children: (organization: Organization, organizations: Organization[]) => ReactNode }) {
  const { organization, organizations, isLoading, error } = useCurrentOrganization();
  if (isLoading) return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  if (error) return <ErrorNotice error={error} />;
  if (!organization) {
    return (
      <Card flush>
        <EmptyState title="You don't have access to any organization yet">
          Ask an administrator to grant you a role. Access granted to your email takes effect the next time this page refreshes.
        </EmptyState>
      </Card>
    );
  }
  return <>{children(organization, organizations)}</>;
}
