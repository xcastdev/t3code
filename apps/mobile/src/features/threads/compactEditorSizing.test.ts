import { describe, expect, it } from "vite-plus/test";

import { compactEditorSizing, EXPANDED_EDITOR_BOTTOM } from "./compactEditorSizing";

const body = { lineHeight: 23, inset: 6 };
const empty = { width: 0, height: 0 };
const lines = (count: number) => ({ width: 200, height: 23 * count });

describe("compact editor sizing", () => {
  it("keeps the one-row pill and the 4-line ceiling without focus growth", () => {
    const focusedEmpty = compactEditorSizing({
      ...body,
      content: empty,
      compactWidth: 220,
      hasText: false,
    });
    expect(focusedEmpty.isExpanded).toBe(false);
    expect(focusedEmpty.compactRowHeight).toBe(44);

    const long = compactEditorSizing({
      ...body,
      content: lines(10),
      compactWidth: 220,
      hasText: true,
    });
    expect(long.height).toBe(23 * 4 + 12);
    expect(long.isFull).toBe(true);
  });

  it("expands an empty focused editor to twice the pill and collapses it on blur", () => {
    const focused = compactEditorSizing({
      ...body,
      content: empty,
      compactWidth: 220,
      hasText: false,
      growth: { focused: true },
    });
    expect(focused.isExpanded).toBe(true);
    expect(focused.expandedRowHeight).toBe(2 * focused.compactRowHeight);
    expect(focused.isAtMaxHeight).toBe(false);

    const blurred = compactEditorSizing({
      ...body,
      content: empty,
      compactWidth: 220,
      hasText: false,
      growth: { focused: false },
    });
    expect(blurred.isExpanded).toBe(false);
  });

  it("keeps wrapped text expanded after blur", () => {
    const sizing = compactEditorSizing({
      ...body,
      content: lines(2),
      compactWidth: 220,
      hasText: true,
      growth: { focused: false },
    });
    expect(sizing.isExpanded).toBe(true);
    expect(sizing.height).toBe(23 * 2 + 12);
  });

  it("grows with the text up to four times the pill, then reports max height", () => {
    const sizing = (count: number) =>
      compactEditorSizing({
        ...body,
        content: lines(count),
        compactWidth: 220,
        hasText: true,
        growth: { focused: true },
      });
    expect(sizing(3).expandedRowHeight).toBe(23 * 3 + 12 + EXPANDED_EDITOR_BOTTOM);
    expect(sizing(3).isAtMaxHeight).toBe(false);
    expect(sizing(12).expandedRowHeight).toBe(4 * sizing(12).compactRowHeight);
    expect(sizing(12).isAtMaxHeight).toBe(true);
  });

  it("scales both bounds with a large text size", () => {
    const sizing = compactEditorSizing({
      lineHeight: 40,
      inset: 6,
      content: lines(20),
      compactWidth: 220,
      hasText: true,
      growth: { focused: true },
    });
    expect(sizing.compactRowHeight).toBe(52);
    expect(sizing.expandedRowHeight).toBe(4 * 52);
  });
});
