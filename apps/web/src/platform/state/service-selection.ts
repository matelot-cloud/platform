import { useSyncExternalStore } from "react";

/**
 * Global "selected service" per project — shared by the navbar switcher and the project layout.
 * Persisted in localStorage; "" means "all services".
 */
const listeners = new Set<() => void>();
const key = (projectId: string) => `secops.service.${projectId}`;
const cache = new Map<string, string>();

function read(projectId: string): string {
  if (cache.has(projectId)) return cache.get(projectId)!;
  let v = "";
  try {
    v = localStorage.getItem(key(projectId)) ?? "";
  } catch {
    /* ignore */
  }
  cache.set(projectId, v);
  return v;
}

export function getSelectedServiceId(projectId: string): string {
  return read(projectId);
}

export function setSelectedServiceId(projectId: string, serviceId: string): void {
  cache.set(projectId, serviceId);
  try {
    localStorage.setItem(key(projectId), serviceId);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export function useSelectedServiceId(projectId: string | undefined): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (projectId ? read(projectId) : ""),
    () => "",
  );
}
