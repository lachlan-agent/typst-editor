/**
 * The fonts shipped with the editor.
 *
 * Libertinus Serif is Typst's default text font, New Computer Modern covers
 * documents that ask for it (and its math face backs every equation), and
 * DejaVu Sans Mono is what `raw` blocks fall back to.
 */
export const FONT_FILES = [
  "LibertinusSerif-Regular.otf",
  "LibertinusSerif-Bold.otf",
  "LibertinusSerif-Italic.otf",
  "LibertinusSerif-BoldItalic.otf",
  "NewCM10-Regular.otf",
  "NewCM10-Bold.otf",
  "NewCM10-Italic.otf",
  "NewCM10-BoldItalic.otf",
  "NewCMMath-Regular.otf",
  "DejaVuSansMono.ttf",
  "DejaVuSansMono-Bold.ttf",
  "DejaVuSansMono-Oblique.ttf",
  "DejaVuSansMono-BoldOblique.ttf",
] as const;

/** URLs to fetch the fonts from, resolved against the deployed base path. */
export function fontUrls(): string[] {
  return FONT_FILES.map(
    (name) => new URL(`fonts/${name}`, document.baseURI).href,
  );
}
