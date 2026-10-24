/**
 * The theme registry.
 *
 * Palettes live in `themes.css`; this module only names them, says whether
 * each is light or dark, and applies one to the document.
 */

export type ThemeKind = "light" | "dark";

export interface Theme {
  id: string;
  /** Shown in the picker. */
  name: string;
  /** One line on why you would pick it. */
  note: string;
  kind: ThemeKind;
}

export const THEMES: Theme[] = [
  { id: "chalk", name: "Chalk", note: "White and crisp", kind: "light" },
  { id: "newsprint", name: "Newsprint", note: "Cool grey, softer contrast", kind: "light" },
  { id: "vellum", name: "Vellum", note: "Warm paper, ink blue", kind: "light" },
  { id: "solarized-light", name: "Solarized Light", note: "The classic", kind: "light" },
  { id: "gruvbox-light", name: "Gruvbox Light", note: "Warm retro, faded ink", kind: "light" },
  { id: "catppuccin-latte", name: "Catppuccin Latte", note: "Soft pastels on cool white", kind: "light" },
  { id: "rose-pine-dawn", name: "Rosé Pine Dawn", note: "Muted rose and gold", kind: "light" },
  { id: "tangerine", name: "Tangerine", note: "Peach paper, saturated ink", kind: "light" },
  { id: "sorbet", name: "Sorbet", note: "Pink-white, candy accents", kind: "light" },
  { id: "nocturne", name: "Nocturne", note: "Neutral near-black", kind: "dark" },
  { id: "slate", name: "Slate", note: "Blue-grey, easy on the eyes", kind: "dark" },
  { id: "oxide", name: "Oxide", note: "Warm dark, copper accent", kind: "dark" },
  { id: "ember", name: "Ember", note: "Charred brown, glowing orange", kind: "dark" },
  { id: "lava", name: "Lava", note: "Red-black, molten accents", kind: "dark" },
  { id: "marigold", name: "Marigold", note: "Dark umber, saturated gold", kind: "dark" },
  { id: "sunset", name: "Sunset", note: "Plum dusk, coral and pink", kind: "dark" },
  { id: "carnival", name: "Carnival", note: "Ink-blue night, every colour at once", kind: "dark" },
  { id: "synthwave", name: "Synthwave", note: "Purple neon, retro arcade", kind: "dark" },
  { id: "lagoon", name: "Lagoon", note: "Deep teal, tropical brights", kind: "dark" },
  { id: "monokai", name: "Monokai", note: "The vivid classic", kind: "dark" },
  { id: "dracula", name: "Dracula", note: "Purple-grey, candy brights", kind: "dark" },
  { id: "solarized-dark", name: "Solarized Dark", note: "The classic", kind: "dark" },
  { id: "nord", name: "Nord", note: "Arctic blue-grey", kind: "dark" },
  { id: "gruvbox-dark", name: "Gruvbox Dark", note: "Warm retro terminal", kind: "dark" },
  { id: "tokyo-night", name: "Tokyo Night", note: "Indigo night, neon accents", kind: "dark" },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", note: "Soft pastels, cosy dark", kind: "dark" },
  { id: "rose-pine", name: "Rosé Pine", note: "Muted rose, low contrast", kind: "dark" },
  { id: "contrast", name: "Contrast", note: "Black and white at AAA", kind: "dark" },
  { id: "paper", name: "Paper", note: "GitHub’s light palette", kind: "light" },
  { id: "ayu-light", name: "Ayu Light", note: "Pale grey, warm oranges", kind: "light" },
  { id: "midnight", name: "Midnight", note: "Blue-black, One Dark hues", kind: "dark" },
  { id: "everforest", name: "Everforest", note: "Forest greens, soft contrast", kind: "dark" },
];

export const DEFAULT_LIGHT = "chalk";
export const DEFAULT_DARK = "nocturne";

const byId = new Map(THEMES.map((theme) => [theme.id, theme]));

export function themeById(id: string): Theme {
  return byId.get(id) ?? byId.get(DEFAULT_DARK)!;
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** Whether the operating system is currently asking for a dark interface. */
export function systemPrefersDark(): boolean {
  return darkQuery.matches;
}

export function onSystemSchemeChange(listener: () => void): void {
  darkQuery.addEventListener("change", listener);
}

/**
 * Resolves a stored preference — a theme id, or `"system"` — to a real theme.
 */
export function resolveTheme(
  preference: string,
  lightId: string,
  darkId: string,
): Theme {
  if (preference !== "system") return themeById(preference);
  return themeById(systemPrefersDark() ? darkId : lightId);
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset["theme"] = theme.id;
  // Tells the browser which way to paint scrollbars, form controls and the
  // canvas behind the page.
  root.style.colorScheme = theme.kind;
}
