import {
  ChangeSet,
  countColumn,
  EditorState,
  Prec,
  type ChangeSpec,
  type Transaction,
} from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
import { ySyncAnnotation } from "y-codemirror.next";

const orderedMark = /^(\d{1,9})[.)]$/;

/** The ordered lists that hold `pos` or end or begin there, innermost first. */
function listsAt(tree: Tree, pos: number) {
  const lists: SyntaxNode[] = [];
  for (const side of [-1, 1] as const)
    for (
      let node: SyntaxNode | null = tree.resolveInner(pos, side);
      node;
      node = node.parent
    )
      if (
        node.name === "OrderedList" &&
        !lists.some((l) => l.from === node!.from)
      )
        lists.push(node);
  return lists;
}

function touchesMark(tree: Tree, from: number, to: number) {
  let found = false;
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.name === "ListMark") found = true;
      return !found;
    },
  });
  return found;
}

/** Each item's number, where it is in the text and how far it is indented. */
function numbers(state: EditorState, list: SyntaxNode) {
  return list.getChildren("ListItem").flatMap((item) => {
    const mark = item.getChild("ListMark");
    const digits = mark
      ? state.sliceDoc(mark.from, mark.to).match(orderedMark)?.[1]
      : undefined;
    if (!mark || !digits) return [];
    const line = state.doc.lineAt(mark.from);
    const column = countColumn(
      state.sliceDoc(line.from, mark.from),
      state.tabSize,
    );
    return [{ from: mark.from, digits, column }];
  });
}

/** The number of the item that began on the line at `pos` before the edit,
 * if its number stood at `column`. */
function numberOnLine(
  state: EditorState,
  tree: Tree,
  pos: number,
  column: number,
) {
  const line = state.doc.lineAt(pos);
  let digits: string | undefined;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (digits !== undefined) return false;
      if (node.name !== "ListMark" || node.from < line.from) return;
      const at = countColumn(
        state.sliceDoc(line.from, node.from),
        state.tabSize,
      );
      digits =
        at === column
          ? (state.sliceDoc(node.from, node.to).match(orderedMark)?.[1] ?? "")
          : "";
    },
  });
  return digits || undefined;
}

/** Changes that number each ordered list `tr` reshaped in sequence from
 * the number it started with. Only an edit that adds or removes a line or
 * touches a list number reshapes a list, so typing inside an item never
 * rewrites numbers someone chose to repeat. */
export function listRenumbering(tr: Transaction): ChangeSpec[] {
  const before = tr.startState;
  const oldTree = syntaxTree(before);
  const added: { from: number; to: number }[] = [];
  let reshaped = false;
  let end = 0;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    end = Math.max(end, toB);
    if (toB > fromB) added.push({ from: fromB, to: toB });
    if (
      inserted.toString().includes("\n") ||
      before.sliceDoc(fromA, toA).includes("\n") ||
      touchesMark(oldTree, fromA, toA)
    )
      reshaped = true;
  });
  const state = tr.state;
  // Typing reads only what the editor has parsed around the caret; parsing
  // further ahead waits for an edit that renumbers.
  if (
    !reshaped &&
    !added.some((r) => touchesMark(syntaxTree(state), r.from, r.to))
  )
    return [];
  const tree =
    ensureSyntaxTree(state, Math.min(state.doc.length, end + 20_000), 50) ??
    syntaxTree(state);
  // A number typed or pasted is the writer's choice, so its list starts
  // there. A moved line rewrites its number too, but chose none.
  const typedOver = (from: number, to: number) =>
    tr.isUserEvent("input") &&
    added.some((range) => range.from < to && range.to > from);
  const lists = new Map<number, SyntaxNode>();
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    for (const list of [...listsAt(tree, fromB), ...listsAt(tree, toB)])
      lists.set(list.from, list);
  });
  const inverse = tr.changes.invert(before.doc);
  const changes: ChangeSpec[] = [];
  for (const list of lists.values()) {
    // Items indented less than an item's text still belong to its list in
    // Markdown, but writers indent them to number them on their own. So each
    // run of items at one indent counts by itself, and a run ends where a
    // less indented item comes.
    const runs = new Map<number, number>();
    for (const item of numbers(state, list)) {
      for (const column of [...runs.keys()])
        if (column > item.column) runs.delete(column);
      const last = runs.get(item.column);
      let number = last === undefined ? Number(item.digits) : last + 1;
      if (
        last === undefined &&
        !typedOver(item.from, item.from + item.digits.length)
      ) {
        // A run keeps the number it started with, also when its first item
        // goes: map its line back and read the number that began there.
        const was = numberOnLine(
          before,
          oldTree,
          inverse.mapPos(state.doc.lineAt(item.from).from, -1),
          item.column,
        );
        if (was) number = Number(was);
      }
      runs.set(item.column, number);
      if (item.digits !== String(number))
        changes.push({
          from: item.from,
          to: item.from + item.digits.length,
          insert: String(number),
        });
    }
  }
  return changes;
}

/** Ordered lists stay numbered in sequence as items are added, deleted or
 * moved. Remote and undone edits arrive through Yjs already numbered by the
 * writer who made them, so only local edits renumber. Highest precedence:
 * transaction filters run lowest first, so this one sees the final edit. */
export const orderedListNumbers = Prec.highest(
  EditorState.transactionFilter.of((tr) => {
    if (
      !tr.docChanged ||
      tr.startState.readOnly ||
      tr.annotation(ySyncAnnotation)
    )
      return tr;
    const renumbering = listRenumbering(tr);
    if (!renumbering.length) return tr;
    const changes = ChangeSet.of(renumbering, tr.newDoc.length, "\n");
    return [
      tr,
      { changes, selection: tr.newSelection.map(changes), sequential: true },
    ];
  }),
);
