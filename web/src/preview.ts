/**
 * The page preview.
 *
 * Pages are diffed by their SVG string and only replaced when they actually
 * changed. Rewriting the whole container on every compile would reset the
 * scroll position on every keystroke, which makes editing a long document
 * unusable.
 */

import type { PageLayout, PreviewFit } from "./settings";

export interface PreviewCallbacks {
  /** Reports the effective zoom so the toolbar can show it. */
  onZoomChange: (zoom: number) => void;
  /** Reports the zoom a pinch settled on, so it can be remembered. */
  onPinchEnd?: (zoom: number) => void;
}

export class Preview {
  readonly #container: HTMLElement;
  readonly #callbacks: PreviewCallbacks;
  readonly #sheets: HTMLElement[] = [];
  #rendered: string[] = [];
  #zoom = 1;
  #fit: PreviewFit = "width";
  #layout: PageLayout = "single";
  #placeholder: HTMLElement | null = null;
  readonly #resizes: ResizeObserver;

  constructor(container: HTMLElement, callbacks: PreviewCallbacks) {
    this.#container = container;
    this.#callbacks = callbacks;
    this.#resizes = new ResizeObserver(() => this.#applyZoom());
    this.#resizes.observe(container);
    this.#setupPinch();
  }

  /** Stops watching the pane; for a window that closed or now shows something else. */
  dispose(): void {
    this.#resizes.disconnect();
  }

  get pageCount(): number {
    return this.#sheets.length;
  }

  get zoom(): number {
    return this.#zoom;
  }

  get fit(): PreviewFit {
    return this.#fit;
  }

  /** Shows a message in place of pages, before the first successful compile. */
  showPlaceholder(message: string): void {
    if (this.#sheets.length > 0) return;
    if (!this.#placeholder) {
      this.#placeholder = document.createElement("p");
      this.#placeholder.className = "preview-empty";
      this.#container.append(this.#placeholder);
    }
    this.#placeholder.textContent = message;
  }

  render(pages: string[]): void {
    this.#placeholder?.remove();
    this.#placeholder = null;

    for (let i = 0; i < pages.length; i++) {
      const svg = pages[i]!;
      if (this.#rendered[i] === svg) continue;

      let sheet = this.#sheets[i];
      if (!sheet) {
        sheet = document.createElement("div");
        sheet.className = "sheet";

        const page = document.createElement("div");
        page.className = "page";
        const caption = document.createElement("span");
        caption.className = "page-caption";
        sheet.append(page, caption);

        this.#container.append(sheet);
        this.#sheets.push(sheet);
      }
      const page = sheet.querySelector<HTMLElement>(".page")!;
      page.innerHTML = svg;
      recordNaturalSize(page);
    }

    for (const removed of this.#sheets.splice(pages.length)) {
      removed.remove();
    }
    this.#rendered = pages.slice();
    this.#renumber();
    this.#applyZoom();
  }

  /** Captions read "1 / 4", which is only worth saying when there is a 4. */
  #renumber(): void {
    const total = this.#sheets.length;
    this.#sheets.forEach((sheet, index) => {
      const caption = sheet.querySelector<HTMLElement>(".page-caption")!;
      caption.textContent = total > 1 ? `${index + 1} / ${total}` : "";
    });
  }

  setFit(fit: PreviewFit): void {
    this.#fit = fit;
    this.#applyZoom();
  }

  get layout(): PageLayout {
    return this.#layout;
  }

  /** How the pages sit; "width" fit then fills the row with two pages for double and book. */
  setLayout(layout: PageLayout): void {
    this.#layout = layout;
    this.#container.dataset["layout"] = layout;
    this.#applyZoom();
  }

  /** Sets an explicit zoom, which switches the fit mode to manual. */
  setZoom(zoom: number): void {
    this.#fit = "actual";
    this.#zoom = clamp(zoom, 0.25, 4);
    this.#applyZoom();
  }

  zoomBy(factor: number): void {
    this.setZoom(this.#zoom * factor);
  }

  /**
   * Two-finger pinch on a touch screen.
   *
   * Zooms the pages themselves, like the toolbar buttons, rather than letting
   * the browser magnify the whole app — which would leave the toolbar and the
   * editor zoomed too. Touch events rather than pointer events, because the
   * browser cancels a pointer as soon as it starts panning with it.
   */
  #setupPinch(): void {
    let start: { spread: number; zoom: number } | null = null;
    let frame = 0;

    const spread = (touches: TouchList) =>
      Math.hypot(
        touches[0]!.clientX - touches[1]!.clientX,
        touches[0]!.clientY - touches[1]!.clientY,
      );

    this.#container.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length === 2) {
          start = { spread: spread(event.touches), zoom: this.#zoom };
        }
      },
      { passive: true },
    );
    this.#container.addEventListener(
      "touchmove",
      (event) => {
        if (!start || event.touches.length !== 2 || start.spread === 0) return;
        const zoom = (start.zoom * spread(event.touches)) / start.spread;
        const x = (event.touches[0]!.clientX + event.touches[1]!.clientX) / 2;
        const y = (event.touches[0]!.clientY + event.touches[1]!.clientY) / 2;
        // Re-laying out every page per touchmove would stutter, so at most
        // once a frame.
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => this.#zoomAround(zoom, x, y));
      },
      { passive: true },
    );
    const end = (event: TouchEvent) => {
      if (!start || event.touches.length >= 2) return;
      start = null;
      cancelAnimationFrame(frame);
      this.#callbacks.onPinchEnd?.(this.#zoom);
    };
    this.#container.addEventListener("touchend", end);
    this.#container.addEventListener("touchcancel", end);
  }

  /** Zooms while keeping the point under the fingers where it is. */
  #zoomAround(zoom: number, clientX: number, clientY: number): void {
    const before = this.#zoom;
    const bounds = this.#container.getBoundingClientRect();
    const offsetX = clientX - bounds.left;
    const offsetY = clientY - bounds.top;
    const x = this.#container.scrollLeft + offsetX;
    const y = this.#container.scrollTop + offsetY;

    this.setZoom(zoom);

    const ratio = this.#zoom / before;
    this.#container.scrollLeft = x * ratio - offsetX;
    this.#container.scrollTop = y * ratio - offsetY;
  }

  #applyZoom(): void {
    const first = this.#sheets[0]?.querySelector<HTMLElement>(".page");
    if (first) {
      const naturalWidth = Number(first.dataset["width"]);
      const naturalHeight = Number(first.dataset["height"]);
      // Read rather than assumed, since narrow screens use less padding.
      // The extra 20px is room for the caption.
      const style = getComputedStyle(this.#container);
      const availableWidth =
        this.#container.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const availableHeight =
        this.#container.clientHeight -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom) -
        20;

      // Two-up rows share the width, less the gap between the pages.
      const across = this.#layout === "double" || this.#layout === "book" ? 2 : 1;
      const gap = across > 1 ? Number.parseFloat(style.columnGap) || 0 : 0;
      if (this.#fit === "width" && naturalWidth > 0 && availableWidth > 0) {
        this.#zoom = clamp((availableWidth - gap) / (naturalWidth * across), 0.25, 2);
      } else if (this.#fit === "page" && naturalWidth > 0 && naturalHeight > 0 && availableHeight > 0) {
        this.#zoom = clamp(
          Math.min((availableWidth - gap) / (naturalWidth * across), availableHeight / naturalHeight),
          0.25,
          2,
        );
      }
    }
    // The SVG is sized directly rather than through CSS `zoom`: Safari and
    // Firefox apply `zoom` to an SVG's glyph positions and to the glyphs
    // themselves differently, so text runs drifted apart and overlapped at
    // any zoom but 100%. Width and height over a viewBox scale the same way
    // everywhere.
    for (const sheet of this.#sheets) {
      const page = sheet.querySelector<HTMLElement>(".page")!;
      const svg = page.querySelector<SVGSVGElement>("svg");
      if (!svg) continue;
      svg.style.width = `${Number(page.dataset["width"]) * this.#zoom}px`;
      svg.style.height = `${Number(page.dataset["height"]) * this.#zoom}px`;
    }
    this.#callbacks.onZoomChange(this.#zoom);
  }
}

/**
 * Stores a page's natural size in CSS pixels on the element. Typst's SVG
 * gives it in points, as a viewBox; a point is 4/3 of a CSS pixel.
 */
function recordNaturalSize(page: HTMLElement): void {
  const box = page.querySelector("svg")?.viewBox.baseVal;
  page.dataset["width"] = String((box?.width ?? 0) * (4 / 3));
  page.dataset["height"] = String((box?.height ?? 0) * (4 / 3));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
