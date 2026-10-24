import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readTar } from "./tar";
import { writeTar } from "./tarWrite";

describe("writeTar", () => {
  const files = [
    { path: "main.typ", data: new TextEncoder().encode("= Hello\n") },
    { path: "img/dot.bin", data: new Uint8Array([0, 1, 2, 255]) },
    { path: "a/".repeat(60) + "deep.typ", data: new TextEncoder().encode("x") },
    // No slash to split at: needs a GNU long-name record.
    { path: "n".repeat(120) + ".typ", data: new TextEncoder().encode("y") },
    // 70 characters but 140 bytes: lengths must be counted in bytes.
    { path: "img/" + "ü".repeat(70) + ".png", data: new Uint8Array([9]) },
  ];

  it("round-trips through readTar", () => {
    const entries = readTar(writeTar(files));
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.path));
    expect([...entries[1]!.data]).toEqual([0, 1, 2, 255]);
  });

  it("is an archive the system tar accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "typst-tarwrite-"));
    const archive = join(dir, "p.tar");
    writeFileSync(archive, writeTar(files));
    const listing = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).trim().split("\n");
    expect(listing).toEqual(files.map((f) => f.path));
  });
});
