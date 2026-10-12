import Badge from "@/components/ui/badge/Badge";
import type { ApiToken, Environment } from "@/platform/api/types";
import { cn } from "@/utils";
import { useState } from "react";
import { CodeBlock } from "./CodeBlock";
import { CI_SYSTEMS, CLI_INSTALL, type CiSystem } from "./ci-snippets";
import { BrandIcon } from "./EnvironmentManager";
import { muted } from "./ui";

/** Environments grouped by slug across the services of the level (a token is allowed per environment slug). */
export interface EnvChoice { slug: string; name: string; kind: string; protected: boolean; services: number }

export function envChoices(envMap: Record<string, Environment[]>): EnvChoice[] {
  const by = new Map<string, EnvChoice>();
  for (const e of Object.values(envMap).flat()) {
    const cur = by.get(e.slug) ?? { slug: e.slug, name: e.name, kind: e.kind, protected: false, services: 0 };
    cur.services += 1;
    cur.protected ||= e.settings?.protected === true;
    by.set(e.slug, cur);
  }
  const order = (k: string) => (k === "development" ? 0 : k === "testing" || k === "staging" ? 1 : k === "production" ? 2 : 3);
  return [...by.values()].sort((a, b) => order(a.kind) - order(b.kind) || a.slug.localeCompare(b.slug));
}

const KIND_STYLE: Record<string, { dot: string; label: string }> = {
  production: { dot: "bg-error-500", label: "production" },
  staging: { dot: "bg-warning-500", label: "staging" },
  testing: { dot: "bg-warning-400", label: "testing" },
  development: { dot: "bg-success-500", label: "development" },
};

/** Tile picker for "may deploy to": one tile per environment, kind colour, protected lock, select all / none. */
export function EnvironmentPicker({ choices, value, onChange, preset }: { choices: EnvChoice[]; value: string[]; onChange: (v: string[]) => void; preset: string }) {
  const toggle = (slug: string) => onChange(value.includes(slug) ? value.filter((x) => x !== slug) : [...value, slug]);
  const prodSelected = choices.some((c) => c.kind === "production" && value.includes(c.slug));
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-400">May deploy to</p>
        <div className="flex gap-3 text-xs">
          <button type="button" className="text-brand-500 hover:underline" onClick={() => onChange(choices.filter((c) => c.kind !== "production").map((c) => c.slug))}>All except production</button>
          <button type="button" className="text-brand-500 hover:underline" onClick={() => onChange(choices.map((c) => c.slug))}>All</button>
          <button type="button" className="text-gray-500 hover:underline" onClick={() => onChange([])}>None</button>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {choices.map((c) => {
          const on = value.includes(c.slug);
          const style = KIND_STYLE[c.kind] ?? { dot: "bg-gray-400", label: c.kind };
          return (
            <button key={c.slug} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(c.slug)}
              className={cn("relative flex flex-col items-start rounded-xl border px-3 py-2.5 text-start transition", on ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-500/10" : "border-gray-200 hover:border-gray-300 dark:border-gray-800 dark:hover:border-gray-700")}>
              <span className={cn("absolute end-2.5 top-2.5 flex size-4 items-center justify-center rounded border text-[10px] font-bold", on ? "border-brand-500 bg-brand-500 text-white" : "border-gray-300 dark:border-gray-600")}>{on ? "✓" : ""}</span>
              <span className="flex items-center gap-2 pe-6 text-sm font-semibold text-gray-800 dark:text-white/90"><span className={cn("size-2 rounded-full", style.dot)} />{c.name}</span>
              <span className={`mt-0.5 text-xs ${muted}`}>{c.slug} · {style.label}{c.services > 1 ? ` · ${c.services} services` : ""}</span>
              {c.protected && <span className="mt-1.5"><Badge size="sm" color="warning">protected</Badge></span>}
            </button>
          );
        })}
      </div>
      <p className={`mt-2 text-xs ${muted}`}>Only matters for <em>protected</em> environments; unprotected ones accept any token of the level.{value.length ? ` Selected: ${value.join(", ")}.` : " Nothing selected: this token cannot deploy to protected environments."}</p>
      {prodSelected && preset !== "full" && preset !== "deploy" && <p className="mt-1 text-xs text-warning-600">Production is selected for a "{preset}" token: give the release job its own deploy token instead.</p>}
      {prodSelected && <p className="mt-1 text-xs text-warning-600">This token can promote to production. Keep it in a protected CI environment / branch only.</p>}
    </div>
  );
}

function CopyRow({ label, value, secret, hint }: { label: string; value: string; secret?: boolean; hint?: string }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">{label}</p>
        {hint && <code className="text-[11px] text-gray-500 dark:text-gray-400">{hint}</code>}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-black px-3 py-2 font-mono text-xs text-gray-100">{shown ? value : "•".repeat(Math.min(32, value.length))}</code>
        {secret && <button type="button" className="rounded-lg border border-gray-200 px-2.5 py-2 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5" onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>}
        <button type="button" className="rounded-lg bg-brand-500 px-3 py-2 text-xs font-medium text-white hover:bg-brand-600" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

const WHERE: Record<CiSystem, { steps: string[]; varKind: string }> = {
  github: { varKind: "secrets", steps: ["Repository (or organization) → Settings → Secrets and variables → Actions.", "Secrets: MATELOT_KEY_ID and MATELOT_SECRET. Variables: MATELOT_URL.", "For production deploys, put them on a GitHub Environment with required reviewers instead of the repository."] },
  gitlab: { varKind: "variables", steps: ["Project (or group) → Settings → CI/CD → Variables → Add variable.", "MATELOT_KEY_ID and MATELOT_SECRET: Masked and Protected. MATELOT_URL: plain.", "Protected variables reach only protected branches and tags — keep production tokens there."] },
  bitbucket: { varKind: "variables", steps: ["Repository settings → Pipelines → Repository variables (or Deployments → production for deployment variables).", "MATELOT_KEY_ID and MATELOT_SECRET: tick Secured. MATELOT_URL: plain.", "Pipelines must be enabled (Repository settings → Pipelines → Settings)."] },
};

function job(sys: CiSystem, envHint: string): string {
  if (sys === "github") return `# .github/workflows/deploy.yml
jobs:
  deploy:
    runs-on: ubuntu-latest        # or self-hosted when the platform is not public
    steps:
      - uses: actions/checkout@v4
      - uses: matelot-io/setup-cli@v2
        with:
          url: \${{ vars.MATELOT_URL }}
          key-id: \${{ secrets.MATELOT_KEY_ID }}
          secret: \${{ secrets.MATELOT_SECRET }}
      - run: matelot whoami
      - run: matelot deploy --env ${envHint} --version \${{ github.ref_name }}`;
  if (sys === "gitlab") return `# .gitlab-ci.yml
deploy:
  image: node:22
  before_script:
    - ${CLI_INSTALL}
  script:
    - matelot whoami
    - matelot deploy --env ${envHint} --version $CI_COMMIT_TAG
  rules: [{ if: '$CI_COMMIT_TAG' }]`;
  return `# bitbucket-pipelines.yml
image: node:22
pipelines:
  tags:
    'v*':
      - step:
          name: Deploy
          script:
            - ${CLI_INSTALL}
            - matelot whoami
            - matelot deploy --env ${envHint} --version $BITBUCKET_TAG`;
}

/** Shown once after creation: separate copy fields, the all-in-one block, then per-CI tabs with logos. */
export function CreatedToken({ token, secret, url }: { token: ApiToken; secret: string; url: string }) {
  const [ci, setCi] = useState<CiSystem>("github");
  const envHint = token.environments?.length === 1 ? `<${token.environments[0]} environment id>` : "<environmentId>";
  const all = `MATELOT_URL=${url}\nMATELOT_KEY_ID=${token.keyId}\nMATELOT_SECRET=${secret}`;
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
     <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3">
        <CopyRow label="Key ID" value={token.keyId} hint="MATELOT_KEY_ID" />
        <CopyRow label="Secret" value={secret} secret hint="MATELOT_SECRET" />
        <CopyRow label="Platform URL" value={url} hint="MATELOT_URL" />
      </div>
      <div>
        <p className="mb-1.5 text-sm font-medium text-gray-800 dark:text-white/90">All three as environment variables</p>
        <CodeBlock code={all} />
      </div>
     </div>
      <div className="min-w-0">
        <p className="mb-2 text-sm font-medium text-gray-800 dark:text-white/90">Use it in your CI</p>
        <div className="grid grid-cols-3 gap-2">
          {CI_SYSTEMS.map((s) => (
            <button key={s.key} type="button" onClick={() => setCi(s.key)} className={cn("flex flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-xs font-semibold transition sm:flex-row sm:gap-2.5 sm:text-sm", ci === s.key ? "border-brand-500 bg-brand-50 text-gray-900 ring-1 ring-brand-500 dark:bg-brand-500/10 dark:text-white" : "border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-800 dark:text-gray-300 dark:hover:border-gray-700")}>
              <BrandIcon name={s.key} className="size-6" />{s.label}
            </button>
          ))}
        </div>
        <div className="mt-3 rounded-xl bg-gray-50 p-4 dark:bg-white/3">
          <p className="text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">Where to store the {WHERE[ci].varKind}</p>
          <ol className="mt-1.5 list-decimal space-y-1 ps-5 text-sm text-gray-700 dark:text-gray-300">{WHERE[ci].steps.map((x) => <li key={x}>{x}</li>)}</ol>
        </div>
        <CodeBlock className="mt-3" code={job(ci, envHint)} />
        <p className={`mt-2 text-xs ${muted}`}>Full pipelines (scan, gate, promote, evidence) are under each environment → CI snippet and in docs/examples.</p>
      </div>
    </div>
  );
}
