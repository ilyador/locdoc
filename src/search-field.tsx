import {
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { X } from "@phosphor-icons/react";
import { textDirection } from "./bidi";

// A search field with Clear search at its inline end while it holds text.
// A click or a tap empties it through the same update typing runs, so the
// results follow as they would for deleted text, and leaves the caret in the
// field. Like the browsers' own clear buttons, the button is not a Tab stop:
// from the keyboard, Escape clears the text first, and only Escape in an
// empty field reaches the dialog, panel or drawer around it.
export function SearchField({
  value,
  onValueChange,
  inputRef,
  className = "",
  inputClassName,
  start,
  hint,
  onKeyDown,
  autoFocus,
  ...input
}: Omit<ComponentProps<"input">, "value" | "onChange" | "ref" | "dir"> & {
  value: string;
  // What typing runs with the field's new text; clearing runs it with "".
  onValueChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  // The field's box; the input itself takes inputClassName.
  className?: string;
  inputClassName?: string;
  // A decorative icon before the text.
  start?: ReactNode;
  // Shown at the end of an empty field, such as its shortcut. Clear search
  // takes its place.
  hint?: ReactNode;
}) {
  const own = useRef<HTMLInputElement>(null);
  const field = inputRef ?? own;
  // React's autoFocus focuses the field as it mounts, and writes no autofocus
  // attribute. In a dialog that is not open yet the field cannot take focus,
  // and showModal() then focuses the dialog's first control with the
  // attribute, or else its first control, such as Close. So the field has the
  // attribute too.
  useLayoutEffect(() => {
    field.current?.toggleAttribute("autofocus", !!autoFocus);
  }, [autoFocus, field]);
  return (
    <div
      className={`search-control ${className}`}
      // The field reads in its query's direction, as the input's dir="auto"
      // does, so Clear search ends a Hebrew query on its left.
      dir={textDirection(value) ?? undefined}
      onMouseDown={(event) => {
        // A press beside the text puts the caret in the field, as a label's
        // would, and a press on Clear search leaves it there.
        if (event.button !== 0 || event.target === field.current) return;
        event.preventDefault();
        field.current?.focus();
      }}
    >
      {start}
      <input
        // A query is not prose: as in the find widget, no spelling marks
        // under it, and the keyboard neither corrects nor capitalizes it.
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        {...input}
        ref={field}
        className={inputClassName}
        autoFocus={autoFocus}
        dir="auto"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            value &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.stopPropagation();
            onValueChange("");
            return;
          }
          onKeyDown?.(event);
        }}
      />
      {value ? (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          title="Clear search"
          tabIndex={-1}
          onClick={() => {
            onValueChange("");
            field.current?.focus();
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      ) : (
        hint
      )}
    </div>
  );
}
