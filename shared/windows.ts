/**
 * Windows, as in shader-editor: everything beside the editor is a window with
 * a bar (what it shows, dock/undock, close) over a body. Docked windows stack
 * in the dock pane; floating ones are fixed boxes on <body>, dragged by the
 * bar, resized from any edge, snapping to each other and to the panes. The
 * editor pane borrows the same gestures through a `FloatHost`.
 *
 * This module owns geometry and chrome only. What goes inside a window, and
 * where the layout is saved, is the caller's (main.ts) business.
 *
 * Shared by typst-editor and musictest3. This file is the source of truth:
 * typst-editor imports it in place; musictest3 keeps a synced copy under
 * src/shared/ (scripts/sync-shared.sh). It has no imports on purpose, so it
 * compiles under either app's tsconfig. The window-kind union is a type
 * parameter; each app pins it in its own windows.ts shim.
 */

/* ── Rects ──────────────────────────────────────────────────────────── */

/** A floating window's position, in viewport pixels. */
export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function isRect(r: unknown): r is FloatRect {
  const o = r as Record<string, unknown> | null;
  return !!o && typeof o === "object" && ["x", "y", "w", "h"].every((k) => Number.isFinite(o[k]));
}

export const copyRect = (r: FloatRect): FloatRect => ({ x: r.x, y: r.y, w: r.w, h: r.h });

/**
 * One window beside the editor. `rect` is where it sits when floating, kept
 * while docked; `w = 0` means it has never floated and gets a default spot.
 */
export interface WindowSpec<K extends string = string> {
  kind: K;
  docked: boolean;
  rect: FloatRect;
}

/* ── Floating geometry ──────────────────────────────────────────────── */

export interface FloatHost {
  el: HTMLElement;
  bar: HTMLElement;
  minW: number;
  minH: number;
  rect(): FloatRect;
  /** Store the rect and write it to the element's styles. */
  setRect(r: FloatRect): void;
  onRelease?(): void;
}

export interface FloaterOptions {
  /** Top of the usable area (below the toolbar), in viewport pixels. */
  top(): number;
  /** Bottom of the usable area (above the status bar). */
  bottom(): number;
  /** Elements whose edges a dragged window sticks to, besides other floating windows. */
  snapTargets(): HTMLElement[];
  /** The user let go of a window: persist the layout. */
  onChange(): void;
}

const BAR_H = 28; // must match .win-bar / .float-bar height in styles.css
export const MARGIN = 8; // breathing room from the viewport edges
const SNAP = 8; // px: an edge this close to another sticks to it (Alt disables)
const FLOAT_Z = 50; // below the apps' panels (400) and toasts (450); CodeMirror panels sit at 300

const RESIZE_DIRS = ["n", "s", "w", "e", "nw", "ne", "sw", "se"];

export function writeRect(el: HTMLElement, r: FloatRect): void {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.w}px`;
  el.style.height = `${r.h}px`;
}

export function clearRect(el: HTMLElement): void {
  el.style.left = el.style.top = el.style.width = el.style.height = el.style.zIndex = "";
}

export function addResizeHandles(el: HTMLElement): HTMLElement[] {
  return RESIZE_DIRS.map((d) => {
    const h = document.createElement("div");
    h.className = `fh fh-${d}`;
    h.dataset["dir"] = d;
    el.append(h);
    return h;
  });
}

interface Gesture {
  host: FloatHost;
  dir: string;
  startX: number;
  startY: number;
  start: FloatRect;
  pointerId: number;
}

export class Floater {
  readonly #opts: FloaterOptions;
  #gesture: Gesture | null = null;
  readonly #guideX = document.createElement("div");
  readonly #guideY = document.createElement("div");
  /** The floating window last touched: Esc closes it. */
  front: HTMLElement | null = null;

  constructor(opts: FloaterOptions) {
    this.#opts = opts;
    this.#guideX.className = "snap-guide snap-x";
    this.#guideY.className = "snap-guide snap-y";
    document.body.append(this.#guideX, this.#guideY);
  }

  get dragging(): boolean {
    return this.#gesture !== null;
  }

  /** Fit the usable area, and keep the bar grabbable. */
  clamp(r: FloatRect, minW: number, minH: number): FloatRect {
    const vw = window.innerWidth;
    const top = this.#opts.top();
    const bottom = this.#opts.bottom();
    const w = Math.min(Math.max(r.w, minW), vw - 2 * MARGIN);
    const h = Math.min(Math.max(r.h, minH), bottom - top - 2 * MARGIN);
    const x = Math.min(Math.max(r.x, MARGIN), vw - w - MARGIN);
    const y = Math.min(Math.max(r.y, top + MARGIN), bottom - h - MARGIN);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  /** The free area floating windows live in. */
  area(): FloatRect {
    const top = this.#opts.top() + MARGIN;
    return { x: MARGIN, y: top, w: window.innerWidth - 2 * MARGIN, h: this.#opts.bottom() - top - MARGIN };
  }

  attach(host: FloatHost, handles: HTMLElement[]): void {
    const begin = (e: PointerEvent, dir: string, target: HTMLElement): void => {
      if (e.button !== 0 || document.fullscreenElement || this.#gesture) return;
      if (dir === "move" && (e.target as HTMLElement).closest("button, select, input")) return;
      this.#gesture = { host, dir, startX: e.clientX, startY: e.clientY, start: copyRect(host.rect()), pointerId: e.pointerId };
      target.setPointerCapture(e.pointerId);
      host.el.classList.add("moving");
      document.body.classList.add("resizing");
      e.preventDefault();
    };
    const move = (e: PointerEvent): void => this.#move(e);
    const end = (e: PointerEvent): void => this.#end(e);
    host.bar.addEventListener("pointerdown", (e) => begin(e, "move", host.bar));
    host.bar.addEventListener("pointermove", move);
    host.bar.addEventListener("pointerup", end);
    host.bar.addEventListener("pointercancel", end);
    for (const h of handles) {
      h.addEventListener("pointerdown", (e) => begin(e, h.dataset["dir"] ?? "se", h));
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", end);
      h.addEventListener("pointercancel", end);
    }
  }

  /** Bring a window above its siblings; z-indices are renumbered from a fixed base. */
  raise(el: HTMLElement): void {
    if (el.classList.contains("win")) this.front = el;
    const wins = Array.from(document.querySelectorAll<HTMLElement>(".floating"))
      .filter((w) => w !== el)
      .sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0));
    wins.push(el);
    wins.forEach((w, i) => (w.style.zIndex = String(FLOAT_Z + i)));
  }

  /** Double-click on a bar: cycle through halves and quarters of the free area. */
  tile(host: FloatHost): void {
    const a = this.area();
    const zones: FloatRect[] = [
      { x: a.x, y: a.y, w: a.w / 2, h: a.h },
      { x: a.x + a.w / 2, y: a.y, w: a.w / 2, h: a.h },
      { x: a.x, y: a.y, w: a.w / 2, h: a.h / 2 },
      { x: a.x + a.w / 2, y: a.y, w: a.w / 2, h: a.h / 2 },
      { x: a.x, y: a.y + a.h / 2, w: a.w / 2, h: a.h / 2 },
      { x: a.x + a.w / 2, y: a.y + a.h / 2, w: a.w / 2, h: a.h / 2 },
    ];
    const i = (Number(host.el.dataset["tile"] ?? -1) + 1) % zones.length;
    host.el.dataset["tile"] = String(i);
    host.setRect(this.clamp(zones[i]!, host.minW, host.minH));
    this.#opts.onChange();
  }

  /** Edges worth sticking to: the free area, the panes and every other floating window. */
  #snapLines(except: HTMLElement): { xs: number[]; ys: number[] } {
    const a = this.area();
    const xs = [a.x, a.x + a.w];
    const ys = [a.y, a.y + a.h];
    const targets = [...document.querySelectorAll<HTMLElement>(".win.floating"), ...this.#opts.snapTargets()];
    for (const el of targets) {
      if (el === except || !el.isConnected || el.clientWidth === 0) continue;
      const r = el.getBoundingClientRect();
      xs.push(r.left, r.right);
      ys.push(r.top, r.bottom);
    }
    return { xs, ys };
  }

  #guides(x: number | null, y: number | null): void {
    this.#guideX.style.display = x === null ? "none" : "block";
    this.#guideY.style.display = y === null ? "none" : "block";
    if (x !== null) this.#guideX.style.left = `${x}px`;
    if (y !== null) this.#guideY.style.top = `${y}px`;
  }

  #move(e: PointerEvent): void {
    const g = this.#gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const vw = window.innerWidth;
    const top = this.#opts.top();
    const bottom = this.#opts.bottom();
    const { minW, minH } = g.host;
    let { x, y, w, h } = g.start;
    const lines = e.altKey ? null : this.#snapLines(g.host.el);
    let guideX: number | null = null;
    let guideY: number | null = null;

    if (g.dir === "move") {
      // Slide freely while held (re-clamped on release) but never lose the bar.
      x = Math.min(Math.max(g.start.x + dx, -w + 80), vw - 80);
      y = Math.min(Math.max(g.start.y + dy, top), bottom - BAR_H);
      if (lines) {
        const l = nearest(x, lines.xs);
        const r = nearest(x + w, lines.xs);
        if (l !== null && (r === null || Math.abs(l - x) <= Math.abs(r - x - w))) (x = l), (guideX = l);
        else if (r !== null) (x = r - w), (guideX = r);
        const t = nearest(y, lines.ys);
        const b = nearest(y + h, lines.ys);
        if (t !== null && (b === null || Math.abs(t - y) <= Math.abs(b - y - h))) (y = t), (guideY = t);
        else if (b !== null) (y = b - h), (guideY = b);
      }
    } else {
      // The edge opposite the one being dragged stays put.
      if (g.dir.includes("e")) w = Math.min(Math.max(g.start.w + dx, minW), vw - MARGIN - x);
      if (g.dir.includes("s")) h = Math.min(Math.max(g.start.h + dy, minH), bottom - MARGIN - y);
      if (g.dir.includes("w")) {
        const right = g.start.x + g.start.w;
        x = Math.min(Math.max(g.start.x + dx, MARGIN), right - minW);
        w = right - x;
      }
      if (g.dir.includes("n")) {
        const bot = g.start.y + g.start.h;
        y = Math.min(Math.max(g.start.y + dy, top + MARGIN), bot - minH);
        h = bot - y;
      }
      if (lines) {
        // Only the edge being dragged snaps.
        if (g.dir.includes("e")) {
          const r = nearest(x + w, lines.xs);
          if (r !== null && r - x >= minW) (w = r - x), (guideX = r);
        }
        if (g.dir.includes("w")) {
          const l = nearest(x, lines.xs);
          if (l !== null && x + w - l >= minW) (w = x + w - l), (x = l), (guideX = l);
        }
        if (g.dir.includes("s")) {
          const b = nearest(y + h, lines.ys);
          if (b !== null && b - y >= minH) (h = b - y), (guideY = b);
        }
        if (g.dir.includes("n")) {
          const t = nearest(y, lines.ys);
          if (t !== null && y + h - t >= minH) (h = y + h - t), (y = t), (guideY = t);
        }
      }
    }
    this.#guides(guideX, guideY);
    g.host.setRect({ x, y, w, h });
  }

  #end(e: PointerEvent): void {
    const g = this.#gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.#gesture = null;
    this.#guides(null, null);
    g.host.el.classList.remove("moving");
    document.body.classList.remove("resizing");
    g.host.setRect(this.clamp(g.host.rect(), g.host.minW, g.host.minH));
    g.host.onRelease?.();
    this.#opts.onChange();
  }
}

function nearest(v: number, lines: number[]): number | null {
  let best: number | null = null;
  let d = SNAP + 1;
  for (const l of lines) {
    const dd = Math.abs(l - v);
    if (dd < d) {
      d = dd;
      best = l;
    }
  }
  return best;
}

/* ── Windows ────────────────────────────────────────────────────────── */

export const WIN_MIN_W = 200;
export const WIN_MIN_H = 140;

export interface Win<K extends string = string> {
  readonly spec: WindowSpec<K>;
  readonly el: HTMLElement;
  /** Where the content goes; emptied whenever the kind changes. */
  readonly body: HTMLElement;
  /** A slot in the bar, after the selector, for a kind's own small controls; emptied with the body. */
  readonly tools: HTMLElement;
  readonly docked: boolean;
  setKind(kind: K): void;
  setDocked(on: boolean): void;
  remove(): void;
}

export interface WindowManagerOptions<K extends string = string> {
  dock: HTMLElement;
  /** The flex container of editor + dock; gets `dock-empty` when nothing is docked. */
  main: HTMLElement;
  kinds: Array<[K, string]>;
  floater: Floater;
  /** Narrow screens: every window is docked, whatever its spec says. */
  stacked: MediaQueryList;
  /** Fill (or refill) a window"s body for its kind. */
  mount(win: Win<K>): void;
  /** Something about the set of windows or their placement changed. */
  onChange(): void;
}

const ICON_UNDOCK =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 4.5V11h6.5M4 1h7v7H4z"/></svg>';
const ICON_DOCK =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 1h10v10H1zM6 1v10"/></svg>';

export class WindowManager<K extends string = string> {
  readonly #opts: WindowManagerOptions<K>;
  readonly wins: Win<K>[] = [];

  constructor(opts: WindowManagerOptions<K>) {
    this.#opts = opts;
    opts.stacked.addEventListener("change", () => {
      for (const w of this.wins) this.#place(w);
    });
    window.addEventListener("resize", () => {
      if (opts.floater.dragging || document.fullscreenElement) return;
      for (const w of this.wins) {
        if (w.docked) continue;
        w.spec.rect = opts.floater.clamp(w.spec.rect, WIN_MIN_W, WIN_MIN_H);
        writeRect(w.el, w.spec.rect);
      }
    });
  }

  get specs(): WindowSpec<K>[] {
    return this.wins.map((w) => w.spec);
  }

  get dockEmpty(): boolean {
    return !this.#opts.dock.querySelector(":scope > .win");
  }

  /** Windows showing `kind`, docked first in dock order, then floating. */
  of(kind: K): Win<K>[] {
    const docked = Array.from(this.#opts.dock.querySelectorAll<HTMLElement>(":scope > .win"))
      .map((el) => this.wins.find((w) => w.el === el))
      .filter((w): w is Win<K> => !!w);
    const floating = this.wins.filter((w) => !docked.includes(w));
    return [...docked, ...floating].filter((w) => w.spec.kind === kind);
  }

  /** Replace every window with the given specs (a restored or reset layout). */
  load(specs: WindowSpec<K>[]): void {
    for (const w of [...this.wins]) this.#detach(w);
    for (const spec of specs) this.#make({ ...spec, rect: copyRect(spec.rect) }, false);
    this.#sync();
    this.#opts.onChange();
  }

  /** A new window: docked when the dock is empty (or stacked), floating otherwise, cascading from the top right. */
  open(kind: K): Win<K> {
    const docked = this.#opts.stacked.matches || this.dockEmpty;
    const a = this.#opts.floater.area();
    const w = Math.round(Math.min(Math.max(a.w * 0.45, 320), 720));
    const h = Math.round(Math.min(Math.max(a.h * 0.6, 240), 600));
    const n = this.wins.filter((x) => !x.docked).length;
    const rect = { x: a.x + a.w - w - 16 - n * 28, y: a.y + 16 + n * 28, w, h };
    const win = this.#make({ kind, docked, rect }, !docked);
    this.#sync();
    this.#opts.onChange();
    return win;
  }

  /** Close the topmost floating window, if any. */
  closeFront(): boolean {
    let win: Win<K> | null = null;
    let z = -Infinity;
    for (const w of this.wins) {
      if (w.docked) continue;
      const wz = Number(w.el.style.zIndex) || 0;
      if (wz >= z) {
        z = wz;
        win = w;
      }
    }
    if (!win) return false;
    win.remove();
    return true;
  }

  #make(spec: WindowSpec<K>, animate: boolean): Win<K> {
    const { floater, kinds } = this.#opts;
    const el = document.createElement("section");
    el.className = `win${animate ? " pop" : ""}`;
    el.innerHTML = `
      <div class="win-bar">
        <span class="grip-dots"></span>
        <select class="win-select" title="What this window shows"></select>
        <span class="win-tools"></span>
        <span class="spacer"></span>
        <button class="win-btn win-dock" type="button"></button>
        <button class="win-btn win-close" type="button" title="Close window (Esc when floating)">✕</button>
      </div>
      <div class="win-body"></div>`;
    const bar = el.querySelector<HTMLElement>(".win-bar")!;
    const select = el.querySelector<HTMLSelectElement>(".win-select")!;
    const body = el.querySelector<HTMLElement>(".win-body")!;
    const tools = el.querySelector<HTMLElement>(".win-tools")!;
    const dockBtn = el.querySelector<HTMLButtonElement>(".win-dock")!;
    for (const [id, name] of kinds) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = name;
      select.append(o);
    }
    const handles = addResizeHandles(el);

    const self = this;
    const win: Win<K> = {
      spec,
      el,
      body,
      tools,
      get docked() {
        return spec.docked || self.#opts.stacked.matches;
      },
      setKind(kind) {
        if (!self.#opts.kinds.some(([k]) => k === kind)) return;
        spec.kind = kind;
        el.dataset["kind"] = kind;
        select.value = kind;
        body.replaceChildren();
        tools.replaceChildren();
        self.#opts.mount(win);
        self.#opts.onChange();
      },
      setDocked(on) {
        spec.docked = on;
        self.#place(win);
        self.#sync();
        self.#opts.onChange();
      },
      remove() {
        self.#detach(win);
        self.#sync();
        self.#opts.onChange();
      },
    };

    const host: FloatHost = {
      el,
      bar,
      minW: WIN_MIN_W,
      minH: WIN_MIN_H,
      rect: () => spec.rect,
      setRect: (r) => {
        spec.rect = r;
        writeRect(el, r);
      },
    };
    floater.attach(host, handles);
    select.addEventListener("change", () => win.setKind(select.value as K));
    dockBtn.addEventListener("click", () => win.setDocked(!spec.docked));
    el.querySelector(".win-close")!.addEventListener("click", () => win.remove());
    el.addEventListener("pointerdown", () => !win.docked && floater.raise(el), true);
    bar.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("button, select") || win.docked) return;
      floater.tile(host);
    });
    el.addEventListener("animationend", () => el.classList.remove("pop"));

    this.wins.push(win);
    el.dataset["kind"] = spec.kind;
    select.value = spec.kind;
    this.#place(win);
    this.#opts.mount(win);
    return win;
  }

  /** Put a window where its state says: in the dock, or floating at its rect. */
  #place(win: Win<K>): void {
    const { dock, floater, stacked } = this.#opts;
    const docked = win.docked;
    const dockBtn = win.el.querySelector<HTMLButtonElement>(".win-dock")!;
    win.el.classList.toggle("docked", docked);
    win.el.classList.toggle("floating", !docked);
    dockBtn.innerHTML = docked ? ICON_UNDOCK : ICON_DOCK;
    dockBtn.title = docked ? "Undock into a floating window" : "Dock beside the editor";
    dockBtn.disabled = stacked.matches;
    if (docked) {
      if (win.el.parentElement !== dock) dock.append(win.el);
      clearRect(win.el);
    } else {
      if (win.el.parentElement !== document.body) document.body.append(win.el);
      if (!win.spec.rect.w) {
        const a = floater.area();
        const w = Math.round(Math.min(Math.max(a.w * 0.45, 320), 720));
        const h = Math.round(Math.min(Math.max(a.h * 0.6, 240), 540));
        win.spec.rect = { x: a.x + a.w - w - 8, y: a.y + 8, w, h };
      }
      win.spec.rect = floater.clamp(win.spec.rect, WIN_MIN_W, WIN_MIN_H);
      writeRect(win.el, win.spec.rect);
      floater.raise(win.el);
    }
  }

  #detach(win: Win<K>): void {
    win.body.replaceChildren();
    win.el.remove();
    const i = this.wins.indexOf(win);
    if (i >= 0) this.wins.splice(i, 1);
    if (this.#opts.floater.front === win.el) this.#opts.floater.front = null;
  }

  #sync(): void {
    this.#opts.main.classList.toggle("dock-empty", this.dockEmpty);
  }
}
