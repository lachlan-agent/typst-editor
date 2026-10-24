/**
 * The Documents panel: name and save the working project, open a saved one,
 * export, import, share. A popover like the settings panel; main.ts owns the
 * library and the project and does the actual work.
 */

import { fmtBytes, fmtDate, type LibraryEntry } from "./library";

export interface DocumentsOptions {
  container: HTMLElement;
  /** The working document's name and, when it was opened from the library, its entry id. */
  current(): { name: string; libId: string | null; dirty: boolean };
  library(): LibraryEntry[];
  rename(name: string): void;
  save(asCopy: boolean): void;
  fresh(): void;
  open(entry: LibraryEntry): void;
  renameEntry(entry: LibraryEntry, name: string): void;
  deleteEntry(entry: LibraryEntry): void;
  exportProject(): void;
  importFile(file: File): void;
  exportPdf(): void;
  copyLink(): void;
}

export class DocumentsPanel {
  readonly #options: DocumentsOptions;
  readonly #element: HTMLElement;
  #open = false;

  constructor(options: DocumentsOptions) {
    this.#options = options;
    this.#element = options.container;
    this.#element.hidden = true;

    document.addEventListener("pointerdown", (event) => {
      if (!this.#open) return;
      const target = event.target as Node;
      if (this.#element.contains(target)) return;
      if ((target as HTMLElement).closest?.("[data-documents-toggle]")) return;
      this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.#open) {
        event.preventDefault();
        this.close();
      }
    });
  }

  onToggle: ((open: boolean) => void) | null = null;

  get isOpen(): boolean {
    return this.#open;
  }

  toggle(): void {
    this.#open ? this.close() : this.open();
  }

  open(): void {
    this.#open = true;
    this.#element.hidden = false;
    this.render();
    this.onToggle?.(true);
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#element.hidden = true;
    this.onToggle?.(false);
  }

  render(): void {
    if (!this.#open) return;
    const scroll = this.#element.scrollTop;
    this.#element.replaceChildren(
      el("h2", { class: "panel-title", text: "Documents" }),
      this.#currentField(),
      this.#fileField(),
      this.#savedField(),
    );
    this.#element.scrollTop = scroll;
  }

  #currentField(): HTMLElement {
    const { name, libId, dirty } = this.#options.current();
    const input = el("input", {
      class: "name-input",
      type: "text",
      placeholder: "Document name",
      maxlength: "64",
      spellcheck: "false",
    }) as HTMLInputElement;
    input.value = name;
    input.addEventListener("change", () => this.#options.rename(input.value));
    input.addEventListener("keydown", (e) => {
      // Enter and Ctrl/⌘+S both commit the name and save; the browser's own
      // "save page" must not get the shortcut while the cursor is in here.
      const save = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s";
      if (e.key === "Enter" || save) {
        e.preventDefault();
        this.#options.rename(input.value);
        this.#options.save(save && e.shiftKey);
      }
    });

    const state = libId ? (dirty ? "unsaved changes" : "saved") : "unsaved";
    return el("div", { class: "field" }, [
      el("span", { class: "field-label" }, [
        el("span", { text: "Current " }),
        el("span", { class: "field-state", text: state }),
      ]),
      input,
      el("div", { class: "inline inline-end" }, [
        button("Save", "Keep a named snapshot in this browser (Ctrl/⌘ + S)", () =>
          this.#options.save(false),
        ),
        button("Save copy", "Save as a new entry (Ctrl/⌘ + Shift + S)", () =>
          this.#options.save(true),
        ),
        button("New", "Start from the starter document", () => this.#options.fresh()),
      ]),
      el("div", {
        class: "field-note",
        text: "Your work is autosaved as you type either way; saving keeps a named copy of every file, with its window layout.",
      }),
    ]);
  }

  #fileField(): HTMLElement {
    const file = el("input", {
      type: "file",
      accept: ".typ,.tar,.txt,text/plain,application/x-tar",
      hidden: "",
    }) as HTMLInputElement;
    file.addEventListener("change", () => {
      const picked = file.files?.[0];
      if (picked) this.#options.importFile(picked);
      file.value = "";
    });

    return el("div", { class: "field" }, [
      el("span", { class: "field-label", text: "File" }),
      el("div", { class: "inline" }, [
        button("Export project", "Download every file as one .tar (a lone main file downloads as .typ)", () =>
          this.#options.exportProject(),
        ),
        button("Import", "Open a .typ file as the main file, or a .tar as a whole project", () =>
          file.click(),
        ),
        file,
      ]),
      el("div", { class: "inline", style: "margin-top: 8px" }, [
        button("Export PDF", "Compile and download the PDF (Ctrl/⌘ + E)", () =>
          this.#options.exportPdf(),
        ),
        button("Copy link", "A link that carries the whole project in its fragment", () =>
          this.#options.copyLink(),
        ),
      ]),
    ]);
  }

  #savedField(): HTMLElement {
    const library = this.#options.library();
    const { libId } = this.#options.current();
    const list = el("div", { class: "doc-list" });
    if (!library.length) {
      list.append(
        el("div", {
          class: "field-note",
          text: "Nothing saved yet. Name the document above and press Save.",
        }),
      );
    }
    for (const entry of [...library].sort((a, b) => b.updated - a.updated)) {
      const row = el("div", {
        class: `doc-row${entry.id === libId ? " current" : ""}`,
        title: `Open "${entry.name}"`,
      });
      const meta = `${entry.files === 1 ? "1 file" : `${entry.files} files`} · ${fmtBytes(entry.bytes)} · ${fmtDate(entry.updated)}`;
      const main = el("div", { class: "dr-main" }, [
        el("div", { class: "dr-name", text: entry.name }),
        el("div", { class: "dr-meta", text: meta }),
      ]);
      const rename = el("button", { class: "dr-btn", type: "button", text: "✎", title: "Rename" });
      rename.addEventListener("click", (e) => {
        e.stopPropagation();
        const typed = prompt("Rename document", entry.name);
        if (typed === null || !typed.trim()) return;
        this.#options.renameEntry(entry, typed.trim());
      });
      const del = el("button", { class: "dr-btn dr-danger", type: "button", text: "✕", title: "Delete" });
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${entry.name}" from this browser?`)) return;
        this.#options.deleteEntry(entry);
      });
      row.append(main, el("div", { class: "dr-actions" }, [rename, del]));
      row.addEventListener("click", () => this.#options.open(entry));
      list.append(row);
    }
    return el("div", { class: "field" }, [
      el("span", { class: "field-label" }, [
        el("span", { text: "Saved " }),
        el("span", { class: "field-state", text: library.length ? String(library.length) : "" }),
      ]),
      list,
    ]);
  }
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { class: "btn", type: "button", text: label, title }) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  return b;
}

function el(tag: string, attributes: Record<string, string> = {}, children: Element[] = []): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "text") element.textContent = value;
    else element.setAttribute(name, value);
  }
  element.append(...children);
  return element;
}
