import { createContext, useContext } from 'react';

/** Runtime configuration, served as /config.json (Vite public/ in dev, a ConfigMap in a cell). */
export interface RuntimeConfig {
  productName: string;
  keycloakUrl: string;
  realm: string;
  clientId: string;
  apiBaseUrl: string;
  /** The public documentation site; the sidebar's "Documentation" opens it in a new tab. Defaults to the published site. */
  docsUrl?: string;
}

export const DEFAULT_DOCS_URL = 'https://matelot-cloud.github.io/website/docs/latest/';
export const docsUrl = (c: Pick<RuntimeConfig, 'docsUrl'>): string => (c.docsUrl?.trim() ? c.docsUrl.trim() : DEFAULT_DOCS_URL);

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load /config.json (${response.status})`);
  return (await response.json()) as RuntimeConfig;
}

export const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

export function useRuntimeConfig(): RuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (!config) throw new Error('RuntimeConfigContext is missing');
  return config;
}
