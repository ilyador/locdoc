import { useState } from "react";
import { api, send } from "./api";
import { useRemote } from "./use-remote";

const permissions: Record<string, string> = {
  "locdoc:read": "Read enabled documents, comments and version history",
  "locdoc:write": "Edit enabled documents, create files in enabled folders and comment",
  "locdoc:share": "Manage public links for enabled documents and folders",
};

export function authorizationRedirect(value: string) {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\./.test(url.hostname);
  if (
    url.username ||
    url.password ||
    !(url.protocol === "https:" || (loopback && url.protocol === "http:"))
  )
    throw new Error("The connection returned an invalid redirect address.");
  return url.href;
}

export function McpAuthorization({ request }: { request: string }) {
  const preview = useRemote<{
    clientName: string;
    scopes: string[];
    redirectUri: string;
  }>(`/api/mcp/authorize?request=${encodeURIComponent(request)}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const respond = async (allow: boolean) => {
    if (busy || !preview.data) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ redirect: string }>(
        "/api/mcp/authorize",
        send("POST", { request, allow }),
      );
      location.assign(authorizationRedirect(result.redirect));
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <main className="connection-page">
      <section aria-labelledby="connection-title">
        <a className="connection-brand" href="/" aria-label="Locdoc home">
          <img src="/icons/icon-192-v5.png" width="42" height="42" alt="" />
          <span>locdoc.</span>
        </a>
        <h1 id="connection-title">Connect to your workspace</h1>
        {preview.loading && <p role="status">Checking the connection…</p>}
        {preview.data && (
          <>
            <p>
              {/* The app chose this name: its text cannot reorder the rest. */}
              <strong>
                <bdi>{preview.data.clientName}</bdi>
              </strong>{" "}
              is requesting access to Locdoc.
              <span className="field-help connection-app-name">
                Name supplied by the requesting app.
              </span>
            </p>
            <p className="connection-origin">
              Application return address
              <code>{new URL(preview.data.redirectUri).origin}</code>
            </p>
            <ul className="connection-permissions">
              {preview.data.scopes.map((scope) => (
                <li key={scope}>{permissions[scope] || scope}</li>
              ))}
            </ul>
            <p className="field-help">
              Only documents and folders with “Allow MCP” enabled in Share are
              accessible. You can disconnect this app in workspace settings.
            </p>
            <div className="connection-actions">
              <button
                className="button quiet"
                disabled={busy}
                onClick={() => respond(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => respond(true)}
              >
                {busy ? "Connecting…" : "Allow access"}
              </button>
            </div>
          </>
        )}
        {(error || preview.error) && (
          <p className="error" role="alert">
            {error || preview.error}
          </p>
        )}
        {preview.error && (
          <p className="field-help">
            Open Locdoc as its owner to approve this connection.
          </p>
        )}
      </section>
    </main>
  );
}

type Connection = {
  id: string;
  clientName: string;
  scopes: string[];
  created: number;
};

export function McpConnections({ publicUrl }: { publicUrl: string }) {
  const result = useRemote<{ connections: Connection[] }>(
    "/api/mcp/connections",
  );
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const endpoint = `${publicUrl.replace(/\/$/, "")}/mcp`;
  const disconnect = async (id: string) => {
    setPending(id);
    setError("");
    try {
      await api(
        `/api/mcp/connections/${encodeURIComponent(id)}/revoke`,
        send("POST"),
      );
      setRemoved((current) => new Set([...current, id]));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(null);
    }
  };
  return (
    <section
      className="mcp-connections"
      aria-labelledby="mcp-connections-title"
    >
      <h3 id="mcp-connections-title">ChatGPT &amp; MCP</h3>
      <p className="field-help">
        Add this server as a custom MCP plugin in ChatGPT.
      </p>
      <div className="mcp-endpoint">
        <code>{endpoint}</code>
        <button
          className="text-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(endpoint);
              setCopied(true);
            } catch {
              setError(
                "Could not copy the address. Select and copy it instead.",
              );
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {result.loading && (
        <p className="field-help" role="status">
          Loading connections…
        </p>
      )}
      {result.data?.connections
        .filter((connection) => !removed.has(connection.id))
        .map((connection) => (
          <div className="mcp-connection" key={connection.id}>
            <span>
              <strong>
                <bdi>{connection.clientName}</bdi>
              </strong>
              <small>
                {connection.scopes
                  .map((scope) => scope.replace("locdoc:", ""))
                  .join(" · ")}
              </small>
            </span>
            <button
              className="text-button"
              disabled={pending !== null}
              onClick={() => disconnect(connection.id)}
            >
              {pending === connection.id ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        ))}
      {(error || result.error) && (
        <p className="error" role="alert">
          {error || result.error}
        </p>
      )}
    </section>
  );
}
