// Sidebar shortcuts: the label a menu shows, then its aria-keyshortcuts value.
export const mac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
export const shortcuts = mac
  ? {
      remove: ["⌘⌫", "Meta+Backspace"],
      copyPath: ["⌥⌘C", "Alt+Meta+C"],
      copyRelative: ["⇧⌥⌘C", "Shift+Alt+Meta+C"],
      undo: ["⌘Z", "Meta+Z"],
    }
  : {
      remove: ["Del", "Delete"],
      copyPath: ["Shift+Alt+C", "Shift+Alt+C"],
      copyRelative: ["Ctrl+Shift+Alt+C", "Control+Shift+Alt+C"],
      undo: ["Ctrl+Z", "Control+Z"],
    };
