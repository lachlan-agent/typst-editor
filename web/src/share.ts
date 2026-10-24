/**
 * Encoding a project into a URL fragment and back.
 *
 * The fragment is deliberate: it is never sent to a server, so sharing a link
 * does not hand the document to whoever hosts the app.
 *
 * Wire format (all little-endian):
 *   magic "TYP1" | mainLen u16 | main utf-8 | fileCount u16
 *   then per file: pathLen u16 | path utf-8 | dataLen u32 | data
 * The whole blob is deflate-raw compressed and base64url encoded.
 */

import { Project } from "./project";

const MAGIC = new Uint8Array([0x54, 0x59, 0x50, 0x31]); // "TYP1"

/** Above this, a link stops being something you can paste into a chat. */
export const MAX_ENCODED_LENGTH = 32_000;

export class ShareTooLargeError extends Error {
  constructor(readonly encodedLength: number) {
    super(
      `this project encodes to ${encodedLength} characters, over the ${MAX_ENCODED_LENGTH} character limit for a shareable URL`,
    );
    this.name = "ShareTooLargeError";
  }
}

export function serializeProject(project: Project): Uint8Array {
  const encoder = new TextEncoder();
  const main = encoder.encode(project.main);
  const files = project
    .paths()
    .map((path) => ({ path: encoder.encode(path), data: project.bytes(path)! }));

  let length = MAGIC.length + 2 + main.length + 2;
  for (const file of files) {
    length += 2 + file.path.length + 4 + file.data.length;
  }

  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(MAGIC, offset);
  offset += MAGIC.length;
  view.setUint16(offset, main.length, true);
  offset += 2;
  out.set(main, offset);
  offset += main.length;
  view.setUint16(offset, files.length, true);
  offset += 2;

  for (const file of files) {
    view.setUint16(offset, file.path.length, true);
    offset += 2;
    out.set(file.path, offset);
    offset += file.path.length;
    view.setUint32(offset, file.data.length, true);
    offset += 4;
    out.set(file.data, offset);
    offset += file.data.length;
  }

  return out;
}

export function deserializeProject(bytes: Uint8Array): Project {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;

  const magicMatches = MAGIC.every((byte, i) => bytes[i] === byte);
  if (!magicMatches) {
    throw new Error("this link does not contain a Typst project");
  }
  offset += MAGIC.length;

  const readSlice = (length: number): Uint8Array => {
    if (offset + length > bytes.length) {
      throw new Error("this link is truncated or corrupt");
    }
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  // A length field cut off by truncation must fail the same way as its data.
  const readU16 = (): number => {
    if (offset + 2 > bytes.length) throw new Error("this link is truncated or corrupt");
    const value = view.getUint16(offset, true);
    offset += 2;
    return value;
  };
  const readU32 = (): number => {
    if (offset + 4 > bytes.length) throw new Error("this link is truncated or corrupt");
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };

  const main = decoder.decode(readSlice(readU16()));
  const fileCount = readU16();

  const project = new Project(main);
  for (let i = 0; i < fileCount; i++) {
    const path = decoder.decode(readSlice(readU16()));
    const dataLength = readU32();
    // Copied rather than referenced so the project doesn't pin the whole blob.
    project.writeBytes(path, new Uint8Array(readSlice(dataLength)));
  }

  // A blob whose `main` names no file would leave the editor with nothing to
  // open and nothing to compile; the first Typst file stands in for it.
  if (fileCount > 0 && !project.has(main)) {
    const paths = project.paths();
    project.main = paths.find((path) => /\.typ$/i.test(path)) ?? paths[0]!;
  }

  return project;
}

async function pipeThrough(
  bytes: Uint8Array,
  // `CompressionStream` is typed as accepting `BufferSource`, which is wider
  // than what a `TransformStream<Uint8Array, Uint8Array>` demands.
  transform: TransformStream<BufferSource, Uint8Array>,
): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // Chunked to stay clear of the argument-count limit on large projects.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encodes a project into the text that goes after `#` in a share URL. */
export async function encodeShare(project: Project): Promise<string> {
  const compressed = await pipeThrough(
    serializeProject(project),
    new CompressionStream("deflate-raw"),
  );
  const encoded = toBase64Url(compressed);
  if (encoded.length > MAX_ENCODED_LENGTH) {
    throw new ShareTooLargeError(encoded.length);
  }
  return encoded;
}

/** Decodes the text after `#` in a share URL back into a project. */
export async function decodeShare(fragment: string): Promise<Project> {
  const decompressed = await pipeThrough(
    fromBase64Url(fragment),
    new DecompressionStream("deflate-raw"),
  );
  return deserializeProject(decompressed);
}
