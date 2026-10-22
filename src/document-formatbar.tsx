import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { CaretDown, DotsThree, Minus, Plus } from "@phosphor-icons/react";
import type { DocumentFormat } from "./document-format";
import type { FountainForce } from "./fountain";
import { IconButton } from "./ui";

export function DocumentFormatbar({
  editable,
  format,
  font,
  fontSize,
  setFontSize,
  appearanceOpen,
  toggleAppearance,
  appearanceTrigger,
  optionsOpen,
  openOptions,
  formatFountain,
  tools,
}: {
  editable: boolean;
  format: DocumentFormat;
  font: string;
  fontSize: number;
  setFontSize: Dispatch<SetStateAction<number>>;
  appearanceOpen: boolean;
  toggleAppearance: () => void;
  appearanceTrigger: RefObject<HTMLButtonElement | null>;
  optionsOpen: boolean;
  openOptions: () => void;
  formatFountain: (kind: FountainForce) => void;
  tools: ReactNode;
}) {
  const fountain = format === "fountain";
  return (
    <div className="formatbar" data-format={format}>
      <div className="format-left">
        <button
          className="font-button"
          ref={appearanceTrigger}
          aria-label="Fonts and appearance"
          aria-expanded={appearanceOpen}
          aria-controls="appearance-panel"
          title={`Fonts and appearance (${font})`}
          onClick={toggleAppearance}
        >
          <span>aA</span>
        </button>
        <div
          className="text-size-control"
          role="group"
          aria-label="Document text size"
        >
          <IconButton
            label="Decrease text size"
            disabled={fontSize <= 10}
            onClick={() => setFontSize((value) => Math.max(10, value - 1))}
          >
            <Minus size={14} />
          </IconButton>
          <output aria-live="polite" aria-label="Text size">
            {fontSize}
          </output>
          <IconButton
            label="Increase text size"
            disabled={fontSize >= 28}
            onClick={() => setFontSize((value) => Math.min(28, value + 1))}
          >
            <Plus size={14} />
          </IconButton>
        </div>
      </div>
      <div className="format-tools">
        {editable && (
          <>
            {fountain && (
              <div className="select-field fountain-element-field">
                <select
                  className="fountain-element-select"
                  aria-label="Screenplay element"
                  value=""
                  onChange={(event) =>
                    formatFountain(event.target.value as FountainForce)
                  }
                >
                  <option value="" disabled>
                    Element
                  </option>
                  <option value="scene">Scene heading</option>
                  <option value="action">Action</option>
                  <option value="character">Character</option>
                  <option value="parenthetical">Parenthetical</option>
                  <option value="transition">Transition</option>
                  <option value="centered">Centered</option>
                  <option value="lyric">Lyrics</option>
                </select>
                <CaretDown
                  size={14}
                  className="select-arrow"
                  aria-hidden="true"
                />
              </div>
            )}
          </>
        )}
        <div
          className="format-command-slot"
          aria-hidden={optionsOpen || undefined}
        >
          {tools}
        </div>
        <span className="toolbar-divider" />
        <IconButton label="Document options" onClick={openOptions}>
          <DotsThree size={22} />
        </IconButton>
      </div>
    </div>
  );
}
