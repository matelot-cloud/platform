import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/** Dashboard-wide settings: which organization is selected and how often data refreshes. */
export interface DashboardState {
  organizationId: string | null;
  setOrganizationId: (id: string) => void;
  refreshSeconds: number;
  setRefreshSeconds: (seconds: number) => void;
}

const DashboardContext = createContext<DashboardState | null>(null);

const ORG_KEY = 'secops.organizationId';
const REFRESH_KEY = 'secops.refreshSeconds';

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); the setting just won't persist.
  }
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [organizationId, setOrgState] = useState<string | null>(() => readStorage(ORG_KEY));
  const [refreshSeconds, setRefreshState] = useState<number>(() => Number(readStorage(REFRESH_KEY) ?? 15));

  const setOrganizationId = useCallback((id: string) => {
    setOrgState(id);
    writeStorage(ORG_KEY, id);
  }, []);

  const setRefreshSeconds = useCallback((seconds: number) => {
    setRefreshState(seconds);
    writeStorage(REFRESH_KEY, String(seconds));
  }, []);

  const value = useMemo(
    () => ({ organizationId, setOrganizationId, refreshSeconds, setRefreshSeconds }),
    [organizationId, setOrganizationId, refreshSeconds, setRefreshSeconds]
  );
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardState {
  const state = useContext(DashboardContext);
  if (!state) throw new Error('DashboardProvider is missing');
  return state;
}
