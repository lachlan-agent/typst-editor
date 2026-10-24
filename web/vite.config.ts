import { defineConfig } from "vite";

export default defineConfig({
  // Served from a subpath of the monorepo Pages site, so use relative asset
  // URLs. Local `vite dev` and `vite preview` handle the base transparently.
  base: "./",
  build: {
    target: "es2022",
    // The wasm module dwarfs everything else; warning about it on every build
    // is noise.
    chunkSizeWarningLimit: 32_000,
  },
  worker: {
    format: "es",
  },
  server: {
    // src/windows.ts re-exports the shared window system from the repo root.
    fs: { allow: [".", "../shared"] },
  },
  // `.wasm` is served as an asset and instantiated explicitly by the worker,
  // which avoids needing a wasm-specific Vite plugin.
  assetsInclude: ["**/*.otf", "**/*.ttf"],
  test: {
    // `*.network.test.ts` talks to packages.typst.org. Kept out of the default
    // run so the suite stays deterministic offline; `npm run test:network`
    // sets NETWORK_TESTS to exercise it deliberately.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(process.env["NETWORK_TESTS"] ? [] : ["**/*.network.test.ts"]),
    ],
  },
});
