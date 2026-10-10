# ADR 0002 — Web app: React on the TailAdmin template, runtime configuration

**Status:** accepted · **Date:** 2026-09-18

## Context

The team chose React for the frontend and, after trying an MUI-based kit, the TailAdmin React
template (MIT; React 19, TypeScript, Tailwind CSS v4) as the base: all TypeScript, dark mode and
a collapsible sidebar built in, and small readable primitives instead of a component framework.

## Decisions

1. **TailAdmin kept as the presentation layer; product code separated.** `src/layout`,
   `src/components`, `src/context` and `src/icons` are the template, adapted where the product
   needs it (sidebar menu, header controls, user menu, brand). `src/platform` and `src/pages` are
   ours. Styling is Tailwind utility classes using the template's design tokens (`src/index.css`).
2. **Same origin as the API.** In a cell the ingress routes `/api` to the API and `/` to the web
   app; in development Vite proxies `/api`. No CORS configuration is needed for the first-party UI
   and cookies/tokens never cross origins.
3. **Runtime configuration via `/config.json`.** One image serves every cell; the ConfigMap holds
   the Keycloak URL, realm, client id and product name.
4. **Authentication in the browser with `oidc-client-ts`** (authorization code + PKCE against the
   `platform-web` public client). Tokens live in session storage; the API remains the only place
   authorization is decided.
5. **Data access through TanStack Query** with a global refresh interval (the "Update every"
   control), so every section polls the same way LiveDashboard does.

## Consequences

* New sections = a page component + hooks; no build-time environment variables.
* Visual changes use the template's Tailwind tokens (`src/index.css`); no separate stylesheet.
* `test/render.mjs` mounts the whole app in jsdom in CI; keep it green when adding pages.
* Later, Vulnerabilities/SBOM/Policies/Compliance replace their muted tabs with pages.
