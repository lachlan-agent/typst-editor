/**
 * The file tab bar.
 *
 * The compiled document is always `main`, whichever tab is in front — that is
 * how Typst projects work, and the badge on the main tab is what keeps it from
 * being a surprise.
 */

import { isTextPath, type Project } from "./project";

export interface TabsCallbacks {
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onRename: (path: string) => void;
  onSetMain: (path: string) => void;
  onCreate: () => void;
  /** Drop `path` before `before`, or last when null. */
  onReorder: (path: string, before: string | null) => void;
}

export class Tabs {
  readonly #container: HTMLElement;
  readonly #callbacks: TabsCallbacks;
  /** The path being dragged, while one is. */
  #dragging: string | null = null;

  constructor(container: HTMLElement, callbacks: TabsCallbacks) {
    this.#container = container;
    this.#callbacks = callbacks;
  }

  render(project: Project, active: string): void {
    const tabs = project.paths().map((path) => this.#tab(project, path, active));

    const add = button("+", "New file", () => this.#callbacks.onCreate());
    add.classList.add("tab-add");

    this.#container.replaceChildren(...tabs, add);
  }

  #tab(project: Project, path: string, active: string): HTMLElement {
    const isActive = path === active;
    const isMain = path === project.main;

    const tab = document.createElement("div");
    tab.className = "tab";
    tab.dataset["active"] = String(isActive);
    tab.dataset["kind"] = isTextPath(path) ? "text" : "binary";
    tab.dataset["path"] = path;
    this.#draggable(tab, path);

    const select = document.createElement("button");
    select.className = "tab-name";
    select.type = "button";
    select.textContent = displayName(path);
    select.title = isMain ? `${path} — compiled as the main file` : path;
    select.setAttribute("aria-pressed", String(isActive));
    select.addEventListener("click", () => this.#callbacks.onSelect(path));
    // Renaming from the tab itself is the obvious gesture, and there is no
    // other place a file name appears.
    select.addEventListener("dblclick", () => this.#callbacks.onRename(path));
    tab.append(select);

    if (isMain) {
      const badge = document.createElement("span");
      badge.className = "tab-badge";
      badge.textContent = "main";
      badge.title = "This file is the one compiled into the preview";
      tab.append(badge);
    } else if (isTextPath(path)) {
      const setMain = button("◎", "Compile this file instead", () =>
        this.#callbacks.onSetMain(path),
      );
      setMain.classList.add("tab-action");
      tab.append(setMain);
    }

    // The main file has nothing to fall back to, so it cannot be closed.
    if (!isMain) {
      const close = button("×", `Delete ${path}`, () =>
        this.#callbacks.onClose(path),
      );
      close.classList.add("tab-action", "tab-close");
      tab.append(close);
    }

    return tab;
  }

  /**
   * Reordering by drag. Native drag and drop: the tab is the drag image, a
   * line on the neighbour shows where it will land, and dropping on the
   * strip's empty end puts it last.
   */
  #draggable(tab: HTMLElement, path: string): void {
    tab.draggable = true;
    tab.addEventListener("dragstart", (event) => {
      this.#dragging = path;
      tab.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", path);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    tab.addEventListener("dragend", () => {
      this.#dragging = null;
      tab.classList.remove("dragging");
      this.#clearMarks();
    });
    tab.addEventListener("dragover", (event) => {
      if (!this.#dragging || this.#dragging === path) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const box = tab.getBoundingClientRect();
      const before = event.clientX < box.left + box.width / 2;
      this.#clearMarks();
      tab.classList.add(before ? "drop-before" : "drop-after");
    });
    tab.addEventListener("dragleave", () => tab.classList.remove("drop-before", "drop-after"));
    tab.addEventListener("drop", (event) => {
      if (!this.#dragging || this.#dragging === path) return;
      event.preventDefault();
      const box = tab.getBoundingClientRect();
      const before = event.clientX < box.left + box.width / 2;
      const dragged = this.#dragging;
      this.#clearMarks();
      this.#callbacks.onReorder(dragged, before ? path : this.#after(path));
    });
    // The strip's empty end: drop there to put the tab last.
    if (!this.#container.dataset["dropEnd"]) {
      this.#container.dataset["dropEnd"] = "1";
      this.#container.addEventListener("dragover", (event) => {
        if (this.#dragging && event.target === this.#container) event.preventDefault();
      });
      this.#container.addEventListener("drop", (event) => {
        if (!this.#dragging || event.target !== this.#container) return;
        event.preventDefault();
        this.#callbacks.onReorder(this.#dragging, null);
      });
    }
  }

  /** The path of the tab after `path`, or null at the end. */
  #after(path: string): string | null {
    const tabs = [...this.#container.querySelectorAll<HTMLElement>(".tab")];
    const at = tabs.findIndex((t) => t.dataset["path"] === path);
    return tabs[at + 1]?.dataset["path"] ?? null;
  }

  #clearMarks(): void {
    for (const t of this.#container.querySelectorAll(".drop-before, .drop-after")) {
      t.classList.remove("drop-before", "drop-after");
    }
  }
}

/** Tabs show the file name; the full path lives in the tooltip. */
function displayName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function button(
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.title = title;
  element.setAttribute("aria-label", title);
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return element;
}
