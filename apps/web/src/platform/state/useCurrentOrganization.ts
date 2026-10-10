import { useEffect } from "react";
import { useOrganizations } from "../api/hooks";
import type { Organization } from "../api/types";
import { useDashboard } from "./DashboardContext";

/** The organization selected in the header (defaults to the first visible one). */
export function useCurrentOrganization(): {
  organization: Organization | undefined;
  organizations: Organization[];
  isLoading: boolean;
  error: unknown;
} {
  const organizations = useOrganizations();
  const { organizationId, setOrganizationId } = useDashboard();
  const list = organizations.data ?? [];

  useEffect(() => {
    if (!list.length) return;
    if (!organizationId || !list.some((o) => o.id === organizationId)) setOrganizationId(list[0].id);
  }, [list, organizationId, setOrganizationId]);

  return {
    organization: list.find((o) => o.id === organizationId) ?? list[0],
    organizations: list,
    isLoading: organizations.isLoading,
    error: organizations.error,
  };
}
