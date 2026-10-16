import { createContext } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router";
import { LEVEL_LABEL, useScopeLocation, type Crumb } from "./scope";

/**
 * Top of every page inside the app: the full, clickable path (Organization › Workspace › Team › Project › Service ›
 * Page) and a heading that always names the scope ("Members — checkout-api (project)"). Long names are cut with an
 * ellipsis in the middle segments; the full name is on hover.
 */
export function ScopeHeader() {
  const loc = useScopeLocation();
  const kind = loc.level === "organization" || loc.level === "workspace" || loc.level === "team" || loc.level === "project" ? LEVEL_LABEL[loc.level].toLowerCase() : null;
  const description =
    loc.page === "Overview" ? (loc.level === "project" ? loc.project?.description : loc.level === "team" ? loc.team?.description : loc.level === "workspace" ? loc.workspace?.description : null) : null;
  return (
    <div className="mb-6 min-w-0" data-scope-level={loc.level}>
      <Breadcrumb crumbs={loc.crumbs} />
      {loc.page && (
        <h1 className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2 text-xl font-semibold text-gray-800 dark:text-white/90">
          <span>{loc.page}</span>{" "}
          {kind && loc.scopeName && (
            <span className="min-w-0 text-base font-normal [overflow-wrap:anywhere] text-gray-500 dark:text-gray-400" title={`${loc.scopeName} (${kind})`}>
              — <span className="font-medium text-gray-700 dark:text-gray-300">{loc.scopeName}</span> ({kind})
            </span>
          )}
          {loc.level === "account" && <span className="text-base font-normal text-gray-500 dark:text-gray-400">— your account</span>}
          {loc.level === "administration" && <span className="text-base font-normal text-gray-500 dark:text-gray-400">— cell administration</span>}
        </h1>
      )}
      {description && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>}
    </div>
  );
}

/** True inside the app layout, where <PageMeta> leaves the tab title to ScopeDocumentTitle. */
export const InAppLayout = createContext(false);

/** The browser tab title inside the app: "Members · checkout-api · Globex". */
export function ScopeDocumentTitle() {
  const loc = useScopeLocation();
  return <Helmet><title>{loc.documentTitle}</title></Helmet>;
}

export function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const middle = i > 0 && !last;
          const title = c.kind ? `${c.kind}: ${c.label}` : c.label;
          return (
            <li key={`${i}-${c.label}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <span aria-hidden="true" className="text-gray-300 dark:text-gray-600">›</span>}
              {c.to && !last ? (
                <Link to={c.to} title={title} className={`${middle ? "max-w-[9rem] sm:max-w-[14rem]" : "max-w-[12rem] sm:max-w-[18rem]"} truncate hover:text-brand-500`}>{c.label}</Link>
              ) : (
                <span title={title} aria-current={last ? "page" : undefined} className={`${last ? "font-medium text-gray-800 dark:text-white/90" : ""} max-w-[18rem] truncate`}>{c.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
