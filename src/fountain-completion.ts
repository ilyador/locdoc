import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  acceptCompletion,
  autocompletion,
  completionStatus,
  insertCompletionText,
  pickedCompletion,
  selectedCompletionIndex,
  setSelectedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { visibleTextRanges } from "./editor-comments";
import { fountainScript } from "./fountain-preview";

export function completeFountainSpeaker(
  context: CompletionContext,
): CompletionResult | null {
  const { state, pos, explicit } = context;
  if (
    state.readOnly ||
    state.selection.ranges.length !== 1 ||
    !state.selection.main.empty
  )
    return null;
  const script = state.facet(fountainScript);
  if (!script) return null;
  const line = state.doc.lineAt(pos);
  const prefix = /^([ \t]*)(@?)([\p{L}\p{M}\p{N} .’'_#-]*)$/u.exec(
    state.sliceDoc(line.from, pos),
  );
  if (!prefix || (!prefix[2] && !prefix[3].trim() && !explicit)) return null;
  const current = script.lines[line.number - 1];
  if (!["blank", "action", "character"].includes(current.kind)) return null;
  // Standalone annotations are transparent to Fountain's cue boundaries.
  let previous = line.number - 2;
  while (
    previous >= 0 &&
    ["note", "omitted"].includes(script.lines[previous].kind)
  )
    previous--;
  if (
    current.kind !== "character" &&
    !prefix[2] &&
    !(previous < 0 || script.lines[previous].kind === "blank")
  )
    return null;
  // Never replace text after the caret, comment records, or cue extensions.
  const after = visibleTextRanges(state, pos, line.to)
    .map((range) => state.sliceDoc(range.from, range.to))
    .join("");
  if (!/^(?:\s*\([^)]*\))?\s*\^?\s*$/.test(after)) return null;
  const names = new Set<string>();
  for (const cue of script.lines) {
    if (cue.kind !== "character" || cue.from === line.from) continue;
    const name = cue.text
      .replace(/\s*\^\s*$/, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
    if (name && name.toLocaleLowerCase() !== prefix[3].toLocaleLowerCase())
      names.add(name);
  }
  if (!names.size) return null;
  return {
    from: line.from + prefix[1].length + prefix[2].length,
    options: [...names].map<Completion>((label) => ({
      label,
      apply(view, completion, from, to) {
        // Pointer acceptance bypasses CodeMirror's keyboard read-only guard.
        if (view.state.readOnly) return;
        // Mixed-case names need Fountain's explicit character marker.
        const text =
          prefix[2] || label === label.toUpperCase() ? label : `@${label}`;
        view.dispatch({
          ...insertCompletionText(view.state, text, from, to),
          annotations: pickedCompletion.of(completion),
        });
      },
    })),
    validFor: /^[\p{L}\p{M}\p{N} .’'_#-]*$/u,
  };
}

export function fountainSpeakerCompletion() {
  return [
    autocompletion({
      override: [completeFountainSpeaker],
      filterStrict: true,
      selectOnOpen: false,
      icons: false,
      maxRenderedOptions: 6,
      tooltipClass: () => "fountain-speakers",
    }),
    Prec.high(
      keymap.of([
        {
          key: "Tab",
          run(view) {
            if (
              view.state.readOnly ||
              completionStatus(view.state) !== "active"
            )
              return false;
            if (selectedCompletionIndex(view.state) === null)
              view.dispatch({ effects: setSelectedCompletion(0) });
            return acceptCompletion(view);
          },
        },
      ]),
    ),
    EditorView.theme({
      ".cm-tooltip.fountain-speakers": {
        fontFamily: "var(--ui-font)",
        fontSize: "var(--ui-control-size)",
        borderRadius: "6px",
        boxShadow: "0 4px 18px #15213114",
        maxWidth: "min(320px, calc(100vw - 32px))",
      },
      ".fountain-speakers > ul": {
        fontFamily: "inherit",
        minWidth: "144px",
        maxHeight: "204px",
        padding: "3px",
      },
      ".fountain-speakers > ul > li": {
        padding: "7px 10px",
        lineHeight: "1.4",
        borderRadius: "3px",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },
      ".fountain-speakers > ul > li[aria-selected]": {
        backgroundColor: "var(--accent-soft)",
        color: "var(--accent)",
      },
      ".fountain-speakers .cm-completionMatchedText": {
        textDecoration: "none",
        fontWeight: "var(--weight-semibold)",
      },
    }),
  ];
}
