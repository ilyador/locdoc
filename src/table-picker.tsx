import { useEffect, useRef, useState } from "react";
import { Table, X } from "@phosphor-icons/react";

export function TablePicker({
  onInsert,
}: {
  onInsert: (rows: number, columns: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState({ rows: 3, columns: 3 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = (focus = false) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    root.current
      ?.querySelector<HTMLButtonElement>('[role="gridcell"][tabindex="0"]')
      ?.focus();
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  function insert(rows: number, columns: number) {
    setOpen(false);
    onInsert(rows, columns);
  }
  return (
    <div
      className="table-picker"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        className="icon-button"
        title="Insert table"
        aria-label="Insert table"
        aria-expanded={open}
        aria-controls="table-picker-panel"
        ref={trigger}
        onClick={() => setOpen((value) => !value)}
      >
        <Table size={19} />
      </button>
      {open && (
        <div className="table-picker-panel" id="table-picker-panel">
          <div className="table-picker-heading">
            <strong>Insert table</strong>
            <button
              className="icon-button"
              aria-label="Close table picker"
              onClick={() => close(true)}
            >
              <X size={16} />
            </button>
          </div>
          <p id="table-dimensions" aria-live="polite">
            {size.columns} columns × {size.rows} rows
          </p>
          <div
            role="grid"
            aria-label="Choose table size"
            aria-describedby="table-dimensions"
            aria-rowcount={6}
            aria-colcount={8}
            onKeyDown={(event) => {
              const movement = {
                ArrowLeft: [0, -1],
                ArrowRight: [0, 1],
                ArrowUp: [-1, 0],
                ArrowDown: [1, 0],
              }[event.key];
              if (!movement) return;
              event.preventDefault();
              const rows = Math.max(1, Math.min(6, size.rows + movement[0]));
              const columns = Math.max(
                1,
                Math.min(8, size.columns + movement[1]),
              );
              setSize({ rows, columns });
              root.current
                ?.querySelector<HTMLButtonElement>(
                  `[data-size="${rows}-${columns}"]`,
                )
                ?.focus();
            }}
          >
            {Array.from({ length: 6 }, (_, row) => (
              <div role="row" key={row}>
                {Array.from({ length: 8 }, (_, column) => (
                  <button
                    key={column}
                    type="button"
                    role="gridcell"
                    aria-label={`${column + 1} columns, ${row + 1} rows`}
                    aria-rowindex={row + 1}
                    aria-colindex={column + 1}
                    aria-selected={row < size.rows && column < size.columns}
                    tabIndex={
                      row + 1 === size.rows && column + 1 === size.columns
                        ? 0
                        : -1
                    }
                    data-size={`${row + 1}-${column + 1}`}
                    onPointerEnter={() =>
                      setSize({ rows: row + 1, columns: column + 1 })
                    }
                    onFocus={() =>
                      setSize({ rows: row + 1, columns: column + 1 })
                    }
                    onClick={() => insert(row + 1, column + 1)}
                  />
                ))}
              </div>
            ))}
          </div>
          <small>Click a cell to choose the size.</small>
        </div>
      )}
    </div>
  );
}
