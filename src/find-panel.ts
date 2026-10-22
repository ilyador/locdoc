import {
  EditorSelection,
  EditorState,
  type Extension,
  type StateCommand,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  runScopeHandlers,
  type KeyBinding,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import {
  SearchCursor,
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { sourceCommentRanges } from "./editor-comments";

type Range = { from: number; to: number };

// Hidden comment records are conversation metadata, not prose: never find,
// highlight, select or replace text inside them. Ranges are sorted.
function overlapsHidden(hidden: readonly Range[], from: number, to: number) {
  let low = 0,
    high = hidden.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (hidden[middle].to <= from) low = middle + 1;
    else high = middle;
  }
  const range = hidden[low];
  return !!range && (from === to ? range.from < from : range.from < to);
}

export function visibleMatch(
  _match: string,
  state: EditorState,
  from: number,
  to: number,
) {
  return !overlapsHidden(sourceCommentRanges(state), from, to);
}

function visibleQuery(query: SearchQuery) {
  return query.test === visibleMatch
    ? query
    : new SearchQuery({
        search: query.search,
        caseSensitive: query.caseSensitive,
        literal: query.literal,
        regexp: query.regexp,
        replace: query.replace,
        wholeWord: query.wholeWord,
        test: visibleMatch,
      });
}

// CodeMirror builds queries from the selection when the panel opens. Give
// every query the visible-text filter, whoever created it.
const visibleQueries = EditorState.transactionExtender.of((tr) => {
  const effects = tr.effects
    .filter(
      (effect) =>
        effect.is(setSearchQuery) && effect.value.test !== visibleMatch,
    )
    .map((effect) => setSearchQuery.of(visibleQuery(effect.value)));
  return effects.length ? { effects } : null;
});

function nextOccurrence(state: EditorState, text: string) {
  const { main, ranges } = state.selection;
  const word = state.wordAt(main.head);
  const wholeWord = word && word.from === main.from && word.to === main.to;
  const hidden = sourceCommentRanges(state);
  const last = ranges[ranges.length - 1];
  for (
    let cycled = false, cursor = new SearchCursor(state.doc, text, last.to);
    ;
  ) {
    cursor.next();
    if (cursor.done) {
      if (cycled) return null;
      cursor = new SearchCursor(state.doc, text, 0, Math.max(0, last.from - 1));
      cycled = true;
      continue;
    }
    const { from, to } = cursor.value;
    if (cycled && ranges.some((range) => range.from === from)) continue;
    if (wholeWord) {
      const found = state.wordAt(from);
      if (!found || found.from !== from || found.to !== to) continue;
    }
    if (!overlapsHidden(hidden, from, to)) return { from, to };
  }
}

// Sublime's Quick Add Next: select the word at each caret, then add the next
// visible occurrence of the selection. It only selects, so it is available in
// read-only views; edits through the new selections keep their usual guards.
export const selectNextVisibleOccurrence: StateCommand = ({
  state,
  dispatch,
}) => {
  const { ranges } = state.selection;
  if (ranges.some((range) => range.empty)) {
    const words = EditorSelection.create(
      ranges.map(
        (range) =>
          state.wordAt(range.head) || EditorSelection.cursor(range.head),
      ),
      state.selection.mainIndex,
    );
    if (words.eq(state.selection)) return false;
    dispatch(state.update({ selection: words, userEvent: "select" }));
    return true;
  }
  const text = state.sliceDoc(ranges[0].from, ranges[0].to);
  if (ranges.some((range) => state.sliceDoc(range.from, range.to) !== text))
    return false;
  const found = nextOccurrence(state, text);
  if (!found) return false;
  dispatch(
    state.update({
      selection: state.selection.addRange(
        EditorSelection.range(found.from, found.to),
        false,
      ),
      effects: EditorView.scrollIntoView(found.to),
      userEvent: "select",
    }),
  );
  return true;
};

const selectVisibleSelectionMatches: StateCommand = ({ state, dispatch }) => {
  const selection = state.selection;
  if (selection.ranges.length > 1 || selection.main.empty) return false;
  const { from, to } = selection.main;
  const hidden = sourceCommentRanges(state);
  const ranges = [];
  let main = 0;
  for (
    let cursor = new SearchCursor(state.doc, state.sliceDoc(from, to));
    !cursor.next().done;
  ) {
    const match = cursor.value;
    if (match.from !== from && overlapsHidden(hidden, match.from, match.to))
      continue;
    if (ranges.length > 1000) return false;
    if (match.from === from) main = ranges.length;
    ranges.push(EditorSelection.range(match.from, match.to));
  }
  dispatch(
    state.update({
      selection: EditorSelection.create(ranges, main),
      userEvent: "select.search.matches",
    }),
  );
  return true;
};

export const findKeymap: readonly KeyBinding[] = [
  ...searchKeymap.map((binding) =>
    binding.key === "Mod-d"
      ? { ...binding, run: selectNextVisibleOccurrence }
      : binding.key === "Mod-Shift-l"
        ? { ...binding, run: selectVisibleSelectionMatches }
        : binding,
  ),
  { key: "Alt-g", run: selectNextVisibleOccurrence, preventDefault: true },
];

// Phosphor regular geometry, matching the workspace's icon controls. The
// regexp and whole-word marks are drawn on the same grid and stroke weight.
type Shape = [tag: "path" | "circle", attributes: Record<string, string>];
const fill = (d: string): Shape => ["path", { d, fill: "currentColor" }];
const stroke = (d: string): Shape => [
  "path",
  {
    d,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "16",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  },
];
const ring = (cx: number, cy: number): Shape => [
  "circle",
  {
    cx: String(cx),
    cy: String(cy),
    r: "28",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "16",
  },
];
const icons: Record<string, Shape[]> = {
  caret: [
    fill(
      "M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z",
    ),
  ],
  case: [
    fill(
      "M87.24,52.59a8,8,0,0,0-14.48,0l-64,136a8,8,0,1,0,14.48,6.81L39.9,160h80.2l16.66,35.4a8,8,0,1,0,14.48-6.81ZM47.43,144,80,74.79,112.57,144ZM200,96c-12.76,0-22.73,3.47-29.63,10.32a8,8,0,0,0,11.26,11.36c3.8-3.77,10-5.68,18.37-5.68,13.23,0,24,9,24,20v3.22A42.76,42.76,0,0,0,200,128c-22.06,0-40,16.15-40,36s17.94,36,40,36a42.73,42.73,0,0,0,24-7.25,8,8,0,0,0,16-.75V132C240,112.15,222.06,96,200,96Zm0,88c-13.23,0-24-9-24-20s10.77-20,24-20,24,9,24,20S213.23,184,200,184Z",
    ),
  ],
  regexp: [
    stroke("M168,52v96M126.43,76l83.14,48M126.43,124l83.14-48"),
    ["circle", { cx: "64", cy: "192", r: "14", fill: "currentColor" }],
  ],
  word: [
    ring(76, 124),
    stroke("M104,96v56"),
    ring(176, 124),
    stroke("M148,60v92"),
    stroke("M36,180v24H220V180"),
  ],
  previous: [
    fill(
      "M205.66,117.66a8,8,0,0,1-11.32,0L136,59.31V216a8,8,0,0,1-16,0V59.31L61.66,117.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0l72,72A8,8,0,0,1,205.66,117.66Z",
    ),
  ],
  next: [
    fill(
      "M205.66,149.66l-72,72a8,8,0,0,1-11.32,0l-72-72a8,8,0,0,1,11.32-11.32L120,196.69V40a8,8,0,0,1,16,0V196.69l58.34-58.35a8,8,0,0,1,11.32,11.32Z",
    ),
  ],
  all: [
    fill(
      "M104,40a8,8,0,0,1,8-8h32a8,8,0,0,1,0,16H112A8,8,0,0,1,104,40Zm40,168H112a8,8,0,0,0,0,16h32a8,8,0,0,0,0-16ZM208,32H184a8,8,0,0,0,0,16h24V72a8,8,0,0,0,16,0V48A16,16,0,0,0,208,32Zm8,72a8,8,0,0,0-8,8v32a8,8,0,0,0,16,0V112A8,8,0,0,0,216,104Zm0,72a8,8,0,0,0-8,8v24H184a8,8,0,0,0,0,16h24a16,16,0,0,0,16-16V184A8,8,0,0,0,216,176ZM40,152a8,8,0,0,0,8-8V112a8,8,0,0,0-16,0v32A8,8,0,0,0,40,152Zm32,56H48V184a8,8,0,0,0-16,0v24a16,16,0,0,0,16,16H72a8,8,0,0,0,0-16ZM40,80a8,8,0,0,0,8-8V48H72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,48V72A8,8,0,0,0,40,80ZM176,184H80a8,8,0,0,1-8-8V80a8,8,0,0,1,8-8h96a8,8,0,0,1,8,8v96A8,8,0,0,1,176,184Zm-8-96H88v80h80Z",
    ),
  ],
  close: [
    fill(
      "M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z",
    ),
  ],
};

function icon(name: string) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attributes] of icons[name]) {
    const shape = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attributes))
      shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  attributes: Record<string, string> = {},
) {
  const node = document.createElement(tag);
  node.className = className;
  for (const [name, value] of Object.entries(attributes))
    node.setAttribute(name, value);
  return node;
}

function iconButton(className: string, label: string, glyph: string) {
  const button = element("button", `find-button ${className}`, {
    type: "button",
    "aria-label": label,
    title: label,
  });
  button.append(icon(glyph));
  return button;
}

// The replace row's disclosure is a per-tab preference.
let replaceExpanded = false;
let panels = 0;
const countLimit = 9999;

// A compact find widget that keeps every command of CodeMirror's panel:
// find, replace, replace all, match case, regexp, whole word, next, previous
// and select all, with Enter, Shift-Enter, Escape and Mod-f unchanged.
class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private query: SearchQuery;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly toggles: Record<
    "caseSensitive" | "regexp" | "wholeWord",
    HTMLButtonElement
  >;
  private readonly disclosure: HTMLButtonElement;
  private readonly replaceRow: HTMLElement;
  private readonly count: HTMLElement;
  private readonly commands: HTMLButtonElement[];
  private matches: { doc: Text; query: SearchQuery; ranges: Range[] } | null =
    null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly view: EditorView) {
    const id = `find-${++panels}`;
    this.query = getSearchQuery(view.state);
    this.dom = element("div", "find-widget", {
      role: "search",
      "aria-label": "Find in document",
    });
    const main = element("div", "find-row find-main");
    this.disclosure = iconButton("find-disclosure", "Toggle replace", "caret");
    this.disclosure.setAttribute("aria-controls", `${id}-replace`);
    this.disclosure.onclick = () => {
      replaceExpanded = !replaceExpanded;
      this.syncAccess();
      if (replaceExpanded) this.replaceField.focus();
    };
    const field = element("div", "find-field");
    this.searchField = element("input", "find-input", {
      type: "text",
      placeholder: "Find",
      "aria-label": "Find",
      "aria-describedby": `${id}-count`,
      autocomplete: "off",
      spellcheck: "false",
      "main-field": "true",
      enterkeyhint: "search",
    }) as HTMLInputElement;
    this.searchField.name = "search";
    this.searchField.oninput = () => {
      this.commit();
      this.selectNearest();
    };
    this.count = element("span", "find-count", { id: `${id}-count` });
    field.append(this.searchField, this.count);
    const toggle = (label: string, glyph: string) => {
      const button = iconButton("find-toggle", label, glyph);
      button.setAttribute("aria-pressed", "false");
      button.onclick = () => {
        button.setAttribute(
          "aria-pressed",
          String(button.getAttribute("aria-pressed") !== "true"),
        );
        this.commit();
        this.selectNearest();
      };
      return button;
    };
    this.toggles = {
      caseSensitive: toggle("Match case", "case"),
      regexp: toggle("Use regular expression", "regexp"),
      wholeWord: toggle("Match whole word", "word"),
    };
    const options = element("div", "find-options", {
      role: "group",
      "aria-label": "Search options",
    });
    options.append(
      this.toggles.caseSensitive,
      this.toggles.regexp,
      this.toggles.wholeWord,
    );
    const previous = iconButton(
      "find-previous",
      "Previous match (Shift+Enter)",
      "previous",
    );
    previous.onclick = () => findPrevious(view);
    const next = iconButton("find-next", "Next match (Enter)", "next");
    next.onclick = () => findNext(view);
    const all = iconButton("find-all", "Select all matches", "all");
    all.onclick = () => selectMatches(view);
    const close = iconButton("find-close", "Close find (Escape)", "close");
    close.onclick = () => closeSearchPanel(view);
    const navigation = element("div", "find-navigation");
    navigation.append(previous, next, all);
    const tools = element("div", "find-tools");
    tools.append(options, navigation, close);
    main.append(this.disclosure, field, tools);

    this.replaceRow = element("div", "find-row find-replace", {
      id: `${id}-replace`,
    });
    const replaceBox = element("div", "find-field");
    this.replaceField = element("input", "find-input", {
      type: "text",
      placeholder: "Replace",
      "aria-label": "Replace with",
      autocomplete: "off",
      spellcheck: "false",
      enterkeyhint: "done",
    }) as HTMLInputElement;
    this.replaceField.name = "replace";
    this.replaceField.oninput = () => this.commit();
    replaceBox.append(this.replaceField);
    const replace = element("button", "find-text-button find-replace-one", {
      type: "button",
      title: "Replace (Enter)",
    });
    replace.textContent = "Replace";
    replace.onclick = () => replaceNext(view);
    const replaceEvery = element(
      "button",
      "find-text-button find-replace-all",
      {
        type: "button",
        "aria-label": "Replace all",
        title: "Replace all",
      },
    );
    const everyLong = element("span", "find-label-long");
    everyLong.textContent = "Replace all";
    const everyShort = element("span", "find-label-short", {
      "aria-hidden": "true",
    });
    everyShort.textContent = "All";
    replaceEvery.append(everyLong, everyShort);
    replaceEvery.onclick = () => replaceAll(view);
    this.replaceRow.append(replaceBox, replace, replaceEvery);
    this.commands = [previous, next, all, replace, replaceEvery];
    this.dom.append(main, this.replaceRow);
    this.dom.addEventListener("keydown", (event) => this.keydown(event));
    this.setQuery(this.query);
    this.syncAccess();
    this.refreshCount();
  }

  mount() {
    this.searchField.focus();
    this.searchField.select();
  }

  update(update: ViewUpdate) {
    let changed = false;
    for (const tr of update.transactions)
      for (const effect of tr.effects)
        if (effect.is(setSearchQuery)) {
          if (!effect.value.eq(this.query)) this.setQuery(effect.value);
          changed = true;
        }
    if (update.state.readOnly !== update.startState.readOnly) this.syncAccess();
    // Counting rescans the document: coalesce while someone is typing.
    if (update.docChanged) this.schedule(150);
    else if (changed) this.schedule(0);
    else if (update.selectionSet) this.refreshCount();
  }

  destroy() {
    clearTimeout(this.timer);
  }

  private keydown(event: KeyboardEvent) {
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
      // Escape closes the find widget only, not the surrounding workspace.
      if (event.key === "Escape") event.stopPropagation();
      return;
    }
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.target === this.searchField) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    } else if (event.target === this.replaceField) {
      event.preventDefault();
      replaceNext(this.view);
    }
  }

  private commit() {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.pressed("caseSensitive"),
      regexp: this.pressed("regexp"),
      wholeWord: this.pressed("wholeWord"),
      replace: this.replaceField.value,
      test: visibleMatch,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  // Find as you type, from the current selection, like the browser's find bar.
  private selectNearest() {
    const { state } = this.view;
    const query = getSearchQuery(state);
    if (!query.valid) return;
    const { from } = state.selection.main;
    let found = query.getCursor(state, from).next();
    if (found.done) found = query.getCursor(state, 0, from).next();
    if (found.done) return;
    const { from: start, to: end } = found.value;
    const main = state.selection.main;
    if (
      state.selection.ranges.length === 1 &&
      main.from === start &&
      main.to === end
    )
      return;
    this.view.dispatch({
      selection: EditorSelection.single(start, end),
      effects: EditorView.scrollIntoView(EditorSelection.range(start, end), {
        y: "nearest",
      }),
      userEvent: "select.search",
    });
  }

  private pressed(key: keyof FindPanel["toggles"]) {
    return this.toggles[key].getAttribute("aria-pressed") === "true";
  }

  private setQuery(query: SearchQuery) {
    this.query = query;
    if (this.searchField.value !== query.search)
      this.searchField.value = query.search;
    if (this.replaceField.value !== query.replace)
      this.replaceField.value = query.replace;
    this.toggles.caseSensitive.setAttribute(
      "aria-pressed",
      String(query.caseSensitive),
    );
    this.toggles.regexp.setAttribute("aria-pressed", String(query.regexp));
    this.toggles.wholeWord.setAttribute(
      "aria-pressed",
      String(query.wholeWord),
    );
  }

  // Replacing edits the document: only offer it while this user may edit.
  private syncAccess() {
    const writable = !this.view.state.readOnly;
    const open = writable && replaceExpanded;
    this.disclosure.hidden = !writable;
    this.disclosure.setAttribute("aria-expanded", String(open));
    if (!open && this.replaceRow.contains(document.activeElement))
      this.searchField.focus();
    this.replaceRow.hidden = !open;
    this.dom.classList.toggle("with-replace", open);
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refreshCount(), delay);
  }

  private ranges(state: EditorState, query: SearchQuery) {
    if (this.matches?.doc === state.doc && this.matches.query.eq(query))
      return this.matches.ranges;
    const ranges: Range[] = [];
    const cursor = query.getCursor(state);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      ranges.push({ from: next.value.from, to: next.value.to });
      if (ranges.length > countLimit) break;
    }
    this.matches = { doc: state.doc, query, ranges };
    return ranges;
  }

  private refreshCount() {
    clearTimeout(this.timer);
    const { state } = this.view;
    const query = getSearchQuery(state);
    let label = "";
    let total = 0;
    if (query.search && !query.valid) label = "Invalid expression";
    else if (query.valid) {
      const ranges = this.ranges(state, query);
      total = ranges.length;
      const capped = total > countLimit;
      const shown = capped ? `${countLimit}+` : String(total);
      const { from, to } = state.selection.main;
      let low = 0,
        high = Math.min(total, countLimit);
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (ranges[middle].from < from) low = middle + 1;
        else high = middle;
      }
      const current =
        low < total && ranges[low].from === from && ranges[low].to === to
          ? low
          : -1;
      label = !total
        ? "No matches"
        : current >= 0
          ? `${current + 1} of ${shown}`
          : `${shown} ${total === 1 ? "match" : "matches"}`;
    }
    this.count.textContent = label;
    this.count.hidden = !label;
    this.dom.classList.toggle("no-matches", !!query.search && !total);
    // A command that used up the last match must not drop keyboard focus to
    // the page as it disables itself: its row's field keeps it.
    const focused = this.dom.ownerDocument.activeElement;
    if (!total && this.commands.some((command) => command === focused))
      (this.replaceRow.contains(focused)
        ? this.replaceField
        : this.searchField
      ).focus();
    for (const command of this.commands) command.disabled = !total;
  }
}

export function findExtension(): Extension {
  return [
    search({ top: true, createPanel: (view) => new FindPanel(view) }),
    visibleQueries,
  ];
}
