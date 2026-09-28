import type { TerminalReadMatch } from "@t3tools/contracts";

import { BoundedTerminalHistory, type HistoryReadResult } from "./History.ts";

export const MAX_TERMINAL_SEARCH_SCAN_BYTES = 256 * 1024;
const MAX_SEARCH_MATCHES = 256;
const EXCERPT_CONTEXT_CODE_POINTS = 24;

export interface TerminalOutputSearchInput {
  readonly position: number;
  readonly text: string;
  readonly ignoreCase: boolean;
  readonly maxBytes: number;
}

export type TerminalOutputSearchResult =
  | {
      readonly kind: "search";
      readonly matches: ReadonlyArray<TerminalReadMatch>;
      readonly nextPosition: number;
      readonly hasMore: boolean;
      readonly truncated: boolean;
    }
  | { readonly kind: "invalid-budget" }
  | { readonly kind: "invalid-position" };

const utf8Length = (codePoint: number): number =>
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;

const previousCodePointStart = (text: string, offset: number): number => {
  let previous = offset - 1;
  const codePoint = text.charCodeAt(previous);
  if (codePoint >= 0xdc00 && codePoint <= 0xdfff && previous > 0) {
    const high = text.charCodeAt(previous - 1);
    if (high >= 0xd800 && high <= 0xdbff) previous -= 1;
  }
  return previous;
};

const nextCodePointEnd = (text: string, offset: number): number => {
  const codePoint = text.codePointAt(offset)!;
  return offset + (codePoint > 0xffff ? 2 : 1);
};

const matchExcerpt = (
  source: string,
  start: number,
  end: number,
  maxBytes: number,
): string | null => {
  const matchedBytes = Buffer.byteLength(source.slice(start, end));
  if (matchedBytes > maxBytes) return null;

  let left = start;
  for (let count = 0; count < EXCERPT_CONTEXT_CODE_POINTS && left > 0; count += 1) {
    left = previousCodePointStart(source, left);
  }
  let right = end;
  for (let count = 0; count < EXCERPT_CONTEXT_CODE_POINTS && right < source.length; count += 1) {
    right = nextCodePointEnd(source, right);
  }

  while (Buffer.byteLength(source.slice(left, right)) > maxBytes) {
    if (left < start) {
      left = nextCodePointEnd(source, left);
    } else if (right > end) {
      right = previousCodePointStart(source, right);
    } else {
      return null;
    }
  }
  return source.slice(left, right);
};

const historyReadError = (
  read: HistoryReadResult,
): { readonly kind: "invalid-budget" } | { readonly kind: "invalid-position" } | null =>
  read.kind === "read" ? null : { kind: read.kind };

export const searchTerminalOutput = (
  history: BoundedTerminalHistory,
  input: TerminalOutputSearchInput,
): TerminalOutputSearchResult => {
  if (input.text.length === 0 || !Number.isInteger(input.maxBytes) || input.maxBytes < 1) {
    return { kind: "invalid-budget" };
  }

  const normalizedQuery = input.ignoreCase ? input.text.toLowerCase() : input.text;
  const minimumMatchBytes = Buffer.byteLength(input.text);
  if (minimumMatchBytes > input.maxBytes) return { kind: "invalid-budget" };

  const scan = history.read(input.position, MAX_TERMINAL_SEARCH_SCAN_BYTES);
  const scanError = historyReadError(scan);
  if (scanError) return scanError;
  if (scan.kind !== "read") return { kind: "invalid-position" };

  const effectiveStart =
    input.position < history.startPosition ? history.startPosition : input.position;
  const scanBytes = scan.nextPosition - effectiveStart;
  const lookaheadBytes = Math.max(4, Array.from(normalizedQuery).length * 4);
  const lookahead = scan.hasMore ? history.read(scan.nextPosition, lookaheadBytes) : null;
  if (lookahead !== null) {
    const lookaheadError = historyReadError(lookahead);
    if (lookaheadError) return lookaheadError;
  }
  const source = scan.output + (lookahead?.kind === "read" ? lookahead.output : "");
  const failure = new Uint32Array(normalizedQuery.length);
  for (
    let queryOffset = 1, prefixLength = 0;
    queryOffset < normalizedQuery.length;
    queryOffset += 1
  ) {
    const codeUnit = normalizedQuery.charCodeAt(queryOffset);
    while (prefixLength > 0 && codeUnit !== normalizedQuery.charCodeAt(prefixLength)) {
      prefixLength = failure[prefixLength - 1]!;
    }
    if (codeUnit === normalizedQuery.charCodeAt(prefixLength)) prefixLength += 1;
    failure[queryOffset] = prefixLength;
  }
  const matchStartByteOffsets = new Uint32Array(normalizedQuery.length);
  const matchStartUnitOffsets = new Uint32Array(normalizedQuery.length);
  const matches: Array<TerminalReadMatch> = [];
  let outputBytes = 0;
  let nextPosition = scan.nextPosition;
  let hasMore = scan.hasMore;
  let normalizedUnits = 0;
  let matchedUnits = 0;
  let previousMatchStart = -1;
  let previousMatchEnd = -1;
  let stopSearch = false;
  let invalidBudget = false;

  const visitNormalizedUnit = (
    codeUnit: number,
    sourceStartByte: number,
    sourceStartUnit: number,
    sourceEndByte: number,
    sourceEndUnit: number,
  ) => {
    const ringIndex = normalizedUnits % normalizedQuery.length;
    matchStartByteOffsets[ringIndex] = sourceStartByte;
    matchStartUnitOffsets[ringIndex] = sourceStartUnit;
    normalizedUnits += 1;

    while (matchedUnits > 0 && codeUnit !== normalizedQuery.charCodeAt(matchedUnits)) {
      matchedUnits = failure[matchedUnits - 1]!;
    }
    if (codeUnit === normalizedQuery.charCodeAt(matchedUnits)) matchedUnits += 1;
    if (matchedUnits !== normalizedQuery.length) return;

    const startIndex = (normalizedUnits - normalizedQuery.length) % normalizedQuery.length;
    const startByteOffset = matchStartByteOffsets[startIndex]!;
    const sourceStart = matchStartUnitOffsets[startIndex]!;
    matchedUnits = failure[matchedUnits - 1]!;
    if (startByteOffset >= scanBytes) return;

    const start = effectiveStart + startByteOffset;
    const end = effectiveStart + sourceEndByte;
    if (start === previousMatchStart && end === previousMatchEnd) return;
    previousMatchStart = start;
    previousMatchEnd = end;
    if (matches.length >= MAX_SEARCH_MATCHES) {
      nextPosition = start;
      hasMore = true;
      stopSearch = true;
      return;
    }

    const excerpt = matchExcerpt(source, sourceStart, sourceEndUnit, input.maxBytes - outputBytes);
    if (excerpt === null) {
      if (matches.length === 0) {
        invalidBudget = true;
      } else {
        nextPosition = start;
        hasMore = true;
      }
      stopSearch = true;
      return;
    }
    matches.push({ start, end, excerpt });
    outputBytes += Buffer.byteLength(excerpt);
  };

  let sourceUnit = 0;
  let sourceByte = 0;
  while (sourceUnit < source.length) {
    if (stopSearch || invalidBudget) break;
    const codePoint = source.codePointAt(sourceUnit)!;
    const sourceUnitEnd = sourceUnit + (codePoint > 0xffff ? 2 : 1);
    const sourceByteEnd = sourceByte + utf8Length(codePoint);

    if (input.ignoreCase && codePoint <= 0x7f) {
      const normalizedCodePoint =
        codePoint >= 0x41 && codePoint <= 0x5a ? codePoint + 0x20 : codePoint;
      visitNormalizedUnit(
        normalizedCodePoint,
        sourceByte,
        sourceUnit,
        sourceByteEnd,
        sourceUnitEnd,
      );
    } else {
      const mapped = input.ignoreCase
        ? source.slice(sourceUnit, sourceUnitEnd).toLowerCase()
        : source.slice(sourceUnit, sourceUnitEnd);
      for (let mappedUnit = 0; mappedUnit < mapped.length; mappedUnit += 1) {
        visitNormalizedUnit(
          mapped.charCodeAt(mappedUnit),
          sourceByte,
          sourceUnit,
          sourceByteEnd,
          sourceUnitEnd,
        );
        if (stopSearch || invalidBudget) break;
      }
    }

    sourceByte = sourceByteEnd;
    sourceUnit = sourceUnitEnd;
  }

  if (invalidBudget) return { kind: "invalid-budget" };

  return {
    kind: "search",
    matches,
    nextPosition,
    hasMore,
    truncated: scan.truncated,
  };
};
