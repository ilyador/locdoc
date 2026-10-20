import { DocumentWorkspace } from "./document-workspace";
import { useWorkspace, type Workspace } from "./workspace";
import { McpAuthorization } from "./mcp-authorization";

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  // A document has one mounted state owner. Async callbacks from an unmounted
  // owner cannot write to the next document's state.
  return (
    <DocumentWorkspace key={workspace.id || "empty"} workspace={workspace} />
  );
}
function WorkspaceApp() {
  return <WorkspaceView workspace={useWorkspace()} />;
}
export function App() {
  const request = new URLSearchParams(location.search).get("mcp_authorize");
  return request ? <McpAuthorization request={request} /> : <WorkspaceApp />;
}
