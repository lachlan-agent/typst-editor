// The Reference window: the shortcuts, the windows, and a Typst crib sheet.

const KEYS: Array<[string, string]> = [
  ["Ctrl/⌘ + S", "save to the document list (Ctrl/⌘ + Shift + S saves a copy)"],
  ["Ctrl/⌘ + E", "export PDF"],
  ["Shift + Alt + F", "format the file (or :format in vim mode)"],
  ["Ctrl/⌘ + ,", "settings"],
  ["Alt + W", "new window"],
  ["Esc", "close the front floating window"],
];

const WINDOWS: Array<[string, string]> = [
  ["Bar", "drag to move a floating window; its buttons dock, undock or close it"],
  ["Edges", "resize from any edge or corner; edges snap to other windows (Alt to drag freely)"],
  ["Double-click bar", "cycle a floating window through halves and quarters of the screen"],
  ["Double-click editor bar", "dock the editor back into the split"],
];

const TYPST: Array<[string, string]> = [
  ["= Heading", "heading; == for the next level"],
  ["*bold* _italic_ `code`", "inline markup"],
  ["- item / + item", "bullet and numbered lists"],
  ["$a^2 + b^2 = c^2$", "inline math; on its own lines with spaces for display"],
  ["#let f(x) = x + 1", "a function or constant"],
  ["#set text(size: 11pt)", "set a default for everything after"],
  ["#show heading: it => …", "transform every element of a kind"],
  ["#image(\"photo.png\")", "a file in this project (add it from the tabs)"],
  ["#import \"@preview/cetz:0.3.1\"", "a package, downloaded on first use"],
  ["@label / <label>", "reference a figure, heading or equation"],
];

function table(rows: Array<[string, string]>): string {
  return `<table>${rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("")}</table>`;
}

function esc(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

export const REFERENCE_HTML = `
<h3>Shortcuts</h3>
${table(KEYS)}
<h3>Windows</h3>
${table(WINDOWS)}
<h3>Typst</h3>
<p>The main file (badged in the tabs) is what the preview compiles; other files are chapters or assets it can include. Hover a function for its documentation, or press F1.</p>
${table(TYPST)}
<p>The full reference lives at <a href="https://typst.app/docs" target="_blank" rel="noopener">typst.app/docs</a>.</p>
`;
