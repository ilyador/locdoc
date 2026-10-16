import { DocumentWorkspace } from "./document-workspace";
import { useWorkspace, type Workspace } from "./workspace";

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  // A document has one mounted state owner. Async callbacks from an unmounted
  // owner cannot write to the next document's state.
  return (
    <DocumentWorkspace key={workspace.id || "empty"} workspace={workspace} />
  );
}
export function App() {
  return <WorkspaceView workspace={useWorkspace()} />;
}
