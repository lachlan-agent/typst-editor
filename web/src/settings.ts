/**
 * Editor and view preferences.
 *
 * These live in `localStorage` rather than IndexedDB: they are a few hundred
 * bytes, and reading them synchronously before first paint is what keeps the
 * app from flashing the wrong theme on load.
 */

import { DEFAULT_DARK, DEFAULT_LIGHT, THEMES } from "./theme";
import { copyRect, isRect, type FloatRect, type WindowSpec as SharedWindowSpec } from "../../shared/windows";

export type Leading = "tight" | "normal" | "loose";
export type PreviewFit = "width" | "page" | "actual";
/** How pages sit in a preview: one column, two side by side, two with the first alone (a book), or as many as fit. */
export type PageLayout = "single" | "double" | "book" | "wrap";
export const PAGE_LAYOUTS: Array<[PageLayout, string, string]> = [
  ["single", "Single", "One page per row"],
  ["double", "Two-up", "Two pages side by side"],
  ["book", "Book", "Two-up with the first page alone, as a bound book opens"],
  ["wrap", "Wrap", "As many pages per row as fit"],
];
export const isPageLayout = (v: unknown): v is PageLayout => PAGE_LAYOUTS.some(([l]) => l === v);
export type Keymap = "default" | "vim";

export { copyRect, isRect, type FloatRect };

/** What a window shows. */
export type WindowKind = "preview" | "problems" | "reference";
export const WINDOW_KINDS: Array<[WindowKind, string]> = [
  ["preview", "Preview"],
  ["problems", "Problems"],
  ["reference", "Reference"],
];
export const isWindowKind = (v: unknown): v is WindowKind =>
  WINDOW_KINDS.some(([k]) => k === v);

export type WindowSpec = SharedWindowSpec<WindowKind>;

export const DOCKED_PREVIEW = (): WindowSpec => ({
  kind: "preview",
  docked: true,
  rect: { x: 0, y: 0, w: 0, h: 0 },
});

/** The undocked editor's background: see applyEditorGlass in main.ts. */
export type GlassMode = "solid" | "tint" | "clear" | "glass";
export const GLASS_MODES: Array<[GlassMode, string]> = [
  ["solid", "Solid"],
  ["tint", "Tint"],
  ["clear", "Clear"],
  ["glass", "Glass"],
];
export const isGlassMode = (v: unknown): v is GlassMode =>
  GLASS_MODES.some(([m]) => m === v);
export const MAX_FROST = 40;

export interface Settings {
  /** A theme id, or `"system"` to follow the operating system. */
  theme: string;
  /** Used when `theme` is `"system"`. */
  lightTheme: string;
  darkTheme: string;
  fontFamily: string;
  fontSize: number;
  leading: Leading;
  lineNumbers: boolean;
  wrap: boolean;
  keymap: Keymap;
  /** Whether imported packages may be fetched from packages.typst.org. */
  downloadPackages: boolean;
  previewFit: PreviewFit;
  /** Manual zoom, used when `previewFit` is `"actual"`. */
  previewZoom: number;
  dimPage: boolean;
  pageLayout: PageLayout;
  /** The strip of fit, zoom and layout controls in a preview window's bar, unfolded. */
  previewTools: boolean;

  /** Fraction of the width the editor takes when docked. */
  split: number;
  /** Editor on the right, windows on the left. */
  swapped: boolean;
  /** The editor pane undocked into a floating window, and where it sits. */
  editorFloating: boolean;
  editorRect: FloatRect | null;
  /** The windows: docked ones stack beside the editor, the rest float. */
  windows: WindowSpec[];
  /** The undocked editor's background, its opacity (tint and glass) and blur (glass). */
  editorGlass: GlassMode;
  glassTint: number;
  glassFrost: number;
}

/** The layout fields alone, as a fresh install has them. */
export const DEFAULT_LAYOUT: Pick<
  Settings,
  "split" | "swapped" | "editorFloating" | "editorRect" | "windows"
> = {
  split: 0.46,
  swapped: false,
  editorFloating: false,
  editorRect: null,
  windows: [DOCKED_PREVIEW()],
};

export const FONT_STACKS: Array<{ id: string; name: string; note: string; stack: string }> = [
  {
    id: "dejavu",
    name: "DejaVu Sans Mono",
    note: "Bundled — always available",
    stack: '"DejaVu Sans Mono Web", ui-monospace, monospace',
  },
  {
    id: "system",
    name: "System monospace",
    note: "Whatever your OS uses for code",
    stack: 'ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", monospace',
  },
  {
    id: "jetbrains",
    name: "JetBrains Mono",
    note: "If installed",
    stack: '"JetBrains Mono", "DejaVu Sans Mono Web", monospace',
  },
  {
    id: "plex",
    name: "IBM Plex Mono",
    note: "If installed",
    stack: '"IBM Plex Mono", "DejaVu Sans Mono Web", monospace',
  },
  {
    id: "iosevka",
    name: "Iosevka",
    note: "If installed — narrow, fits more",
    stack: 'Iosevka, "Iosevka Term", "DejaVu Sans Mono Web", monospace',
  },
];

export const LEADING_VALUES: Record<Leading, number> = {
  tight: 1.35,
  normal: 1.6,
  loose: 1.85,
};

// Small enough for a phone to show a useful amount of a line. iOS would zoom
// the page into editor text under 16px on focus; index.html stops that on
// iOS alone, so the size needs no device-specific floor.
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 22;

/** Whether the main pointer is a finger, which usually means no hardware keyboard. */
export function isTouchScreen(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
  );
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  lightTheme: DEFAULT_LIGHT,
  darkTheme: DEFAULT_DARK,
  fontFamily: "dejavu",
  fontSize: 14,
  leading: "normal",
  lineNumbers: true,
  wrap: true,
  keymap: "default",
  downloadPackages: true,
  previewFit: "width",
  previewZoom: 1,
  dimPage: false,
  pageLayout: "single",
  previewTools: false,
  split: 0.46,
  swapped: false,
  editorFloating: false,
  editorRect: null,
  windows: [DOCKED_PREVIEW()],
  editorGlass: "solid",
  glassTint: 0.6,
  glassFrost: 8,
};

const KEY = "typsteditor.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return sanitize({ ...DEFAULT_SETTINGS });
    const stored = JSON.parse(raw) as Partial<Settings>;
    // Merged over the defaults so that settings added in a later version
    // don't leave an older stored object missing keys.
    return sanitize({ ...DEFAULT_SETTINGS, ...stored });
  } catch {
    return sanitize({ ...DEFAULT_SETTINGS });
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota. Preferences are a convenience, so
    // losing them must not interrupt editing.
  }
}

export function sanitize(settings: Settings): Settings {
  const known = FONT_STACKS.some((font) => font.id === settings.fontFamily);
  const knownTheme = (id: unknown) => THEMES.some((theme) => theme.id === id);
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  return {
    ...settings,
    theme: settings.theme === "system" || knownTheme(settings.theme) ? settings.theme : DEFAULT_SETTINGS.theme,
    lightTheme: knownTheme(settings.lightTheme) ? settings.lightTheme : DEFAULT_LIGHT,
    darkTheme: knownTheme(settings.darkTheme) ? settings.darkTheme : DEFAULT_DARK,
    fontFamily: known ? settings.fontFamily : DEFAULT_SETTINGS.fontFamily,
    fontSize: clamp(Math.round(settings.fontSize), MIN_FONT_SIZE, MAX_FONT_SIZE),
    leading: settings.leading in LEADING_VALUES ? settings.leading : DEFAULT_SETTINGS.leading,
    lineNumbers: bool(settings.lineNumbers, DEFAULT_SETTINGS.lineNumbers),
    wrap: bool(settings.wrap, DEFAULT_SETTINGS.wrap),
    keymap: settings.keymap === "vim" ? "vim" : "default",
    downloadPackages: bool(settings.downloadPackages, DEFAULT_SETTINGS.downloadPackages),
    previewFit: settings.previewFit === "page" || settings.previewFit === "actual" ? settings.previewFit : "width",
    previewZoom: clamp(settings.previewZoom, 0.25, 4),
    dimPage: bool(settings.dimPage, DEFAULT_SETTINGS.dimPage),
    pageLayout: isPageLayout(settings.pageLayout) ? settings.pageLayout : "single",
    previewTools: settings.previewTools === true,
    split: clamp(settings.split, 0.15, 0.85),
    swapped: settings.swapped === true,
    editorFloating: settings.editorFloating === true,
    editorRect: isRect(settings.editorRect) ? copyRect(settings.editorRect) : null,
    windows: sanitizeWindows(settings.windows),
    editorGlass: isGlassMode(settings.editorGlass) ? settings.editorGlass : "solid",
    glassTint: clamp(settings.glassTint, 0, 1),
    glassFrost: clamp(Math.round(settings.glassFrost), 0, MAX_FROST),
  };
}


/** Whatever came out of storage, coerced into valid window specs (possibly none). */
function sanitizeWindows(raw: unknown): WindowSpec[] {
  if (!Array.isArray(raw)) return [DOCKED_PREVIEW()];
  const out: WindowSpec[] = [];
  for (const w of raw as Array<Partial<WindowSpec> | null>) {
    if (!w || !isWindowKind(w.kind)) continue;
    out.push({
      kind: w.kind,
      docked: w.docked === true,
      rect: isRect(w.rect) ? copyRect(w.rect) : { x: 0, y: 0, w: 0, h: 0 },
    });
  }
  return out;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), high);
}

export function fontStackFor(id: string): string {
  return (
    FONT_STACKS.find((font) => font.id === id)?.stack ?? FONT_STACKS[0]!.stack
  );
}

/** Pushes the typographic settings onto the document as custom properties. */
export function applyTypography(settings: Settings): void {
  const root = document.documentElement.style;
  root.setProperty("--editor-font", fontStackFor(settings.fontFamily));
  root.setProperty("--editor-size", `${settings.fontSize}px`);
  root.setProperty("--editor-leading", String(LEADING_VALUES[settings.leading]));
}
