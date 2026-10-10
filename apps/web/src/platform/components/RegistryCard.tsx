import { CodeBlock } from "./CodeBlock";
import { CiSnippetBlock } from "./ci-snippets";
import { useProjectIntegrations, useRegistryInfo } from "@/platform/api/hooks";
import type { ProjectRow, Service } from "@/platform/api/types";
import { Link } from "react-router";
import { BrandIcon } from "./EnvironmentManager";
import { Card, muted } from "./ui";


/** Explains the three ways images reach the platform, with this project's own values filled in. */
export function RegistryCard({ project, service }: { project: ProjectRow; service?: Service }) {
  const info = useRegistryInfo();
  const integrations = useProjectIntegrations(project.id);
  const registries = (integrations.data ?? []).filter((i) => i.provider === "registry" && i.status !== "disconnected");
  const host = info.data?.host;
  const repo = `${project.workspaceSlug}/${project.teamSlug}/${project.slug}/${service?.slug ?? "<service-slug>"}`;
  return (
    <Card title="Where do images come from?" description="Three ways, all automatic once set up. Tags matching a version link to the release; every new image gets an SBOM.">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-white/90"><BrandIcon name="docker" /> Built-in registry {info.data?.available ? "" : "(not enabled on this cell)"}</p>
          <p className={`mt-1 text-xs ${muted}`}>Namespaces mirror the platform: builds go to <code>{repo}</code> (scanned on every push); each environment has its own repository <code>{repo}/&lt;environment-slug&gt;</code> — pushing or promoting there is the deployment, and your cluster pulls from it. Mark production <em>protected</em> so only release tokens can deploy to it.</p>
          {host && (
            <CiSnippetBlock input={{ intro: [`Built-in registry: build → scanned → promoted.`], vars: { MATELOT_SERVICE_ID: service?.id ?? "<service id>", MATELOT_ENV_DEV: "<environment id>" }, docker: true, job: "build", steps: ["matelot registry login                                  # docker login with the CI token", `IMAGE=$(matelot registry path --service $MATELOT_SERVICE_ID)  # ${host}/${repo}
docker build -t $IMAGE:{sha} . && docker push $IMAGE:{sha}    # build → scanned`, "matelot pipeline --service $MATELOT_SERVICE_ID --ref {sha} --wait", "matelot promote --env $MATELOT_ENV_DEV --tag {sha}            # → deployed to that environment"] }} />
          )}
        </div>
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-white/90"><span className="flex -space-x-1"><BrandIcon name="github" className="size-4" /><BrandIcon name="gitlab" className="size-4" /></span> Your registry (GHCR, Docker Hub, GitLab, Harbor…)</p>
          <p className={`mt-1 text-xs ${muted}`}>{registries.length ? `Connected: ${registries.map((r) => r.name).join(", ")}. Tags and digests are read every 15 minutes.` : "Connect it once at project, workspace or organization level with a robot/deploy token (Integrations → Connect a source → Container registry); tags and digests are then read every 15 minutes."}</p>
          <Link to={`/projects/${project.id}/integrations`} className="mt-2 inline-block text-sm text-brand-500 hover:underline">Connect a registry</Link>
        </div>
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-white/90"><span className="flex -space-x-1"><BrandIcon name="github" className="size-4" /><BrandIcon name="gitlab" className="size-4" /></span> Reported by your pipeline</p>
          <p className={`mt-1 text-xs ${muted}`}>No registry credential at all: the deploy step names the image, ideally by digest.</p>
          <CodeBlock className="mt-2" code={`matelot deploy --env <environmentId> --version 1.2.0 \\
  --image ghcr.io/acme/app@sha256:…`} />
        </div>
      </div>
    </Card>
  );
}
