import * as NodeCrypto from "node:crypto";

const DEFAULT_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_HISTORY_CHUNK_LENGTH = 16 * 1024;

interface TerminalHistoryChunk {
  data: string;
  byteLength: number;
  lineBreaks: number;
}

export type HistoryReadResult =
  | {
      readonly kind: "read";
      readonly output: string;
      readonly nextPosition: number;
      readonly hasMore: boolean;
      readonly truncated: boolean;
    }
  | { readonly kind: "invalid-budget" }
  | { readonly kind: "invalid-position" };

const utf8Length = (codePoint: number): number =>
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;

const replaceUnpairedSurrogates = (text: string): string => {
  let firstInvalid = 0;
  while (firstInvalid < text.length) {
    const codeUnit = text.charCodeAt(firstInvalid);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(firstInvalid + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        firstInvalid += 2;
        continue;
      }
      break;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) break;
    firstInvalid += 1;
  }
  if (firstInvalid === text.length) return text;

  const result: Array<string> = [text.slice(0, firstInvalid)];
  let segmentStart = firstInvalid;
  for (let index = firstInvalid; index < text.length;) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 2;
        continue;
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      index += 1;
      continue;
    }

    result.push(text.slice(segmentStart, index), "\uFFFD");
    index += 1;
    segmentStart = index;
  }
  result.push(text.slice(segmentStart));
  return result.join("");
};

export class BoundedTerminalHistory {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private chunks: Array<TerminalHistoryChunk | undefined> = [];
  private start = 0;
  private byteLength = 0;
  private lineBreaks = 0;
  private absoluteStart = 0;
  private absoluteEnd = 0;
  private absoluteStartAtLineBoundary = true;
  private cursorGeneration = NodeCrypto.randomUUID();
  // Reading the old string's tail on each append can force chunk concatenation.
  private lastCodeUnit: number | undefined;
  private cachedValue: string | null = "";

  constructor(maxLines: number, initial: string, maxBytes = DEFAULT_HISTORY_BYTE_LIMIT) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.append(initial);
  }

  get generation(): string {
    return this.cursorGeneration;
  }

  get startPosition(): number {
    return this.absoluteStart;
  }

  get endPosition(): number {
    return this.absoluteEnd;
  }

  private get pendingHighSurrogate(): boolean {
    return (
      this.lastCodeUnit !== undefined && this.lastCodeUnit >= 0xd800 && this.lastCodeUnit <= 0xdbff
    );
  }

  private get readableEndPosition(): number {
    return this.absoluteEnd - (this.pendingHighSurrogate ? 3 : 0);
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.cachedValue = null;
    let appendedBytes = 0;
    if (this.maxBytes <= 0 || this.maxLines <= 0) {
      this.clear();
      this.absoluteEnd = appendedBytes;
      // Preserve the existing zero-line limit's trailing newline behavior.
      if (this.maxBytes > 0 && text.endsWith("\n")) {
        this.appendChunk("\n");
        this.absoluteStart = this.absoluteEnd - 1;
      } else {
        this.absoluteStart = this.absoluteEnd;
      }
      return;
    }

    let offset = 0;
    const previous = this.chunks.at(-1);
    const lastCode = this.lastCodeUnit;
    const firstCode = text.charCodeAt(0);
    if (
      previous &&
      lastCode !== undefined &&
      lastCode >= 0xd800 &&
      lastCode <= 0xdbff &&
      firstCode >= 0xdc00 &&
      firstCode <= 0xdfff
    ) {
      // Joining a split surrogate changes its UTF-8 size from 3 to 4 bytes.
      previous.data += text[0];
      previous.byteLength += 1;
      this.byteLength += 1;
      appendedBytes += 1;
      this.lastCodeUnit = firstCode;
      offset = 1;
      this.trim();
    }

    while (offset < text.length) {
      let end = Math.min(offset + MAX_HISTORY_CHUNK_LENGTH, text.length);
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      const data = text.slice(offset, end);
      // Detach small chunks from large input strings so evicted prefixes can be collected.
      appendedBytes += this.appendChunk(
        text.length > MAX_HISTORY_CHUNK_LENGTH
          ? Buffer.from(data, "utf16le").toString("utf16le")
          : data,
      );
      this.trim();
      offset = end;
    }
    this.absoluteEnd += appendedBytes;
  }

  private appendChunk(data: string): number {
    const byteLength = Buffer.byteLength(data);
    let lineBreaks = 0;
    for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
      lineBreaks += 1;
    }
    const previous = this.chunks.at(-1);
    if (previous && previous.data.length + data.length <= MAX_HISTORY_CHUNK_LENGTH) {
      previous.data += data;
      previous.byteLength += byteLength;
      previous.lineBreaks += lineBreaks;
    } else {
      this.chunks.push({ data, byteLength, lineBreaks });
    }
    this.byteLength += byteLength;
    this.lineBreaks += lineBreaks;
    this.lastCodeUnit = data.charCodeAt(data.length - 1);
    this.cachedValue = null;
    return byteLength;
  }

  private discardChunk(): void {
    const first = this.chunks[this.start]!;
    this.byteLength -= first.byteLength;
    this.lineBreaks -= first.lineBreaks;
    this.absoluteStart += first.byteLength;
    this.absoluteStartAtLineBoundary = first.data.endsWith("\n");
    this.chunks[this.start++] = undefined;
  }

  private trimChunk(offset: number, byteLength: number, lineBreaks: number): void {
    const first = this.chunks[this.start]!;
    if (offset === first.data.length) {
      this.discardChunk();
      return;
    }
    const startsAtLineBoundary = first.data.charCodeAt(offset - 1) === 10;
    first.data = first.data.slice(offset);
    first.byteLength -= byteLength;
    first.lineBreaks -= lineBreaks;
    this.byteLength -= byteLength;
    this.lineBreaks -= lineBreaks;
    this.absoluteStart += byteLength;
    this.absoluteStartAtLineBoundary = startsAtLineBoundary;
  }

  private trim(): void {
    const trailingNewline = this.lastCodeUnit === 10;
    let linesToDrop = this.lineBreaks + (trailingNewline ? 0 : 1) - this.maxLines;
    while (linesToDrop > 0) {
      const first = this.chunks[this.start]!;
      if (first.lineBreaks < linesToDrop) {
        linesToDrop -= first.lineBreaks;
        this.discardChunk();
        continue;
      }
      let offset = 0;
      for (let line = 0; line < linesToDrop; line += 1) {
        offset = first.data.indexOf("\n", offset) + 1;
      }
      this.trimChunk(offset, Buffer.byteLength(first.data.slice(0, offset)), linesToDrop);
      linesToDrop = 0;
    }

    while (this.byteLength > this.maxBytes) {
      const first = this.chunks[this.start]!;
      const bytesToDrop = this.byteLength - this.maxBytes;
      if (first.byteLength <= bytesToDrop) {
        this.discardChunk();
        continue;
      }
      if (first.byteLength === first.data.length && first.lineBreaks === 0) {
        // ASCII without newlines needs no scan to find the byte cutoff.
        this.trimChunk(bytesToDrop, bytesToDrop, 0);
        continue;
      }
      let offset = 0;
      let bytes = 0;
      let lineBreaks = 0;
      // Scan only the discarded prefix of one small chunk, never all history.
      while (bytes < bytesToDrop) {
        const codePoint = first.data.codePointAt(offset)!;
        bytes += utf8Length(codePoint);
        offset += codePoint <= 0xffff ? 1 : 2;
        if (codePoint === 10) lineBreaks += 1;
      }
      this.trimChunk(offset, bytes, lineBreaks);
    }
    if (
      this.start === this.chunks.length ||
      (this.start > 2_048 && this.start * 2 >= this.chunks.length)
    ) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
      if (this.chunks.length === 0) this.lastCodeUnit = undefined;
    }
  }

  clear(): void {
    this.chunks = [];
    this.start = 0;
    this.byteLength = 0;
    this.lineBreaks = 0;
    this.absoluteStart = 0;
    this.absoluteEnd = 0;
    this.absoluteStartAtLineBoundary = true;
    this.cursorGeneration = NodeCrypto.randomUUID();
    this.lastCodeUnit = undefined;
    this.cachedValue = "";
  }

  finalizePendingCodePoint(): void {
    if (!this.pendingHighSurrogate) return;
    const last = this.chunks.at(-1);
    if (!last) return;
    last.data = `${last.data.slice(0, -1)}\uFFFD`;
    this.lastCodeUnit = 0xfffd;
    this.cachedValue = null;
  }

  read(position: number, maxBytes: number): HistoryReadResult {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) return { kind: "invalid-budget" };
    if (!Number.isSafeInteger(position) || position < 0 || position > this.readableEndPosition) {
      return { kind: "invalid-position" };
    }

    const wasEvicted = position < this.absoluteStart;
    const effectivePosition = wasEvicted ? this.absoluteStart : position;
    const location = this.locate(effectivePosition);
    if (!location) return { kind: "invalid-position" };

    const output: Array<string> = [];
    let outputBytes = 0;
    let chunkIndex = location.chunkIndex;
    let unitOffset = location.unitOffset;
    while (chunkIndex < this.chunks.length && outputBytes < maxBytes) {
      const chunk = this.chunks[chunkIndex]!;
      const chunkEnd =
        this.pendingHighSurrogate && chunkIndex === this.chunks.length - 1
          ? chunk.data.length - 1
          : chunk.data.length;
      let endOffset = unitOffset;
      let chunkBytes = 0;
      while (endOffset < chunkEnd) {
        const codePoint = chunk.data.codePointAt(endOffset)!;
        const bytes = utf8Length(codePoint);
        if (outputBytes + chunkBytes + bytes > maxBytes) break;
        chunkBytes += bytes;
        endOffset += codePoint <= 0xffff ? 1 : 2;
      }
      if (endOffset > unitOffset) {
        output.push(replaceUnpairedSurrogates(chunk.data.slice(unitOffset, endOffset)));
        outputBytes += chunkBytes;
        unitOffset = endOffset;
      }
      if (unitOffset < chunkEnd) break;
      if (chunkEnd < chunk.data.length) break;
      chunkIndex += 1;
      unitOffset = 0;
    }

    if (outputBytes === 0 && effectivePosition < this.readableEndPosition) {
      return { kind: "invalid-budget" };
    }
    const nextPosition = effectivePosition + outputBytes;
    return {
      kind: "read",
      output: output.join(""),
      nextPosition,
      hasMore: nextPosition < this.readableEndPosition,
      truncated: wasEvicted,
    };
  }

  tail(lines: number, maxBytes: number): HistoryReadResult {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) return { kind: "invalid-budget" };
    if (!Number.isInteger(lines) || lines < 1) return { kind: "invalid-budget" };
    if (this.readableEndPosition === this.absoluteStart) {
      return {
        kind: "read",
        output: "",
        nextPosition: this.readableEndPosition,
        hasMore: false,
        truncated: false,
      };
    }

    const delimiterCount = lines + (this.lastCodeUnit === 10 ? 1 : 0);
    const lineStart = this.findPositionAfterNthNewlineFromEnd(delimiterCount);
    const lineBytes = this.readableEndPosition - lineStart;
    const tailStart = lineBytes > maxBytes ? this.findSuffixStart(maxBytes, lineStart) : lineStart;
    const slice = this.read(tailStart, maxBytes);
    if (slice.kind !== "read") return slice;
    if (lineBytes > 0 && slice.output.length === 0) return { kind: "invalid-budget" };
    return {
      ...slice,
      nextPosition: this.readableEndPosition,
      hasMore: false,
      truncated:
        slice.truncated ||
        lineBytes > maxBytes ||
        (lineStart === this.absoluteStart &&
          this.absoluteStart > 0 &&
          (!this.absoluteStartAtLineBoundary ||
            lines > this.lineBreaks + (this.lastCodeUnit === 10 ? 0 : 1))),
    };
  }

  private locate(
    position: number,
  ): { readonly chunkIndex: number; readonly unitOffset: number } | null {
    let remaining = position - this.absoluteStart;
    let chunkIndex = this.start;
    while (chunkIndex < this.chunks.length) {
      const chunk = this.chunks[chunkIndex]!;
      if (remaining > chunk.byteLength) {
        remaining -= chunk.byteLength;
        chunkIndex += 1;
        continue;
      }
      if (remaining === chunk.byteLength) {
        return { chunkIndex: chunkIndex + 1, unitOffset: 0 };
      }
      let unitOffset = 0;
      let consumedBytes = 0;
      while (consumedBytes < remaining) {
        const codePoint = chunk.data.codePointAt(unitOffset)!;
        consumedBytes += utf8Length(codePoint);
        unitOffset += codePoint <= 0xffff ? 1 : 2;
      }
      return consumedBytes === remaining ? { chunkIndex, unitOffset } : null;
    }
    return remaining === 0 ? { chunkIndex: this.chunks.length, unitOffset: 0 } : null;
  }

  private findPositionAfterNthNewlineFromEnd(count: number): number {
    let bytesAfter = 0;
    let remaining = count;
    for (let chunkIndex = this.chunks.length - 1; chunkIndex >= this.start; chunkIndex -= 1) {
      const data = this.chunks[chunkIndex]!.data;
      let unitOffset =
        this.pendingHighSurrogate && chunkIndex === this.chunks.length - 1
          ? data.length - 1
          : data.length;
      while (unitOffset > 0) {
        let startOffset = unitOffset - 1;
        let codePoint = data.charCodeAt(startOffset);
        if (codePoint >= 0xdc00 && codePoint <= 0xdfff && startOffset > 0) {
          const high = data.charCodeAt(startOffset - 1);
          if (high >= 0xd800 && high <= 0xdbff) {
            startOffset -= 1;
            codePoint = data.codePointAt(startOffset)!;
          }
        }
        if (codePoint === 10) {
          remaining -= 1;
          if (remaining === 0) return this.readableEndPosition - bytesAfter;
        }
        bytesAfter += utf8Length(codePoint);
        unitOffset = startOffset;
      }
    }
    return this.absoluteStart;
  }

  private findSuffixStart(maxBytes: number, lowerBound: number): number {
    let bytesAfter = 0;
    for (let chunkIndex = this.chunks.length - 1; chunkIndex >= this.start; chunkIndex -= 1) {
      const data = this.chunks[chunkIndex]!.data;
      let unitOffset =
        this.pendingHighSurrogate && chunkIndex === this.chunks.length - 1
          ? data.length - 1
          : data.length;
      while (unitOffset > 0) {
        let startOffset = unitOffset - 1;
        let codePoint = data.charCodeAt(startOffset);
        if (codePoint >= 0xdc00 && codePoint <= 0xdfff && startOffset > 0) {
          const high = data.charCodeAt(startOffset - 1);
          if (high >= 0xd800 && high <= 0xdbff) {
            startOffset -= 1;
            codePoint = data.codePointAt(startOffset)!;
          }
        }
        const bytes = utf8Length(codePoint);
        const codePointPosition = this.readableEndPosition - bytesAfter - bytes;
        if (codePointPosition < lowerBound) return lowerBound;
        if (bytesAfter + bytes > maxBytes) {
          return this.readableEndPosition - bytesAfter;
        }
        bytesAfter += bytes;
        unitOffset = startOffset;
      }
    }
    return lowerBound;
  }

  value(): string {
    if (this.cachedValue !== null) return this.cachedValue;
    this.cachedValue = this.chunks
      .slice(this.start)
      .map((chunk) => chunk!.data)
      .join("");
    return this.cachedValue;
  }
}
