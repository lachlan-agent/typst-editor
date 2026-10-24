import { describe, expect, it } from "vitest";
import { ByteMap } from "./offsets";

/** A reference implementation to check the fast one against. */
function referenceByteToChar(text: string, byte: number): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  let chars = 0;
  for (const char of text) {
    const width = encoder.encode(char).length;
    if (bytes + width > byte) break;
    bytes += width;
    chars += char.length;
  }
  return chars;
}

describe("ByteMap", () => {
  it("is the identity for ASCII", () => {
    const map = new ByteMap("= Hello\n\nworld");
    expect(map.byteToChar(9)).toBe(9);
    expect(map.charToByte(9)).toBe(9);
    expect(map.byteLength).toBe(14);
  });

  it("round-trips through multi-byte text", () => {
    const text = "= Überschrift\n\nEin „Beispiel“ — mit Unicode 🎉 und 日本語.\n";
    const map = new ByteMap(text);

    for (let char = 0; char <= text.length; char++) {
      // Skip the low half of a surrogate pair: it has no byte offset of its
      // own, so it cannot round-trip.
      const code = text.charCodeAt(char);
      if (code >= 0xdc00 && code <= 0xdfff) continue;
      expect(map.byteToChar(map.charToByte(char))).toBe(char);
    }
  });

  it("agrees with a naive encoder on every byte offset", () => {
    const text = "Größe: 5 µm — 日本 🎉 ende";
    const map = new ByteMap(text);
    const byteLength = new TextEncoder().encode(text).length;

    for (let byte = 0; byte <= byteLength; byte++) {
      expect(map.byteToChar(byte)).toBe(referenceByteToChar(text, byte));
    }
  });

  it("reports the byte length of multi-byte text", () => {
    expect(new ByteMap("é").byteLength).toBe(2);
    expect(new ByteMap("日").byteLength).toBe(3);
    expect(new ByteMap("🎉").byteLength).toBe(4);
  });

  it("clamps offsets outside the document", () => {
    const map = new ByteMap("héllo");
    expect(map.byteToChar(-5)).toBe(0);
    expect(map.byteToChar(1000)).toBe(5);
    expect(map.charToByte(-5)).toBe(0);
    expect(map.charToByte(1000)).toBe(6);
  });

  it("handles multi-byte characters spread over many lines", () => {
    const text = Array.from({ length: 200 }, (_, i) => `Zeile ${i} — ü`).join(
      "\n",
    );
    const map = new ByteMap(text);
    const needle = text.indexOf("Zeile 199");
    expect(map.byteToChar(map.charToByte(needle))).toBe(needle);
  });

  it("treats an empty document as empty", () => {
    const map = new ByteMap("");
    expect(map.byteLength).toBe(0);
    expect(map.byteToChar(0)).toBe(0);
    expect(map.charToByte(0)).toBe(0);
  });
});
