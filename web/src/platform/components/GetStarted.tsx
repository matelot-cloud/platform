import { useOnboarding, useSetOnboardingDismissed } from "@/platform/api/hooks";
import type { OnboardingStep } from "@/platform/api/types";
import { CheckLineIcon } from "@/icons";
import { cn } from "@/utils";
import { useState } from "react";
import { Link } from "react-router";
import { Card, ErrorNotice, linkButton, muted } from "./ui";

function Step({ step, expanded, onToggle }: { step: OnboardingStep; expanded: boolean; onToggle: () => void }) {
  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        <span aria-hidden className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border", step.done ? "border-success-500 bg-success-500 text-white" : "border-gray-300 dark:border-gray-600")}>
          {step.done && <CheckLineIcon className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <button type="button" className={cn("text-start text-sm", step.done ? "text-gray-500 dark:text-gray-400" : "font-medium text-gray-800 dark:text-white/90")} onClick={onToggle} aria-expanded={expanded}>
              {step.title}{step.optional && <span className={`ms-2 text-xs font-normal ${muted}`}>optional</span>}
            </button>
            <span className="flex items-center gap-3 text-xs">
              {step.detail && <span className={muted}>{step.detail}</span>}
              {!step.done && <Link to={step.href} className="font-medium text-brand-500 hover:text-brand-600">Open →</Link>}
            </span>
          </div>
          {expanded && (
            <div className="mt-1.5 space-y-1.5">
              <p className={`text-sm ${muted}`}>{step.description}</p>
              {step.cli && <code className="block overflow-x-auto rounded-md bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700 dark:bg-white/5 dark:text-gray-300">{step.cli}</code>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Overview setup checklist, for organization administrators only: every step's state comes from the API (what has
 * happened), so there is nothing to tick and it only moves forward. Open steps are listed; completed ones fold away.
 * Shown until setup was complete once; an administrator can hide it earlier and bring it back.
 */
export function GetStarted({ organizationId }: { organizationId: string }) {
  const onboarding = useOnboarding(organizationId);
  const setDismissed = useSetOnboardingDismissed(organizationId);
  const [open, setOpen] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const d = onboarding.data;
  // only for people who can act on the organization's setup — developers of every team never see it
  if (!d || !d.canManage) return null;
  if (!d.visible) {
    // hidden by an administrator before setup was complete: a one-line way back; after completion, nothing
    if (d.completedAt || !d.dismissedAt) return null;
    return (
      <p className={`text-sm ${muted}`}>
        Setup {d.completed}/{d.total} done.{" "}
        <button type="button" className={linkButton} disabled={setDismissed.isPending} onClick={() => setDismissed.mutate(false)}>Show the setup checklist</button>
      </p>
    );
  }
  const pct = Math.round((d.completed / d.total) * 100);
  const expanded = open ?? d.next?.id ?? null;
  const remaining = d.steps.filter((s) => !s.done);
  const done = d.steps.filter((s) => s.done);
  return (
    <Card
      title={<span className="flex items-center gap-3">Set up your organization <span className={`text-sm font-normal ${muted}`}>{d.completed} of {d.total} done</span></span>}
      description={d.next ? `Next: ${d.next.title.toLowerCase()}. One-time, organization-level steps, shown to administrators until done; per-service coverage is tracked separately.` : "Setup is complete."}
      actions={<button type="button" className={linkButton} disabled={setDismissed.isPending} onClick={() => setDismissed.mutate(true)}>Hide</button>}
    >
      <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-white/5" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
        <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ol className="divide-y divide-gray-100 dark:divide-gray-800">
        {remaining.map((s) => <Step key={s.id} step={s} expanded={expanded === s.id} onToggle={() => setOpen(expanded === s.id ? "" : s.id)} />)}
        {showDone && done.map((s) => <Step key={s.id} step={s} expanded={expanded === s.id} onToggle={() => setOpen(expanded === s.id ? "" : s.id)} />)}
      </ol>
      {done.length > 0 && (
        <button type="button" className={`${linkButton} mt-2 text-xs`} onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>
          {showDone ? "Hide completed steps" : `Show ${done.length} completed step${done.length === 1 ? "" : "s"}`}
        </button>
      )}
      {setDismissed.error ? <div className="mt-3"><ErrorNotice error={setDismissed.error} /></div> : null}
    </Card>
  );
}
