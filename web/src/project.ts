/**
 * The project model: a virtual file system plus which file is `main`.
 *
 * Files are held as raw bytes — the same representation the Rust side
 * consumes — so there is one source of truth rather than a text copy and a
 * byte copy that can drift apart.
 */

export interface ProjectFile {
  bytes: Uint8Array;
  /** Text files are decoded on demand and cached here. */
  text?: string;
}

const TEXT_EXTENSIONS = new Set(["typ", "txt", "csv", "json", "yaml", "yml", "xml", "bib"]);

export function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export class Project {
  readonly #files = new Map<string, ProjectFile>();
  #main: string;

  constructor(main: string) {
    this.#main = main;
  }

  get main(): string {
    return this.#main;
  }

  set main(path: string) {
    this.#main = path;
  }

  get size(): number {
    return this.#files.size;
  }

  /** In tab order: the order files were added, as rearranged by `move`. It survives serialization. */
  paths(): string[] {
    return [...this.#files.keys()];
  }

  /**
   * Moves a file to sit before `before` in the order, or last when `before`
   * is null. False when either path is unknown.
   */
  move(path: string, before: string | null): boolean {
    const file = this.#files.get(path);
    if (!file || (before !== null && !this.#files.has(before))) return false;
    if (path === before) return true;
    const entries = [...this.#files.entries()].filter(([p]) => p !== path);
    const at = before === null ? entries.length : entries.findIndex(([p]) => p === before);
    entries.splice(at, 0, [path, file]);
    this.#files.clear();
    for (const [p, f] of entries) this.#files.set(p, f);
    return true;
  }

  has(path: string): boolean {
    return this.#files.has(path);
  }

  bytes(path: string): Uint8Array | undefined {
    return this.#files.get(path)?.bytes;
  }

  /** The decoded text of a file, or `undefined` if it is not a text file. */
  text(path: string): string | undefined {
    const file = this.#files.get(path);
    if (!file) return undefined;
    if (file.text === undefined) {
      if (!isTextPath(path)) return undefined;
      file.text = new TextDecoder().decode(file.bytes);
    }
    return file.text;
  }

  writeText(path: string, text: string): void {
    this.#files.set(path, { bytes: new TextEncoder().encode(text), text });
  }

  writeBytes(path: string, bytes: Uint8Array): void {
    this.#files.set(path, { bytes });
  }

  delete(path: string): boolean {
    return this.#files.delete(path);
  }

  entries(): Array<[string, Uint8Array]> {
    return [...this.#files.entries()].map(([path, file]) => [path, file.bytes]);
  }

  /** Total size of all file contents, in bytes. */
  byteLength(): number {
    let total = 0;
    for (const file of this.#files.values()) {
      total += file.bytes.length;
    }
    return total;
  }

  /**
   * Renames a file, keeping its contents.
   *
   * Returns false if the name is taken, so the caller can say so rather than
   * silently destroying the other file.
   */
  rename(from: string, to: string): boolean {
    if (from === to) return true;
    const file = this.#files.get(from);
    if (!file || this.#files.has(to)) return false;

    // Rebuilt in place so the tab keeps its position. Dropping the cached
    // text forces a re-decode, which is what makes a rename between a text
    // and a binary extension behave correctly.
    const entries = [...this.#files.entries()].map(([p, f]): [string, ProjectFile] => (p === from ? [to, { bytes: f.bytes }] : [p, f]));
    this.#files.clear();
    for (const [p, f] of entries) this.#files.set(p, f);
    if (this.#main === from) this.#main = to;
    return true;
  }

  static from(
    main: string,
    files: Iterable<readonly [string, Uint8Array]>,
  ): Project {
    const project = new Project(main);
    for (const [path, bytes] of files) {
      project.writeBytes(path, bytes);
    }
    return project;
  }
}
