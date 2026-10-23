import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from "react";
import { X } from "@phosphor-icons/react";
import { formatLabel, type DocumentFormat } from "./document-format";
import {
  exampleSource,
  syntaxReference,
  type SyntaxGroup,
} from "./syntax-reference";

// How the reference opened decides what closes it. A hover ends when the
// pointer leaves; keyboard focus when focus moves on; a press or tap on a
// second press. Escape, typing elsewhere and a press elsewhere close any of
// them, and none takes focus or the caret from the document.
type Opening = "hover" | "focus" | "press";
export const HOVER_DELAY = 250;
export const LEAVE_DELAY = 300;
// Viewport margins: the side gutter, the gap above the label and the top.
const EDGE = 16;
const GAP = 8;
const TOP = 12;
const modifiers = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

function keyboardFocus(element: Element) {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

// The footer's format label. Hovering, keyboard focus or a tap shows what that
// format's editor recognizes, as inert text.
export function FormatReference({ format }: { format: DocumentFormat }) {
  const reference = syntaxReference[format];
  const label = formatLabel(format);
  const [opening, setOpening] = useState<Opening | null>(null);
  // Event handlers run before React renders; they read the latest value here.
  const current = useRef<Opening | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const over = useRef({ trigger: false, panel: false });
  // Focus that closing returns to the label is not a request to open again.
  const returning = useRef(false);
  const id = useId();
  const show = (how: Opening) => {
    clearTimeout(timer.current);
    current.current = how;
    setOpening(how);
  };
  const hide = () => {
    clearTimeout(timer.current);
    current.current = null;
    // A removed panel reports no pointer leaving it.
    over.current.panel = false;
    setOpening(null);
  };
  const dismiss = () => {
    const inside = !!panel.current?.contains(document.activeElement);
    hide();
    if (!inside) return;
    returning.current = true;
    trigger.current?.focus({ preventScroll: true });
    returning.current = false;
  };
  // Above the label, inside the viewport, never taller than the room above it.
  const place = () => {
    const button = trigger.current;
    const layer = panel.current;
    if (!button || !layer) return;
    // The footer hides while a software keyboard is open.
    if (button.checkVisibility?.() === false) {
      hide();
      return;
    }
    const anchor = button.getBoundingClientRect();
    const room = Math.max(
      120,
      Math.min(anchor.top - GAP - TOP, window.innerHeight * 0.72),
    );
    layer.style.maxHeight = `${room}px`;
    // Its border box in the layout. The panel opens growing from its bottom
    // right corner, and its smaller box on that first frame would place it
    // over the label.
    const size = getComputedStyle(layer);
    const width = Math.min(
      parseFloat(size.width) || layer.offsetWidth,
      window.innerWidth - EDGE * 2,
    );
    const height = Math.min(
      parseFloat(size.height) || layer.offsetHeight,
      room,
    );
    layer.style.left = `${Math.max(
      EDGE,
      Math.min(anchor.right - width, window.innerWidth - EDGE - width),
    )}px`;
    layer.style.top = `${Math.max(TOP, anchor.top - GAP - height)}px`;
  };
  const open = !!opening;
  useLayoutEffect(() => {
    const layer = panel.current;
    if (!open || !layer) return;
    try {
      if (!layer.matches(":popover-open")) layer.showPopover?.();
    } catch {
      // Without popovers the panel is still a fixed layer.
    }
    place();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      !!(trigger.current?.contains(target) || panel.current?.contains(target));
    // The press still reaches the document, so its caret lands where it was
    // aimed.
    const press = (event: Event) => {
      if (!inside(event.target)) hide();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // An editor command, another layer or an input method used this
        // Escape first.
        if (event.defaultPrevented || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      } else if (!inside(event.target) && !modifiers.has(event.key)) hide();
    };
    const away = () => hide();
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", place);
    window.addEventListener("blur", away);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", place);
      window.removeEventListener("blur", away);
    };
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const enter = (part: "trigger" | "panel") => (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    over.current[part] = true;
    clearTimeout(timer.current);
    // A drag across the footer is not a hover.
    if (current.current || part !== "trigger" || event.buttons) return;
    timer.current = setTimeout(() => show("hover"), HOVER_DELAY);
  };
  const leave = (part: "trigger" | "panel") => (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    over.current[part] = false;
    if (current.current === "hover") {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (!over.current.trigger && !over.current.panel) hide();
      }, LEAVE_DELAY);
    } else if (!current.current) clearTimeout(timer.current);
  };
  const blur = (event: FocusEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      (trigger.current?.contains(event.relatedTarget) ||
        panel.current?.contains(event.relatedTarget))
    )
      return;
    if (current.current === "focus" || current.current === "press") hide();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="markdown-tag"
        aria-label={`${label} syntax`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerEnter={enter("trigger")}
        onPointerLeave={leave("trigger")}
        onFocus={(event) => {
          if (!returning.current && !current.current)
            if (keyboardFocus(event.currentTarget)) show("focus");
        }}
        onBlur={blur}
        // Keep the document's focus and caret: the label is not a field.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (current.current === "hover" || !current.current) show("press");
          else hide();
        }}
      >
        {label}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          popover="manual"
          role="dialog"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-summary`}
          className="syntax-reference"
          data-columns={reference.columns.length}
          onPointerEnter={enter("panel")}
          onPointerLeave={leave("panel")}
          // Selecting an example to copy keeps the reference open.
          onPointerDown={() => {
            if (current.current === "hover") show("press");
          }}
          onBlur={blur}
        >
          <div className="syntax-reference-head">
            <div>
              <h2 id={`${id}-title`}>{label} syntax</h2>
              <p id={`${id}-summary`}>{reference.summary}</p>
            </div>
            <button
              type="button"
              className="find-button syntax-reference-close"
              aria-label="Close syntax reference"
              title="Close"
              onMouseDown={(event) => event.preventDefault()}
              onClick={dismiss}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div
            className="syntax-reference-body"
            // Keyboard users can scroll a long reference.
            tabIndex={0}
            role="region"
            aria-labelledby={`${id}-title`}
          >
            <div className="syntax-columns">
              {reference.columns.map((column, c) => (
                <div className="syntax-column" key={c}>
                  {column.map((group, g) => (
                    <SyntaxGroupList
                      key={group.title}
                      id={`${id}-${c}-${g}`}
                      group={group}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Each example is text: typed syntax in ink, the writer's own words muted.
function SyntaxGroupList({ id, group }: { id: string; group: SyntaxGroup }) {
  return (
    <section className="syntax-group" aria-labelledby={id}>
      <h3 id={id}>{group.title}</h3>
      <dl>
        {group.examples.map((example) => (
          <div className="syntax-entry" key={exampleSource(example)}>
            <dt>
              <code>
                {example.source.map((run, i) =>
                  !run ? null : i % 2 ? (
                    <var key={i}>{run}</var>
                  ) : (
                    <span key={i}>{run}</span>
                  ),
                )}
              </code>
            </dt>
            <dd>{example.meaning}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
