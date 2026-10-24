/** The message protocol shared by the main thread and the compile worker. */

/** A diagnostic as produced by the Rust engine. */
export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  /** Path of the file the span points into, or `null` when detached. */
  path: string | null;
  /** Byte offsets into that file, or `null` when detached. */
  from: number | null;
  to: number | null;
  hints: string[];
}

/** A syntax-highlighting token, in byte offsets. */
export interface Token {
  from: number;
  to: number;
  tag: string;
}

export interface SvgOutput {
  pages: string[];
  diagnostics: Diagnostic[];
}

export interface PdfOutput {
  data: Uint8Array | null;
  diagnostics: Diagnostic[];
}

/** A file in the virtual file system. */
export interface VirtualFile {
  path: string;
  /** Text files carry `text`; everything else carries `bytes`. */
  text?: string;
  bytes?: Uint8Array;
}

/** A completion offered at the cursor. */
export interface Completion {
  /** `"func"`, `"type"`, `"label"`, or `"symbol:<glyph>"`. */
  kind: string;
  label: string;
  /** Text to insert, possibly with `${...}` snippet placeholders. */
  apply: string | null;
  detail: string | null;
}

export interface Completions {
  /** Byte offset where the replaced text starts. */
  from: number;
  items: Completion[];
}

/** Documentation for the expression under the cursor. */
export interface Hover {
  kind: "text" | "code";
  value: string;
}

/** One file of a package, as handed to the worker. */
export interface PackageFilePayload {
  path: string;
  data: Uint8Array;
}

export type Request =
  | { kind: "init"; fontUrls: string[]; localNowMs: number }
  | { kind: "write"; files: VirtualFile[]; removed: string[]; main: string }
  | { kind: "compileSvg" }
  | { kind: "compilePdf" }
  | { kind: "highlight"; path: string }
  | { kind: "autocomplete"; path: string; cursor: number; explicit: boolean }
  | { kind: "hover"; path: string; cursor: number }
  | { kind: "missingPackages" }
  | { kind: "addPackage"; spec: string; files: PackageFilePayload[] }
  | { kind: "format"; text: string; maxWidth: number; tabSpaces: number }
  | { kind: "starter" };

/** Payload types keyed by request kind, so `rpc.send` can infer its result. */
export interface ResponseMap {
  init: { fontCount: number };
  write: null;
  compileSvg: SvgOutput & { elapsedMs: number };
  compilePdf: PdfOutput;
  highlight: Token[];
  autocomplete: Completions;
  hover: Hover | null;
  missingPackages: string[];
  addPackage: null;
  format: string;
  starter: { path: string; text: string };
}

export type RequestOf<K extends keyof ResponseMap> = Extract<
  Request,
  { kind: K }
>;

export interface Envelope {
  id: number;
  request: Request;
}

export type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
