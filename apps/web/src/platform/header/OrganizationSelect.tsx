import { useOrganizations } from "../api/hooks";
import { SelectField } from "../components/ui";
import { useDashboard } from "../state/DashboardContext";

/** The header's organization switcher (parent company / subsidiaries / MSSP customers). */
export function OrganizationSelect() {
  const organizations = useOrganizations();
  const { organizationId, setOrganizationId } = useDashboard();
  const list = organizations.data ?? [];
  if (list.length <= 1) return null;
  const value = list.some((o) => o.id === organizationId) ? organizationId! : list[0].id;
  return <SelectField ariaLabel="Organization" value={value} onChange={setOrganizationId} options={list.map((o) => ({ value: o.id, label: o.name }))} className="min-w-44 max-w-72 shrink-0" />;
}
