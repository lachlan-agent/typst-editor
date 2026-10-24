/**
 * A ustar writer, the counterpart of `readTar`: a project exports as one
 * archive, which `tar` (and this editor's import) read back.
 */

export interface TarInput {
  /** Without a leading slash; directories are implied. */
  path: string;
  data: Uint8Array;
}

const BLOCK = 512;

/** The name GNU tar gives the record that carries a long name. */
const LONG_LINK = "././@LongLink";

export function writeTar(files: TarInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const push = (header: Uint8Array, data: Uint8Array): void => {
    parts.push(header, data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  };
  for (const file of files) {
    const name = encoder.encode(file.path);
    // ustar splits a long path into prefix/name at a slash; failing that, a
    // GNU `L` record ahead of the entry carries the whole path, and the
    // header's own name field holds only its head.
    let prefix = new Uint8Array(0);
    let base = name;
    if (name.length > 100) {
      const cut = splitPoint(name);
      if (cut > 0) {
        prefix = name.subarray(0, cut);
        base = name.subarray(cut + 1);
      } else {
        const long = new Uint8Array(name.length + 1); // NUL-terminated
        long.set(name);
        push(header(encoder.encode(LONG_LINK), new Uint8Array(0), 0x4c, long.length), long);
        base = name.subarray(0, 100);
      }
    }
    push(header(base, prefix, 0x30, file.data.length), file.data);
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The byte index of the slash to split at, so that the prefix fits 155 bytes
 * and the rest 100; 0 when there is none.
 */
function splitPoint(name: Uint8Array): number {
  for (let i = Math.min(155, name.length - 1); i > 0; i--) {
    if (name[i] === 0x2f && name.length - i - 1 <= 100) return i;
  }
  return 0;
}

/** A ustar header block; `typeFlag` is the byte, '0' for a file or 'L' for a long name. */
function header(base: Uint8Array, prefix: Uint8Array, typeFlag: number, size: number): Uint8Array {
  const encoder = new TextEncoder();
  const block = new Uint8Array(BLOCK);
  block.set(base.subarray(0, 100), 0);
  block.set(encoder.encode("0000644\0"), 100);
  block.set(encoder.encode("0000000\0"), 108);
  block.set(encoder.encode("0000000\0"), 116);
  block.set(encoder.encode(octal(size, 11) + "\0"), 124);
  block.set(encoder.encode(octal(Math.floor(Date.now() / 1000), 11) + "\0"), 136);
  block.set(encoder.encode("        "), 148); // checksum placeholder: spaces
  block[156] = typeFlag;
  block.set(encoder.encode("ustar\0"), 257);
  block.set(encoder.encode("00"), 263);
  block.set(prefix.subarray(0, 155), 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.set(encoder.encode(octal(sum, 6) + "\0 "), 148);
  return block;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}
