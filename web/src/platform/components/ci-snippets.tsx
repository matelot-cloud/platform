import { CodeBlock } from "./CodeBlock";
/**
 * CI snippets shown next to connections, registries and environments. One list of shell steps, rendered for
 * GitHub Actions, GitLab CI and Bitbucket Pipelines with each system's variables and install line.
 */
export type CiSystem = "github" | "gitlab" | "bitbucket";
export const CI_SYSTEMS: { key: CiSystem; label: string }[] = [
  { key: "github", label: "GitHub Actions" },
  { key: "gitlab", label: "GitLab CI" },
  { key: "bitbucket", label: "Bitbucket Pipelines" },
];

export const CLI_INSTALL = 'npm install -g "github:dev-testing-secops-platform/secops-platform-cli#main"';

/** Per-system names of the commit SHA, the tag / ref name and the "current branch" variable. */
export const CI_VARS: Record<CiSystem, { sha: string; ref: string; shortSha: string }> = {
  github: { sha: "${{ github.sha }}", ref: "${{ github.ref_name }}", shortSha: "${GITHUB_SHA::7}" },
  gitlab: { sha: "$CI_COMMIT_SHA", ref: "$CI_COMMIT_TAG", shortSha: "$CI_COMMIT_SHORT_SHA" },
  bitbucket: { sha: "$BITBUCKET_COMMIT", ref: "$BITBUCKET_TAG", shortSha: "${BITBUCKET_COMMIT:0:7}" },
};

export interface CiSnippetInput {
  /** Shell lines (may reference the SHA via `{sha}` and the ref via `{ref}`; substituted per system). */
  steps: string[];
  /** Comment lines printed at the top. */
  intro?: string[];
  /** Repository variables (name → example value) and secrets. */
  vars?: Record<string, string>;
  secrets?: string[];
  /** Needs Docker (registry login / build / push). */
  docker?: boolean;
  /** Name of the job. */
  job?: string;
  /** Mark the deploy step manual / protected. */
  manual?: boolean;
}

const sub = (line: string, sys: CiSystem) => line.replaceAll("{sha}", CI_VARS[sys].sha).replaceAll("{ref}", CI_VARS[sys].ref).replaceAll("{shortSha}", CI_VARS[sys].shortSha);

export function ciSnippet(sys: CiSystem, input: CiSnippetInput): string {
  const job = input.job ?? "matelot";
  const vars = { MATELOT_URL: "https://matelot.example.com", ...(input.vars ?? {}) };
  const secrets = input.secrets ?? ["MATELOT_KEY_ID", "MATELOT_SECRET"];
  const head = [
    ...(input.intro ?? []),
    `# Variables: ${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("  ")}`,
    `# Secrets (masked): ${secrets.join(", ")}   — from \`matelot ci-token create\` or project Settings → CI tokens`,
  ].map((l) => (l.startsWith("#") ? l : `# ${l}`));
  const steps = input.steps.map((s) => sub(s, sys));
  if (sys === "github") {
    return [
      ...head,
      `jobs:`,
      `  ${job}:`,
      `    runs-on: self-hosted            # or ubuntu-latest once the platform is reachable from GitHub`,
      ...(input.manual ? [`    environment: production        # optional reviewer approval on top of the policy gate`] : []),
      `    steps:`,
      `      - uses: actions/checkout@v4`,
      `      - uses: dev-testing-secops-platform/secops-platform-cli@main`,
      `        with: { url: \${{ vars.MATELOT_URL }}, key-id: \${{ secrets.MATELOT_KEY_ID }}, secret: \${{ secrets.MATELOT_SECRET }} }`,
      ...steps.map((s) => (s.includes("\n") ? `      - run: |\n${s.split("\n").map((l) => `          ${l}`).join("\n")}` : `      - run: ${s}`)),
    ].join("\n");
  }
  if (sys === "gitlab") {
    return [
      ...head,
      `${job}:`,
      `  image: ${input.docker ? "docker:27" : "node:22"}`,
      ...(input.docker ? [`  services: [docker:27-dind]`] : []),
      `  before_script:`,
      ...(input.docker ? [`    - apk add --no-cache nodejs npm git`] : []),
      `    - ${CLI_INSTALL}`,
      `  script:`,
      ...steps.flatMap((s) => s.split("\n").map((l) => `    - ${l}`)),
      ...(input.manual ? [`  when: manual`, `  environment: production`] : []),
    ].join("\n");
  }
  return [
    ...head,
    `image: node:22`,
    `pipelines:`,
    `  default:`,
    `    - step:`,
    `        name: ${job}`,
    ...(input.docker ? [`        services: [docker]`] : []),
    ...(input.manual ? [`        trigger: manual`, `        deployment: production`] : []),
    `        script:`,
    `          - ${CLI_INSTALL}`,
    ...steps.flatMap((s) => s.split("\n").map((l) => `          - ${l}`)),
  ].join("\n");
}

import { cn } from "@/utils";
import { BrandIcon } from "./EnvironmentManager";

export function CiTabs({ value, onChange }: { value: CiSystem; onChange: (v: CiSystem) => void }) {
  return (
    <div className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-white/5">
      {CI_SYSTEMS.map((s) => (
        <button key={s.key} type="button" onClick={() => onChange(s.key)} className={cn("flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium", value === s.key ? "bg-white text-gray-800 shadow-theme-xs dark:bg-gray-800 dark:text-white/90" : "text-gray-500 hover:text-gray-700 dark:text-gray-400")}>
          <BrandIcon name={s.key} className="size-4" />{s.label}
        </button>
      ))}
    </div>
  );
}

import { useState } from "react";

/** A ready-to-paste block with the GitHub Actions / GitLab CI / Bitbucket Pipelines switcher and a Copy button. */
export function CiSnippetBlock({ input, title }: { input: CiSnippetInput; title?: string }) {
  const [ci, setCi] = useState<CiSystem>("github");
  const text = ciSnippet(ci, input);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {title ? <p className="text-sm font-medium text-gray-800 dark:text-white/90">{title}</p> : <span />}
        <CiTabs value={ci} onChange={setCi} />
      </div>
      <CodeBlock code={text} className="mt-2" />
    </div>
  );
}
