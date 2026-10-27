// Mounts two hooks with providers only: one polled (useMe, refresh interval), one not (useOrganizations).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { RuntimeConfigContext } from '@/platform/runtime-config';
import { DashboardProvider } from '@/platform/state/DashboardContext';
import { useMe, useOrganizations } from '@/platform/api/hooks';

function Probe() {
  const me = useMe();
  const orgs = useOrganizations();
  return <div data-testid="probe">{me.data?.email ?? '…'} / {orgs.data?.length ?? 0}</div>;
}

export function mountProbe(el: HTMLElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRoot(el);
  root.render(
    <RuntimeConfigContext.Provider value={{ productName: 'Matelot', keycloakUrl: 'http://kc', realm: 'r', clientId: 'c', apiBaseUrl: '/api/v1' } as never}>
      <QueryClientProvider client={client}><DashboardProvider><Probe /></DashboardProvider></QueryClientProvider>
    </RuntimeConfigContext.Provider>,
  );
  return { root, client };
}
