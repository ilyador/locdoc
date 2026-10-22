import { Facet } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { parseMarkdownTable } from "./markdown-table";
import { isolate, textDirection } from "./bidi";

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
    // A table whose text starts in Hebrew runs its columns from the right and
    // scrolls from there. Each cell reads in its own direction.
    const direction = textDirection(
      data.rows.flatMap((row) => row.map((cell) => cell.text)).join(" "),
    );
    if (direction) wrap.dir = direction;
    const table = document.createElement("table");
    table.setAttribute("aria-label", "Document table");
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    data.rows.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      row.forEach((cell, columnIndex) => {
        const td = document.createElement(rowIndex === 0 ? "th" : "td");
        const own = textDirection(cell.text);
        if (own) td.dir = own;
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
          // The user's own selection: the preview reveals the source there.
          edit.onclick = () => {
            view.dispatch({
              selection: { anchor: view.posAtDOM(wrap) + cell.from },
              scrollIntoView: true,
              userEvent: "select",
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

// Phosphor's regular ImageBroken, drawn like the workspace's other icons.
const BROKEN_MEDIA =
  "M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16h64a8,8,0,0,0,7.59-5.47l14.83-44.48L163,151.43a8.07,8.07,0,0,0,4.46-4.46l14.62-36.55,44.48-14.83A8,8,0,0,0,232,88V56A16,16,0,0,0,216,40ZM112.41,157.47,98.23,200H40V172l52-52,30.42,30.42L117,152.57A8,8,0,0,0,112.41,157.47ZM216,82.23,173.47,96.41a8,8,0,0,0-4.9,4.62l-14.72,36.82L138.58,144l-35.27-35.27a16,16,0,0,0-22.62,0L40,149.37V56H216Zm12.68,33a8,8,0,0,0-7.21-1.1l-23.8,7.94a8,8,0,0,0-4.9,4.61l-14.31,35.77-35.77,14.31a8,8,0,0,0-4.61,4.9l-7.94,23.8A8,8,0,0,0,137.73,216H216a16,16,0,0,0,16-16V121.73A8,8,0,0,0,228.68,115.24ZM216,200H148.83l3.25-9.75,35.51-14.2a8.07,8.07,0,0,0,4.46-4.46l14.2-35.51,9.75-3.25Z";

// Why link visitors cannot see media, or why the server shows it to nobody,
// as the server names it. The Share dialog lists every one; the owner's
// editor says the second kind in place of the picture.
export const mediaReasons: Record<string, string> = {
  unapproved: "Not approved for link visitors",
  missing: "File not found",
  outside: "Outside your documents folder",
  hidden: "In a hidden file or folder",
  state: "In Locdoc's state folder",
  "too-large": "Over the 5 MB image or 20 MB video limit",
  unsupported: "Not an image or video Locdoc can show",
  invalid: "Not a file path Locdoc can open",
  // A refused Show to link visitors only: the document no longer names it.
  unreferenced: "No longer in this document",
};

// Present in the owner's editor, where media the server refuses even to its
// owner says why. Link visitors see only its alt text.
export const explainMedia = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

// What stands in for media the server will not serve here, such as an image
// the owner has not shown to link visitors or a missing file: its alt text in
// quiet interface type instead of the browser's broken-image box.
function unavailableMedia(alt: string, video: boolean) {
  const holder = document.createElement("span");
  holder.className = "media-missing";
  holder.setAttribute("role", "img");
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.setAttribute("viewBox", "0 0 256 256");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", BROKEN_MEDIA);
  path.setAttribute("fill", "currentColor");
  icon.append(path);
  holder.append(icon, document.createElement("span"));
  describeUnavailable(holder, alt, video);
  return holder;
}
// Its alt text and, once the server has said why, the reason it refuses it.
function describeUnavailable(
  holder: HTMLElement,
  alt: string,
  video: boolean,
  why = "",
) {
  const kind = video ? "Video" : "Image";
  const unavailable = `${kind} unavailable${why ? `: ${why}` : ""}`;
  holder.setAttribute(
    "aria-label",
    alt
      ? `${alt} (${kind.toLowerCase()} unavailable${why ? `: ${why}` : ""})`
      : unavailable,
  );
  holder.title = unavailable;
  // The description keeps its own direction beside the interface's reason.
  const description = isolate(alt);
  holder.lastElementChild!.textContent =
    alt && why ? `${description} · ${why}` : description || why || unavailable;
}

// The placeholder of each medium a view could not load, with how to request
// it once more.
const retries = new WeakMap<Element, () => void>();

// Requests once more each medium shown as unavailable inside `root`, as when
// the server says an approval may let it serve more of the document's media.
// One that is still refused becomes a placeholder again, until the next time.
export function retryUnavailableMedia(root: ParentNode) {
  for (const holder of Array.from(root.querySelectorAll(".media-missing")))
    retries.get(holder)?.();
}

// Why the server refuses media to its owner, as its error names it, or ""
// when it gives none or now serves the file.
async function refusal(src: string) {
  const request = new AbortController();
  try {
    const response = await fetch(src, { signal: request.signal });
    if (response.ok) return "";
    const { reason } = (await response.json()) as { reason?: unknown };
    return typeof reason === "string" ? reason : "";
  } catch {
    return "";
  } finally {
    request.abort();
  }
}

// Source text reaches the DOM only through properties, never as markup.
function mediaElement(
  src: string,
  alt: string,
  title: string,
  explain: boolean,
): HTMLElement {
  const video = isVideo(src);
  const el = document.createElement(video ? "video" : "img");
  if (el instanceof HTMLVideoElement) {
    el.controls = true;
    el.preload = "metadata";
    if (alt) el.setAttribute("aria-label", alt);
  } else {
    el.alt = alt;
    el.loading = "lazy";
    el.draggable = false;
  }
  if (title) el.title = title;
  el.addEventListener(
    "error",
    () => {
      const holder = unavailableMedia(alt, video);
      retries.set(holder, () => {
        retries.delete(holder);
        holder.replaceWith(mediaElement(src, alt, title, explain));
      });
      el.replaceWith(holder);
      if (explain)
        void refusal(src).then((reason) => {
          if (Object.hasOwn(mediaReasons, reason))
            describeUnavailable(holder, alt, video, mediaReasons[reason]);
        });
    },
    { once: true },
  );
  el.src = src;
  return el;
}

export class MediaWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly title = "",
  ) {
    super();
  }
  eq(other: MediaWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.title === this.title
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("figure");
    wrap.className = "embed";
    // A Hebrew description puts Edit Markdown at the figure's left edge.
    if (textDirection(this.alt) === "rtl") wrap.dir = "rtl";
    wrap.appendChild(
      mediaElement(
        this.src,
        this.alt,
        this.title,
        view.state.facet(explainMedia),
      ),
    );
    const edit = document.createElement("button");
    edit.textContent = "Edit Markdown";
    edit.className = "embed-edit";
    edit.type = "button";
    // The user's own selection: the preview reveals the source there.
    edit.onclick = () => {
      view.dispatch({
        selection: { anchor: view.posAtDOM(wrap) },
        userEvent: "select",
      });
      view.focus();
    };
    wrap.appendChild(edit);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

// An image or video inside a line of text. Clicking an image in an editable
// view places the caret at its source, which the preview then reveals.
export class InlineMediaWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly title = "",
  ) {
    super();
  }
  eq(other: InlineMediaWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.title === this.title
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "embed-inline";
    const media = mediaElement(
      this.src,
      this.alt,
      this.title,
      view.state.facet(explainMedia),
    );
    wrap.appendChild(media);
    if (!(media instanceof HTMLVideoElement))
      wrap.onclick = (event) => {
        if (view.state.readOnly) return;
        event.preventDefault();
        view.dispatch({
          selection: { anchor: view.posAtDOM(wrap) },
          userEvent: "select",
        });
        view.focus();
      };
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
