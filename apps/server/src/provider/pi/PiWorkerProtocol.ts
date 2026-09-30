import * as Schema from "effect/Schema";

export const PI_WORKER_PROTOCOL_VERSION = 1;
// P1's pinned SDK stream proof used these byte limits and one-chunk ACK window.
// The frame limit includes LF; JSON escaping and the envelope share that budget.
export const PI_WORKER_MAX_FRAME_BYTES = 16_384;
export const PI_WORKER_MAX_REQUEST_BYTES = 12_288;
export const PI_WORKER_MAX_RESPONSE_BYTES = 2_097_152;
export const PI_WORKER_MAX_CHUNK_BYTES = 8_192;
export const PI_WORKER_MAX_CHUNK_BASE64_BYTES = 4 * Math.ceil(PI_WORKER_MAX_CHUNK_BYTES / 3);

const SafeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const RequestId = SafeInteger.check(Schema.isGreaterThan(0));
const Token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const RequestBody = Schema.String.check(
  Schema.makeFilter((value) => Buffer.byteLength(value, "utf8") <= PI_WORKER_MAX_REQUEST_BYTES),
);
const ChunkData = Schema.String.check(
  Schema.makeFilter((value) => {
    // Check the encoded size before allocating the decoded buffer. Buffer's own
    // decoder accepts noncanonical padding and characters, so round-trip too.
    if (value.length === 0 || Buffer.byteLength(value) > PI_WORKER_MAX_CHUNK_BASE64_BYTES)
      return false;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      return false;
    const bytes = Buffer.from(value, "base64");
    return bytes.length <= PI_WORKER_MAX_CHUNK_BYTES && bytes.toString("base64") === value;
  }),
);

export const PiWorkerIdentity = Schema.Struct({ workerId: Token, generation: SafeInteger });
export type PiWorkerIdentity = typeof PiWorkerIdentity.Type;

const envelope = {
  version: Schema.Literal(PI_WORKER_PROTOCOL_VERSION),
  ...PiWorkerIdentity.fields,
  sequence: SafeInteger,
};
export const PiWorkerFrame = Schema.Struct({
  ...envelope,
  message: Schema.Union([
    Schema.Struct({ type: Schema.Literal("request"), requestId: RequestId, body: RequestBody }),
    Schema.Struct({ type: Schema.Literal("ack"), requestId: RequestId }),
    Schema.Struct({ type: Schema.Literal("cancel"), requestId: RequestId }),
    Schema.Struct({ type: Schema.Literals(["agent_start", "agent_end", "agent_settled"]) }),
    Schema.Struct({ type: Schema.Literal("done") }),
    Schema.Struct({ type: Schema.Literal("worker-failure"), code: Token }),
  ]),
});
export type PiWorkerFrame = typeof PiWorkerFrame.Type;

export const PiParentFrame = Schema.Struct({
  ...envelope,
  message: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("headers"),
      requestId: RequestId,
      status: Schema.Literal(200),
    }),
    Schema.Struct({ type: Schema.Literal("chunk"), requestId: RequestId, data: ChunkData }),
    Schema.Struct({ type: Schema.Literal("end"), requestId: RequestId }),
    Schema.Struct({ type: Schema.Literal("error"), requestId: RequestId, code: Token }),
  ]),
});
export type PiParentFrame = typeof PiParentFrame.Type;

const strict = { onExcessProperty: "error" } as const;
const decodeWorkerJson = Schema.decodeSync(Schema.fromJsonString(PiWorkerFrame), strict);
const decodeParentJson = Schema.decodeSync(Schema.fromJsonString(PiParentFrame), strict);
const encodeWorkerJson = Schema.encodeSync(Schema.fromJsonString(PiWorkerFrame), strict);
const encodeParentJson = Schema.encodeSync(Schema.fromJsonString(PiParentFrame), strict);
const decodeIdentity = Schema.decodeUnknownSync(PiWorkerIdentity, strict);

export class PiWorkerProtocolError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "PiWorkerProtocolError";
  }
}

function fail(code: string): never {
  throw new PiWorkerProtocolError(code);
}

function frameSize(raw: string) {
  if (Buffer.byteLength(raw, "utf8") + 1 > PI_WORKER_MAX_FRAME_BYTES) fail("FRAME_BYTE_LIMIT");
}

/** Decode one LF-free frame only after its byte budget is checked. */
export function decodePiWorkerFrame(raw: string): PiWorkerFrame {
  frameSize(raw);
  try {
    return decodeWorkerJson(raw);
  } catch {
    return fail("INVALID_WORKER_FRAME");
  }
}

export function decodePiParentFrame(raw: string): PiParentFrame {
  frameSize(raw);
  try {
    return decodeParentJson(raw);
  } catch {
    return fail("INVALID_PARENT_FRAME");
  }
}

export function encodePiWorkerFrame(frame: PiWorkerFrame): Buffer {
  const raw = encodeWorkerJson(frame);
  frameSize(raw);
  return Buffer.from(`${raw}\n`);
}

export function encodePiParentFrame(frame: PiParentFrame): Buffer {
  const raw = encodeParentJson(frame);
  frameSize(raw);
  return Buffer.from(`${raw}\n`);
}

/** Consume each complete frame synchronously; retain at most one bounded partial frame. */
export function makePiWorkerLineFramer(consume: (raw: string) => void) {
  const held = Buffer.allocUnsafe(PI_WORKER_MAX_FRAME_BYTES);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let closed = false;
  let failed = false;
  return {
    push(chunk: Uint8Array) {
      if (closed || failed) fail("FRAMER_CLOSED");
      try {
        for (let offset = 0; offset < chunk.length;) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          const size = end - offset;
          if (length + size + 1 > PI_WORKER_MAX_FRAME_BYTES) fail("FRAME_BYTE_LIMIT");
          held.set(chunk.subarray(offset, end), length);
          length += size;
          if (newline >= 0) {
            const bytes = held.subarray(0, length);
            let raw: string;
            try {
              raw = utf8.decode(bytes);
            } catch {
              return fail("INVALID_FRAME_UTF8");
            }
            length = 0;
            consume(raw);
            offset = newline + 1;
          } else {
            break;
          }
        }
      } catch (error) {
        failed = true;
        length = 0;
        throw error;
      }
    },
    finish() {
      if (closed || failed) fail("FRAMER_CLOSED");
      closed = true;
      if (length !== 0) {
        length = 0;
        fail("INCOMPLETE_FRAME");
      }
    },
  };
}

interface PendingRequest {
  id: number;
  headers: boolean;
  unacked: boolean;
  bytes: number;
  terminal: "end" | "error" | undefined;
}

/** Validate one worker generation. Receipts establish stream drain, never OS process exit. */
export function makePiWorkerProtocol(identity: PiWorkerIdentity) {
  const expected = decodeIdentity(identity);
  let parentSequence = 0;
  let workerSequence = 0;
  let lastRequestId = 0;
  let pending: PendingRequest | undefined;
  let lastOutcome: "end" | "error" | undefined;
  let agentRunning = false;
  let agentStarted = false;
  let settled = false;
  let canceled = false;
  let terminal: "done" | "failed" | undefined;

  const canFinishSuccessfully = () =>
    terminal === undefined && !pending && settled && !canceled && lastOutcome === "end";
  const checkEnvelope = (frame: PiParentFrame | PiWorkerFrame, sequence: number) => {
    if (terminal !== undefined) fail("WORKER_TERMINAL");
    if (frame.workerId !== expected.workerId || frame.generation !== expected.generation)
      fail("WORKER_IDENTITY_MISMATCH");
    if (frame.sequence !== sequence) fail("FRAME_ORDER");
  };
  const request = (id: number) => {
    if (!pending || pending.id !== id) return fail("UNEXPECTED_REQUEST_ID");
    return pending;
  };
  const drain = () => {
    if (pending?.terminal && !pending.unacked) {
      lastOutcome = pending.terminal;
      pending = undefined;
    }
  };

  return {
    acceptParent(frame: PiParentFrame) {
      try {
        // Validate typed callers too; only these checked encoders/decoders belong at IPC edges.
        encodePiParentFrame(frame);
        checkEnvelope(frame, parentSequence);
        const message = frame.message;
        const active = request(message.requestId);
        if (active.terminal) fail("REQUEST_TERMINAL");
        switch (message.type) {
          case "headers":
            if (active.headers) fail("DUPLICATE_HEADERS");
            active.headers = true;
            break;
          case "chunk": {
            if (!active.headers) fail("HEADERS_REQUIRED");
            if (active.unacked) fail("CHUNK_ACK_REQUIRED");
            const size = Buffer.from(message.data, "base64").length;
            if (active.bytes + size > PI_WORKER_MAX_RESPONSE_BYTES) fail("RESPONSE_BYTE_LIMIT");
            active.bytes += size;
            active.unacked = true;
            break;
          }
          case "end":
            if (!active.headers) fail("HEADERS_REQUIRED");
            active.terminal = "end";
            break;
          case "error":
            active.terminal = "error";
            break;
        }
        parentSequence++;
        drain();
      } catch (error) {
        terminal = "failed";
        throw error;
      }
    },
    acceptWorker(frame: PiWorkerFrame) {
      try {
        encodePiWorkerFrame(frame);
        checkEnvelope(frame, workerSequence);
        const message = frame.message;
        switch (message.type) {
          case "request":
            if (pending || canceled) fail("REQUEST_BARRIER");
            if (message.requestId <= lastRequestId) fail("REQUEST_ID_REUSE");
            lastRequestId = message.requestId;
            pending = {
              id: message.requestId,
              headers: false,
              unacked: false,
              bytes: 0,
              terminal: undefined,
            };
            lastOutcome = undefined;
            settled = false;
            break;
          case "ack": {
            const active = request(message.requestId);
            if (!active.unacked) fail("UNEXPECTED_ACK");
            active.unacked = false;
            drain();
            break;
          }
          case "cancel":
            request(message.requestId);
            if (canceled) fail("DUPLICATE_CANCEL");
            canceled = true;
            break;
          case "agent_start":
            if (agentRunning || canceled) fail("UNEXPECTED_AGENT_START");
            agentRunning = true;
            agentStarted = true;
            settled = false;
            break;
          case "agent_end":
            if (!agentRunning) fail("UNEXPECTED_AGENT_END");
            agentRunning = false;
            break;
          case "agent_settled":
            if (!agentStarted || agentRunning || settled) fail("UNEXPECTED_AGENT_SETTLED");
            settled = true;
            break;
          case "done":
            if (!canFinishSuccessfully()) fail("SUCCESS_BARRIER");
            terminal = "done";
            break;
          case "worker-failure":
            terminal = "failed";
            break;
        }
        workerSequence++;
      } catch (error) {
        terminal = "failed";
        throw error;
      }
    },
    get canStartRequest() {
      return terminal === undefined && !pending && !canceled;
    },
    get canFinishSuccessfully() {
      return canFinishSuccessfully();
    },
    get successful() {
      return terminal === "done";
    },
  };
}
