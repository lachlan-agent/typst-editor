/**
 * The settings panel.
 *
 * Built from the theme and font registries rather than hand-written markup,
 * so adding a theme in `themes.css` plus a line in `theme.ts` is all it takes
 * to have it appear here.
 */

import {
  FONT_STACKS,
  isTouchScreen,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  GLASS_MODES,
  MAX_FROST,
  PAGE_LAYOUTS,
  WINDOW_KINDS,
  type GlassMode,
  type Keymap,
  type Leading,
  type Settings,
  type WindowKind,
} from "./settings";
import { THEMES, themeById, type Theme } from "./theme";

export interface PanelOptions {
  container: HTMLElement;
  get(): Settings;
  /** Applies a change and re-renders. */
  update(patch: Partial<Settings>, rerender?: boolean): void;
  newWindow(kind: WindowKind): void;
  resetLayout(): void;
  format(): void;
}

export class SettingsPanel {
  readonly #options: PanelOptions;
  readonly #element: HTMLElement;
  #open = false;
  #themesOpen = false;
  #windowKind: WindowKind = "preview";

  constructor(options: PanelOptions) {
    this.#options = options;
    this.#element = options.container;
    this.#element.hidden = true;

    // Clicking away or pressing Escape closes the panel, which is what every
    // popover in every other app does.
    document.addEventListener("pointerdown", (event) => {
      if (!this.#open) return;
      const target = event.target as Node;
      if (this.#element.contains(target)) return;
      if ((target as HTMLElement).closest?.("[data-panel-toggle]")) return;
      this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.#open) {
        event.preventDefault();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return this.#open;
  }

  toggle(): void {
    this.#open ? this.close() : this.open();
  }

  /** Fires after the panel opens or closes, for the toggle's aria state. */
  onToggle: ((open: boolean) => void) | null = null;

  open(): void {
    this.#open = true;
    this.#element.hidden = false;
    this.render();
    this.#element.querySelector<HTMLElement>("button, select")?.focus();
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
    const settings = this.#options.get();

    this.#element.replaceChildren(
      el("h2", { class: "panel-title", text: "Settings" }),
      this.#themeField(settings),
      this.#typeField(settings),
      this.#editorField(settings),
      this.#previewField(settings),
      this.#layoutField(settings),
      this.#packagesField(settings),
    );
  }

  #layoutField(settings: Settings): HTMLElement {
    const sides: Array<[boolean, string]> = [
      [false, "Left"],
      [true, "Right"],
    ];
    const kind = el("select") as HTMLSelectElement;
    for (const [id, name] of WINDOW_KINDS) {
      const option = el("option", { text: name }) as HTMLOptionElement;
      option.value = id;
      option.selected = id === this.#windowKind;
      kind.append(option);
    }
    kind.addEventListener("change", () => (this.#windowKind = kind.value as WindowKind));
    const open = button("Open", "Open another window (Alt + W opens a preview)", () =>
      this.#options.newWindow(this.#windowKind),
    );
    open.classList.remove("btn-icon");
    const glassNote: Record<GlassMode, string> = {
      solid: "The undocked editor is opaque.",
      tint: "Undocked, the editor's backgrounds go translucent so a window behind shows through the code.",
      clear: "Undocked, the editor has no background at all; only the text and its chrome are drawn.",
      glass: "Undocked, the editor blurs whatever is behind it, like frosted glass.",
    };
    const reset = button("Reset layout", "Back to the editor beside one docked preview", () =>
      this.#options.resetLayout(),
    );
    reset.classList.remove("btn-icon");
    const format = button("Format file", "Tidy the file on screen with typstyle (Shift + Alt + F, or :format in vim mode)", () =>
      this.#options.format(),
    );
    format.classList.remove("btn-icon");

    return el("div", { class: "field" }, [
      el("span", { class: "field-label", text: "Layout" }),
      row("Editor side", this.#choice(sides, settings.swapped, (swapped) => ({ swapped }))),
      row("New window", el("div", { class: "inline" }, [kind, open])),
      row("Editor background", this.#choice(GLASS_MODES, settings.editorGlass, (editorGlass) => ({ editorGlass }))),
      ...(settings.editorGlass === "tint" || settings.editorGlass === "glass"
        ? [row("Opacity", this.#range(settings.glassTint, 0, 1, 0.05, (glassTint) => ({ glassTint })))]
        : []),
      ...(settings.editorGlass === "glass"
        ? [row("Frost", this.#range(settings.glassFrost, 0, MAX_FROST, 1, (glassFrost) => ({ glassFrost })))]
        : []),
      el("div", { class: "field-note", text: glassNote[settings.editorGlass] }),
      el("div", { class: "field-note", text: "Each window's bar docks or undocks it. Floating windows drag by the bar and resize from any edge; edges snap (Alt to drag freely). Double-click a bar to tile it, Esc closes the front one. The editor undocks from the button beside its tabs. The layout is remembered, and saved with each document." }),
      el("div", { class: "inline inline-end" }, [format, reset]),
    ]);
  }

  #choice<T>(items: Array<[T, string]>, current: T, patch: (value: T) => Partial<Settings>): HTMLElement {
    return segmented(
      items.map(([value, label]) => ({
        label,
        pressed: current === value,
        onClick: () => this.#options.update(patch(value)),
      })),
    );
  }

  #range(value: number, min: number, max: number, step: number, patch: (value: number) => Partial<Settings>): HTMLElement {
    const input = el("input", { class: "slider", type: "range", min: String(min), max: String(max), step: String(step) }) as HTMLInputElement;
    input.value = String(value);
    input.addEventListener("input", () => this.#options.update(patch(Number(input.value)), false));
    return input;
  }

  #themeField(settings: Settings): HTMLElement {
    const current =
      settings.theme === "system"
        ? { id: "system", name: "Match system", note: "", kind: "dark" as const }
        : themeById(settings.theme);

    // Twenty-odd chips would bury every other setting, so the rack folds
    // away behind a summary showing the theme in use.
    const summary = el("summary", { class: "theme-summary" }, [
      el("span", { class: "field-label", text: "Theme" }),
      el("span", { class: "theme-current" }, [
        swatch(current),
        el("span", { text: current.name }),
      ]),
    ]);

    const details = el("details", { class: "theme-picker" }, [summary]) as HTMLDetailsElement;
    details.open = this.#themesOpen;
    details.addEventListener("toggle", () => (this.#themesOpen = details.open));

    const system = el("div", { class: "rack" }, [
      chip(
        { id: "system", name: "Match system", note: "", kind: "dark" },
        settings.theme === "system",
        () => this.#options.update({ theme: "system" }),
      ),
    ]);
    details.append(system);

    for (const kind of ["light", "dark"] as const) {
      const rack = el("div", { class: "rack" });
      for (const theme of THEMES.filter((th) => th.kind === kind)) {
        rack.append(
          chip(theme, settings.theme === theme.id, () =>
            this.#options.update({ theme: theme.id }),
          ),
        );
      }
      details.append(
        el("span", { class: "rack-label", text: kind === "light" ? "Light" : "Dark" }),
        rack,
      );
    }

    const field = el("div", { class: "field" }, [details]);

    if (settings.theme === "system") {
      const light = themeById(settings.lightTheme).name;
      const dark = themeById(settings.darkTheme).name;
      field.append(
        el("div", {
          class: "field-note",
          text: `Follows your operating system: ${light} when it is light, ${dark} when it is dark. Pick a theme to change the pair.`,
        }),
      );
    }
    return field;
  }

  #typeField(settings: Settings): HTMLElement {
    const select = el("select") as HTMLSelectElement;
    for (const font of FONT_STACKS) {
      const option = el("option", { text: font.name }) as HTMLOptionElement;
      option.value = font.id;
      option.selected = font.id === settings.fontFamily;
      // Previewing each face in the dropdown saves a round of trial and error.
      option.style.fontFamily = font.stack;
      select.append(option);
    }
    select.addEventListener("change", () =>
      this.#options.update({ fontFamily: select.value }),
    );

    const note = FONT_STACKS.find((f) => f.id === settings.fontFamily)?.note ?? "";
    const size = settings.fontSize;

    return el("div", { class: "field" }, [
      el("span", { class: "field-label", text: "Typeface" }),
      select,
      el("div", { class: "field-note", text: note }),
      row(
        "Size",
        stepper(
          `${size}px`,
          size > MIN_FONT_SIZE,
          size < MAX_FONT_SIZE,
          (delta) => this.#options.update({ fontSize: size + delta }),
        ),
      ),
      row("Line spacing", this.#leadingControl(settings)),
    ]);
  }

  #leadingControl(settings: Settings): HTMLElement {
    const options: Array<[Leading, string]> = [
      ["tight", "Tight"],
      ["normal", "Normal"],
      ["loose", "Loose"],
    ];
    return segmented(
      options.map(([value, label]) => ({
        label,
        pressed: settings.leading === value,
        onClick: () => this.#options.update({ leading: value }),
      })),
    );
  }

  #editorField(settings: Settings): HTMLElement {
    const keymaps: Array<[Keymap, string]> = [
      ["default", "Standard"],
      ["vim", "Vim"],
    ];

    return el("div", { class: "field" }, [
      el("span", { class: "field-label", text: "Editor" }),
      row(
        "Key bindings",
        segmented(
          keymaps.map(([value, label]) => ({
            label,
            pressed: settings.keymap === value,
            onClick: () => this.#options.update({ keymap: value }),
          })),
        ),
      ),
      row(
        "Line numbers",
        toggle(settings.lineNumbers, (on) =>
          this.#options.update({ lineNumbers: on }),
        ),
      ),
      row(
        "Wrap long lines",
        toggle(settings.wrap, (on) => this.#options.update({ wrap: on })),
      ),
      settings.keymap === "vim"
        ? el("div", {
            class: "field-note",
            text: isTouchScreen()
              ? "The mode and : commands appear along the bottom of the editor. Vim needs a hardware keyboard: on-screen keyboards have no Esc key."
              : "The mode and : commands appear along the bottom of the editor.",
          })
        : el("span"),
    ]);
  }

  #packagesField(settings: Settings): HTMLElement {
    return el("div", { class: "field" }, [
      el("span", { class: "field-label", text: "Packages" }),
      row(
        "Download imported packages",
        toggle(settings.downloadPackages, (on) =>
          this.#options.update({ downloadPackages: on }),
        ),
      ),
      el("div", {
        class: "field-note",
        text: settings.downloadPackages
          ? "Fetches @preview packages from packages.typst.org and keeps them for offline use. Only the package name and version are sent — never your document."
          : "Documents that import a package will not compile until you turn this back on.",
      }),
    ]);
  }

  #previewField(settings: Settings): HTMLElement {
    return el("div", { class: "field" }, [
      el("span", { class: "field-label", text: "Preview" }),
      row(
        "Pages",
        this.#choice(
          PAGE_LAYOUTS.map(([id, name]) => [id, name] as [typeof id, string]),
          settings.pageLayout,
          (pageLayout) => ({ pageLayout }),
        ),
      ),
      row(
        "Dim the page",
        toggle(settings.dimPage, (on) => this.#options.update({ dimPage: on })),
      ),
      el("div", {
        class: "field-note",
        text: "Darkens the preview only. Exported PDFs keep their real colours.",
      }),
    ]);
  }
}

/** A theme chip: a small sheet of that theme's paper, ink and accent. */
function chip(theme: Theme, pressed: boolean, onClick: () => void): HTMLElement {
  const button = el("button", { class: "chip", type: "button" }) as HTMLButtonElement;
  button.setAttribute("aria-pressed", String(pressed));
  button.title = theme.note ? `${theme.name} — ${theme.note}` : theme.name;

  // Setting `data-theme` on the chip re-binds the palette variables for its
  // whole subtree, so the chip paints itself in the theme it offers. The
  // "Match system" chip carries no attribute and so shows the active theme —
  // which is exactly what picking it would give you.
  if (theme.id !== "system") {
    button.dataset["theme"] = theme.id;
  }

  button.append(
    el("span", { class: "chip-face", text: "Aa" }),
    el("span", { class: "chip-rule" }),
    el("span", { class: "chip-name", text: theme.name }),
  );
  button.addEventListener("click", onClick);
  return button;
}

/** A tiny strip of a theme's paper, accent and hues, for the folded summary. */
function swatch(theme: Theme): HTMLElement {
  const strip = el("span", { class: "theme-swatch" });
  if (theme.id !== "system") strip.dataset["theme"] = theme.id;
  for (const hue of ["accent", "c-magenta", "c-green", "c-orange"]) {
    strip.append(el("span", { style: `background: var(--${hue})` }));
  }
  return strip;
}

function row(label: string, control: HTMLElement): HTMLElement {
  return el("div", { class: "row" }, [
    el("span", { class: "row-label", text: label }),
    control,
  ]);
}

function toggle(on: boolean, onChange: (on: boolean) => void): HTMLElement {
  const input = el("input") as HTMLInputElement;
  input.type = "checkbox";
  input.checked = on;
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "switch" }, [
    input,
    el("span", { class: "switch-track" }),
  ]);
}

function stepper(
  value: string,
  canDecrease: boolean,
  canIncrease: boolean,
  onStep: (delta: number) => void,
): HTMLElement {
  const minus = button("−", "Smaller", () => onStep(-1));
  const plus = button("+", "Larger", () => onStep(1));
  minus.disabled = !canDecrease;
  plus.disabled = !canIncrease;
  return el("div", { class: "stepper" }, [
    minus,
    el("span", { class: "stepper-value", text: value }),
    plus,
  ]);
}

function segmented(
  items: Array<{ label: string; pressed: boolean; onClick: () => void }>,
): HTMLElement {
  const group = el("div", { class: "segmented" });
  for (const item of items) {
    const element = button(item.label, item.label, item.onClick);
    element.setAttribute("aria-pressed", String(item.pressed));
    group.append(element);
  }
  return group;
}

function button(
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const element = el("button", {
    class: "btn btn-icon",
    type: "button",
    text: label,
  }) as HTMLButtonElement;
  element.title = title;
  element.addEventListener("click", onClick);
  return element;
}

function el(
  tag: string,
  attributes: Record<string, string> = {},
  children: Element[] = [],
): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "text") {
      element.textContent = value;
    } else {
      element.setAttribute(name, value);
    }
  }
  element.append(...children);
  return element;
}
