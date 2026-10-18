import type { ChangeDesc, EditorState, Transaction } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Tree, type TreeBuffer } from "@lezer/common";

export type PreviewRange = { from: number; to: number };

// Markdown balances its block tree. Compare the stored fragments, not every
// syntax node: an ordinary edit only visits the changed block and its siblings
// along the balanced path. Never reuse inline fragments across block contexts.
function containsTree(
  root: Tree,
  target: Tree | TreeBuffer,
  from: number,
): boolean {
  if (root === target && from === 0) return true;
  let lo = 0,
    hi = root.children.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (root.positions[mid] <= from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0; i--) {
    const child = root.children[i],
      offset = root.positions[i];
    if (offset + child.length < from + target.length) break;
    if (offset === from && child === target) return true;
    if (
      child instanceof Tree &&
      child.type.isAnonymous &&
      containsTree(child, target, from - offset)
    )
      return true;
  }
  return false;
}

function changedBlocks(tree: Tree, other: Tree, back: ChangeDesc) {
  const ranges: PreviewRange[] = [];
  function visit(node: Tree | TreeBuffer, from: number, root = false) {
    const to = from + node.length;
    const oldFrom = back.mapPos(from, 1),
      oldTo = back.mapPos(to, -1);
    if (oldTo - oldFrom === node.length && containsTree(other, node, oldFrom))
      return;
    if (node instanceof Tree && (root || node.type.isAnonymous)) {
      for (let i = 0; i < node.children.length; i++)
        visit(node.children[i], from + node.positions[i]);
    } else ranges.push({ from, to });
  }
  visit(tree, 0, true);
  return ranges;
}

function blockAt(state: EditorState, pos: number, side: -1 | 1) {
  let node = syntaxTree(state).resolve(pos, side);
  while (node.parent && node.parent.parent) node = node.parent;
  return node.parent
    ? { from: node.from, to: node.to }
    : { from: pos, to: pos };
}

export function previewRanges(tr: Transaction): PreviewRange[] {
  const before = syntaxTree(tr.startState),
    after = syntaxTree(tr.state);
  const ranges = changedBlocks(after, before, tr.changes.invertedDesc);
  for (const range of changedBlocks(before, after, tr.changes)) {
    const from = tr.changes.mapPos(range.from, -1);
    const to = tr.changes.mapPos(range.to, 1);
    // A time-sliced parse can temporarily cover less text than its predecessor.
    // Unparsed is not deleted: retain those mapped blocks and their heights
    // until the background parser reaches them again.
    if (from <= after.length)
      ranges.push({ from, to: Math.min(to, after.length) });
  }
  tr.changes.iterChangedRanges((_from, _to, from, to) =>
    ranges.push({ from, to }),
  );
  // An edit can map the old selection onto a different line even without an
  // explicit selection transaction. Refresh both ends of the visibility change.
  const selections = [
    ...tr.startState.selection.ranges.map((r) => ({
      from: tr.changes.mapPos(r.from, -1),
      to: tr.changes.mapPos(r.to, 1),
    })),
    ...tr.state.selection.ranges,
  ];
  for (const range of selections)
    ranges.push({ from: range.from, to: range.to });
  const expanded = ranges
    .map(({ from, to }) => {
      const first = tr.state.doc.lineAt(from),
        last = tr.state.doc.lineAt(to);
      const a = blockAt(tr.state, first.from, 1);
      const b = blockAt(tr.state, last.to, -1);
      return {
        from: tr.state.doc.lineAt(Math.min(first.from, a.from)).from,
        to: tr.state.doc.lineAt(Math.max(last.to, b.to)).to,
      };
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: PreviewRange[] = [];
  for (const range of expanded) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to + 1)
      previous.to = Math.max(previous.to, range.to);
    else merged.push(range);
  }
  return merged;
}
