import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readTar, stripCommonPrefix } from "./tar";

/**
 * Builds a real archive with the system `tar`, so the parser is checked
 * against the format as actually produced rather than one we wrote ourselves.
 */
function buildArchive(
  files: Record<string, string>,
  options: { gzip?: boolean } = {},
): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "tartest-"));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  const archive = join(dir, "out.tar");
  execFileSync("tar", [
    options.gzip ? "-czf" : "-cf",
    archive,
    "-C",
    dir,
    ...Object.keys(files),
  ]);
  return new Uint8Array(readFileSync(archive));
}

function asText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("readTar", () => {
  it("reads a single file", () => {
    const entries = readTar(buildArchive({ "typst.toml": "[package]\n" }));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("typst.toml");
    expect(asText(entries[0]!.data)).toBe("[package]\n");
  });

  it("reads several files including nested paths", () => {
    const entries = readTar(
      buildArchive({
        "typst.toml": "[package]\nname = \"demo\"\n",
        "src/lib.typ": "#let x = 1\n",
        "README.md": "# demo\n",
      }),
    );
    const byName = new Map(entries.map((e) => [e.name, asText(e.data)]));
    expect(byName.get("typst.toml")).toContain("demo");
    expect(byName.get("src/lib.typ")).toBe("#let x = 1\n");
    expect(byName.get("README.md")).toBe("# demo\n");
  });

  it("skips directory entries", () => {
    const entries = readTar(buildArchive({ "src/lib.typ": "x" }));
    expect(entries.map((e) => e.name)).not.toContain("src/");
    expect(entries.every((e) => !e.name.endsWith("/"))).toBe(true);
  });

  it("preserves exact bytes of a file that is not a multiple of 512", () => {
    const contents = "a".repeat(1000);
    const entries = readTar(buildArchive({ "big.typ": contents }));
    expect(entries[0]!.data).toHaveLength(1000);
    expect(asText(entries[0]!.data)).toBe(contents);
  });

  it("handles an empty file", () => {
    const entries = readTar(buildArchive({ "empty.typ": "" }));
    const empty = entries.find((e) => e.name === "empty.typ");
    expect(empty).toBeDefined();
    expect(empty!.data).toHaveLength(0);
  });

  it("handles a name longer than the 100-byte header field", () => {
    const deep = `${"nested/".repeat(20)}lib.typ`;
    const entries = readTar(buildArchive({ [deep]: "deep" }));
    const found = entries.find((e) => e.name.endsWith("lib.typ"));
    expect(found).toBeDefined();
    expect(found!.name).toBe(deep);
    expect(asText(found!.data)).toBe("deep");
  });

  it("preserves UTF-8 content", () => {
    const entries = readTar(buildArchive({ "u.typ": "Grüße 🎉 日本語" }));
    expect(asText(entries[0]!.data)).toBe("Grüße 🎉 日本語");
  });

  it("returns nothing for an archive of only zero blocks", () => {
    expect(readTar(new Uint8Array(1024))).toEqual([]);
  });

  it("returns nothing rather than throwing on a truncated header", () => {
    expect(readTar(new Uint8Array(100))).toEqual([]);
  });
});

describe("stripCommonPrefix", () => {
  it("removes a shared wrapping directory", () => {
    const stripped = stripCommonPrefix([
      { name: "pkg/typst.toml", data: new Uint8Array() },
      { name: "pkg/lib.typ", data: new Uint8Array() },
    ]);
    expect(stripped.map((e) => e.name)).toEqual(["typst.toml", "lib.typ"]);
  });

  it("leaves entries alone when they share no prefix", () => {
    const entries = [
      { name: "typst.toml", data: new Uint8Array() },
      { name: "lib.typ", data: new Uint8Array() },
    ];
    expect(stripCommonPrefix(entries).map((e) => e.name)).toEqual([
      "typst.toml",
      "lib.typ",
    ]);
  });

  it("leaves entries alone when only some share the prefix", () => {
    const entries = [
      { name: "pkg/typst.toml", data: new Uint8Array() },
      { name: "other.typ", data: new Uint8Array() },
    ];
    expect(stripCommonPrefix(entries).map((e) => e.name)).toEqual([
      "pkg/typst.toml",
      "other.typ",
    ]);
  });

  it("handles an empty list", () => {
    expect(stripCommonPrefix([])).toEqual([]);
  });
});

export { buildArchive };
