// Mounts the keyless identity UI (Manage → Identity, and the connect wizard's success panel) with providers only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { RuntimeConfigContext } from '@/platform/runtime-config';
import { DashboardProvider } from '@/platform/state/DashboardContext';
import { MemoryRouter } from 'react-router';
import { IntegrationManager } from '@/platform/components/IntegrationManager';
import { GetStarted } from '@/platform/components/GetStarted';
import type { Integration } from '@/platform/api/types';

export function mountManager(el: HTMLElement, integration: Integration, organizationId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRoot(el);
  root.render(
    <RuntimeConfigContext.Provider value={{ productName: 'Matelot', keycloakUrl: 'http://kc', realm: 'r', clientId: 'c', apiBaseUrl: '/api/v1' } as never}>
      <QueryClientProvider client={client}>
        <DashboardProvider><MemoryRouter><IntegrationManager integration={integration} organizationId={organizationId} repoCount={0} onClose={() => undefined} /></MemoryRouter></DashboardProvider>
      </QueryClientProvider>
    </RuntimeConfigContext.Provider>,
  );
  return root;
}

export function mountGetStarted(el: HTMLElement, organizationId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRoot(el);
  root.render(
    <RuntimeConfigContext.Provider value={{ productName: 'Matelot', keycloakUrl: 'http://kc', realm: 'r', clientId: 'c', apiBaseUrl: '/api/v1' } as never}>
      <QueryClientProvider client={client}>
        <DashboardProvider><MemoryRouter><GetStarted organizationId={organizationId} /></MemoryRouter></DashboardProvider>
      </QueryClientProvider>
    </RuntimeConfigContext.Provider>,
  );
  return root;
}
