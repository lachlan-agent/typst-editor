/**
 * Drives the compiled `.wasm` through its real JavaScript bindings.
 *
 * The Rust tests cover the engine natively; this one covers the layer the
 * browser actually touches — the wasm-bindgen glue, the typed-array marshalling
 * and the shape of the values the worker forwards to the UI.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import init, {
  TypstEngine,
  starterDocument,
  starterPath,
} from "./wasm/typst_wasm.js";
import { FONT_FILES } from "./fonts";
import type { Diagnostic, Token } from "./protocol";

const fontDir = new URL("../public/fonts/", import.meta.url);
const wasmPath = fileURLToPath(new URL("./wasm/typst_wasm_bg.wasm", import.meta.url));

let fonts: Uint8Array[];

beforeAll(async () => {
  await init({ module_or_path: await readFile(wasmPath) });
  fonts = await Promise.all(
    FONT_FILES.map(async (name) =>
      new Uint8Array(await readFile(fileURLToPath(new URL(name, fontDir)))),
    ),
  );
}, 120_000);

function newEngine(): TypstEngine {
  const engine = new TypstEngine(Date.UTC(2024, 4, 17));
  for (const font of fonts) engine.addFont(font);
  return engine;
}

describe("the wasm bindings", () => {
  it("formats source with typstyle, and refuses what does not parse", () => {
    const engine = newEngine();
    expect(engine.format("#let  f(x)={x+1}\n= Title\n", 80, 2)).toContain("#let f(x) = { x + 1 }");
    expect(() => engine.format("#let (", 80, 2)).toThrow(/syntax/i);
  });

  it("registers every bundled font", () => {
    expect(newEngine().fontCount()).toBeGreaterThanOrEqual(FONT_FILES.length);
  });

  it("compiles to SVG", () => {
    const engine = newEngine();
    engine.setSource(starterPath(), "= Hello\n\nSome #emph[text].");
    engine.setMain(starterPath());

    const output = engine.compileSvg() as {
      pages: string[];
      diagnostics: Diagnostic[];
    };
    expect(output.diagnostics).toEqual([]);
    expect(output.pages).toHaveLength(1);
    expect(output.pages[0]).toMatch(/^<svg/);
  });

  it("compiles the starter document without errors", () => {
    const engine = newEngine();
    engine.setSource(starterPath(), starterDocument());
    engine.setMain(starterPath());

    const output = engine.compileSvg() as {
      pages: string[];
      diagnostics: Diagnostic[];
    };
    expect(output.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(output.pages.length).toBeGreaterThan(0);
  });

  it("reports diagnostics with byte offsets into the source", () => {
    const engine = newEngine();
    const text = "Fine.\n\n#nope()\n";
    engine.setSource(starterPath(), text);
    engine.setMain(starterPath());

    const output = engine.compileSvg() as {
      pages: string[];
      diagnostics: Diagnostic[];
    };
    const error = output.diagnostics.find((d) => d.severity === "error");
    expect(error).toBeDefined();
    expect(error!.path).toBe(starterPath());
    expect(text.slice(error!.from!, error!.to!)).toBe("nope");
  });

  it("reports byte offsets, not character offsets, for non-ASCII text", () => {
    const engine = newEngine();
    // "Grüße" is 5 characters but 7 UTF-8 bytes; a character-offset span would
    // point two bytes short of the error.
    const text = "Grüße\n\n#nope()\n";
    engine.setSource(starterPath(), text);
    engine.setMain(starterPath());

    const output = engine.compileSvg() as { diagnostics: Diagnostic[] };
    const error = output.diagnostics.find((d) => d.severity === "error")!;
    const bytes = new TextEncoder().encode(text);
    expect(new TextDecoder().decode(bytes.slice(error.from!, error.to!))).toBe(
      "nope",
    );
  });

  it("exports a PDF as a typed array", () => {
    const engine = newEngine();
    engine.setSource(starterPath(), "= Hello");
    engine.setMain(starterPath());

    const output = engine.compilePdf() as {
      data: Uint8Array | null;
      diagnostics: Diagnostic[];
    };
    expect(output.data).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(output.data!.slice(0, 5))).toBe("%PDF-");
  });

  it("returns highlighting tokens", () => {
    const engine = newEngine();
    engine.setSource(starterPath(), "= Heading\n\n#let x = 1\n");
    const tokens = engine.highlight(starterPath()) as Token[];
    expect(tokens.map((t) => t.tag)).toEqual(
      expect.arrayContaining(["heading", "keyword", "number"]),
    );
  });

  it("resolves includes across files", () => {
    const engine = newEngine();
    engine.setSource(starterPath(), '#include "/chapter.typ"');
    engine.setSource("/chapter.typ", "= Chapter");
    engine.setMain(starterPath());

    const output = engine.compileSvg() as {
      pages: string[];
      diagnostics: Diagnostic[];
    };
    expect(output.diagnostics).toEqual([]);
    expect(output.pages).toHaveLength(1);
  });

  it("keeps compiling correctly after a removed file is re-added", () => {
    const engine = newEngine();
    engine.setSource(starterPath(), '#include "/chapter.typ"');
    engine.setSource("/chapter.typ", "= Chapter");
    engine.setMain(starterPath());
    expect((engine.compileSvg() as { pages: string[] }).pages).toHaveLength(1);

    engine.removeFile("/chapter.typ");
    const broken = engine.compileSvg() as { diagnostics: Diagnostic[] };
    expect(broken.diagnostics.some((d) => d.severity === "error")).toBe(true);

    engine.setSource("/chapter.typ", "= Chapter again");
    expect((engine.compileSvg() as { pages: string[] }).pages).toHaveLength(1);
  });

  it("reports the packages a document imports", () => {
    const engine = newEngine();
    engine.setSource(
      starterPath(),
      '#import "@preview/one:1.0.0": *\n#import "@preview/two:2.1.0"\n',
    );
    engine.setMain(starterPath());

    expect(engine.missingPackages()).toEqual([
      "@preview/one:1.0.0",
      "@preview/two:2.1.0",
    ]);
  });

  it("compiles a document against a package pushed through the bindings", () => {
    const engine = newEngine();
    const encoder = new TextEncoder();
    engine.setSource(
      starterPath(),
      '#import "@preview/greet:1.0.0": hello\n#hello[world]',
    );
    engine.setMain(starterPath());

    const spec = "@preview/greet:1.0.0";
    engine.addPackageFile(
      spec,
      "/typst.toml",
      encoder.encode(
        '[package]\nname = "greet"\nversion = "1.0.0"\nentrypoint = "lib.typ"\n',
      ),
    );
    engine.addPackageFile(
      spec,
      "/lib.typ",
      encoder.encode("#let hello(body) = [Hello, #body!]"),
    );
    engine.markPackageLoaded(spec);

    expect(engine.missingPackages()).toEqual([]);
    const output = engine.compileSvg() as {
      pages: string[];
      diagnostics: Diagnostic[];
    };
    expect(output.diagnostics).toEqual([]);
    expect(output.pages).toHaveLength(1);
  });

  it("rejects a malformed package spec instead of dropping the file", () => {
    const engine = newEngine();
    expect(() =>
      engine.addPackageFile("not-a-spec", "/lib.typ", new Uint8Array([1])),
    ).toThrow(/invalid package spec/);
  });

  it("offers function completions after a hash", () => {
    const engine = newEngine();
    const text = "#im";
    engine.setSource(starterPath(), text);
    engine.setMain(starterPath());

    const result = engine.autocomplete(starterPath(), text.length, false) as {
      from: number;
      items: Array<{ label: string; kind: string; detail: string | null }>;
    };
    expect(result.items.map((i) => i.label)).toContain("image");
    expect(result.from).toBeLessThanOrEqual(text.length);
  });

  it("offers label completions once the document has been compiled", () => {
    const engine = newEngine();
    const text = "= Intro <intro>\n\nSee @";
    engine.setSource(starterPath(), text);
    engine.setMain(starterPath());
    engine.compileSvg();

    const result = engine.autocomplete(starterPath(), text.length, false) as {
      items: Array<{ label: string }>;
    };
    expect(result.items.map((i) => i.label)).toContain("intro");
  });

  it("returns documentation on hover", () => {
    const engine = newEngine();
    engine.setSource(starterPath(), "#emph[hi]");
    engine.setMain(starterPath());

    const hover = engine.hover(starterPath(), 3) as {
      kind: string;
      value: string;
    } | null;
    expect(hover).not.toBeNull();
    expect(hover!.value.length).toBeGreaterThan(0);
  });

  it("returns null hovering plain prose", () => {
    const engine = newEngine();
    engine.setSource(starterPath(), "Just some words.");
    engine.setMain(starterPath());
    expect(engine.hover(starterPath(), 5)).toBeNull();
  });

  it("sends absent values as null, not undefined", () => {
    // `showDiagnostics` skips spanless diagnostics with a `=== null` check,
    // which silently fails if the wasm layer emits `undefined` instead.
    const engine = newEngine();
    engine.setSource(starterPath(), "#im");
    engine.setMain(starterPath());

    const result = engine.autocomplete(starterPath(), 3, false) as {
      items: Array<{ apply: string | null; detail: string | null }>;
    };
    for (const item of result.items) {
      expect(item.apply).not.toBeUndefined();
      expect(item.detail).not.toBeUndefined();
    }

    const out = engine.compileSvg() as { diagnostics: Diagnostic[] };
    for (const diagnostic of out.diagnostics) {
      expect(diagnostic.path).not.toBeUndefined();
      expect(diagnostic.from).not.toBeUndefined();
      expect(diagnostic.to).not.toBeUndefined();
    }
  });

  it("survives a cursor inside a multi-byte character", () => {
    const engine = newEngine();
    engine.setSource(starterPath(), "Grüße #im");
    engine.setMain(starterPath());
    // Byte 4 is the middle of "ü" — must clamp rather than panic.
    expect(() => engine.autocomplete(starterPath(), 4, false)).not.toThrow();
    expect(() => engine.hover(starterPath(), 4)).not.toThrow();
  });

  it("survives eviction of the incremental cache", () => {
    const engine = newEngine();
    engine.setSource(starterPath(), "= Hello");
    engine.setMain(starterPath());
    engine.compileSvg();
    engine.evict(0);
    expect((engine.compileSvg() as { pages: string[] }).pages).toHaveLength(1);
  });
});
