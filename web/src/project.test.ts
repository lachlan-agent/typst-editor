import { describe, expect, it } from "vitest";

import { isTextPath, Project } from "./project";

function demo(): Project {
  const project = new Project("/main.typ");
  project.writeText("/main.typ", "= Main");
  project.writeText("/chapter.typ", "= Chapter");
  project.writeBytes("/logo.png", new Uint8Array([137, 80, 78, 71]));
  return project;
}

describe("isTextPath", () => {
  it.each(["/a.typ", "/a.txt", "/data.json", "/refs.bib", "/x.YAML"])(
    "treats %s as text",
    (path) => expect(isTextPath(path)).toBe(true),
  );

  it.each(["/a.png", "/a.jpg", "/a.pdf", "/noextension"])(
    "treats %s as binary",
    (path) => expect(isTextPath(path)).toBe(false),
  );
});

describe("Project", () => {
  it("lists files in the order they were added", () => {
    expect(demo().paths()).toEqual(["/main.typ", "/chapter.typ", "/logo.png"]);
  });

  it("moves a file before another, or to the end", () => {
    const project = demo();
    expect(project.move("/logo.png", "/main.typ")).toBe(true);
    expect(project.paths()).toEqual(["/logo.png", "/main.typ", "/chapter.typ"]);
    expect(project.move("/main.typ", null)).toBe(true);
    expect(project.paths()).toEqual(["/logo.png", "/chapter.typ", "/main.typ"]);
    expect(project.move("/missing.typ", null)).toBe(false);
    expect(project.move("/main.typ", "/missing.typ")).toBe(false);
  });

  it("keeps a renamed file in its place", () => {
    const project = demo();
    expect(project.rename("/chapter.typ", "/intro.typ")).toBe(true);
    expect(project.paths()).toEqual(["/main.typ", "/intro.typ", "/logo.png"]);
  });

  it("decodes text files and refuses binary ones", () => {
    const project = demo();
    expect(project.text("/chapter.typ")).toBe("= Chapter");
    expect(project.text("/logo.png")).toBeUndefined();
    expect(project.text("/missing.typ")).toBeUndefined();
  });

  it("reports its total size", () => {
    expect(demo().byteLength()).toBe(6 + 9 + 4);
  });
});

describe("rename", () => {
  it("moves the contents and leaves nothing behind", () => {
    const project = demo();
    expect(project.rename("/chapter.typ", "/part-one.typ")).toBe(true);
    expect(project.has("/chapter.typ")).toBe(false);
    expect(project.text("/part-one.typ")).toBe("= Chapter");
  });

  it("follows the main file so the project stays compilable", () => {
    const project = demo();
    project.rename("/main.typ", "/book.typ");
    expect(project.main).toBe("/book.typ");
  });

  it("leaves main alone when renaming another file", () => {
    const project = demo();
    project.rename("/chapter.typ", "/part.typ");
    expect(project.main).toBe("/main.typ");
  });

  it("refuses to overwrite an existing file", () => {
    const project = demo();
    expect(project.rename("/chapter.typ", "/main.typ")).toBe(false);
    // Neither file is disturbed by the refusal.
    expect(project.text("/chapter.typ")).toBe("= Chapter");
    expect(project.text("/main.typ")).toBe("= Main");
  });

  it("refuses to rename a file that does not exist", () => {
    expect(demo().rename("/nope.typ", "/other.typ")).toBe(false);
  });

  it("treats renaming to the same name as a no-op success", () => {
    const project = demo();
    expect(project.rename("/main.typ", "/main.typ")).toBe(true);
    expect(project.text("/main.typ")).toBe("= Main");
  });

  it("re-decodes when an extension change makes a file text", () => {
    const project = new Project("/main.typ");
    project.writeBytes("/notes.bin", new TextEncoder().encode("hello"));
    expect(project.text("/notes.bin")).toBeUndefined();

    project.rename("/notes.bin", "/notes.txt");
    expect(project.text("/notes.txt")).toBe("hello");
  });

  it("stops treating a file as text when renamed to a binary extension", () => {
    const project = demo();
    project.rename("/chapter.typ", "/chapter.bin");
    expect(project.text("/chapter.bin")).toBeUndefined();
    expect(Array.from(project.bytes("/chapter.bin")!)).toEqual(
      Array.from(new TextEncoder().encode("= Chapter")),
    );
  });
});

describe("delete", () => {
  it("removes a file and reports whether it was there", () => {
    const project = demo();
    expect(project.delete("/chapter.typ")).toBe(true);
    expect(project.delete("/chapter.typ")).toBe(false);
    expect(project.paths()).toEqual(["/main.typ", "/logo.png"]);
  });
});
