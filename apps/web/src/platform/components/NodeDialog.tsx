import Label from "@/components/form/Label";
import { Modal } from "@/components/ui/modal";
import { useState, type FormEvent } from "react";
import type { Criticality } from "../api/types";
import { SLUG_PATTERN, slugify, titleCase } from "../format";
import { ErrorNotice, inputClass, SelectField } from "./ui";

export interface NodeDraft {
  name: string;
  slug: string;
  description: string;
  criticality: Criticality;
  kind?: string;
}

/** Create dialog shared by workspaces, teams and projects. */
export function NodeDialog({
  title,
  submitLabel,
  withCriticality,
  criticalities,
  kinds,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  withCriticality?: boolean;
  criticalities: Criticality[];
  /** Optional "kind" select (services). */
  kinds?: { value: string; label: string }[];
  pending: boolean;
  error: unknown;
  onSubmit: (draft: NodeDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<NodeDraft>({ name: "", slug: "", description: "", criticality: "MEDIUM", kind: kinds?.[0]?.value });
  const [slugTouched, setSlugTouched] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(draft);
  };

  return (
    <Modal isOpen title={<>{title}</>} onClose={onClose} className="max-w-150 p-6 lg:p-10">
      <form onSubmit={submit}>
        <div className="space-y-5">
          <div>
            <Label htmlFor="node-name">Name</Label>
            <input
              id="node-name"
              autoFocus
              required
              maxLength={120}
              className={inputClass}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value, slug: slugTouched ? draft.slug : slugify(e.target.value) })}
            />
          </div>
          <div>
            <Label htmlFor="node-slug">Slug</Label>
            <input
              id="node-slug"
              required
              pattern={SLUG_PATTERN}
              maxLength={63}
              className={inputClass}
              value={draft.slug}
              onChange={(e) => {
                setSlugTouched(true);
                setDraft({ ...draft, slug: e.target.value });
              }}
            />
            <p className="mt-1.5 text-xs text-gray-500">Lowercase letters, digits and hyphens. Cannot be changed later.</p>
          </div>
          <div>
            <Label htmlFor="node-description">Description</Label>
            <textarea
              id="node-description"
              rows={3}
              maxLength={2000}
              className="w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:focus:border-brand-800"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          {kinds && (
            <div>
              <Label>Kind</Label>
              <SelectField value={draft.kind ?? kinds[0]!.value} onChange={(v) => setDraft({ ...draft, kind: v })} options={kinds} />
            </div>
          )}
          {withCriticality && (
            <div>
              <Label>Business criticality</Label>
              <SelectField
                value={draft.criticality}
                onChange={(v) => setDraft({ ...draft, criticality: v as Criticality })}
                options={criticalities.map((c) => ({ value: c, label: titleCase(c) }))}
              />
            </div>
          )}
          {error ? <ErrorNotice error={error} /> : null}
        </div>
        <div className="mt-8 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700 dark:hover:bg-white/3">
            Cancel
          </button>
          <button type="submit" disabled={pending} className="rounded-lg bg-brand-500 px-4 py-3 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 disabled:bg-brand-300">
            {pending ? "Creating…" : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
