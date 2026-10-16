import { useDashboard } from "../state/DashboardContext";
import { LocationPicker } from "./ContextSwitcher";

const OPTIONS = [
  { value: "0", label: "off" },
  { value: "5", label: "5 s" },
  { value: "15", label: "15 s" },
  { value: "30", label: "30 s" },
  { value: "60", label: "1 min" },
];

/** How often every section refreshes its data. */
export function RefreshSelect() {
  const { refreshSeconds, setRefreshSeconds } = useDashboard();
  return <LocationPicker kind="Refresh" compact value={String(refreshSeconds)} onChange={(v) => setRefreshSeconds(Number(v))} items={OPTIONS} />;
}
