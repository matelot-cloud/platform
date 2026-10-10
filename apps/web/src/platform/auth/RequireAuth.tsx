import { BrandMark } from "@/components/common/Brand";
import { useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "react-oidc-context";
import { useLocation, useNavigate } from "react-router";
import { useRuntimeConfig } from "../runtime-config";

/** Sends unauthenticated visitors to Keycloak and renders children only with a valid session. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { productName } = useRuntimeConfig();
  const resumed = useRef(false);

  useEffect(() => {
    if (!auth.isLoading && !auth.isAuthenticated && !auth.error && !auth.activeNavigator) {
      void auth.signinRedirect({ state: { returnTo: window.location.pathname + window.location.search } });
    }
  }, [auth]);

  // Back from Keycloak with ?code&state still in the URL (onSigninCallback normally rewrites it first; this is the
  // belt to that brace): go to where the visitor started and, until then, render nothing routable.
  const params = new URLSearchParams(location.search);
  const inCallback = params.has("code") || params.has("state");
  useEffect(() => {
    if (!auth.isAuthenticated || !inCallback || resumed.current) return;
    resumed.current = true;
    const returnTo = (auth.user?.state as { returnTo?: string } | undefined)?.returnTo;
    void navigate(returnTo && returnTo.startsWith("/") ? returnTo : "/overview", { replace: true });
  }, [auth.isAuthenticated, auth.user, inCallback, navigate]);

  if (auth.error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="mb-3 text-2xl font-semibold text-gray-800 dark:text-white/90">{productName}</h1>
          <p className="mb-6 text-sm text-error-500">{auth.error.message}</p>
          <button
            className="rounded-lg bg-brand-500 px-5 py-3 text-sm font-medium text-white hover:bg-brand-600"
            onClick={() => void auth.signinRedirect()}
          >
            Try signing in again
          </button>
        </div>
      </div>
    );
  }

  if (!auth.isAuthenticated || (inCallback && !resumed.current)) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <BrandMark className="size-14" />
        <p className="text-sm text-gray-500 dark:text-gray-400">Signing you in…</p>
      </div>
    );
  }

  return <>{children}</>;
}
