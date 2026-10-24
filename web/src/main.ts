/** Wires the editor, the compile worker, the preview and the settings. */

import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import {
  configure,
  createEditor,
  revealCursor,
  showDiagnostics,
  showState,
  type EditorConfig,
} from "./editor";
import { DocumentsPanel } from "./documents-ui";
import { fontUrls } from "./fonts";
import { setTokens } from "./highlighting";
import {
  cleanName,
  fmtBytes,
  loadIdentity,
  loadLibrary,
  newId,
  persistLibrary,
  saveIdentity,
  UNTITLED,
  type DocumentIdentity,
  type LibraryEntry,
  type SavedLayout,
} from "./library";
import { ByteMap } from "./offsets";
import { loadPackage, PackageError } from "./packages";
import { Preview } from "./preview";
import { isTextPath, Project } from "./project";
import type { Diagnostic } from "./protocol";
import { REFERENCE_HTML } from "./reference";
import { Latest, Rpc } from "./rpc";
import {
  applyTypography,
  DEFAULT_LAYOUT,
  isTouchScreen,
  loadSettings,
  PAGE_LAYOUTS,
  sanitize,
  saveSettings,
  WINDOW_KINDS,
  type FloatRect,
  type GlassMode,
  type Settings,
  type WindowKind,
} from "./settings";
import { SettingsPanel } from "./settings-ui";
import { decodeShare, deserializeProject, encodeShare, serializeProject, ShareTooLargeError } from "./share";
import { Store } from "./store";
import { Tabs } from "./tabs";
import { readTar, stripCommonPrefix, type TarEntry } from "./tar";
import { writeTar } from "./tarWrite";
import { addResizeHandles, clearRect, Floater, WindowManager, writeRect, type FloatHost, type Win } from "./windows";
import {
  applyTheme,
  onSystemSchemeChange,
  resolveTheme,
  themeById,
} from "./theme";

/** How long to wait after the last keystroke before recompiling. */
const COMPILE_DEBOUNCE_MS = 200;

/** The longest the wait stretches to on a slow device; see `scheduleCompile`. */
const MAX_COMPILE_DEBOUNCE_MS = 800;

/** A guard against a dependency cycle turning into an endless download loop. */
const MAX_PACKAGE_ROUNDS = 8;

/** Packages that cannot be downloaded, so they are not retried every keystroke. */
const failedPackages = new Set<string>();
/** Packages already complained about, so a toast appears once, not per compile. */
const reportedFailures = new Set<string>();
let announcedDownload = false;

const elements = {
  tabs: requireElement("tabs"),
  editor: requireElement("editor"),
  binaryView: requireElement("binary-view"),
  main: requireElement("main"),
  dock: requireElement("dock"),
  editorPane: requireElement("editor-pane"),
  editorBar: requireElement("editor-bar"),
  editorDock: requireElement<HTMLButtonElement>("editor-dock"),
  editorUndock: requireElement<HTMLButtonElement>("editor-undock"),
  newWindow: requireElement<HTMLButtonElement>("new-window"),
  documentsToggle: requireElement<HTMLButtonElement>("documents-toggle"),
  documentName: requireElement("document-name"),
  documentsPanel: requireElement("documents-panel"),
  divider: requireElement("divider"),
  status: requireElement("status"),
  statusMain: requireElement("status-main"),
  statusPosition: requireElement("status-position"),
  statusPages: requireElement("status-pages"),
  toast: requireElement("toast"),
  panel: requireElement("settings-panel"),
  settingsToggle: requireElement<HTMLButtonElement>("settings-toggle"),
  showSource: requireElement<HTMLButtonElement>("show-source"),
  showPreview: requireElement<HTMLButtonElement>("show-preview"),
};

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

const rpc = new Rpc(
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
);
const compiles = new Latest<void>();
const store = new Store();

let settings: Settings = loadSettings();
let project: Project;
let library: LibraryEntry[] = [];
let identity: DocumentIdentity = loadIdentity();
let view: EditorView | null = null;
let createState: ((doc: string) => EditorState) | null = null;
let compileTimer: ReturnType<typeof setTimeout> | null = null;
/** How long the last compile took in the worker. */
let lastCompileMs = 0;
let ready = false;

/** The file on screen, which is not necessarily the one being compiled. */
let activePath = "";
/** Per-file editor state, so switching tabs keeps undo history and selection. */
const states = new Map<string, EditorState>();
/** The most recent compile's diagnostics, replayed when switching files. */
let lastDiagnostics: Diagnostic[] = [];

/* Windows ------------------------------------------------------------------ */

/**
 * The controls in a preview window's bar: fit, zoom and page layout, folded
 * sideways behind one small toggle so the bar stays quiet. Fit and layout are
 * one setting shared by every preview; zoom is read per window.
 */
function buildPreviewTools(win: Win, readout: HTMLButtonElement): void {
  const strip = document.createElement("span");
  strip.className = "win-strip";

  const toggle = tool(ICON_SLIDERS, "Preview controls: fit, zoom, page layout", () => {
    updateSettings({ previewTools: !settings.previewTools }, false);
  });
  toggle.classList.add("win-strip-toggle");
  toggle.setAttribute("aria-expanded", String(settings.previewTools));

  const body = document.createElement("span");
  body.className = "win-strip-body";
  body.hidden = !settings.previewTools;

  const fit = seg();
  for (const [id, label, title] of [["width", "Width", "Fit the page width"], ["page", "Page", "Fit the whole page"]] as const) {
    const b = tool(label, title, () => updateSettings({ previewFit: id }));
    b.dataset["fit"] = id;
    b.classList.toggle("active", settings.previewFit === id);
    fit.append(b);
  }
  const zoom = seg();
  zoom.append(
    tool("−", "Zoom out", () => zoomBy(0.8)),
    tool("+", "Zoom in", () => zoomBy(1.25)),
  );
  readout.type = "button";
  readout.className = "win-btn win-readout";
  readout.title = "Zoom; click for 100%";
  readout.addEventListener("click", () => {
    eachPreview((p) => p.setZoom(1));
    updateSettings({ previewFit: "actual", previewZoom: 1 });
  });
  const layout = seg();
  for (const [id, name, title] of PAGE_LAYOUTS) {
    const b = tool(LAYOUT_ICONS[id]!, `${name}: ${title}`, () => updateSettings({ pageLayout: id }));
    b.dataset["layout"] = id;
    b.setAttribute("aria-label", name);
    b.classList.toggle("active", id === settings.pageLayout);
    layout.append(b);
  }
  body.append(fit, zoom, readout, layout);
  strip.append(toggle, body);
  win.tools.append(strip);
}

function tool(html: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "win-btn";
  b.title = title;
  b.innerHTML = html;
  b.addEventListener("click", onClick);
  return b;
}

function seg(): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "win-seg";
  return s;
}

function zoomBy(factor: number): void {
  const first = firstPreview();
  const zoom = clamp((first?.zoom ?? settings.previewZoom) * factor, 0.25, 4);
  eachPreview((p) => p.setZoom(zoom));
  updateSettings({ previewFit: "actual", previewZoom: zoom });
}

/** Every preview bar's controls reflect the shared settings. */
function syncPreviewTools(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".win-strip [data-layout]")) {
    b.classList.toggle("active", b.dataset["layout"] === settings.pageLayout);
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>(".win-strip [data-fit]")) {
    b.classList.toggle("active", b.dataset["fit"] === settings.previewFit);
  }
  for (const t of document.querySelectorAll<HTMLButtonElement>(".win-strip-toggle")) {
    t.setAttribute("aria-expanded", String(settings.previewTools));
    t.classList.toggle("active", settings.previewTools);
  }
  for (const body of document.querySelectorAll<HTMLElement>(".win-strip-body")) body.hidden = !settings.previewTools;
}

const ICON_SLIDERS =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M1.5 3h9M1.5 6h9M1.5 9h9"/><circle cx="4" cy="3" r="1.3" fill="var(--paper-sunken)"/><circle cx="8" cy="6" r="1.3" fill="var(--paper-sunken)"/><circle cx="5" cy="9" r="1.3" fill="var(--paper-sunken)"/></svg>';

const LAYOUT_ICONS: Record<string, string> = {
  single: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3.5" y="1.5" width="5" height="9" rx="0.5"/></svg>',
  double: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="1.5" width="4.3" height="9" rx="0.5"/><rect x="6.7" y="1.5" width="4.3" height="9" rx="0.5"/></svg>',
  book: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="6.7" y="1.5" width="4.3" height="4" rx="0.5"/><rect x="1" y="7" width="4.3" height="4" rx="0.5"/><rect x="6.7" y="7" width="4.3" height="4" rx="0.5"/></svg>',
  wrap: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="1.5" width="3" height="4" rx="0.4"/><rect x="4.5" y="1.5" width="3" height="4" rx="0.4"/><rect x="8" y="1.5" width="3" height="4" rx="0.4"/><rect x="1" y="6.5" width="3" height="4" rx="0.4"/><rect x="4.5" y="6.5" width="3" height="4" rx="0.4"/></svg>',
};
// Everything beside the editor is a window (windows.ts): a preview of the
// pages, the problems list, or the reference. Several previews may be open;
// each renders the same pages at its own size.

const stacked = matchMedia("(max-width: 720px)"); // must match styles.css

/** The previews on screen, in window order, each with its own zoom. */
const previews = new Map<Win, Preview>();
let lastPages: string[] = [];
let placeholder: string | null = null;

function eachPreview(fn: (p: Preview) => void): void {
  for (const p of previews.values()) fn(p);
}

function firstPreview(): Preview | null {
  const win = windows.of("preview")[0];
  return win ? (previews.get(win) ?? null) : null;
}

function saveLayout(): void {
  prunePreviews();
  settings.windows = windows.specs;
  saveSettings(settings);
  renderDocumentButton();
}

const floater = new Floater({
  top: () => document.querySelector(".toolbar")!.getBoundingClientRect().bottom,
  bottom: () => document.querySelector(".statusbar")!.getBoundingClientRect().top,
  snapTargets: () => [elements.dock, elements.editorPane],
  onChange: saveLayout,
});

const windows = new WindowManager({
  dock: elements.dock,
  main: elements.main,
  kinds: WINDOW_KINDS,
  floater,
  stacked,
  onChange: saveLayout,
  mount(win) {
    switch (win.spec.kind) {
      case "preview": {
        const container = document.createElement("div");
        container.className = "preview-pane";
        win.body.append(container);
        const readout = document.createElement("button");
        const p = new Preview(container, {
          onZoomChange: (zoom) => {
            readout.textContent = `${Math.round(zoom * 100)}%`;
          },
          onPinchEnd: (zoom) => updateSettings({ previewFit: "actual", previewZoom: zoom }),
        });
        previews.set(win, p);
        p.setLayout(settings.pageLayout);
        p.setFit(settings.previewFit);
        buildPreviewTools(win, readout);
        if (settings.previewFit === "actual") p.setZoom(settings.previewZoom);
        if (lastPages.length) p.render(lastPages);
        else if (placeholder) p.showPlaceholder(placeholder);
        break;
      }
      case "problems": {
        const list = document.createElement("div");
        list.className = "problems";
        win.body.append(list);
        renderProblems();
        break;
      }
      case "reference": {
        const ref = document.createElement("div");
        ref.className = "reference";
        ref.innerHTML = REFERENCE_HTML;
        win.body.append(ref);
        break;
      }
    }
  },
});

// A window that stops being a preview, or closes, drops its Preview; checked
// whenever the layout changes (mount runs before onChange).
function prunePreviews(): void {
  for (const win of [...previews.keys()]) {
    if (!win.el.isConnected || win.spec.kind !== "preview" || !win.body.querySelector(".preview-pane")) {
      previews.get(win)?.dispose();
      previews.delete(win);
    }
  }
}

function openWindow(kind: WindowKind = "preview"): void {
  windows.open(kind);
}

/** The Problems windows: the last compile's diagnostics, click to jump. */
function renderProblems(): void {
  for (const win of windows.of("problems")) {
    const list = win.body.querySelector<HTMLElement>(".problems");
    if (!list) continue;
    list.replaceChildren();
    if (!lastDiagnostics.length) {
      const empty = document.createElement("div");
      empty.className = "problems-empty";
      empty.textContent = ready ? "No problems. The document compiled cleanly." : "Waiting for the compiler…";
      list.append(empty);
      continue;
    }
    for (const d of lastDiagnostics) {
      const row = document.createElement("div");
      row.className = "problem";
      row.dataset["severity"] = d.severity;
      const where = document.createElement("span");
      where.className = "problem-where";
      where.textContent = d.path ? `${d.path.slice(d.path.lastIndexOf("/") + 1)}${lineOf(d)}` : d.severity;
      const message = document.createElement("div");
      message.className = "problem-message";
      message.textContent = d.message;
      for (const hint of d.hints) {
        const h = document.createElement("div");
        h.className = "problem-hint";
        h.textContent = `hint: ${hint}`;
        message.append(h);
      }
      row.append(where, message);
      if (d.path && d.from !== null) row.addEventListener("click", () => jumpTo(d.path!, d.from!));
      list.append(row);
    }
  }
}

function lineOf(d: Diagnostic): string {
  if (!d.path || d.from === null) return "";
  const text = project.text(d.path);
  if (text === undefined) return "";
  const line = text.slice(0, new ByteMap(text).byteToChar(d.from)).split("\n").length;
  return `:${line}`;
}

/** Opens a file and puts the cursor at a byte offset. */
function jumpTo(path: string, byteOffset: number): void {
  if (!project.has(path) || !isTextPath(path)) return;
  openFile(path);
  if (!view) return;
  const text = view.state.doc.toString();
  const at = Math.min(new ByteMap(text).byteToChar(byteOffset), text.length);
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
  view.focus();
}

// The editor pane undocks into a floating window with the same gestures.
const EDITOR_MIN_W = 280;
const EDITOR_MIN_H = 160;

function defaultEditorRect(): FloatRect {
  const a = floater.area();
  const w = Math.round(Math.min(Math.max(a.w * 0.45, EDITOR_MIN_W), 820));
  const h = Math.round(Math.min(Math.max(a.h * 0.85, EDITOR_MIN_H), 900));
  return { x: a.x + 8, y: a.y + 8, w, h };
}

const editorHost: FloatHost = {
  el: elements.editorPane,
  bar: elements.editorBar,
  minW: EDITOR_MIN_W,
  minH: EDITOR_MIN_H,
  rect: () => settings.editorRect ?? defaultEditorRect(),
  setRect(r) {
    settings.editorRect = r;
    writeRect(elements.editorPane, r);
  },
};

function applyEditorFloating(on: boolean, animate = false): void {
  settings.editorFloating = on;
  renderEditorFloating(animate);
}

/** Whether the editor pane floats right now: the preference, unless the screen is too narrow. */
function editorFloats(): boolean {
  return settings.editorFloating && !stacked.matches;
}

/**
 * Puts the pane where the preference says. Narrow screens stack everything,
 * but that is an override on the DOM alone: the preference survives the
 * resize and comes back when the window widens again.
 */
function renderEditorFloating(animate = false): void {
  const on = editorFloats();
  elements.editorPane.classList.toggle("floating", on);
  elements.editorPane.classList.toggle("pop", on && animate);
  elements.main.classList.toggle("editor-floating", on);
  if (on) {
    editorHost.setRect(floater.clamp(editorHost.rect(), EDITOR_MIN_W, EDITOR_MIN_H));
    floater.raise(elements.editorPane);
  } else {
    clearRect(elements.editorPane);
  }
}

/** Only the backgrounds change (styles.css keys off these); the pane is opaque while docked. */
function applyEditorGlass(mode: GlassMode, tint: number, frost: number): void {
  const root = document.documentElement.style;
  root.setProperty("--glass-a", String(mode === "clear" ? 0 : tint));
  root.setProperty("--glass-blur", `${frost}px`);
  elements.editorPane.classList.toggle("glass", mode !== "solid");
  elements.editorPane.classList.toggle("glass-frost", mode === "glass");
}

function setupFloatingEditor(): void {
  elements.editorUndock.addEventListener("click", () => {
    applyEditorFloating(true, true);
    saveSettings(settings);
  });
  elements.editorDock.addEventListener("click", () => {
    applyEditorFloating(false);
    saveSettings(settings);
  });
  elements.editorBar.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    applyEditorFloating(false);
    saveSettings(settings);
  });
  elements.editorPane.addEventListener("animationend", () => elements.editorPane.classList.remove("pop"));
  elements.editorPane.addEventListener("pointerdown", () => editorFloats() && floater.raise(elements.editorPane), true);
  floater.attach(editorHost, addResizeHandles(elements.editorPane));
  window.addEventListener("resize", () => {
    if (floater.dragging || !editorFloats()) return;
    editorHost.setRect(floater.clamp(editorHost.rect(), EDITOR_MIN_W, EDITOR_MIN_H));
  });
  stacked.addEventListener("change", () => {
    if (settings.editorFloating) renderEditorFloating();
    elements.editorUndock.disabled = stacked.matches;
  });
  elements.editorUndock.disabled = stacked.matches;
}

/** The layout fields of a settings object. */
function layoutOf(s: Settings): SavedLayout {
  return { split: s.split, swapped: s.swapped, editorFloating: s.editorFloating, editorRect: s.editorRect, windows: s.windows };
}

/** A document's saved window arrangement, onto the screen. */
function applyLayout(layout: SavedLayout): void {
  updateSettings(structuredClone(layout));
  applyEditorFloating(settings.editorFloating);
  windows.load(settings.windows);
}

function resetLayout(): void {
  applyLayout(structuredClone(DEFAULT_LAYOUT));
}

const panel = new SettingsPanel({
  container: elements.panel,
  get: () => settings,
  update: (patch, rerender) => updateSettings(patch, rerender),
  newWindow: (kind) => openWindow(kind),
  resetLayout,
  format: () => void formatFile(),
});
panel.onToggle = (open) => {
  elements.settingsToggle.setAttribute("aria-expanded", String(open));
  if (open) documents.close();
};

const documents = new DocumentsPanel({
  container: elements.documentsPanel,
  current: () => ({ name: identity.name, libId: identity.libId, dirty: documentDirty() }),
  library: () => library,
  rename(name) {
    identity.name = cleanName(name);
    saveIdentity(identity);
    renderDocumentButton();
  },
  save: (asCopy) => void saveToLibrary(asCopy),
  fresh: () => void newDocument(),
  open(entry) {
    if (entry.id === identity.libId && !documentDirty()) {
      documents.close();
      return;
    }
    if (!confirmDiscard()) return;
    void openDocument(deserializeProject(entry.project), entry.name, entry.id, entry.layout);
    documents.close();
  },
  renameEntry(entry, name) {
    entry.name = cleanName(name);
    if (entry.id === identity.libId) identity.name = entry.name;
    void persistLibrary(library);
    saveIdentity(identity);
    documents.render();
    renderDocumentButton();
  },
  deleteEntry(entry) {
    library = library.filter((e) => e !== entry);
    if (entry.id === identity.libId) identity.libId = null; // the working copy lives on, unsaved
    void persistLibrary(library);
    saveIdentity(identity);
    rebaseline();
    documents.render();
    renderDocumentButton();
  },
  exportProject,
  importFile: (file) => void importFile(file),
  exportPdf: () => void exportPdf(),
  copyLink: () => void copyShareLink(),
});
documents.onToggle = (open) => {
  elements.documentsToggle.setAttribute("aria-expanded", String(open));
  if (open) panel.close();
};

const tabs = new Tabs(elements.tabs, {
  onSelect: (path) => openFile(path),
  onClose: (path) => deleteFile(path),
  onRename: (path) => renameFile(path),
  onSetMain: (path) => setMain(path),
  onCreate: () => createFile(),
  onReorder: (path, before) => {
    if (!project.move(path, before)) return;
    store.save(project);
    tabs.render(project, activePath);
    renderDocumentButton();
  },
});

/**
 * Files written since the worker last saw them.
 *
 * A shared or restored project can carry chapters and images alongside the
 * document being edited, and those must reach the engine too — but resending
 * every asset on every keystroke would be wasteful, so only what changed is
 * sent.
 */
let dirty = new Set<string>();

/** Pushes pending file writes to the worker. */
async function syncFiles(): Promise<void> {
  if (dirty.size === 0) return;

  const files = [...dirty]
    .filter((path) => project.has(path))
    .map((path) => {
      const text = project.text(path);
      return text !== undefined
        ? { path, text }
        : { path, bytes: project.bytes(path)! };
    });
  const removed = [...dirty].filter((path) => !project.has(path));
  const sent = dirty;
  dirty = new Set();

  try {
    await rpc.send({ kind: "write", files, removed, main: project.main });
  } catch (error) {
    // Put the writes back, or the engine would keep compiling stale text for
    // the rest of the session.
    for (const path of sent) dirty.add(path);
    throw error;
  }
}

/* Files and tabs ----------------------------------------------------------- */

function editorConfig(): EditorConfig {
  const theme = resolveTheme(
    settings.theme,
    settings.lightTheme,
    settings.darkTheme,
  );
  return {
    lineNumbers: settings.lineNumbers,
    wrap: settings.wrap,
    keymap: settings.keymap,
    dark: theme.kind === "dark",
  };
}

function openFile(path: string): void {
  if (!project.has(path) || path === activePath) return;
  if (view && activePath && isTextPath(activePath)) {
    states.set(activePath, view.state);
  }
  activePath = path;
  showActiveFile();
}

/** Puts the active file on screen — the editor, or a card for a binary file. */
function showActiveFile(): void {
  const text = isTextPath(activePath) ? project.text(activePath) : undefined;
  const isText = text !== undefined;

  elements.editor.hidden = !isText;
  elements.binaryView.hidden = isText;

  if (isText && view && createState) {
    const state = states.get(activePath) ?? createState(text);
    states.set(activePath, state);
    showState(view, state, editorConfig());
    // On a touch screen focus raises the keyboard, which should wait until
    // the user taps into the text rather than cover the file just opened.
    if (!isTouchScreen()) view.focus();
    showDiagnostics(view, activePath, lastDiagnostics);
    void refreshHighlighting();
  } else if (!isText) {
    renderBinaryView();
  }

  tabs.render(project, activePath);
  updateStatusMain();
}

function renderBinaryView(): void {
  const bytes = project.bytes(activePath);
  elements.binaryView.replaceChildren();
  if (!bytes) return;

  const card = document.createElement("div");
  card.className = "binary-card";

  const name = document.createElement("p");
  name.className = "binary-name";
  name.textContent = activePath;
  card.append(name);

  const size = document.createElement("p");
  size.className = "binary-size";
  size.textContent = `${formatBytes(bytes.length)} · not editable here`;
  card.append(size);

  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(activePath)) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const image = document.createElement("img");
    image.className = "binary-preview";
    image.src = url;
    image.alt = activePath;
    // Released once the browser has decoded it, so switching tabs repeatedly
    // does not leak a blob per visit.
    image.addEventListener("load", () => URL.revokeObjectURL(url));
    image.addEventListener("error", () => URL.revokeObjectURL(url));
    card.append(image);
  }

  const hint = document.createElement("p");
  hint.className = "binary-hint";
  hint.textContent = `Reference it from your document as #image("${activePath}")`;
  card.append(hint);

  elements.binaryView.append(card);
}

function formatBytes(count: number): string {
  if (count < 1024) return `${count} bytes`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} kB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

/** Normalizes and checks a file name typed by the user. */
function validateName(raw: string, existing: Project): string | null {
  let path = raw.trim();
  if (!path) return null;
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.endsWith("/")) {
    toast("A file name cannot end with a slash.");
    return null;
  }
  if (!/^[\w./-]+$/.test(path)) {
    toast("Use letters, digits, dots, dashes and slashes in file names.");
    return null;
  }
  if (existing.has(path)) {
    toast(`${path} already exists.`);
    return null;
  }
  return path;
}

function createFile(): void {
  const raw = prompt("New file name", "/chapter.typ");
  if (raw === null) return;
  const path = validateName(raw, project);
  if (!path) return;

  project.writeText(path, "");
  dirty.add(path);
  store.save(project);
  openFileAfterChange(path);
}

function renameFile(path: string): void {
  const raw = prompt("Rename file", path);
  if (raw === null) return;
  // Accepting the name as it is asks for nothing, so it must not be refused
  // as "already exists".
  const kept = raw.trim();
  if (kept === path || `/${kept}` === path) return;
  const target = validateName(raw, project);
  if (!target || target === path) return;

  if (view && activePath === path) states.set(path, view.state);
  const state = states.get(path);
  if (!project.rename(path, target)) {
    toast(`Could not rename ${path}.`);
    return;
  }

  states.delete(path);
  if (state) states.set(target, state);
  // The old path must be removed from the engine, or a stale copy keeps
  // satisfying imports that should now fail.
  dirty.add(path);
  dirty.add(target);
  store.save(project);
  openFileAfterChange(activePath === path ? target : activePath);
}

function deleteFile(path: string): void {
  if (path === project.main) {
    toast("The main file cannot be deleted. Make another file main first.");
    return;
  }
  if (!confirm(`Delete ${path}? This cannot be undone.`)) return;

  project.delete(path);
  states.delete(path);
  dirty.add(path);
  store.save(project);
  openFileAfterChange(activePath === path ? project.main : activePath);
}

function setMain(path: string): void {
  if (!isTextPath(path)) {
    toast("Only a Typst file can be the main file.");
    return;
  }
  project.main = path;
  // `main` travels with the write, so something must be pending for it to
  // reach the engine.
  dirty.add(path);
  store.save(project);
  tabs.render(project, activePath);
  updateStatusMain();
  scheduleCompile();
}

/** Re-opens `path` after the file list changed, and recompiles. */
function openFileAfterChange(path: string): void {
  // The active file may be about to leave the screen (or be re-shown from its
  // saved state), so its live edits have to be captured first, as openFile does.
  if (view && activePath && isTextPath(activePath) && project.has(activePath)) {
    states.set(activePath, view.state);
  }
  activePath = project.has(path) ? path : project.main;
  showActiveFile();
  scheduleCompile();
}

function updateStatusMain(): void {
  elements.statusMain.textContent =
    activePath === project.main ? "" : `compiling ${project.main}`;
}

/* Settings ----------------------------------------------------------------- */

function updateSettings(patch: Partial<Settings>, rerender = true): void {
  const previous = settings;
  settings = sanitize({ ...settings, ...patch });

  // Picking a theme also makes it the one "Match system" reaches for at that
  // time of day, so the automatic pair is whatever the user last chose rather
  // than a fixed default they never asked for.
  if (patch.theme && patch.theme !== "system") {
    const chosen = themeById(patch.theme);
    if (chosen.kind === "light") settings.lightTheme = chosen.id;
    else settings.darkTheme = chosen.id;
  }

  saveSettings(settings);
  applySettings(previous);
  if (rerender) panel.render();
}

/** Applies whatever changed, touching the editor only when it has to. */
function applySettings(previous?: Settings): void {
  const theme = resolveTheme(
    settings.theme,
    settings.lightTheme,
    settings.darkTheme,
  );
  applyTheme(theme);
  applyTypography(settings);

  document.body.classList.toggle("dim-page", settings.dimPage);

  // Reconfiguring is cheap and idempotent, so there is no point working out
  // which of the four compartments actually changed.
  if (view) configure(view, editorConfig());

  if (previous?.previewFit !== settings.previewFit) {
    eachPreview((p) => p.setFit(settings.previewFit));
  }
  if (previous?.pageLayout !== settings.pageLayout) {
    eachPreview((p) => p.setLayout(settings.pageLayout));
  }
  syncPreviewTools();
  elements.main.style.setProperty("--split", String(settings.split));
  elements.main.classList.toggle("swapped", settings.swapped);
  applyEditorGlass(settings.editorGlass, settings.glassTint, settings.glassFrost);
}

/* Status bar --------------------------------------------------------------- */

function setStatus(
  text: string,
  kind: "info" | "error" | "working" = "info",
): void {
  elements.status.textContent = text;
  elements.status.dataset["kind"] = kind;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(message: string): void {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 4_500);
}

/* Project loading ---------------------------------------------------------- */

/** Loads the project to open: a shared link, the last session, or the starter. */
async function resolveProject(): Promise<Project> {
  const fragment = location.hash.slice(1);
  const saved = await store.load();

  if (fragment) {
    try {
      const shared = await decodeShare(fragment);
      // Replacing unsaved local work without asking would lose it silently.
      if (
        !saved ||
        confirm(
          "Open the shared document? Your current document will be replaced.",
        )
      ) {
        history.replaceState(null, "", location.pathname + location.search);
        return shared;
      }
    } catch (error) {
      toast(`Could not open the shared link: ${describe(error)}`);
    }
    history.replaceState(null, "", location.pathname + location.search);
  }

  if (saved) return saved;

  const starter = await rpc.send({ kind: "starter" });
  const fresh = new Project(starter.path);
  fresh.writeText(starter.path, starter.text);
  return fresh;
}

/* Compiling ---------------------------------------------------------------- */

function scheduleCompile(): void {
  if (compileTimer !== null) clearTimeout(compileTimer);
  // On a slow phone a compile can outlast the pause between two words, and
  // compiling in every such pause keeps the worker busy and the preview
  // repainting under the typing. Waiting about as long as a compile takes
  // keeps that in proportion; on a fast machine this stays at the minimum.
  const delay = clamp(
    lastCompileMs,
    COMPILE_DEBOUNCE_MS,
    MAX_COMPILE_DEBOUNCE_MS,
  );
  compileTimer = setTimeout(() => {
    void compile();
  }, delay);
}

async function compile(): Promise<void> {
  if (!ready) return;
  try {
    await runCompile();
  } catch (error) {
    setStatus(`Compile failed: ${describe(error)}`, "error");
  }
}

/**
 * Downloads any packages the document imports, then any packages *those*
 * import, until nothing new appears.
 *
 * The compiler cannot fetch mid-compile — `World` is synchronous — so this
 * has to settle before compiling. Failures are reported and then tolerated:
 * the compile still runs and blames the import site, which is a better place
 * to see the problem than a toast.
 */
async function resolvePackages(): Promise<void> {
  if (!settings.downloadPackages) return;

  for (let round = 0; round < MAX_PACKAGE_ROUNDS; round++) {
    const missing = (await rpc.send({ kind: "missingPackages" })).filter(
      (spec) => !failedPackages.has(spec),
    );
    if (missing.length === 0) return;

    setStatus(
      missing.length === 1
        ? `Downloading ${missing[0]}…`
        : `Downloading ${missing.length} packages…`,
      "working",
    );

    const results = await Promise.allSettled(
      missing.map(async (spec) => {
        const files = await loadPackage(spec, {
          onDownload: () => announceFirstDownload(),
        });
        await rpc.send({ kind: "addPackage", spec, files });
      }),
    );

    let progressed = false;
    for (const [index, result] of results.entries()) {
      const spec = missing[index]!;
      if (result.status === "fulfilled") {
        progressed = true;
        continue;
      }

      const error = result.reason;
      // A package that does not exist will never appear, so stop asking.
      // Being offline might pass, so leave it to be retried next compile.
      if (!(error instanceof PackageError) || !error.retryable) {
        failedPackages.add(spec);
      }
      // Reported once per package, or every keystroke would raise a toast.
      if (!reportedFailures.has(spec)) {
        reportedFailures.add(spec);
        toast(describe(error));
      }
    }

    // Every package in this round failed, so another round would ask for the
    // same ones and get the same answers.
    if (!progressed) return;
  }

  toast(
    "Stopped resolving packages after too many rounds. There may be a dependency cycle.",
  );
}

/** Told once per session, the first time anything is actually downloaded. */
function announceFirstDownload(): void {
  if (announcedDownload) return;
  announcedDownload = true;
  toast(
    "Downloading a package from packages.typst.org. Only its name and version are sent — your document stays on this machine.",
  );
}

async function runCompile(): Promise<void> {
  await compiles.run(async () => {
    await syncFiles();
    await resolvePackages();

    const result = await rpc.send({ kind: "compileSvg" });
    lastCompileMs = result.elapsedMs;

    // Keep the previous preview on failure: a half-typed function shouldn't
    // blank the page you are looking at.
    if (result.pages.length > 0) {
      lastPages = result.pages;
      placeholder = null;
      eachPreview((p) => p.render(result.pages));
    } else if (lastPages.length === 0) {
      placeholder = "Nothing to show yet. Fix the errors in the source and the page will appear here.";
      eachPreview((p) => p.showPlaceholder(placeholder!));
    }

    lastDiagnostics = result.diagnostics;
    renderProblems();
    if (view && isTextPath(activePath)) {
      showDiagnostics(view, activePath, result.diagnostics);
    }
    await refreshHighlighting();
    reportDiagnostics(result.diagnostics, result.elapsedMs);
  });
}

/** Re-colours the file on screen using Typst's own parser. */
async function refreshHighlighting(): Promise<void> {
  if (!ready || !view || !isTextPath(activePath)) return;
  const path = activePath;
  const compiled = project.text(path) ?? "";
  const tokens = await rpc.send({ kind: "highlight", path });
  if (!view) return;
  // A tab switch while the worker answered: these tokens belong to a file no
  // longer on screen, and the one that is needs its own.
  if (activePath !== path) {
    void refreshHighlighting();
    return;
  }
  // Token offsets must be resolved against the text the worker saw, not
  // against whatever has been typed since.
  view.dispatch({ effects: setTokens.of({ tokens, text: compiled }) });
}

function reportDiagnostics(diagnostics: Diagnostic[], elapsedMs: number): void {
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.length - errors.length;

  const pages = lastPages.length;
  elements.statusPages.textContent = pages
    ? `${pages} ${pages === 1 ? "page" : "pages"} · ${Math.round(elapsedMs)} ms`
    : "";

  if (errors.length > 0) {
    // An error with no span never reaches the gutter, so name one here rather
    // than leaving a bare count and nowhere to look. An error in another file
    // says which, since its squiggle is on a tab you cannot see.
    const first = errors.find((d) => d.from === null) ?? errors[0]!;
    const count = errors.length === 1 ? "1 error" : `${errors.length} errors`;
    const where =
      first.path && first.path !== activePath ? ` in ${first.path}` : "";
    setStatus(`${count}${where} · ${first.message}`, "error");
    return;
  }

  if (warnings > 0) {
    const first = diagnostics.find((d) => d.severity === "warning")!;
    const count = warnings === 1 ? "1 warning" : `${warnings} warnings`;
    setStatus(`${count} · ${first.message}`);
    return;
  }

  setStatus("Ready");
}

/* Actions ------------------------------------------------------------------ */

/** A second click while a PDF is already compiling would queue another. */
let exporting = false;

async function exportPdf(): Promise<void> {
  if (!ready || exporting) return;
  exporting = true;
  try {
    await syncFiles();
    await resolvePackages();
    const result = await rpc.send({ kind: "compilePdf" });
    if (!result.data) {
      toast("The document has errors, so it could not be exported.");
      return;
    }

    saveBlob(new Blob([result.data as BlobPart], { type: "application/pdf" }), filenameFor(project.main));
  } catch (error) {
    toast(`Export failed: ${describe(error)}`);
  } finally {
    exporting = false;
  }
}

function filenameFor(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.typ$/i, "") + ".pdf";
}

async function copyShareLink(): Promise<void> {
  try {
    const fragment = await encodeShare(project);
    const url = `${location.origin}${location.pathname}#${fragment}`;
    await navigator.clipboard.writeText(url);
    toast("Link copied. The document travels inside the link itself.");
  } catch (error) {
    if (error instanceof ShareTooLargeError) {
      toast(
        "This document is too large to fit in a link. Export it as a PDF instead.",
      );
    } else {
      toast(`Could not copy the link: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* Documents ---------------------------------------------------------------- */
// The working project autosaves (store.ts). The library keeps named snapshots
// of it — every file plus the window layout — as shader-editor's shader list
// does; export/import move it as a file; a link carries it in the fragment.

function libraryEntry(): LibraryEntry | null {
  return identity.libId ? (library.find((e) => e.id === identity.libId) ?? null) : null;
}

/**
 * The files as they were when the document was last opened or saved (or, for
 * one never saved, the starter), held by reference so that `documentDirty`
 * can answer per keystroke without serialising every image again.
 */
interface Snapshot {
  main: string;
  files: Map<string, Uint8Array>;
}

let baseline: Snapshot | null = null;
let starterSnapshot: Snapshot | null = null;

function snapshotOf(p: Project): Snapshot {
  return { main: p.main, files: new Map(p.entries()) };
}

/** Points the baseline at the library entry the document now belongs to, or the starter. */
function rebaseline(): void {
  const entry = libraryEntry();
  if (!entry) {
    baseline = starterSnapshot;
    return;
  }
  try {
    baseline = snapshotOf(deserializeProject(entry.project));
  } catch {
    baseline = null;
  }
}

/** Does the working project differ from the entry it was opened from (or, unsaved, from the starter)? */
function documentDirty(): boolean {
  if (!project) return false;
  const entry = libraryEntry();
  if (entry && entry.name !== identity.name) return true;
  return baseline !== null && !sameProject(project, baseline);
}

function sameProject(p: Project, s: Snapshot): boolean {
  if (p.main !== s.main || p.size !== s.files.size) return false;
  const paths = p.paths();
  const basePaths = [...s.files.keys()];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    // Order counts: it is the tab order, and it travels with the document.
    if (path !== basePaths[i]) return false;
    const a = p.bytes(path)!;
    const b = s.files.get(path)!;
    // Untouched files still hold the very array the snapshot does, so only
    // the file being typed in is compared byte by byte. A file found equal is
    // re-pointed at the live array, so the next check is a reference test.
    if (a !== b) {
      if (!sameBytes(a, b)) return false;
      s.files.set(path, a);
    }
  }
  return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function renderDocumentButton(): void {
  elements.documentName.textContent = identity.name;
  elements.documentsToggle.classList.toggle("dirty", documentDirty());
}

/** Save the working project into the library, under its own entry or a new one. */
async function saveToLibrary(asCopy: boolean): Promise<void> {
  let name = identity.name;
  // A copy always gets its own name; a first save of something still called
  // "Untitled" deserves a real one.
  if (asCopy || (!libraryEntry() && name === UNTITLED)) {
    const typed = prompt(asCopy ? "Name the copy" : "Name this document", asCopy && name !== UNTITLED ? `${name} copy` : name);
    if (typed === null) return;
    name = cleanName(typed);
  }
  const bytes = serializeProject(project);
  const existing = asCopy ? null : libraryEntry();
  const entry: LibraryEntry = {
    id: existing?.id ?? newId(),
    name,
    updated: Date.now(),
    project: bytes,
    layout: structuredClone(layoutOf(settings)),
    files: project.size,
    bytes: bytes.length,
  };
  // Commit to memory only once storage has taken it, so the two never disagree.
  const before = library;
  library = existing ? library.map((e) => (e === existing ? entry : e)) : [entry, ...library];
  if (!(await persistLibrary(library))) {
    library = before;
    toast("Could not save: this browser's storage is full or blocked.");
    return;
  }
  identity = { name, libId: entry.id };
  saveIdentity(identity);
  baseline = snapshotOf(project);
  documents.render();
  renderDocumentButton();
  toast(`Saved "${name}" (${fmtBytes(bytes.length)}).`);
}

/** Replace the working project: files, editor states, layout. */
async function openDocument(next: Project, name: string, libId: string | null, layout?: SavedLayout): Promise<void> {
  // Every path of the old project must leave the engine, or stale files keep
  // satisfying imports.
  const removed = project.paths();
  project = next;
  states.clear();
  dirty = new Set([...removed, ...project.paths()]);
  identity = { name, libId };
  saveIdentity(identity);
  baseline = libId ? snapshotOf(project) : starterSnapshot;
  store.save(project);
  activePath = "";
  lastDiagnostics = [];
  openFile(project.main);
  if (layout) applyLayout(layout);
  renderDocumentButton();
  documents.render();
  await compile();
}

async function newDocument(): Promise<void> {
  if (!confirmDiscard()) return;
  const starter = await rpc.send({ kind: "starter" });
  const fresh = new Project(starter.path);
  fresh.writeText(starter.path, starter.text);
  await openDocument(fresh, UNTITLED, null);
  documents.close();
}

/** Ask before throwing away unsaved work; true means go ahead. */
function confirmDiscard(): boolean {
  if (!documentDirty()) return true;
  const entry = libraryEntry();
  const what = entry ? `unsaved changes to "${entry.name}"` : `the unsaved document "${identity.name}"`;
  return confirm(`Discard ${what}?`);
}

function fileStem(): string {
  const base = identity.name !== UNTITLED ? identity.name : project.main.slice(project.main.lastIndexOf("/") + 1).replace(/\.typ$/i, "");
  return base.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "document";
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One file downloads as itself; a project downloads as a .tar of every file. */
function exportProject(): void {
  const paths = project.paths();
  if (paths.length === 1 && isTextPath(paths[0]!)) {
    saveBlob(new Blob([project.text(paths[0]!) ?? ""], { type: "text/plain" }), `${fileStem()}.typ`);
    return;
  }
  const archive = writeTar(paths.map((path) => ({ path: path.replace(/^\/+/, ""), data: project.bytes(path)! })));
  saveBlob(new Blob([archive as BlobPart], { type: "application/x-tar" }), `${fileStem()}.tar`);
  toast(`Exported ${paths.length} files. The main file is ${project.main}.`);
}

/** A .typ becomes a one-file project; a .tar is read back whole. */
async function importFile(file: File): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let next: Project;
    if (/\.tar$/i.test(file.name)) {
      const entries = unwrapPackage(readTar(bytes).filter((e) => e.name && !e.name.endsWith("/")));
      if (!entries.length) throw new Error("the archive holds no files");
      const mainEntry = entries.find((e) => /(^|\/)main\.typ$/.test(e.name)) ?? entries.find((e) => /\.typ$/i.test(e.name));
      if (!mainEntry) throw new Error("the archive holds no .typ file");
      next = new Project(`/${mainEntry.name}`);
      for (const e of entries) next.writeBytes(`/${e.name}`, e.data);
    } else {
      const path = `/${file.name.replace(/[^\w./-]+/g, "-")}`;
      if (/\.typ$/i.test(path)) {
        next = new Project(path);
      } else {
        // Only a Typst file can be main, so anything else arrives beside the
        // starter document rather than in its place.
        const starter = await rpc.send({ kind: "starter" });
        next = new Project(starter.path);
        next.writeText(starter.path, starter.text);
      }
      if (isTextPath(path)) next.writeText(path, new TextDecoder().decode(bytes));
      else next.writeBytes(path, bytes);
    }
    if (!confirmDiscard()) return;
    await openDocument(next, cleanName(file.name.replace(/\.[^.]+$/, "")), null);
    documents.close();
    toast(`Imported ${file.name}.`);
  } catch (error) {
    toast(`Could not import ${file.name}: ${describe(error)}`);
  }
}

/**
 * A package archive wraps its files in one directory, which has to come off
 * for `typst.toml` to sit at the root. A project exported from here (or any
 * archive without a manifest) keeps its paths exactly: a project whose files
 * all live in one folder must import with its absolute `#include` and
 * `#image` paths intact.
 */
function unwrapPackage(entries: TarEntry[]): TarEntry[] {
  const tops = new Set(entries.map((e) => e.name.split("/")[0]!));
  if (tops.size !== 1 || entries.some((e) => !e.name.includes("/"))) return entries;
  const [top] = tops;
  return entries.some((e) => e.name === `${top}/typst.toml`) ? stripCommonPrefix(entries) : entries;
}

/** Formats the file on screen with typstyle; a syntax error is reported, not formatted. */
async function formatFile(): Promise<void> {
  if (!ready || !view || !isTextPath(activePath)) return;
  const path = activePath;
  const startDoc = view.state.doc;
  const source = startDoc.toString();
  try {
    const formatted = await rpc.send({ kind: "format", text: source, maxWidth: 80, tabSpaces: 2 });
    // The user may have typed or switched file while the formatter ran; the
    // result then describes a document that is no longer on screen.
    if (!view || activePath !== path || !view.state.doc.eq(startDoc)) {
      toast("Format: the file changed while formatting; try again.");
      return;
    }
    if (formatted === source) {
      toast("Already formatted.");
      return;
    }
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head).number;
    view.dispatch({ changes: { from: 0, to: source.length, insert: formatted }, userEvent: "format" });
    // Keep the cursor on the same line number, clamped.
    const target = view.state.doc.line(Math.min(line, view.state.doc.lines));
    view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
  } catch (error) {
    toast(`Format: ${describe(error)}`);
  }
}

/* Layout ------------------------------------------------------------------- */

/** Drag-to-resize between the two panes, also operable from the keyboard. */
function setupDivider(): void {
  const panes = elements.divider.parentElement!;
  let dragging = false;

  let split = settings.split;
  const setSplit = (fraction: number) => {
    split = clamp(fraction, 0.15, 0.85);
    panes.style.setProperty("--split", String(split));
  };
  const currentSplit = () => settings.split;

  elements.divider.addEventListener("pointerdown", (event) => {
    dragging = true;
    elements.divider.setPointerCapture(event.pointerId);
    elements.divider.classList.add("dragging");
    document.body.classList.add("resizing");
  });
  elements.divider.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const bounds = panes.getBoundingClientRect();
    const frac = (event.clientX - bounds.left) / bounds.width;
    // Swapped, the editor sits after the divider, so it takes the other side.
    setSplit(settings.swapped ? 1 - frac : frac);
  });
  const stopDragging = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    elements.divider.releasePointerCapture(event.pointerId);
    elements.divider.classList.remove("dragging");
    document.body.classList.remove("resizing");
    updateSettings({ split }, false);
  };
  elements.divider.addEventListener("pointerup", stopDragging);
  elements.divider.addEventListener("pointercancel", stopDragging);
  elements.divider.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // Swapped, the editor sits on the right, so moving the divider left grows it.
    const growsEditor = (event.key === "ArrowRight") !== settings.swapped;
    updateSettings({ split: currentSplit() + (growsEditor ? 0.02 : -0.02) }, false);
  });
  elements.divider.addEventListener("dblclick", () => updateSettings({ split: DEFAULT_LAYOUT.split }, false));
}

/**
 * The Source / Preview switch that narrow screens show in place of the
 * side-by-side panes. On wider screens it is hidden and the class is inert.
 */
function setupViewSwitch(): void {
  const show = (preview: boolean) => {
    document.body.classList.toggle("show-preview", preview);
    elements.showSource.setAttribute("aria-pressed", String(!preview));
    elements.showPreview.setAttribute("aria-pressed", String(preview));
    // Dismisses the on-screen keyboard, which would otherwise cover the page.
    if (preview && view?.hasFocus) view.contentDOM.blur();
  };
  elements.showSource.addEventListener("click", () => show(false));
  elements.showPreview.addEventListener("click", () => show(true));
}

/**
 * Keeps the editor usable while an on-screen keyboard is up.
 *
 * Chrome honours `interactive-widget=resizes-content` and shrinks the layout
 * itself. iOS Safari overlays the keyboard and pans the page instead, so
 * there the app is pinned to the part still visible. Either way, the cursor is
 * then scrolled back into view above the keyboard.
 */
function fitVisualViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;

  const fit = () => {
    // A pinch-zoomed page also has a smaller visual viewport, and must not be
    // squashed to fit it.
    const overlaid =
      viewport.scale < 1.01 && root.clientHeight - viewport.height > 1;
    document.body.classList.toggle("keyboard-overlay", overlaid);
    if (overlaid) {
      root.style.setProperty("--viewport-height", `${viewport.height}px`);
      root.style.setProperty("--viewport-top", `${viewport.offsetTop}px`);
    }
  };

  viewport.addEventListener("scroll", fit);
  viewport.addEventListener("resize", () => {
    fit();
    if (view?.hasFocus) revealCursor(view);
  });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/* Boot --------------------------------------------------------------------- */

async function boot(): Promise<void> {
  applySettings();
  setupDivider();
  setupViewSwitch();
  setupFloatingEditor();
  fitVisualViewport();
  library = await loadLibrary();
  if (identity.libId && !library.some((e) => e.id === identity.libId)) identity.libId = null;

  // The compiler is a ~9 MB download on a first visit. Say so, and say it
  // only happens once, rather than leaving an empty window for ten seconds.
  placeholder =
    "Loading the Typst compiler. It is about 9 MB and your browser caches it, so this only happens on your first visit.";
  windows.load(settings.windows);
  applyEditorFloating(settings.editorFloating);
  setStatus("Loading the compiler…", "working");

  // The panel acts on `project`, which is still loading for a moment.
  elements.documentsToggle.addEventListener("click", () => {
    if (project) documents.toggle();
  });
  elements.newWindow.addEventListener("click", () => openWindow());
  elements.settingsToggle.addEventListener("click", () => panel.toggle());

  // Shortcuts that should also work with focus outside the editor. The panels
  // registered their own Escape handlers first; one they consumed is done.
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (view?.hasFocus) return;
    const mod = e.ctrlKey || e.metaKey;
    const inField = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (mod && e.key.toLowerCase() === "s" && !inField) {
      e.preventDefault();
      void saveToLibrary(e.shiftKey);
    } else if (e.altKey && !mod && e.code === "KeyW" && !inField) {
      e.preventDefault();
      openWindow();
    } else if (e.altKey && e.shiftKey && !mod && e.code === "KeyF" && !inField) {
      e.preventDefault();
      void formatFile();
    } else if (e.key === "Escape" && !panel.isOpen && !documents.isOpen) {
      if (windows.closeFront()) e.preventDefault();
    }
  });

  onSystemSchemeChange(() => {
    if (settings.theme === "system") applySettings();
  });

  const loading = rpc.send({
    kind: "init",
    fontUrls: fontUrls(),
    localNowMs: Date.now() - new Date().getTimezoneOffset() * 60_000,
  });
  // Loading the compiler is awaited further down, after the editor is up. Mark
  // the rejection as handled now so a failure in the meantime doesn't surface
  // as an unhandled rejection; the `await` below still sees it.
  loading.catch(() => {});

  project = await resolveProject();
  dirty = new Set(project.paths());
  activePath = project.main;
  {
    const starter = await rpc.send({ kind: "starter" });
    const fresh = new Project(starter.path);
    fresh.writeText(starter.path, starter.text);
    starterSnapshot = snapshotOf(fresh);
  }
  rebaseline();
  renderDocumentButton();

  const created = createEditor({
    parent: elements.editor,
    doc: project.text(activePath) ?? "",
    ...editorConfig(),
    ide: {
      // The worker answers from the text it last received, so the file has to
      // be flushed before asking — otherwise offsets refer to stale text.
      // Nothing to ask until the compiler is up; an early question would
      // only surface as a rejected promise.
      completions: async (cursor, explicit) => {
        if (!ready) return { from: cursor, items: [] };
        await syncFiles();
        return rpc.send({
          kind: "autocomplete",
          path: activePath,
          cursor,
          explicit,
        });
      },
      hover: async (cursor) => {
        if (!ready) return null;
        await syncFiles();
        return rpc.send({ kind: "hover", path: activePath, cursor });
      },
    },
    onChange: (text) => {
      if (!activePath || !isTextPath(activePath)) return;
      project.writeText(activePath, text);
      dirty.add(activePath);
      store.save(project);
      scheduleCompile();
      renderDocumentButton();
    },
    onFormat: () => void formatFile(),
    onSelectionChange: (line, column) => {
      elements.statusPosition.textContent = `Ln ${line}, Col ${column}`;
    },
    keys: [
      {
        key: "Mod-s",
        run: () => {
          void store.flush();
          void compile();
          void saveToLibrary(false);
          return true;
        },
      },
      {
        key: "Shift-Mod-s",
        run: () => {
          void saveToLibrary(true);
          return true;
        },
      },
      {
        key: "Shift-Alt-f",
        run: () => {
          void formatFile();
          return true;
        },
      },
      {
        key: "Alt-w",
        run: () => {
          openWindow();
          return true;
        },
      },
      {
        key: "Mod-e",
        run: () => {
          // Ctrl-E is vim's scroll-down; there it stays vim's.
          if (settings.keymap === "vim") return false;
          void exportPdf();
          return true;
        },
      },
      {
        key: "Mod-,",
        run: () => {
          panel.toggle();
          return true;
        },
      },
    ],
  });
  view = created.view;
  createState = created.createState;
  states.set(activePath, view.state);
  if (!isTouchScreen()) view.focus();

  tabs.render(project, activePath);
  updateStatusMain();

  try {
    const { fontCount } = await loading;
    if (fontCount === 0) {
      setStatus("No fonts loaded, so the preview will be blank.", "error");
      return;
    }
  } catch (error) {
    setStatus(`The compiler did not load: ${describe(error)}`, "error");
    return;
  }

  ready = true;
  await compile();
}

void boot();
