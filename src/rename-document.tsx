import { useState } from "react";
import { api, send } from "./api";
import { documentFormat } from "./document-format";

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
        Rename or move document
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
          Apply
        </button>
      </div>
      <p className="field-help">
        Change the folder path to move.
        {/* Only Markdown embeds attachments by relative path. */}
        {documentFormat(initialPath) === "markdown" &&
          " Relative attachment links may need updating."}
      </p>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
