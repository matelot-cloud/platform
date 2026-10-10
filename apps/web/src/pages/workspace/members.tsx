import { MembersPanel } from "@/platform/components/MembersPanel";
import { useWorkspace } from "./layout";

export default function WorkspaceMembersPage() {
  const { organization, workspace } = useWorkspace();
  return <MembersPanel key={workspace.id} organization={organization} initialScope={{ type: "WORKSPACE", id: workspace.id }} />;
}
