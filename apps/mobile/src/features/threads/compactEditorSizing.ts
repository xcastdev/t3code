export const INLINE_EDITOR_HEIGHT = 36;
// Room under the expanded editor for the toolbar row.
export const EXPANDED_EDITOR_BOTTOM = 52;
const COMPACT_ROW_MIN_HEIGHT = 44;

export interface CompactEditorSizingInput {
  readonly lineHeight: number;
  readonly inset: number;
  readonly content: { readonly width: number; readonly height: number };
  /** Width the one-row slot leaves for text; 0 until it has been measured. */
  readonly compactWidth: number;
  readonly hasText: boolean;
  /** Opts in to focus growth: expanded while focused, from 2× to 4× the one-row height. */
  readonly growth?: { readonly focused: boolean };
}

export function compactEditorSizing(input: CompactEditorSizingInput) {
  const { lineHeight, inset, content } = input;
  const minimum = Math.max(INLINE_EDITOR_HEIGHT, Math.ceil(lineHeight) + 2 * inset);
  const compactRowHeight = Math.max(COMPACT_ROW_MIN_HEIGHT, minimum);
  const floor = input.growth
    ? Math.max(minimum, 2 * compactRowHeight - EXPANDED_EDITOR_BOTTOM)
    : minimum;
  const ceiling = input.growth
    ? Math.max(floor, 4 * compactRowHeight - EXPANDED_EDITOR_BOTTOM)
    : lineHeight * 4 + 2 * inset;
  const fullHeight = content.height + 2 * inset;
  const height = Math.max(floor, Math.min(ceiling, fullHeight));
  // A line that fits the expanded editor may still overflow its compact slot.
  // Compare its measured width too so widening cannot trigger a collapse loop.
  const wraps =
    input.hasText &&
    (content.height > lineHeight * 1.5 ||
      (input.compactWidth > 0 && content.width > input.compactWidth));
  const isExpanded = wraps || input.growth?.focused === true;
  const isFull = fullHeight >= ceiling - 0.5;
  return {
    minimum,
    height,
    compactRowHeight,
    expandedRowHeight: height + EXPANDED_EDITOR_BOTTOM,
    isExpanded,
    /** The text reaches the ceiling, so the editor scrolls. */
    isFull,
    isAtMaxHeight: isExpanded && isFull,
  };
}
