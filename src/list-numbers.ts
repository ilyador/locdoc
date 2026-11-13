import {
  ChangeSet,
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

/** Each item's number, where it is in the text. */
function numbers(state: EditorState, list: SyntaxNode) {
  return list.getChildren("ListItem").flatMap((item) => {
    const mark = item.getChild("ListMark");
    const digits = mark
      ? state.sliceDoc(mark.from, mark.to).match(orderedMark)?.[1]
      : undefined;
    return mark && digits ? [{ from: mark.from, digits }] : [];
  });
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
    const items = numbers(state, list);
    if (!items.length) continue;
    const first = items[0];
    let start = Number(first.digits);
    if (!typedOver(first.from, first.from + first.digits.length)) {
      // A list keeps the number it started with, also when its first item
      // goes: map its start back and read the list that began there.
      const origin = inverse.mapPos(list.from, -1);
      const earlier = listsAt(oldTree, origin).find((l) => l.from === origin);
      const was = earlier && numbers(before, earlier)[0];
      if (was) start = Number(was.digits);
    }
    items.forEach((item, index) => {
      const number = String(start + index);
      if (item.digits !== number)
        changes.push({
          from: item.from,
          to: item.from + item.digits.length,
          insert: number,
        });
    });
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
