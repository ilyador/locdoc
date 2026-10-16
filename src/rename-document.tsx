import { useState } from "react";
import { api, send } from "./api";

export function RenameDocument({
  path: initialPath,
  endpoint,
  onRename,
}: {
  path: string;
  endpoint: string;
  onRename: (path: string) => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="rename-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        try {
          await api(endpoint, send("PATCH", { path }));
          onRename(path);
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setPending(false);
        }
      }}
    >
      <label className="field-label" htmlFor="rename">
        Rename document
      </label>
      <div className="inline-form">
        <input
          id="rename"
          className="text-input"
          name="path"
          value={path}
          disabled={pending}
          onChange={(event) => setPath(event.target.value)}
          required
        />
        <button className="button quiet" disabled={pending}>
          Rename
        </button>
      </div>
      <p className="field-help">
        Keep the folder path to preserve relative attachment links.
      </p>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
