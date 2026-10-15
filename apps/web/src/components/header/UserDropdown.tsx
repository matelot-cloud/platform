import { useMe } from "@/platform/api/hooks";
import { humanize } from "@/platform/format";
import { personInitials, personName, personSubtitle } from "@/platform/people";
import { useState } from "react";
import { useAuth } from "react-oidc-context";
import { Dropdown } from "../ui/dropdown/Dropdown";
import { Link } from "react-router";


export default function UserDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const auth = useAuth();
  const me = useMe();

  const email = me.data?.user.email ?? auth.user?.profile.email ?? "";
  // the platform's view of the user first (it never stores the e-mail or a placeholder as a name); the token's claims
  // only until /me has answered
  const person = me.data ? me.data.user : { email, displayName: auth.user?.profile.name ?? null };
  const displayName = personName(person);
  const roles = [...new Set((me.data?.memberships ?? []).map((m) => humanize(m.role)))];

  const signOut = () => {
    void auth.signoutRedirect({ post_logout_redirect_uri: window.location.origin });
  };

  return (
    <div className="relative">
      <button onClick={() => setIsOpen((prev) => !prev)} className="dropdown-toggle flex items-center text-gray-700 dark:text-gray-400" aria-label="Account">
        <span className="me-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-500 text-sm font-semibold text-white">{personInitials(person)}</span>
        <span className="me-1 hidden max-w-48 truncate text-theme-sm font-medium sm:block" title={displayName}>{displayName}</span>
        <svg className={`stroke-gray-500 transition-transform duration-200 dark:stroke-gray-400 ${isOpen ? "rotate-180" : ""}`} width="18" height="20" viewBox="0 0 18 20" fill="none">
          <path d="M4.3125 8.65625L9 13.3437L13.6875 8.65625" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <Dropdown isOpen={isOpen} onClose={() => setIsOpen(false)} className="absolute inset-e-0 mt-4.25 flex w-72 flex-col rounded-2xl border border-gray-200 bg-white p-3 shadow-theme-lg dark:border-gray-800 dark:bg-gray-dark">
        <div>
          <span className="block truncate text-theme-sm font-medium text-gray-700 dark:text-gray-400">{displayName}</span>
          {personSubtitle(person) && <span className="mt-0.5 block truncate text-theme-xs text-gray-500 dark:text-gray-400">{personSubtitle(person)}</span>}
          {me.data?.user.platformRole === "admin" && <span className="mt-2 inline-block rounded-full bg-brand-50 px-2 py-0.5 text-theme-xs font-medium text-brand-500 dark:bg-brand-500/15 dark:text-brand-400">Cell administrator</span>}
          {roles.length > 0 && <span className="mt-2 block text-theme-xs text-gray-500 dark:text-gray-400">Roles: {roles.join(", ")}</span>}
        </div>
        <Link to="/account/tokens" onClick={() => setIsOpen(false)} className="mt-3 flex items-center gap-3 rounded-lg px-3 py-2 text-theme-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5">
          Access tokens
        </Link>
        <button
          type="button"
          onClick={signOut}
          className="group mt-3 flex items-center gap-3 rounded-lg border-t border-gray-200 px-3 py-2 pt-4 text-theme-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-700 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-300"
        >
          Sign out
        </button>
      </Dropdown>
    </div>
  );
}
