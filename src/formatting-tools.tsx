import {
  ChatCircle,
  Code,
  Image,
  LinkSimple,
  ListBullets,
  ListChecks,
  Quotes,
  TextB,
  TextH,
  TextItalic,
  TextUnderline,
  type Icon,
} from "@phosphor-icons/react";
import type { EditorHandle } from "./editor-types";
import { TablePicker } from "./table-picker";

export function FormattingTools({
  fountain,
  editable,
  busy,
  expanded = false,
  onEdit,
  onLink,
  onUpload,
  onComment,
}: {
  fountain: boolean;
  editable: boolean;
  busy: boolean;
  expanded?: boolean;
  onEdit: (command: (editor: EditorHandle) => void) => void;
  onLink: () => void;
  onUpload: () => void;
  onComment: () => void;
}) {
  const commands: {
    label: string;
    icon: Icon;
    className?: string;
    run: () => void;
    disabled?: boolean;
  }[] = editable
    ? [
        ...(!fountain
          ? [
              {
                label: "Heading",
                icon: TextH,
                className: "toolbar-secondary",
                run: () => onEdit((e) => e.wrap("## ")),
              },
            ]
          : []),
        {
          label: "Bold",
          icon: TextB,
          className: "toolbar-primary",
          run: () => onEdit((e) => e.wrap("**", "**")),
        },
        {
          label: "Italic",
          icon: TextItalic,
          className: "toolbar-primary",
          run: () => onEdit((e) => e.wrap("*", "*")),
        },
        ...(fountain
          ? [
              {
                label: "Underline",
                icon: TextUnderline,
                className: "toolbar-primary",
                run: () => onEdit((e) => e.wrap("_", "_")),
              },
            ]
          : [
              {
                label: "Bulleted list",
                icon: ListBullets,
                className: "toolbar-secondary",
                run: () => onEdit((e) => e.wrap("- ")),
              },
              {
                label: "Todo list",
                icon: ListChecks,
                className: "toolbar-secondary",
                run: () => onEdit((e) => e.toggleTasks()),
              },
              {
                label: "Insert link (Ctrl K)",
                icon: LinkSimple,
                className: "toolbar-primary",
                run: onLink,
              },
              {
                label: "Blockquote",
                icon: Quotes,
                className: "toolbar-extra",
                run: () => onEdit((e) => e.wrap("> ")),
              },
              {
                label: "Inline code",
                icon: Code,
                className: "toolbar-extra",
                run: () => onEdit((e) => e.wrap("`", "`")),
              },
              {
                label: "Insert local image or video",
                icon: Image,
                className: "toolbar-media",
                run: onUpload,
                disabled: busy,
              },
            ]),
      ]
    : [];
  return (
    <div className="formatting-tools">
      {commands
        .filter(({ className }) => !expanded || className !== "toolbar-primary")
        .map(({ label, icon: Glyph, className, run, disabled }) => (
          <button
            key={label}
            className={`${expanded ? "menu-action" : "icon-button"} ${className || ""}`}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={run}
          >
            <Glyph size={18} />
            {expanded && <span>{label.replace(/ \(.*\)$/, "")}</span>}
          </button>
        ))}
      {editable && !fountain && (
        <div className="toolbar-media formatting-table">
          <TablePicker
            showLabel={expanded}
            onInsert={(rows, columns) =>
              onEdit((e) => e.insertTable(rows, columns))
            }
          />
        </div>
      )}
      {!expanded && (
        <button
          className="icon-button toolbar-comment"
          aria-label="Add comment (Ctrl Alt M)"
          title="Add comment (Ctrl Alt M)"
          data-comment-control=""
          onClick={onComment}
        >
          <ChatCircle size={18} />
        </button>
      )}
    </div>
  );
}
