/**
 * Translation between the two coordinate systems in play.
 *
 * Typst reports spans as UTF-8 **byte** offsets; CodeMirror addresses
 * documents in UTF-16 **code unit** offsets. They agree only for ASCII, so any
 * document containing an accent, a dash, an emoji or CJK text would land its
 * squiggles and highlight ranges in the wrong place without this conversion.
 */

/** UTF-8 length of the code point starting at `index`, in bytes. */
function utf8Len(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code > 0xffff) return 4;
  return 3;
}

export class ByteMap {
  readonly #text: string;
  /** `true` when byte and char offsets coincide, i.e. the text is ASCII. */
  readonly #ascii: boolean;
  /** Char offset of the start of each line. */
  readonly #lineChars: number[] = [];
  /** Byte offset of the start of each line, parallel to `#lineChars`. */
  readonly #lineBytes: number[] = [];
  readonly #byteLength: number;

  constructor(text: string) {
    this.#text = text;

    let bytes = 0;
    let chars = 0;
    this.#lineChars.push(0);
    this.#lineBytes.push(0);

    for (const char of text) {
      const code = char.codePointAt(0)!;
      bytes += utf8Len(code);
      chars += char.length;
      if (code === 0x0a) {
        this.#lineChars.push(chars);
        this.#lineBytes.push(bytes);
      }
    }

    this.#byteLength = bytes;
    this.#ascii = bytes === text.length;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  /** Converts a UTF-8 byte offset to a UTF-16 code unit offset. */
  byteToChar(byte: number): number {
    if (this.#ascii) return clamp(byte, 0, this.#text.length);
    if (byte <= 0) return 0;
    if (byte >= this.#byteLength) return this.#text.length;

    const line = lastIndexAtMost(this.#lineBytes, byte);
    let bytes = this.#lineBytes[line]!;
    let chars = this.#lineChars[line]!;

    while (bytes < byte && chars < this.#text.length) {
      const code = this.#text.codePointAt(chars)!;
      const width = utf8Len(code);
      // A byte offset landing mid-character rounds down to that character's
      // start, which is the only position CodeMirror can represent.
      if (bytes + width > byte) break;
      bytes += width;
      chars += code > 0xffff ? 2 : 1;
    }
    return chars;
  }

  /** Converts a UTF-16 code unit offset to a UTF-8 byte offset. */
  charToByte(char: number): number {
    if (this.#ascii) return clamp(char, 0, this.#byteLength);
    if (char <= 0) return 0;
    if (char >= this.#text.length) return this.#byteLength;

    const line = lastIndexAtMost(this.#lineChars, char);
    let bytes = this.#lineBytes[line]!;
    let chars = this.#lineChars[line]!;

    while (chars < char) {
      const code = this.#text.codePointAt(chars)!;
      bytes += utf8Len(code);
      chars += code > 0xffff ? 2 : 1;
    }
    return bytes;
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** Index of the last element of the sorted `values` that is `<= target`. */
function lastIndexAtMost(values: number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (values[mid]! <= target) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}
