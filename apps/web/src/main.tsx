import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebStorageStateStore } from "oidc-client-ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "react-oidc-context";
import App from "./App.tsx";
import { AppWrapper } from "./components/common/PageMeta.tsx";
import { LanguageProvider } from "./context/LanguageContext.tsx";
import { ThemeProvider } from "./context/ThemeContext.tsx";
import "./i18n";
import "./index.css";
import { loadRuntimeConfig, RuntimeConfigContext } from "./platform/runtime-config";
import { DashboardProvider } from "./platform/state/DashboardContext";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});

async function start() {
  const root = createRoot(document.getElementById("root")!);
  try {
    const config = await loadRuntimeConfig();
    document.title = config.productName;
    root.render(
      <StrictMode>
        <RuntimeConfigContext.Provider value={config}>
          <AuthProvider
            authority={`${config.keycloakUrl}/realms/${config.realm}`}
            client_id={config.clientId}
            redirect_uri={`${window.location.origin}/`}
            post_logout_redirect_uri={window.location.origin}
            scope="openid profile email"
            // Back from Keycloak: swap ?code&state for where the visitor started (e.g. /oauth/consent?…) BEFORE the router
            // renders, so the index redirect never sees the callback URL and the consent request is not lost.
            onSigninCallback={(user) => { const returnTo = (user?.state as { returnTo?: string } | undefined)?.returnTo; window.history.replaceState({}, document.title, returnTo && returnTo.startsWith("/") ? returnTo : "/"); }}
            automaticSilentRenew
            userStore={new WebStorageStateStore({ store: window.sessionStorage })}
          >
            <QueryClientProvider client={queryClient}>
              <DashboardProvider>
                <ThemeProvider>
                  <LanguageProvider>
                    <AppWrapper>
                      <App />
                    </AppWrapper>
                  </LanguageProvider>
                </ThemeProvider>
              </DashboardProvider>
            </QueryClientProvider>
          </AuthProvider>
        </RuntimeConfigContext.Provider>
      </StrictMode>,
    );
  } catch (error) {
    root.render(
      <div style={{ fontFamily: "sans-serif", padding: 32 }}>
        <h2>Configuration error</h2>
        <p>{error instanceof Error ? error.message : String(error)}</p>
      </div>,
    );
  }
}

void start();
