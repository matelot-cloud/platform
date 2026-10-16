import { CheckLineIcon, ChevronDownIcon } from "@/icons";
import { useProjects, useServices, useTeams, useWorkspaces } from "@/platform/api/hooks";
import { teamPath, useScopeLocation } from "@/platform/navigation/scope";
import { setSelectedServiceId } from "@/platform/state/service-selection";
import { cn } from "@/utils";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";

/**
 * Header location switcher: "Workspace: Platform ▾ › Team: Payments ▾ › Project: checkout-api ▾ › Service: … ▾".
 * It shows where you are and choosing a value goes there (the URL changes) — it is not a filter. Each list is
 * scoped to its parent (teams of the workspace, projects of the team, or of the workspace when no team is chosen);
 * "All workspaces / All projects" appear only on organization-wide pages. The pills open our own popover
 * (LocationPicker) — never a native <select>, which Chrome paints with the OS look over the dark theme.
 */
export function ContextSwitcher() {
  const navigate = useNavigate();
  const loc = useScopeLocation();
  const orgId = loc.organization?.id;
  const workspaces = useWorkspaces(orgId);
  const teams = useTeams(orgId);
  const projects = useProjects(orgId);
  const services = useServices(loc.projectId);
  if (!loc.organization) return null;
  const orgWide = !loc.workspaceId;

  const wsItems: PickerItem[] = (workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name, sub: w.slug }));
  const teamItems: PickerItem[] = (teams.data ?? []).filter((t) => t.workspaceId === loc.workspaceId).map((t) => ({ value: t.id, label: t.name, sub: t.slug }));
  const projectItems: PickerItem[] = (projects.data ?? [])
    .filter((p) => (!loc.workspaceId || p.workspaceId === loc.workspaceId) && (!loc.teamId || p.teamId === loc.teamId))
    .map((p) => ({ value: p.id, label: p.name, sub: loc.teamId ? p.slug : `${p.workspaceSlug} / ${p.teamSlug} / ${p.slug}` }));
  const serviceItems: PickerItem[] = (services.data ?? []).map((s) => ({ value: s.id, label: s.name, sub: s.slug }));
  const up = loc.teamId && loc.workspaceId ? teamPath({ id: loc.teamId, workspaceId: loc.workspaceId }) : loc.workspaceId ? `/workspaces/${loc.workspaceId}` : "/projects";

  return (
    <nav aria-label="Location" className="flex min-w-0 flex-wrap items-center gap-1.5 xl:flex-nowrap">
      <LocationPicker kind="Workspace" value={loc.workspaceId ?? ""} items={wsItems} all="All workspaces" onChange={(v) => void navigate(v ? `/workspaces/${v}` : "/overview")} />
      {loc.workspaceId && (
        <>
          <Sep />
          <LocationPicker kind="Team" value={loc.teamId ?? ""} items={teamItems} all="Whole workspace" placeholder="Select…" onChange={(v) => void navigate(v ? teamPath({ id: v, workspaceId: loc.workspaceId! }) : `/workspaces/${loc.workspaceId}`)} />
        </>
      )}
      <Sep />
      <LocationPicker kind="Project" value={loc.projectId ?? ""} items={projectItems} all={orgWide ? "All projects" : loc.teamId ? "Whole team" : "Whole workspace"} placeholder={orgWide ? undefined : "Select…"} onChange={(v) => void navigate(v ? `/projects/${v}` : up)} />
      {loc.projectId && serviceItems.length > 0 && (
        <>
          <Sep />
          <LocationPicker kind="Service" compact value={loc.service?.id ?? ""} items={serviceItems} all="All services" allShort="All" onChange={(v) => setSelectedServiceId(loc.projectId!, v)} />
        </>
      )}
    </nav>
  );
}

function Sep() {
  return <span aria-hidden="true" className="text-gray-300 dark:text-gray-600">›</span>;
}

export interface PickerItem { value: string; label: string; sub?: string }

const FILTER_FROM = 7;

/**
 * The header's picker: a pill "Kind: current ▾" that opens a TailAdmin-style panel under it (same surface as the
 * user menu, dark-mode aware). Items show the name (ellipsis, full name on hover) and the slug underneath; the
 * current one carries a check; "All …" (when given) sits first above a divider. Type-to-filter from 7 items.
 * Keyboard: arrows, Home/End, Enter / Space, Escape; closes on click outside. aria: combobox + listbox / option.
 */
export function LocationPicker({ kind, value, items, all, allShort, placeholder, onChange, compact, className }: {
  kind: string;
  value: string;
  items: PickerItem[];
  /** Label of the leading "no selection" entry; omitted = the picker has no such entry. */
  all?: string;
  /** Shorter wording of `all` for the pill. */
  allShort?: string;
  /** Pill wording when nothing is selected and `all` should not be shown as the value ("Select…"). */
  placeholder?: string;
  onChange: (value: string) => void;
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  const options = useMemo<PickerItem[]>(() => (all !== undefined ? [{ value: "", label: all }] : []).concat(items), [all, items]);
  const filterable = items.length >= FILTER_FROM;
  const needle = query.trim().toLowerCase();
  const visible = needle ? options.filter((o) => !o.value || o.label.toLowerCase().includes(needle) || (o.sub ?? "").toLowerCase().includes(needle)) : options;
  const current = items.find((o) => o.value === value);
  const pillText = current ? current.label : placeholder ?? allShort ?? all ?? "";
  const muted = !current;

  const close = (focus = true) => { setOpen(false); setQuery(""); if (focus) button.current?.focus(); };
  const openList = () => { setOpen(true); setQuery(""); const i = options.findIndex((o) => o.value === value); setActive(i < 0 ? 0 : i); };
  const choose = (v: string) => { close(); if (v !== value) onChange(v); };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) close(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);
  useEffect(() => { setActive(0); }, [needle]);
  // focus goes into the panel: the filter when there is one, else the list (arrows work at once)
  useEffect(() => { if (open) (filterable ? root.current?.querySelector<HTMLElement>("input") : list.current)?.focus(); }, [open, filterable]);

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openList(); }
      return;
    }
    const last = visible.length - 1;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(last, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(last); }
    else if (e.key === "Enter" || (e.key === " " && !filterable)) { e.preventDefault(); const o = visible[active]; if (o) choose(o.value); }
    else if (e.key === "Tab") close(false);
  };

  const listboxId = `${id}-list`;
  const activeId = open && visible[active] ? `${id}-opt-${active}` : undefined;
  return (
    <div ref={root} data-location={kind} className={cn("relative", compact ? "shrink-0" : "min-w-0 shrink", className)} onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-label={kind}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeId}
        title={`${kind}: ${pillText}`}
        onClick={() => (open ? close() : openList())}
        className={cn(
          "inline-flex h-9 w-full min-w-16 items-center gap-1.5 rounded-full border px-3 text-sm transition focus:outline-hidden focus-visible:ring-3 focus-visible:ring-brand-500/10",
          compact || muted ? "max-w-40" : "max-w-56 2xl:max-w-64",
          open ? "border-brand-300 bg-white dark:border-brand-500/60 dark:bg-white/5" : "border-gray-200 bg-gray-50 hover:border-brand-300 hover:bg-white dark:border-gray-800 dark:bg-white/3 dark:hover:border-brand-500/60",
        )}
      >
        <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{kind}:</span>{" "}
        <span className={cn("min-w-0 truncate", muted ? "text-gray-500 dark:text-gray-400" : "font-medium text-gray-800 dark:text-white/90")}>{pillText}</span>
        <ChevronDownIcon aria-hidden="true" className={cn("size-4 shrink-0 text-gray-400 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute start-0 top-full z-50 mt-2 w-72 rounded-2xl border border-gray-200 bg-white p-2 shadow-theme-lg dark:border-gray-800 dark:bg-gray-dark" role="presentation">
          {filterable && (
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${kind.toLowerCase()}s`}
              aria-label={`Filter ${kind.toLowerCase()}s`}
              aria-controls={listboxId}
              className="mb-2 h-9 w-full rounded-lg border border-gray-200 bg-transparent px-3 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-800 dark:text-white/90"
            />
          )}
          <ul ref={list} id={listboxId} role="listbox" aria-label={kind} tabIndex={filterable ? -1 : 0} className="max-h-80 overflow-y-auto focus:outline-hidden">
            {visible.length === 0 && <li className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No {kind.toLowerCase()} matches</li>}
            {visible.map((o, i) => {
              const selected = o.value === value;
              const isAll = !o.value && all !== undefined;
              return (
                <li key={o.value || "__all"} role="presentation" className={cn(isAll && visible.length > 1 && "mb-1 border-b border-gray-100 pb-1 dark:border-gray-800")}>
                  <button
                    type="button"
                    role="option"
                    id={`${id}-opt-${i}`}
                    data-index={i}
                    aria-selected={selected}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(o.value)}
                    className={cn("menu-item cursor-pointer text-start", i === active ? "menu-item-active" : "menu-item-inactive")}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" title={o.label}>{o.label}</span>
                      {o.sub && <span className="block truncate text-xs font-normal text-gray-500 dark:text-gray-400">{o.sub}</span>}
                    </span>
                    {selected && <CheckLineIcon aria-hidden="true" className="size-4 shrink-0 text-brand-500" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
