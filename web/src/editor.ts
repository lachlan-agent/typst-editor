/** The CodeMirror instance and the Typst-specific extensions it carries. */

import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippet,
  startCompletion,
  type Completion as CmCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import type { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { vim, Vim } from "@replit/codemirror-vim";

import { ByteMap } from "./offsets";
import type { Completion, Diagnostic, Hover } from "./protocol";
import { typstHighlighting } from "./highlighting";
import type { Keymap } from "./settings";

/**
 * Reconfigurable parts of the editor.
 *
 * Typography is driven by CSS custom properties instead, so changing the font
 * or size needs no reconfiguration at all — only the extensions that add or
 * remove behaviour live in compartments.
 */
const compartments = {
  keymap: new Compartment(),
  lineNumbers: new Compartment(),
  wrap: new Compartment(),
  theme: new Compartment(),
};

/**
 * Vim mode, with its own status line for the current mode and `:` commands.
 *
 * Must sit ahead of every other keymap in the extension list, or the default
 * bindings claim keys like `u` and `d` before vim sees them.
 */
function keymapExtension(mode: Keymap): Extension {
  return mode === "vim" ? vim({ status: true }) : [];
}

/** What the editor needs from the host to answer IDE requests. */
export interface IdeSource {
  /** Completions at a byte offset in the file currently on screen. */
  completions: (
    byteOffset: number,
    explicit: boolean,
  ) => Promise<{ from: number; items: Completion[] }>;
  /** Documentation at a byte offset, or null. */
  hover: (byteOffset: number) => Promise<Hover | null>;
}

export interface EditorConfig {
  lineNumbers: boolean;
  wrap: boolean;
  dark: boolean;
  keymap: Keymap;
}

export interface EditorOptions extends EditorConfig {
  parent: HTMLElement;
  doc: string;
  ide: IdeSource;
  onChange: (text: string) => void;
  /** Fires on cursor movement as well as edits, for the status bar. */
  onSelectionChange: (line: number, column: number) => void;
  keys?: Array<{ key: string; run: () => boolean }>;
  /** `:format` in vim mode (and Shift+Alt+F): tidy the file. */
  onFormat?: () => void;
}

/** Maps Typst completion kinds onto CodeMirror's icon vocabulary. */
function completionType(kind: string): string {
  if (kind.startsWith("symbol:")) return "typst-symbol";
  switch (kind) {
    case "func":
      return "function";
    case "type":
      return "type";
    case "param":
      return "property";
    case "constant":
      return "constant";
    case "label":
      return "typst-label";
    case "path":
      return "typst-path";
    case "package":
      return "typst-package";
    case "font":
      return "typst-font";
    default:
      return "keyword";
  }
}

function toCmCompletion(item: Completion): CmCompletion {
  const insert = item.apply ?? item.label;
  const completion: CmCompletion = {
    label: item.label,
    type: completionType(item.kind),
    // Typst describes insertions with `${...}` placeholders, which is the
    // same syntax CodeMirror snippets use, so they pass straight through.
    apply: insert.includes("${") ? snippet(insert) : insert,
  };

  if (item.kind.startsWith("symbol:")) {
    // The glyph itself is the most useful thing to show for a symbol.
    completion.detail = item.kind.slice("symbol:".length);
  } else if (item.detail) {
    completion.detail = firstLine(item.detail);
  }

  if (item.detail) {
    completion.info = () => {
      const box = document.createElement("div");
      box.className = "completion-docs";
      // textContent, never innerHTML: this text comes from package authors.
      box.textContent = item.detail!;
      return box;
    };
  }

  return completion;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

function completionSource(ide: IdeSource) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const text = context.state.doc.toString();
    const map = new ByteMap(text);
    const result = await ide.completions(
      map.charToByte(context.pos),
      context.explicit,
    );
    if (result.items.length === 0) return null;

    return {
      from: map.byteToChar(result.from),
      options: result.items.map(toCmCompletion),
      // Typst decides what is valid at each position, so let it re-run rather
      // than filtering a stale list against a pattern.
      validFor: undefined,
    };
  };
}

function hoverSource(ide: IdeSource) {
  return hoverTooltip(async (view, pos) => {
    const text = view.state.doc.toString();
    const map = new ByteMap(text);
    const hover = await ide.hover(map.charToByte(pos));
    if (!hover) return null;

    return {
      pos,
      above: true,
      create: () => {
        const box = document.createElement("div");
        box.className = "hover-docs";
        if (hover.kind === "code") {
          const code = document.createElement("pre");
          code.textContent = hover.value;
          box.append(code);
        } else {
          box.textContent = hover.value;
        }
        return { dom: box };
      },
    };
  });
}

/** Extensions shared by every file's state. */
function sharedExtensions(options: EditorOptions): Extension[] {
  return [
    compartments.keymap.of(keymapExtension(options.keymap)),
    compartments.lineNumbers.of(options.lineNumbers ? lineNumbers() : []),
    compartments.wrap.of(options.wrap ? EditorView.lineWrapping : []),
    // Carries no styling of its own — the stylesheet owns every surface — but
    // CodeMirror uses the flag to pick defaults for anything not covered.
    compartments.theme.of(EditorView.theme({}, { dark: options.dark })),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    rectangularSelection(),
    bracketMatching(),
    // Beyond convenience: Typst can only complete arguments inside a *closed*
    // call, so auto-closing the paren is what makes parameter help appear.
    closeBrackets(),
    highlightSelectionMatches(),
    lintGutter(),
    typstHighlighting(),
    autocompletion({
      override: [completionSource(options.ide)],
      icons: false,
      closeOnBlur: false,
    }),
    hoverSource(options.ide),
    keymap.of([
      ...(options.keys ?? []),
      ...closeBracketsKeymap,
      ...completionKeymap,
      { key: "Ctrl-Space", run: startCompletion },
      { key: "Tab", run: acceptCompletion },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        options.onChange(update.state.doc.toString());
      }
      if (update.docChanged || update.selectionSet) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        options.onSelectionChange(line.number, head - line.from + 1);
      }
    }),
  ];
}

/**
 * Creates the view, plus a factory for the states of other files.
 *
 * Each file keeps its own `EditorState`, so switching tabs preserves undo
 * history, selection and scroll position rather than resetting them.
 */
export function createEditor(options: EditorOptions): {
  view: EditorView;
  createState: (doc: string) => EditorState;
} {
  const createState = (doc: string) =>
    EditorState.create({ doc, extensions: sharedExtensions(options) });
  // `:format` (short `:form`), as shader-editor has it; global to the vim
  // extension, but there is exactly one editor.
  if (options.onFormat) Vim.defineEx("format", "form", () => options.onFormat?.());

  return {
    view: new EditorView({ parent: options.parent, state: createState(options.doc) }),
    createState,
  };
}

/**
 * Swaps in another file's state, then reapplies the current configuration.
 *
 * A stored state carries the compartment values it was built with, which may
 * predate a settings change made while another file was on screen.
 */
export function showState(
  view: EditorView,
  state: EditorState,
  config: EditorConfig,
): void {
  view.setState(state);
  configure(view, config);
}

export function configure(view: EditorView, config: EditorConfig): void {
  view.dispatch({
    effects: [
      compartments.keymap.reconfigure(keymapExtension(config.keymap)),
      compartments.lineNumbers.reconfigure(config.lineNumbers ? lineNumbers() : []),
      compartments.wrap.reconfigure(config.wrap ? EditorView.lineWrapping : []),
      compartments.theme.reconfigure(EditorView.theme({}, { dark: config.dark })),
    ],
  });
}

/** Scrolls the editor so the cursor is on screen, e.g. after it was resized. */
export function revealCursor(view: EditorView): void {
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.selection.main.head, {
      y: "nearest",
    }),
  });
}

/**
 * Pushes compiler diagnostics into the editor's lint gutter.
 *
 * Only diagnostics belonging to `path` are shown, and their byte offsets are
 * converted to editor positions. Diagnostics for other files are surfaced in
 * the status bar by `main.ts`, so they aren't silently lost.
 */
export function showDiagnostics(
  view: EditorView,
  path: string,
  diagnostics: Diagnostic[],
): void {
  const text = view.state.doc.toString();
  const map = new ByteMap(text);
  const docLength = view.state.doc.length;

  const converted: CmDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.path !== path) continue;
    if (diagnostic.from === null || diagnostic.to === null) continue;

    let from = Math.min(map.byteToChar(diagnostic.from), docLength);
    // A zero-width span would be invisible, so widen it by one character.
    let to = Math.min(Math.max(map.byteToChar(diagnostic.to), from + 1), docLength);
    if (from >= to) {
      // A span at the very end of the document has nothing after it to
      // underline; anchor it to the last character instead of dropping it.
      if (docLength === 0) continue;
      from = Math.max(0, docLength - 1);
      to = docLength;
    }

    converted.push({
      from,
      to,
      severity: diagnostic.severity,
      message: diagnostic.hints.length
        ? `${diagnostic.message}\n\nhint: ${diagnostic.hints.join("\nhint: ")}`
        : diagnostic.message,
    });
  }

  converted.sort((a, b) => a.from - b.from);
  view.dispatch(setDiagnostics(view.state, converted));
}
