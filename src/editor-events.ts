import { EditorView } from "@codemirror/view";
import type { LinkTarget } from "./editor-types";
import { pastedDocumentPath } from "./document-links";
import type { Entry } from "./model";

// Rendered document links open a preview instead of navigating the page.
export function linkEvents(open: (target: LinkTarget) => void) {
  const preview = (link: HTMLAnchorElement) =>
    open({
      url: link.dataset.linkUrl!,
      label: link.dataset.linkLabel!,
      rect: link.getBoundingClientRect(),
    });
  return EditorView.domEventHandlers({
    pointerover(e) {
      if (e.pointerType !== "mouse") return false;
      const link = (e.target as Element).closest<HTMLAnchorElement>(
        "a[data-link-url]",
      );
      if (
        !link ||
        (e.relatedTarget instanceof Node && link.contains(e.relatedTarget))
      )
        return false;
      preview(link);
      return false;
    },
    click(e) {
      const link = (e.target as Element).closest<HTMLAnchorElement>(
        "a[data-link-url]",
      );
      if (link) {
        preview(link);
        e.preventDefault();
        return true;
      }
      return false;
    },
    keydown(e) {
      if (e.key !== "Enter") return false;
      const link = (e.target as Element).closest<HTMLAnchorElement>(
        "a[data-link-url]",
      );
      if (!link) return false;
      preview(link);
      e.preventDefault();
      return true;
    },
  });
}

// A pasted or dropped file becomes an upload, never inline document content.
export function fileDropEvents(upload: (file: File) => void) {
  return EditorView.domEventHandlers({
    paste(e, view) {
      const file = Array.from(e.clipboardData?.files || [])[0];
      if (file && !view.state.readOnly) {
        upload(file);
        e.preventDefault();
        return true;
      }
      return false;
    },
    drop(e, view) {
      const file = e.dataTransfer?.files[0];
      if (file && !view.state.readOnly) {
        upload(file);
        e.preventDefault();
        return true;
      }
      return false;
    },
  });
}

// A document's workspace path pasted into a Markdown document becomes the
// path from this document's folder, so a link with it opens that document
// (pastedDocumentPath). Other text pastes as it is.
export function documentPathPaste(
  links: () => { path?: string; entries?: Entry[] },
) {
  return EditorView.domEventHandlers({
    paste(e, view) {
      const { path, entries } = links();
      const data = e.clipboardData;
      if (!path || !entries || !data || data.files.length) return false;
      if (view.state.readOnly) return false;
      const text = data.getData("text/plain");
      if (!text || text.length > 4096 || /[\r\n]/.test(text.trim()))
        return false;
      const { from } = view.state.selection.main;
      const written = pastedDocumentPath(
        text,
        path,
        entries,
        view.state.sliceDoc(Math.max(0, from - 2), from) === "](",
      );
      if (written === null) return false;
      e.preventDefault();
      view.dispatch(view.state.replaceSelection(written), {
        userEvent: "input.paste",
        scrollIntoView: true,
      });
      return true;
    },
  });
}
