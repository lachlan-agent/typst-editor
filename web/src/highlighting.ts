/**
 * Syntax highlighting driven by Typst's own parser.
 *
 * Rather than maintaining a Lezer grammar that slowly drifts from the real
 * language, the worker runs `typst_syntax::highlight` and sends back tagged
 * byte ranges. Decorations are mapped through subsequent edits so the text
 * stays coloured during the round-trip instead of flickering.
 */

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

import { ByteMap } from "./offsets";
import type { Token } from "./protocol";

/** Carries a fresh set of tokens, together with the text they describe. */
export const setTokens = StateEffect.define<{ tokens: Token[]; text: string }>();

const marks = new Map<string, Decoration>();

function markFor(tag: string): Decoration {
  let mark = marks.get(tag);
  if (!mark) {
    mark = Decoration.mark({ class: `tok-${tag}` });
    marks.set(tag, mark);
  }
  return mark;
}

function buildDecorations(
  tokens: Token[],
  text: string,
  docLength: number,
): DecorationSet {
  const map = new ByteMap(text);
  const ranges = [];
  for (const token of tokens) {
    // The document may already have moved on from the text these tokens
    // describe. Clamping keeps the colours roughly right until the next
    // round-trip; leaving them unclamped would throw, taking the editor down.
    const from = Math.min(map.byteToChar(token.from), docLength);
    const to = Math.min(map.byteToChar(token.to), docLength);
    if (from < to) {
      ranges.push(markFor(token.tag).range(from, to));
    }
  }
  // `highlight` walks the tree in document order, but converting through the
  // byte map can collapse ranges, so sorting keeps RangeSet.of happy.
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
}

const tokenField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setTokens)) {
        return buildDecorations(
          effect.value.tokens,
          effect.value.text,
          transaction.state.doc.length,
        );
      }
    }
    // No new tokens yet: shift the existing ones so they keep covering the
    // same words while the worker catches up.
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function typstHighlighting(): Extension {
  return tokenField;
}
