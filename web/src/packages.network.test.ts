import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => void store.set(k, v),
  del: async (k: string) => void store.delete(k),
}));

import init, { TypstEngine, starterPath } from "./wasm/typst_wasm.js";
import { FONT_FILES } from "./fonts";
import { loadPackage } from "./packages";

describe("a real package from the live registry", () => {
  it("downloads from the registry and compiles", async () => {
    await init({
      module_or_path: await readFile(
        fileURLToPath(new URL("./wasm/typst_wasm_bg.wasm", import.meta.url)),
      ),
    });
    const engine = new TypstEngine(Date.UTC(2024, 4, 17));
    const fontDir = new URL("../public/fonts/", import.meta.url);
    for (const name of FONT_FILES) {
      engine.addFont(
        new Uint8Array(await readFile(fileURLToPath(new URL(name, fontDir)))),
      );
    }

    engine.setSource(
      starterPath(),
      '#import "@preview/oxifmt:0.2.1": strfmt\n\n#strfmt("{} and {}", 1, 2)\n',
    );
    engine.setMain(starterPath());

    // The resolve loop, exactly as main.ts runs it.
    for (let round = 0; round < 8; round++) {
      const missing = engine.missingPackages() as string[];
      console.log("round", round, "missing:", missing);
      if (missing.length === 0) break;
      for (const spec of missing) {
        const files = await loadPackage(spec);
        for (const f of files) engine.addPackageFile(spec, f.path, f.data);
        engine.markPackageLoaded(spec);
        console.log("  loaded", spec, `(${files.length} files)`);
      }
    }

    const out = engine.compileSvg() as { pages: string[]; diagnostics: unknown[] };
    console.log("diagnostics:", JSON.stringify(out.diagnostics));
    expect(out.diagnostics).toEqual([]);
    expect(out.pages).toHaveLength(1);
    // strfmt should have produced "1 and 2" in the rendered output.
    console.log("svg length:", out.pages[0]!.length);

    const pdf = engine.compilePdf() as { data: Uint8Array | null };
    expect(pdf.data).toBeInstanceOf(Uint8Array);
    console.log("pdf bytes:", pdf.data!.length);
  }, 180_000);
});
