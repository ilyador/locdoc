import { EditorView } from "@codemirror/view";
import type { LinkTarget } from "./editor-types";

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
