// Test double for react-oidc-context. Default: an always-signed-in user. Tests can drive a sign-in round trip through
// window.__oidc: { state: 'anonymous' | 'authenticated', returnTo } — RequireAuth calls signinRedirect, the test then
// "returns from Keycloak" by setting the callback URL and flipping the state (see test/oauth-consent-flow.mjs).
import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';

type Scenario = { state: 'anonymous' | 'authenticated'; returnTo?: string; signinCalls: { returnTo?: string }[] };
const w = window as unknown as { __oidc?: Scenario };
const listeners = new Set<() => void>();
export function setOidcScenario(s: Partial<Scenario>) { w.__oidc = { ...(w.__oidc ?? { state: 'authenticated', signinCalls: [] }), ...s }; for (const l of listeners) l(); }
const DEFAULT: Scenario = { state: 'authenticated', signinCalls: [] };
const snapshot = () => w.__oidc ?? DEFAULT; // stable reference: useSyncExternalStore must see the same object between renders

export function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useAuth() {
  const sc = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, snapshot, snapshot);
  const authenticated = sc.state === 'authenticated';
  return {
    isLoading: false,
    isAuthenticated: authenticated,
    error: undefined,
    activeNavigator: undefined,
    user: authenticated ? { access_token: 'test-token', profile: { email: 'admin@acme.local', name: 'Cell Admin' }, state: sc.returnTo ? { returnTo: sc.returnTo } : undefined } : undefined,
    signinRedirect: async (opts?: { state?: { returnTo?: string } }) => { sc.signinCalls.push({ returnTo: opts?.state?.returnTo }); },
    signoutRedirect: async () => undefined,
  };
}
