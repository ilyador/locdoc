import { DocumentWorkspace } from "./document-workspace";
import { useWorkspace, type Workspace } from "./workspace";
import { McpAuthorization } from "./mcp-authorization";
import { useFrame, WorkspaceFrame } from "./workspace-frame";

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const { frame, setNote } = useFrame();
  // A document has one mounted state owner. Async callbacks from an unmounted
  // owner cannot write to the next document's state. The frame around it,
  // with the sidebar, holds no document state and stays mounted.
  return (
    <WorkspaceFrame workspace={workspace} frame={frame} setNote={setNote}>
      <DocumentWorkspace
        key={workspace.id || "empty"}
        workspace={workspace}
        frame={frame}
      />
    </WorkspaceFrame>
  );
}
function WorkspaceApp() {
  return <WorkspaceView workspace={useWorkspace()} />;
}
export function App() {
  const request = new URLSearchParams(location.search).get("mcp_authorize");
  return request ? <McpAuthorization request={request} /> : <WorkspaceApp />;
}
