/**
 * A reader for the USTAR/GNU tar archives that Typst packages ship as.
 *
 * Writing this out is cheaper than a dependency: the format is a 512-byte
 * header per entry followed by the contents padded to 512 bytes. Only what a
 * package archive actually uses is handled — regular files, directories, and
 * the GNU long-name extension.
 */

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

const BLOCK = 512;

/** Type flags that carry file contents we care about. */
const TYPE_FILE = ["0", "\0"];
const TYPE_LONG_NAME = "L";

export function readTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  const decoder = new TextDecoder();
  let offset = 0;
  /** Set by a GNU long-name record, consumed by the entry that follows it. */
  let pendingLongName: string | null = null;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);

    // Two consecutive zero blocks end the archive; one is enough to stop.
    if (header.every((byte) => byte === 0)) break;

    const name = pendingLongName ?? readString(header, 0, 100, decoder);
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    // USTAR splits long names across a prefix field.
    const prefix = pendingLongName ? "" : readString(header, 345, 155, decoder);
    pendingLongName = null;

    const body = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (typeFlag === TYPE_LONG_NAME) {
      pendingLongName = decoder.decode(body).replace(/\0+$/, "");
      continue;
    }
    if (!TYPE_FILE.includes(typeFlag)) continue;

    const fullName = prefix ? `${prefix}/${name}` : name;
    // Directories are sometimes recorded with a plain file flag and a
    // trailing slash; they carry nothing worth keeping.
    if (fullName.endsWith("/")) continue;

    entries.push({ name: fullName, data: body.slice() });
  }

  return entries;
}

function readString(
  block: Uint8Array,
  start: number,
  length: number,
  decoder: TextDecoder,
): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

/**
 * Reads a tar numeric field.
 *
 * These are normally NUL/space-terminated octal. Sizes above 8 GB use a
 * base-256 form flagged by the high bit, which no Typst package will hit but
 * which is cheap to refuse clearly rather than misparse.
 */
function readOctal(block: Uint8Array, start: number, length: number): number {
  const first = block[start] ?? 0;
  if (first & 0x80) {
    throw new Error("this archive uses base-256 sizes, which are not supported");
  }
  let text = "";
  for (let i = start; i < start + length; i++) {
    const byte = block[i]!;
    if (byte === 0 || byte === 0x20) break;
    text += String.fromCharCode(byte);
  }
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** Strips the leading path segment shared by every entry, if there is one. */
export function stripCommonPrefix(entries: TarEntry[]): TarEntry[] {
  if (entries.length === 0) return entries;

  const firstSegment = (name: string) => name.split("/")[0] ?? "";
  const shared = firstSegment(entries[0]!.name);
  if (!shared) return entries;

  const allShare = entries.every(
    (entry) => entry.name.startsWith(`${shared}/`),
  );
  if (!allShare) return entries;

  return entries.map((entry) => ({
    ...entry,
    name: entry.name.slice(shared.length + 1),
  }));
}
