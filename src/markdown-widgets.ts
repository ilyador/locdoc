import { EditorView, WidgetType } from "@codemirror/view";
import { parseMarkdownTable } from "./markdown-table";

export function mediaUrl(id: string, path: string, token?: string) {
  return `/api/docs/${id}/media?${new URLSearchParams({ path, ...(token ? { token } : {}) })}`;
}
export function isVideo(path: string) {
  return /\.(mp4|webm|mov)(?:[?&]|$)/i.test(decodeURIComponent(path));
}

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly editable: boolean,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return this.source === other.source && this.editable === other.editable;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "md-table-preview";
    const data = parseMarkdownTable(this.source, 0);
    if (!data) return wrap;
    const table = document.createElement("table");
    table.setAttribute("aria-label", "Document table");
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    data.rows.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      row.forEach((cell, columnIndex) => {
        const td = document.createElement(rowIndex === 0 ? "th" : "td");
        td.style.textAlign = data.align[columnIndex];
        if (this.editable) {
          const edit = document.createElement("button");
          edit.type = "button";
          edit.className = "md-table-cell";
          edit.textContent = cell.text || "\u00a0";
          edit.setAttribute(
            "aria-label",
            `Edit row ${rowIndex + 1}, column ${columnIndex + 1}${cell.text ? `: ${cell.text}` : ""}`,
          );
          edit.onclick = () => {
            view.dispatch({
              selection: { anchor: view.posAtDOM(wrap) + cell.from },
              scrollIntoView: true,
            });
            view.focus();
          };
          td.appendChild(edit);
        } else {
          td.textContent = cell.text || "\u00a0";
        }
        tr.appendChild(td);
      });
      (rowIndex === 0 ? head : body).appendChild(tr);
    });
    table.append(head, body);
    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

export class MediaWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: MediaWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("figure");
    wrap.className = "embed";
    const el = document.createElement(isVideo(this.src) ? "video" : "img");
    if (el instanceof HTMLVideoElement) {
      el.controls = true;
      el.preload = "metadata";
    } else {
      el.alt = this.alt;
      el.loading = "lazy";
    }
    el.src = this.src;
    wrap.appendChild(el);
    const edit = document.createElement("button");
    edit.textContent = "Edit Markdown";
    edit.className = "embed-edit";
    edit.type = "button";
    edit.onclick = () => {
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } });
      view.focus();
    };
    wrap.appendChild(edit);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

export class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly editable: boolean,
    readonly label: string,
  ) {
    super();
  }
  eq(other: TaskWidget) {
    return (
      this.checked === other.checked &&
      this.editable === other.editable &&
      this.label === other.label
    );
  }
  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "md-task-checkbox";
    input.checked = this.checked;
    input.disabled = !this.editable;
    input.setAttribute("aria-label", this.label || "Task");
    input.onchange = () => {
      const from = view.posAtDOM(target);
      if (
        view.state.readOnly ||
        !/^\[[ xX]\]$/.test(view.state.sliceDoc(from, from + 3))
      )
        return;
      view.dispatch({
        changes: {
          from: from + 1,
          to: from + 2,
          insert: input.checked ? "x" : " ",
        },
      });
    };
    const target = document.createElement("label");
    target.className = "md-task-toggle";
    target.appendChild(input);
    return target;
  }
  ignoreEvent() {
    return true;
  }
}
