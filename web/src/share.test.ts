import { describe, expect, it } from "vitest";
import { Project } from "./project";
import {
  decodeShare,
  deserializeProject,
  encodeShare,
  fromBase64Url,
  serializeProject,
  ShareTooLargeError,
  toBase64Url,
} from "./share";

function sampleProject(): Project {
  const project = new Project("/main.typ");
  project.writeText("/main.typ", '= Hallo\n\n#include "/kapitel.typ"\n');
  project.writeText("/kapitel.typ", "Grüße — mit Unicode 🎉\n");
  project.writeBytes("/logo.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  return project;
}

function expectSameProject(actual: Project, expected: Project): void {
  expect(actual.main).toBe(expected.main);
  expect(actual.paths()).toEqual(expected.paths());
  for (const path of expected.paths()) {
    expect(Array.from(actual.bytes(path)!)).toEqual(
      Array.from(expected.bytes(path)!),
    );
  }
}

describe("project serialization", () => {
  it("round-trips a multi-file project byte for byte", () => {
    const project = sampleProject();
    expectSameProject(deserializeProject(serializeProject(project)), project);
  });

  it("round-trips an empty project", () => {
    const project = new Project("/main.typ");
    expectSameProject(deserializeProject(serializeProject(project)), project);
  });

  it("rejects a blob that is not a project", () => {
    expect(() => deserializeProject(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(
      /not contain a Typst project/,
    );
  });

  it("rejects a truncated blob", () => {
    const bytes = serializeProject(sampleProject());
    expect(() => deserializeProject(bytes.subarray(0, bytes.length - 10))).toThrow(
      /truncated or corrupt/,
    );
  });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes without padding characters", () => {
    for (let length = 0; length < 8; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 251) % 256);
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(Array.from(fromBase64Url(encoded))).toEqual(Array.from(bytes));
    }
  });

  it("round-trips bytes past the chunking boundary", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 256);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(
      Array.from(bytes),
    );
  });
});

describe("share links", () => {
  it("round-trips a project through a URL fragment", async () => {
    const project = sampleProject();
    const fragment = await encodeShare(project);
    expect(fragment).not.toMatch(/[+/=]/);
    expectSameProject(await decodeShare(fragment), project);
  });

  it("compresses repetitive documents well below their source size", async () => {
    const project = new Project("/main.typ");
    project.writeText("/main.typ", "= Heading\n\nSome text.\n".repeat(400));
    const fragment = await encodeShare(project);
    expect(fragment.length).toBeLessThan(project.byteLength() / 10);
  });

  it("refuses to build a link that is too long to paste", async () => {
    const project = new Project("/main.typ");
    // A xorshift PRNG, so the bytes are genuinely incompressible. A simple
    // `i * k % 256` is periodic and deflate squeezes it to almost nothing.
    let state = 0x9e3779b9;
    const noise = new Uint8Array(200_000).map(() => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state & 0xff;
    });
    project.writeBytes("/noise.bin", noise);
    await expect(encodeShare(project)).rejects.toBeInstanceOf(ShareTooLargeError);
  });

  it("reports a clear error for a corrupt fragment", async () => {
    await expect(decodeShare("bm90LWEtcHJvamVjdA")).rejects.toThrow();
  });
});
