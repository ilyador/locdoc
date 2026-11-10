import { EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { textDirection } from "./bidi";
import { commentParser } from "./comment-syntax";
import { sameLinkTargets } from "./document-links";
import { renderInline } from "./markdown-inline";
import {
  parseMarkdownTable,
  tableWidthChanges,
  tableColumnMinimum,
  tableWidthUnit,
} from "./markdown-table";
import type { Entry } from "./model";

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly editable: boolean,
    readonly path = "",
    readonly entries: Entry[] = [],
  ) {
    super();
  }
  eq(other: TableWidget) {
    return (
      this.source === other.source &&
      this.editable === other.editable &&
      this.path === other.path &&
      sameLinkTargets(this.entries, other.entries)
    );
  }
  toDOM(view: EditorView) {
    const doc = view.dom.ownerDocument;
    const wrap = doc.createElement("div");
    wrap.className = "md-table-preview";
    // Native focus/selection belongs to the controls inside this preview, not
    // the surrounding contenteditable. Cells enter source through `edit` below.
    wrap.contentEditable = "false";
    const data = parseMarkdownTable(this.source);
    if (!data) return wrap;
    const direction = textDirection(
      data.rows.flatMap((row) => row.map((cell) => cell.text)).join(" "),
    );
    if (direction) wrap.dir = direction;
    const table = doc.createElement("table");
    table.setAttribute("aria-label", "Document table");
    const totalWidth = data.widths.reduce((a, b) => a + b, 0);
    // Remember the chosen size while allowing a wider page to stretch it.
    // Phones scroll the table itself instead of squeezing text into slivers.
    table.style.minWidth = `${Math.max(
      data.widths.length * tableColumnMinimum,
      totalWidth * tableWidthUnit,
      (totalWidth / data.widths.reduce((min, width) => Math.min(min, width))) *
        tableColumnMinimum,
    )}px`;
    const group = doc.createElement("colgroup");
    const columns = data.widths.map(() => doc.createElement("col"));
    group.append(...columns);
    const apply = (widths: number[]) => {
      const total = widths.reduce((a, b) => a + b, 0);
      columns.forEach(
        (col, index) => (col.style.width = `${(100 * widths[index]) / total}%`),
      );
    };
    apply(data.widths);
    const nodes = new Map<number, SyntaxNode>();
    commentParser.parse(this.source).iterate({
      enter: ({ node }) => {
        if (node.name === "TableCell") nodes.set(node.from, node);
      },
    });
    const head = doc.createElement("thead");
    const body = doc.createElement("tbody");
    // A mapped widget resolves its live start, never a position captured before
    // someone edited above it. A changed/removed table cancels any pending drag.
    const currentStart = () => {
      if (!wrap.isConnected || view.state.readOnly) return null;
      const from = view.posAtDOM(wrap);
      if (from + this.source.length > view.state.doc.length) return null;
      return view.state.sliceDoc(from, from + this.source.length) ===
        this.source
        ? from
        : null;
    };
    const commit = (widths: number[], focusColumn?: number) => {
      const from = currentStart();
      const changes = tableWidthChanges(this.source, widths);
      if (from === null || !changes?.length) return;
      view.dispatch({
        changes: changes.map((change) => ({
          ...change,
          from: from + change.from,
          to: from + change.to,
        })),
      });
      if (focusColumn !== undefined) {
        for (const el of view.dom.querySelectorAll<HTMLElement>(
          ".md-table-preview",
        ))
          if (view.posAtDOM(el) === from)
            el.querySelectorAll<HTMLElement>(".md-table-resize")[
              focusColumn
            ]?.focus({ preventScroll: true });
      }
      view.requestMeasure();
    };
    data.rows.forEach((row, rowIndex) => {
      const tr = doc.createElement("tr");
      row.forEach((cell, columnIndex) => {
        const td = doc.createElement(rowIndex === 0 ? "th" : "td");
        const own = textDirection(cell.text);
        if (own) td.dir = own;
        td.style.textAlign = data.align[columnIndex];
        const content = doc.createElement("div");
        content.className = "md-table-cell";
        const node = nodes.get(cell.from);
        if (node)
          renderInline(
            (from, to) => this.source.slice(from, to),
            node,
            content,
            this.path,
            this.entries,
          );
        else content.textContent = cell.text || "\u00a0";
        td.append(content);
        if (this.editable) {
          td.tabIndex = 0;
          td.setAttribute(
            "aria-label",
            `Edit row ${rowIndex + 1}, column ${columnIndex + 1}${cell.text ? `: ${cell.text}` : ""}`,
          );
          const edit = () => {
            if (currentStart() === null) return;
            view.dispatch({
              selection: { anchor: view.posAtDOM(wrap) + cell.from },
              scrollIntoView: true,
              userEvent: "select",
            });
            view.focus();
          };
          td.onclick = (event) => {
            if (!(event.target as Element).closest("a, .md-table-resize"))
              edit();
          };
          td.onkeydown = (event) => {
            if (
              event.target === td &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault();
              edit();
            }
          };
          if (rowIndex === 0 && columnIndex < row.length - 1) {
            const handle = doc.createElement("span");
            handle.className = "md-table-resize";
            handle.dir = direction || "ltr";
            handle.tabIndex = 0;
            handle.setAttribute("role", "separator");
            handle.setAttribute("aria-orientation", "vertical");
            handle.setAttribute(
              "aria-label",
              `Resize column ${columnIndex + 1}`,
            );
            handle.setAttribute(
              "aria-valuenow",
              `${Math.round((100 * data.widths[columnIndex]) / data.widths.reduce((a, b) => a + b, 0))}`,
            );
            handle.setAttribute("aria-valuemin", "0");
            handle.setAttribute("aria-valuemax", "100");
            handle.title = "Drag to resize column; use arrow keys when focused";
            let drag: {
              pointer: number;
              x: number;
              widths: number[];
              next: number[];
            } | null = null;
            const widths = () =>
              Array.from(
                head.rows[0].cells,
                (cell) => cell.getBoundingClientRect().width,
              );
            const resized = (widths: number[], delta: number) => {
              const next = widths.slice();
              const left = next[columnIndex],
                right = next[columnIndex + 1];
              const minimum = Math.min(tableColumnMinimum, left, right);
              const change = Math.max(
                minimum - left,
                Math.min(right - minimum, delta),
              );
              next[columnIndex] += change;
              next[columnIndex + 1] -= change;
              return next;
            };
            const sign = direction === "rtl" ? -1 : 1;
            const finish = (save: boolean) => {
              if (!drag) return;
              const last = drag;
              drag = null;
              wrap.classList.remove("is-resizing");
              if (handle.hasPointerCapture?.(last.pointer))
                handle.releasePointerCapture(last.pointer);
              apply(data.widths);
              if (save && last.next.some((n, i) => n !== last.widths[i]))
                commit(last.next);
              view.requestMeasure();
            };
            handle.onpointerdown = (event) => {
              if (drag || event.button !== 0 || currentStart() === null) return;
              event.preventDefault();
              event.stopPropagation();
              const start = widths();
              drag = {
                pointer: event.pointerId,
                x: event.clientX,
                widths: start,
                next: start,
              };
              handle.setPointerCapture(event.pointerId);
              wrap.classList.add("is-resizing");
            };
            handle.onpointermove = (event) => {
              if (!drag || event.pointerId !== drag.pointer) return;
              drag.next = resized(drag.widths, sign * (event.clientX - drag.x));
              apply(drag.next);
              view.requestMeasure();
            };
            handle.onpointerup = (event) => {
              if (event.pointerId === drag?.pointer) finish(true);
            };
            handle.onpointercancel = handle.onlostpointercapture = (event) => {
              if (event.pointerId === drag?.pointer) finish(false);
            };
            handle.onkeydown = (event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(false);
                return;
              }
              if (!/^(ArrowLeft|ArrowRight)$/.test(event.key) || drag) return;
              event.preventDefault();
              event.stopPropagation();
              commit(
                resized(
                  widths(),
                  sign * (event.key === "ArrowRight" ? 16 : -16),
                ),
                columnIndex,
              );
            };
            td.append(handle);
          }
        }
        tr.appendChild(td);
      });
      (rowIndex === 0 ? head : body).appendChild(tr);
    });
    table.append(group, head, body);
    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent(event: Event) {
    // The editor's existing link-preview handlers must receive link events;
    // selection, cell editing and column dragging stay owned by this widget.
    return !(
      event.target instanceof Element &&
      event.target.closest("a[data-link-url]") &&
      /^(click|pointerover|keydown)$/.test(event.type)
    );
  }
}
