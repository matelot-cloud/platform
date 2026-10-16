import { SelectField } from "../components/ui";
import { useDashboard } from "../state/DashboardContext";

const OPTIONS = [
  { value: "0", label: "Refresh: off" },
  { value: "5", label: "Refresh: 5 s" },
  { value: "15", label: "Refresh: 15 s" },
  { value: "30", label: "Refresh: 30 s" },
  { value: "60", label: "Refresh: 1 min" },
];

/** How often every section refreshes its data. */
export function RefreshSelect() {
  const { refreshSeconds, setRefreshSeconds } = useDashboard();
  return <SelectField ariaLabel="Refresh interval" value={String(refreshSeconds)} onChange={(v) => setRefreshSeconds(Number(v))} options={OPTIONS} className="w-36" />;
}
