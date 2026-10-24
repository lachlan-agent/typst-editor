/// <reference lib="webworker" />

/**
 * Owns the wasm compiler for the lifetime of the session.
 *
 * The engine is created once and never replaced: `comemo`'s incremental cache
 * only pays off across compiles, so throwing the engine away per keystroke
 * would make every edit a cold compile.
 */

import init, {
  TypstEngine,
  starterDocument,
  starterPath,
} from "./wasm/typst_wasm.js";
import wasmUrl from "./wasm/typst_wasm_bg.wasm?url";
import type { Envelope, Reply, Request, VirtualFile } from "./protocol";

let engine: TypstEngine | null = null;

/**
 * The wasm instantiation, memoized.
 *
 * The generated glue guards against a *sequential* second `init`, but two
 * overlapping calls both get past that guard and instantiate a 25 MB module
 * twice. `init` and `starter` do overlap on startup.
 */
let loading: Promise<unknown> | null = null;

function load(): Promise<unknown> {
  loading ??= init({ module_or_path: wasmUrl });
  return loading;
}

/** Compiles performed since the last cache eviction. */
let compilesSinceEvict = 0;

/** How many compiles a memoized result may go untouched before it is dropped. */
const EVICT_MAX_AGE = 30;

/** How often to run eviction, in compiles. */
const EVICT_EVERY = 20;

async function handleInit(
  fontUrls: string[],
  localNowMs: number,
): Promise<{ fontCount: number }> {
  await load();
  const created = new TypstEngine(localNowMs);

  // Fonts are fetched in parallel but registered in the order given, so the
  // font book is deterministic regardless of which response lands first.
  const fonts = await Promise.all(
    fontUrls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`failed to load font ${url}: ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  for (const font of fonts) {
    created.addFont(font);
  }

  engine = created;
  return { fontCount: created.fontCount() };
}

function requireEngine(): TypstEngine {
  if (!engine) {
    throw new Error("the compiler has not finished loading yet");
  }
  return engine;
}

function write(files: VirtualFile[], removed: string[], main: string): null {
  const current = requireEngine();
  for (const path of removed) {
    current.removeFile(path);
  }
  for (const file of files) {
    if (file.text !== undefined) {
      current.setSource(file.path, file.text);
    } else if (file.bytes !== undefined) {
      current.setBinary(file.path, file.bytes);
    }
  }
  current.setMain(main);
  return null;
}

function compileSvg() {
  const current = requireEngine();
  const started = performance.now();
  const output = current.compileSvg() as {
    pages: string[];
    diagnostics: unknown[];
  };
  const elapsedMs = performance.now() - started;

  if (++compilesSinceEvict >= EVICT_EVERY) {
    compilesSinceEvict = 0;
    current.evict(EVICT_MAX_AGE);
  }

  return { ...output, elapsedMs };
}

async function dispatch(request: Request): Promise<unknown> {
  switch (request.kind) {
    case "init":
      return handleInit(request.fontUrls, request.localNowMs);
    case "write":
      return write(request.files, request.removed, request.main);
    case "compileSvg":
      return compileSvg();
    case "compilePdf":
      return requireEngine().compilePdf();
    case "highlight":
      return requireEngine().highlight(request.path);
    case "autocomplete":
      return requireEngine().autocomplete(
        request.path,
        request.cursor,
        request.explicit,
      );
    case "hover":
      return requireEngine().hover(request.path, request.cursor);
    case "missingPackages":
      return requireEngine().missingPackages();
    case "addPackage": {
      const engine = requireEngine();
      for (const file of request.files) {
        engine.addPackageFile(request.spec, file.path, file.data);
      }
      // Only after every file, so a partial write can never be mistaken for a
      // complete package.
      engine.markPackageLoaded(request.spec);
      return null;
    }
    case "format":
      return requireEngine().format(request.text, request.maxWidth, request.tabSpaces);
    case "starter":
      await load();
      return { path: starterPath(), text: starterDocument() };
  }
}

self.addEventListener("message", (event: MessageEvent<Envelope>) => {
  const { id, request } = event.data;
  dispatch(request).then(
    (value) => {
      const reply: Reply = { id, ok: true, value };
      self.postMessage(reply);
    },
    (error: unknown) => {
      const reply: Reply = {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(reply);
    },
  );
});
