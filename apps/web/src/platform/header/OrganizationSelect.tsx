import { useOrganizations } from "../api/hooks";
import { useDashboard } from "../state/DashboardContext";
import { LocationPicker } from "./ContextSwitcher";

/** The header's organization switcher (parent company / subsidiaries / MSSP customers). */
export function OrganizationSelect() {
  const organizations = useOrganizations();
  const { organizationId, setOrganizationId } = useDashboard();
  const list = organizations.data ?? [];
  if (list.length <= 1) return null;
  const value = list.some((o) => o.id === organizationId) ? organizationId! : list[0].id;
  return <LocationPicker kind="Organization" value={value} onChange={setOrganizationId} items={list.map((o) => ({ value: o.id, label: o.name, sub: o.slug }))} className="shrink-0" />;
}
