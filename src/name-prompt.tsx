import { useEffect, useRef, useState } from "react";
import { normalizePresence } from "./presence";

export function NamePrompt({ onChoose }: { onChoose: (name: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const safeName = normalizePresence({ name })?.name || "";
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    element.querySelector("input")?.focus();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="dialog name-dialog"
      aria-labelledby="name-title"
      onCancel={(event) => event.preventDefault()}
    >
      <form
        className="dialog-content"
        onSubmit={(event) => {
          event.preventDefault();
          if (safeName) onChoose(safeName);
        }}
      >
        <div className="dialog-heading">
          <h2 id="name-title">What should we call you?</h2>
        </div>
        <label className="field-label" htmlFor="collaborator-name">
          Your name
        </label>
        <input
          id="collaborator-name"
          className="text-input"
          autoComplete="nickname"
          autoFocus
          required
          maxLength={60}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="field-help">Shown beside your cursor and comments.</p>
        <div className="dialog-actions">
          <button className="button primary" disabled={!safeName}>
            Continue
          </button>
        </div>
      </form>
    </dialog>
  );
}
