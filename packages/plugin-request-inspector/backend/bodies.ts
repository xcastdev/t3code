// @effect-diagnostics nodeBuiltinImport:off - The inspector backend packs to one builtin-only CommonJS file with no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import {
  DRAFT_MISSING_DETAIL,
  MISSING_DETAILS,
  REPLAY_INPUT_DETAILS,
  STORAGE_FULL_DETAIL,
} from "./refusals.ts";
import { type BodySide, type InspectorStore, InspectorRefusal, type StoreLane } from "./store.ts";

export const BODY_LIMITS = {
  maxChunkBytes: 128 * 1024,
  maxDecodedBytes: 16 * 1024 * 1024,
  maxDraftBytes: 16 * 1024 * 1024,
  maxDrafts: 4,
} as const;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DRAFT_ID_PATTERN = /^[0-9a-f]{16}$/;

export function decodeBase64Chunk(base64: string): Buffer {
  if (!BASE64_PATTERN.test(base64)) {
    throw new InspectorRefusal("invalid-input", REPLAY_INPUT_DETAILS.base64);
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > BODY_LIMITS.maxChunkBytes) {
    throw new InspectorRefusal(
      "invalid-input",
      `A chunk is at most ${BODY_LIMITS.maxChunkBytes} bytes.`,
    );
  }
  return bytes;
}

const decodeOne = (bytes: Buffer, encoding: string): Buffer => {
  const limits = { maxOutputLength: BODY_LIMITS.maxDecodedBytes };
  // Sync flush decodes the prefix of a body that was cut at capture instead of throwing.
  const zlibOptions = { ...limits, finishFlush: NodeZlib.constants.Z_SYNC_FLUSH };
  switch (encoding) {
    case "identity":
      return bytes;
    case "gzip":
    case "x-gzip":
      return NodeZlib.gunzipSync(bytes, zlibOptions);
    case "deflate":
      try {
        return NodeZlib.inflateSync(bytes, zlibOptions);
      } catch (error) {
        if (error instanceof RangeError) throw error;
        // Some servers send raw deflate without the zlib wrapper.
        return NodeZlib.inflateRawSync(bytes, zlibOptions);
      }
    case "br":
      return NodeZlib.brotliDecompressSync(bytes, {
        ...limits,
        finishFlush: NodeZlib.constants.BROTLI_OPERATION_FLUSH,
      });
    default:
      throw new InspectorRefusal(
        "invalid-input",
        `The body's content-encoding "${encoding}" cannot be decoded. Read it with decoded: false.`,
      );
  }
};

/** Undoes each listed content-encoding, last applied first, up to 16 MiB of output. */
export function decodeBody(bytes: Buffer, contentEncoding: string | undefined): Buffer {
  const encodings = (contentEncoding ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding !== "");
  let decoded = bytes;
  try {
    for (const encoding of encodings.toReversed()) decoded = decodeOne(decoded, encoding);
  } catch (error) {
    if (error instanceof InspectorRefusal) throw error;
    if (error instanceof RangeError) {
      throw new InspectorRefusal(
        "invalid-input",
        "The decoded body is larger than 16 MiB. Read it with decoded: false.",
      );
    }
    throw new InspectorRefusal(
      "invalid-input",
      "The body could not be decoded. Read it with decoded: false.",
    );
  }
  return decoded;
}

export interface ReadBodyInput {
  readonly requestId: number;
  readonly side: BodySide;
  readonly offset: number;
  readonly length: number;
  readonly decoded?: boolean;
}

export interface ReadBodyResult {
  readonly base64: string;
  readonly offset: number;
  readonly length: number;
  readonly totalBytes: number;
  readonly eof: boolean;
  readonly truncatedAtCapture: boolean;
}

/** read_body. Keeps the last decoded body so paging through it decodes once. */
export function makeBodyReader(store: InspectorStore) {
  let cached: { readonly key: string; readonly bytes: Buffer } | undefined;

  return (input: ReadBodyInput): ReadBodyResult => {
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new InspectorRefusal("invalid-input", "offset must be a non-negative integer.");
    }
    if (
      !Number.isSafeInteger(input.length) ||
      input.length < 1 ||
      input.length > BODY_LIMITS.maxChunkBytes
    ) {
      throw new InspectorRefusal(
        "invalid-input",
        `length must be between 1 and ${BODY_LIMITS.maxChunkBytes}.`,
      );
    }
    const body = store.readBody(input.requestId, input.side);
    if (body === undefined) {
      throw new InspectorRefusal("not-found", MISSING_DETAILS.request);
    }
    let bytes = body.bytes;
    if (input.decoded === true) {
      const key = `${input.requestId}:${input.side}:${body.recordSeq}`;
      if (cached?.key !== key) {
        cached = { key, bytes: decodeBody(body.bytes, body.meta.contentEncoding) };
      }
      bytes = cached.bytes;
    }
    const slice = bytes.subarray(input.offset, input.offset + input.length);
    return {
      base64: slice.toString("base64"),
      offset: input.offset,
      length: slice.byteLength,
      totalBytes: bytes.byteLength,
      eof: input.offset + slice.byteLength >= bytes.byteLength,
      truncatedAtCapture: body.meta.truncated,
    };
  };
}

export interface DraftWriteInput {
  readonly draftId?: string;
  readonly offset: number;
  readonly base64: string;
}

export interface DraftStore {
  /** body_draft_write. Takes the store lane itself. */
  readonly write: (input: DraftWriteInput) => Promise<{ draftId: string; size: number }>;
  readonly path: (draftId: string) => string | undefined;
  readonly size: (draftId: string) => number | undefined;
  /** Deletes one draft. Call while holding the lane. */
  readonly remove: (lane: StoreLane, draftId: string) => void;
  /** Deletes every draft (worker start). Call while holding the lane. */
  readonly clear: (lane: StoreLane) => void;
}

/** Body drafts under `drafts/`: at most 4 of at most 16 MiB, least recently written evicted. */
export function makeDraftStore(store: InspectorStore): DraftStore {
  const dir = store.draftsDir;
  // Insertion order is write recency: a write moves its draft to the end.
  const drafts = new Map<string, number>();
  const fileOf = (draftId: string) => NodePath.join(dir, `${draftId}.bin`);

  const deleteDraft = (draftId: string) => {
    drafts.delete(draftId);
    NodeFS.rmSync(fileOf(draftId), { force: true });
  };

  return {
    write: async (input) => {
      if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
        throw new InspectorRefusal("invalid-input", "offset must be a non-negative integer.");
      }
      if (input.draftId !== undefined && !DRAFT_ID_PATTERN.test(input.draftId)) {
        throw new InspectorRefusal("not-found", DRAFT_MISSING_DETAIL);
      }
      const chunk = decodeBase64Chunk(input.base64);
      if (input.offset + chunk.byteLength > BODY_LIMITS.maxDraftBytes) {
        throw new InspectorRefusal("invalid-input", "A body draft is at most 16 MiB.");
      }
      return store.exclusive((lane) => {
        const existing = input.draftId === undefined ? undefined : drafts.get(input.draftId);
        if (input.draftId !== undefined && existing === undefined) {
          throw new InspectorRefusal("not-found", DRAFT_MISSING_DETAIL);
        }
        const current = existing ?? 0;
        if (input.offset > current) {
          throw new InspectorRefusal(
            "invalid-input",
            `offset ${input.offset} is past the draft's end (${current} bytes).`,
          );
        }
        const size = Math.max(current, input.offset + chunk.byteLength);
        if (lane.admit(size - current) === "full") {
          throw new InspectorRefusal("storage-full", STORAGE_FULL_DETAIL);
        }
        const draftId = input.draftId ?? NodeCrypto.randomBytes(8).toString("hex");
        if (input.draftId === undefined) {
          const excess = drafts.size - BODY_LIMITS.maxDrafts + 1;
          for (const id of [...drafts.keys()].slice(0, Math.max(0, excess))) deleteDraft(id);
        }
        NodeFS.mkdirSync(dir, { recursive: true });
        const fd = NodeFS.openSync(fileOf(draftId), input.draftId === undefined ? "w" : "r+");
        try {
          NodeFS.writeSync(fd, chunk, 0, chunk.byteLength, input.offset);
        } finally {
          NodeFS.closeSync(fd);
        }
        drafts.delete(draftId);
        drafts.set(draftId, size);
        lane.noteFileWrite();
        return { draftId, size };
      });
    },
    path: (draftId) => (drafts.has(draftId) ? fileOf(draftId) : undefined),
    size: (draftId) => drafts.get(draftId),
    remove: (lane, draftId) => {
      deleteDraft(draftId);
      lane.noteFileWrite();
    },
    clear: (lane) => {
      drafts.clear();
      NodeFS.rmSync(dir, { recursive: true, force: true });
      lane.noteFileWrite();
    },
  };
}
