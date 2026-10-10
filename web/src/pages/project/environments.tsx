import { PlusIcon } from "@/icons";
import { useCreateEnvironment, useMeta } from "@/platform/api/hooks";
import type { EnvironmentKind, Service } from "@/platform/api/types";
import { EnvironmentDialog } from "@/platform/components/ServicePanel";
import { Card, EmptyState, muted, outlineButton } from "@/platform/components/ui";
import { useState } from "react";
import { Deployments } from "./inventory";
import { useProject } from "./layout";


function ServiceEnvironments({ service, projectId, kinds }: { service: Service; projectId: string; kinds: EnvironmentKind[] }) {
  const create = useCreateEnvironment(service.id);
  const [dialog, setDialog] = useState(false);
  return (
    <Card title={service.name} description="Where this service runs and which version is there." flush actions={<button type="button" className={outlineButton} onClick={() => setDialog(true)}><PlusIcon className="size-4" /> New environment</button>}>
      <Deployments service={service} projectId={projectId} />
      {dialog && <EnvironmentDialog kinds={kinds} pending={create.isPending} error={create.error} onClose={() => setDialog(false)} onSubmit={(d) => create.mutate(d, { onSuccess: () => setDialog(false) })} />}
    </Card>
  );
}

export default function ProjectEnvironmentsPage() {
  const { project, service: selected, services: allServices } = useProject();
  const services = { data: selected ? [selected] : allServices };
  const meta = useMeta();
  const kinds = (meta.data?.environmentKinds ?? ["development", "testing", "staging", "production"]) as EnvironmentKind[];
  return (
    <div className="space-y-6">
      <p className={`text-sm ${muted}`}>An environment is a place a service runs (development, staging, production). The platform learns which version runs there from your CI, from Kubernetes, or from you — and later judges every finding by where it runs: the same vulnerability is medium in development and critical in internet-facing production.</p>
      {(services.data ?? []).length === 0 ? <Card flush><EmptyState title="No services yet">Environments belong to services — create a service first.</EmptyState></Card> : (services.data ?? []).map((s) => <ServiceEnvironments key={s.id} service={s} projectId={project.id} kinds={kinds} />)}
    </div>
  );
}
