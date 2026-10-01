import * as Schema from "effect/Schema";

export const PI_WORKER_PROTOCOL_VERSION = 1;
// P1's pinned SDK stream proof used these byte limits and one-chunk ACK window.
// The frame limit includes LF; JSON escaping and the envelope share that budget.
export const PI_WORKER_MAX_FRAME_BYTES = 16_384;
export const PI_WORKER_MAX_REQUEST_BYTES = 12_288;
export const PI_WORKER_MAX_RESPONSE_BYTES = 2_097_152;
export const PI_WORKER_MAX_CHUNK_BYTES = 8_192;
export const PI_WORKER_MAX_CHUNK_BASE64_BYTES = 4 * Math.ceil(PI_WORKER_MAX_CHUNK_BYTES / 3);
export const PI_WORKER_MAX_TEXT_BYTES = 131_072;
export const PI_WORKER_MAX_TOOL_BYTES = 65_536;
export const PI_WORKER_MAX_EVENT_BYTES = 2_097_152;
export const PI_WORKER_MAX_TRANSFERS = 256;
export const PI_WORKER_MAX_QUEUE_FRAMES = 32;
export const PI_WORKER_MAX_QUEUE_BYTES = 131_072;

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

const boundedText = (bytes: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        Buffer.byteLength(value, "utf8") <= bytes &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
    ),
  );
const Cwd = boundedText(4096).check(
  Schema.isPattern(/^\/(?:[^/\0]+(?:\/[^/\0]+)*)?$/),
  Schema.makeFilter((value) => !value.split("/").some((part) => part === "." || part === "..")),
);
const RelativeReference = boundedText(512).check(
  Schema.isPattern(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/),
  Schema.makeFilter((value) => !value.split("/").some((part) => part === "." || part === "..")),
);
export const PiWorkerOperation = Schema.Struct({
  operationId: Token,
  operationKind: Schema.Literals(["initialize", "prompt", "compact"]),
});
export type PiWorkerOperation = typeof PiWorkerOperation.Type;
export const PiNativeReference = Schema.Struct({
  sessionId: Token,
  sessionReference: RelativeReference,
  leafId: Schema.NullOr(Token),
  persisted: Schema.Boolean,
});
export type PiNativeReference = typeof PiNativeReference.Type;
export const PiWorkerTransferDescriptor = Schema.Struct({
  transferId: Token,
  totalBytes: SafeInteger,
});
const ToolTransfer = PiWorkerTransferDescriptor.check(
  Schema.makeFilter((value) => value.totalBytes <= PI_WORKER_MAX_TOOL_BYTES),
);
export const PiWorkerBootstrap = Schema.Struct({
  type: Schema.Literal("bootstrap"),
  executionMode: Schema.Literals(["managed", "ordinary"]),
  expectedCwd: Cwd,
  native: Schema.NullOr(PiNativeReference),
  context: PiWorkerTransferDescriptor,
  prompt: Schema.NullOr(PiWorkerTransferDescriptor),
  model: Schema.Struct({
    provider: boundedText(128).check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)),
    modelId: boundedText(256).check(Schema.isPattern(/^[a-zA-Z0-9_./:-]+$/)),
    api: Schema.Literal("openai-completions"),
    contextWindow: RequestId,
    maxTokens: RequestId,
    reasoning: Schema.Boolean,
  }),
  allowedTools: Schema.Array(
    Schema.Struct({
      name: Token,
      execution: Schema.Literals(["local", "bridge"]),
      description: boundedText(4000),
      inputSchema: Schema.optional(ToolTransfer),
    }),
  ).check(Schema.isMaxLength(32)),
  resources: Schema.optional(
    Schema.Struct({
      skills: Schema.Array(
        Schema.Struct({
          key: Token,
          path: Cwd.check(Schema.isPattern(/^\/runtime\/skills\//)),
          description: boundedText(4000),
        }),
      ).check(Schema.isMaxLength(32)),
    }),
  ),
});
export type PiWorkerBootstrap = typeof PiWorkerBootstrap.Type;
const FailureCode = Schema.Literals([
  "SDK_FAILURE",
  "TOOL_DENIED",
  "TOOL_FAILURE",
  "INVALID_INPUT",
  "PERSISTENCE_FAILURE",
  "CANCELED",
  "UNAVAILABLE",
]);
export const PiWorkerControl = Schema.Struct({
  type: Schema.Literal("control"),
  controlId: RequestId,
  kind: Schema.Literals(["steer", "follow-up"]),
  text: boundedText(PI_WORKER_MAX_REQUEST_BYTES),
});
export type PiWorkerControl = typeof PiWorkerControl.Type;
export const PiSdkEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["text_delta", "thinking_delta"]),
    text: boundedText(PI_WORKER_MAX_CHUNK_BYTES),
  }),
  Schema.Struct({
    type: Schema.Literals(["message_start", "message_end"]),
    entryId: Token,
    role: Schema.Literals(["user", "assistant", "tool"]),
  }),
  Schema.Struct({ type: Schema.Literal("tool_start"), callId: RequestId, toolName: Token }),
  Schema.Struct({
    type: Schema.Literal("tool_end"),
    callId: RequestId,
    toolName: Token,
    isError: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("assistant_result"),
    stopReason: Schema.Literals(["stop", "toolUse", "error", "aborted"]),
  }),
]);
export type PiSdkEvent = typeof PiSdkEvent.Type;
export const PiWorkerToolCall = Schema.Struct({
  type: Schema.Literal("tool-call"),
  callId: RequestId,
  nativeCallId: Token,
  lifecycleId: RequestId,
  toolName: Token,
  execution: Schema.Literals(["local", "bridge"]),
  input: ToolTransfer,
});
export type PiWorkerToolCall = typeof PiWorkerToolCall.Type;
const TransferChunk = Schema.Struct({
  type: Schema.Literal("transfer-chunk"),
  transferId: Token,
  index: SafeInteger,
  offset: SafeInteger,
  data: ChunkData,
});
const TransferEnd = Schema.Struct({ type: Schema.Literal("transfer-end"), transferId: Token });
const ToolResult = Schema.Struct({
  type: Schema.Literal("tool-result"),
  callId: RequestId,
  output: ToolTransfer,
});
const ToolFailure = Schema.Struct({
  type: Schema.Literal("tool-failure"),
  callId: RequestId,
  code: FailureCode,
});

// JSON is parsed only after the transfer's preallocation/byte barrier. Bound
// nesting and reject keys that could mutate a consumer's object prototype.
const validToolJson = (value: Schema.Json) => {
  const visit = (node: Schema.Json, depth: number): boolean => {
    if (depth > 64) return false;
    if (Array.isArray(node)) return node.every((child) => visit(child, depth + 1));
    if (node !== null && typeof node === "object")
      return Object.entries(node).every(
        ([key, child]) =>
          key !== "__proto__" &&
          key !== "prototype" &&
          key !== "constructor" &&
          visit(child, depth + 1),
      );
    return true;
  };
  return visit(value, 0);
};
const ToolJson = Schema.Json.check(Schema.makeFilter(validToolJson));
export const PiWorkerToolInput = Schema.Struct({
  arguments: Schema.Record(Schema.String, ToolJson),
}).check(Schema.makeFilter(validToolJson));
export const PiWorkerToolOutput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: boundedText(PI_WORKER_MAX_TOOL_BYTES) }),
  Schema.Struct({ kind: Schema.Literal("json"), value: ToolJson }),
]).check(Schema.makeFilter(validToolJson));
export type PiWorkerTransfer =
  | { readonly purpose: "context" | "prompt"; readonly text: string }
  | { readonly purpose: "tool-schema"; readonly value: Schema.JsonObject }
  | { readonly purpose: "tool-input"; readonly value: typeof PiWorkerToolInput.Type }
  | { readonly purpose: "tool-result"; readonly value: typeof PiWorkerToolOutput.Type };

export const PiWorkerIdentity = Schema.Struct({ workerId: Token, generation: SafeInteger });
export type PiWorkerIdentity = typeof PiWorkerIdentity.Type;

const envelope = {
  version: Schema.Literal(PI_WORKER_PROTOCOL_VERSION),
  ...PiWorkerIdentity.fields,
  sequence: SafeInteger,
  operationId: Schema.optional(Token),
  operationKind: Schema.optional(PiWorkerOperation.fields.operationKind),
};
export const PiWorkerFrame = Schema.Struct({
  ...envelope,
  message: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("request"),
      requestId: RequestId,
      lifecycleId: RequestId,
      body: RequestBody,
    }),
    Schema.Struct({
      type: Schema.Literal("ack"),
      requestId: RequestId,
      chunkSequence: SafeInteger,
    }),
    Schema.Struct({ type: Schema.Literal("cancel"), requestId: RequestId }),
    Schema.Struct({
      type: Schema.Literals(["agent_start", "agent_end", "agent_settled"]),
      lifecycleId: RequestId,
    }),
    Schema.Struct({ type: Schema.Literal("done") }),
    Schema.Struct({ type: Schema.Literal("worker-failure"), code: Token }),
    Schema.Struct({ type: Schema.Literal("ready"), actualCwd: Cwd, native: PiNativeReference }),
    Schema.Struct({ type: Schema.Literal("initialized"), native: PiNativeReference }),
    Schema.Struct({
      type: Schema.Literals(["compaction_start", "compaction_end"]),
      lifecycleId: RequestId,
    }),
    Schema.Struct({
      type: Schema.Literal("compacted"),
      lifecycleId: RequestId,
      native: PiNativeReference,
    }),
    Schema.Struct({
      type: Schema.Literal("native"),
      lifecycleId: RequestId,
      native: PiNativeReference,
    }),
    Schema.Struct({
      type: Schema.Literal("operation_settled"),
      lifecycleId: RequestId,
      outcome: Schema.Literals(["success", "failure"]),
    }),
    Schema.Struct({
      type: Schema.Literal("control-receipt"),
      controlId: RequestId,
      kind: Schema.Literals(["steer", "follow-up", "interrupt"]),
    }),
    Schema.Struct({ type: Schema.Literal("sdk-event"), lifecycleId: RequestId, event: PiSdkEvent }),
    PiWorkerToolCall,
    ToolResult,
    ToolFailure,
    TransferChunk,
    TransferEnd,
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
    PiWorkerBootstrap,
    PiWorkerControl,
    Schema.Struct({ type: Schema.Literal("interrupt"), controlId: RequestId }),
    Schema.Struct({
      type: Schema.Literal("tool-authorized"),
      callId: RequestId,
      allowed: Schema.Boolean,
    }),
    ToolResult,
    ToolFailure,
    TransferChunk,
    TransferEnd,
  ]),
});
export type PiParentFrame = typeof PiParentFrame.Type;

const strict = { onExcessProperty: "error" } as const;
const decodeWorkerJson = Schema.decodeSync(Schema.fromJsonString(PiWorkerFrame), strict);
const decodeParentJson = Schema.decodeSync(Schema.fromJsonString(PiParentFrame), strict);
const encodeWorkerJson = Schema.encodeSync(Schema.fromJsonString(PiWorkerFrame), strict);
const encodeParentJson = Schema.encodeSync(Schema.fromJsonString(PiParentFrame), strict);
const decodeIdentity = Schema.decodeUnknownSync(PiWorkerIdentity, strict);
const decodeOperation = Schema.decodeSync(PiWorkerOperation, strict);
const decodeFailure = Schema.decodeUnknownSync(FailureCode, strict);
const decodeToolSchema = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Record(Schema.String, ToolJson).check(Schema.makeFilter(validToolJson)),
  ),
  strict,
);
const decodeToolInput = Schema.decodeSync(Schema.fromJsonString(PiWorkerToolInput), strict);
const decodeToolOutput = Schema.decodeSync(Schema.fromJsonString(PiWorkerToolOutput), strict);
const decodeBootstrap = Schema.decodeSync(Schema.fromJsonString(PiWorkerBootstrap), strict);
const encodeBootstrap = Schema.encodeSync(Schema.fromJsonString(PiWorkerBootstrap), strict);

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

/** Keep coalesced input bounded while one asynchronous consumer owns dispatch. */
export function makePiWorkerDispatchQueue(consume: (raw: string) => void | Promise<void>) {
  const queue: string[] = [];
  let bytes = 0;
  let draining = false;
  let closed = false;
  const abort = () => {
    closed = true;
    queue.length = 0;
    bytes = 0;
  };
  return {
    push(raw: string) {
      if (closed) fail("DISPATCH_CLOSED");
      try {
        frameSize(raw);
        const size = Buffer.byteLength(raw, "utf8") + 1;
        if (queue.length >= PI_WORKER_MAX_QUEUE_FRAMES || bytes + size > PI_WORKER_MAX_QUEUE_BYTES)
          fail("DISPATCH_QUEUE_LIMIT");
        queue.push(raw);
        bytes += size;
      } catch (error) {
        abort();
        throw error;
      }
    },
    async drain() {
      if (closed) fail("DISPATCH_CLOSED");
      if (draining) fail("DISPATCH_ALREADY_DRAINING");
      draining = true;
      try {
        while (queue.length > 0) {
          const raw = queue[0]!;
          await consume(raw);
          if (closed) fail("DISPATCH_CLOSED");
          queue.shift();
          bytes -= Buffer.byteLength(raw, "utf8") + 1;
        }
      } catch (error) {
        abort();
        throw error;
      } finally {
        draining = false;
      }
    },
    finish() {
      if (closed) fail("DISPATCH_CLOSED");
      if (draining || queue.length > 0) {
        abort();
        fail("DISPATCH_DRAIN_REQUIRED");
      }
      closed = true;
    },
    abort,
  };
}

interface PendingRequest {
  id: number;
  headers: boolean;
  unacked: number | undefined;
  bytes: number;
  terminal: "end" | "error" | undefined;
}

/** Validate one worker generation. Receipts establish stream drain, never OS process exit. */
export function makePiWorkerProtocol(identity: PiWorkerIdentity, operation?: PiWorkerOperation) {
  const expected = { ...decodeIdentity(identity) };
  const expectedOperation = operation === undefined ? undefined : { ...decodeOperation(operation) };
  let parentSequence = 0;
  let workerSequence = 0;
  let lastRequestId = 0;
  let pending: PendingRequest | undefined;
  let lastOutcome: "end" | "error" | undefined;
  let lifecycle: "not-started" | "running" | "ended" | "settled" = "not-started";
  let lifecycleId = 0;
  let lifecycleHasRequest = false;
  let canceled = false;
  let terminal: "done" | "initialized" | "failed" | undefined;
  let bootstrap: PiWorkerBootstrap | undefined;
  let ready = false;
  let nativeReference: PiNativeReference | undefined;
  let lifecycleLeaf: string | null | undefined;
  let nativePersisted = false;
  let compacted = false;
  let operationSettled = false;
  let operationFailed = false;
  let assistantSucceeded = false;
  let lastControlId = 0;
  let control: { id: number; kind: "steer" | "follow-up" | "interrupt" } | undefined;
  let lastCallId = 0;
  let tool:
    | {
        call: PiWorkerToolCall;
        authorized: boolean;
        started: boolean;
        inputDone: boolean;
        outputDone: boolean;
        outputId?: string;
      }
    | undefined;
  let initialTransfers = 0;
  let eventBytes = 0;
  const accountEvent = (bytes: number) => {
    if (eventBytes + bytes > PI_WORKER_MAX_EVENT_BYTES) fail("EVENT_BYTE_LIMIT");
    eventBytes += bytes;
  };
  const seenTransfers = new Set<string>();
  const transfers = new Map<
    string,
    {
      purpose: PiWorkerTransfer["purpose"];
      direction: "parent" | "worker";
      bytes: Buffer;
      offset: number;
      index: number;
      value?: PiWorkerTransfer;
    }
  >();

  const requireRuntime = () => {
    if (!expectedOperation) fail("RUNTIME_OPERATION_REQUIRED");
  };
  const requireReady = () => {
    requireRuntime();
    if (!ready) fail("READY_REQUIRED");
    if (operationSettled) fail("OPERATION_SETTLED");
    if (canceled) fail("OPERATION_CANCELED");
    if (operationFailed) fail("OPERATION_FAILED");
  };
  const sameNative = (value: PiNativeReference, reference = nativeReference) => {
    if (
      reference &&
      (value.sessionId !== reference.sessionId ||
        value.sessionReference !== reference.sessionReference)
    )
      fail("NATIVE_IDENTITY_MISMATCH");
  };
  const receiveNative = (value: PiNativeReference) => {
    sameNative(value);
    if (
      expectedOperation?.operationKind !== "initialize" &&
      value.persisted &&
      (value.leafId === null || value.leafId === lifecycleLeaf)
    )
      fail("NATIVE_PERSISTENCE_BARRIER");
    nativeReference = value;
    nativePersisted = value.persisted;
  };
  const currentLifecycle = (id: number) => {
    requireReady();
    if (id !== lifecycleId || lifecycle === "not-started") fail("EVENT_LIFECYCLE");
  };
  const registerTransfer = (
    descriptor: typeof PiWorkerTransferDescriptor.Type,
    purpose: PiWorkerTransfer["purpose"],
    direction: "parent" | "worker",
  ) => {
    if (seenTransfers.has(descriptor.transferId)) fail("TRANSFER_ID_REUSE");
    if (seenTransfers.size >= PI_WORKER_MAX_TRANSFERS) fail("TRANSFER_COUNT_LIMIT");
    const cap =
      purpose === "context" || purpose === "prompt"
        ? PI_WORKER_MAX_TEXT_BYTES
        : PI_WORKER_MAX_TOOL_BYTES;
    if (descriptor.totalBytes > cap) fail("TRANSFER_BYTE_LIMIT");
    seenTransfers.add(descriptor.transferId);
    transfers.set(descriptor.transferId, {
      purpose,
      direction,
      bytes: Buffer.alloc(descriptor.totalBytes),
      offset: 0,
      index: 0,
    });
  };
  const acceptTransfer = (
    message: typeof TransferChunk.Type | typeof TransferEnd.Type,
    direction: "parent" | "worker",
  ) => {
    requireRuntime();
    if (!bootstrap || operationSettled || canceled) fail("TRANSFER_BARRIER");
    const transfer = transfers.get(message.transferId);
    if (!transfer || transfer.direction !== direction || transfer.value)
      fail("UNEXPECTED_TRANSFER");
    if (message.type === "transfer-chunk") {
      const bytes = Buffer.from(message.data, "base64");
      if (
        message.index !== transfer.index ||
        message.offset !== transfer.offset ||
        transfer.offset + bytes.length > transfer.bytes.length
      )
        fail("TRANSFER_ORDER_OR_LIMIT");
      transfer.bytes.set(bytes, transfer.offset);
      transfer.offset += bytes.length;
      transfer.index++;
    } else {
      if (transfer.offset !== transfer.bytes.length) fail("TRANSFER_INCOMPLETE");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(transfer.bytes);
      } catch {
        return fail("INVALID_TRANSFER_UTF8");
      }
      try {
        switch (transfer.purpose) {
          case "context":
          case "prompt":
            transfer.value = { purpose: transfer.purpose, text };
            initialTransfers--;
            break;
          case "tool-schema": {
            const value = decodeToolSchema(text);
            transfer.value = { purpose: "tool-schema", value };
            initialTransfers--;
            break;
          }
          case "tool-input":
            transfer.value = {
              purpose: "tool-input",
              value: decodeToolInput(text),
            };
            if (tool?.call.input.transferId === message.transferId) tool.inputDone = true;
            break;
          case "tool-result":
            transfer.value = {
              purpose: "tool-result",
              value: decodeToolOutput(text),
            };
            if (tool?.outputId === message.transferId) tool.outputDone = true;
            break;
        }
      } catch {
        return fail("INVALID_TOOL_JSON");
      }
      // The parsed value replaces the preallocated transport buffer.
      transfer.bytes = Buffer.alloc(0);
    }
  };
  const activeTool = (id: number) => {
    requireReady();
    if (!tool || tool.call.callId !== id) return fail("UNEXPECTED_TOOL_CALL");
    return tool;
  };
  const closeTool = () => {
    if (tool) {
      transfers.delete(tool.call.input.transferId);
      if (tool.outputId) transfers.delete(tool.outputId);
      tool = undefined;
    }
  };
  const acceptToolResult = (message: typeof ToolResult.Type, direction: "parent" | "worker") => {
    const active = activeTool(message.callId);
    if (
      !active.authorized ||
      !active.started ||
      active.outputId ||
      (active.call.execution === "bridge" ? direction !== "parent" : direction !== "worker")
    )
      fail("TOOL_RESULT_BARRIER");
    if (active.call.input.totalBytes + message.output.totalBytes > PI_WORKER_MAX_TOOL_BYTES)
      fail("TOOL_PAYLOAD_BYTE_LIMIT");
    registerTransfer(message.output, "tool-result", direction);
    active.outputId = message.output.transferId;
  };
  const beginLifecycle = (id: number, kind: "prompt" | "compact") => {
    if (expectedOperation) {
      requireReady();
      if (expectedOperation.operationKind !== kind) fail("OPERATION_KIND");
      if (tool || control) fail("LIFECYCLE_BARRIER");
    }
    if (lifecycle === "running" || canceled) fail("UNEXPECTED_AGENT_START");
    if (id <= lifecycleId) fail("LIFECYCLE_ID_REUSE");
    lifecycle = "running";
    lifecycleId = id;
    lifecycleLeaf = nativeReference?.leafId;
    lifecycleHasRequest = false;
    lastOutcome = undefined;
    assistantSucceeded = false;
    nativePersisted = false;
    compacted = false;
  };

  const canFinishSuccessfully = () =>
    terminal === undefined &&
    !pending &&
    lifecycle === "settled" &&
    lifecycleHasRequest &&
    !canceled &&
    lastOutcome === "end" &&
    (!expectedOperation ||
      (operationSettled &&
        !operationFailed &&
        !control &&
        !tool &&
        nativePersisted &&
        (expectedOperation.operationKind === "prompt"
          ? assistantSucceeded
          : expectedOperation.operationKind === "compact" && compacted)));
  const checkEnvelope = (frame: PiParentFrame | PiWorkerFrame, sequence: number) => {
    if (terminal !== undefined) fail("WORKER_TERMINAL");
    if (frame.workerId !== expected.workerId || frame.generation !== expected.generation)
      fail("WORKER_IDENTITY_MISMATCH");
    if (
      expectedOperation
        ? frame.operationId !== expectedOperation.operationId ||
          frame.operationKind !== expectedOperation.operationKind
        : frame.operationId !== undefined || frame.operationKind !== undefined
    )
      fail("OPERATION_IDENTITY_MISMATCH");
    if (frame.sequence !== sequence) fail("FRAME_ORDER");
  };
  const request = (id: number) => {
    if (!pending || pending.id !== id) return fail("UNEXPECTED_REQUEST_ID");
    return pending;
  };
  const drain = () => {
    if (pending?.terminal && pending.unacked === undefined) {
      lastOutcome = pending.terminal;
      pending = undefined;
    }
  };

  return {
    acceptParent(frame: PiParentFrame) {
      try {
        // Validate typed callers too; only these checked encoders/decoders belong at IPC edges.
        const wire = encodePiParentFrame(frame);
        frame = decodePiParentFrame(wire.toString("utf8").slice(0, -1));
        checkEnvelope(frame, parentSequence);
        const message = frame.message;
        if (
          message.type !== "headers" &&
          message.type !== "chunk" &&
          message.type !== "end" &&
          message.type !== "error"
        ) {
          requireRuntime();
          if (
            message.type === "tool-result" ||
            message.type === "tool-failure" ||
            ((message.type === "transfer-chunk" || message.type === "transfer-end") &&
              transfers.get(message.transferId)?.purpose === "tool-result")
          )
            accountEvent(wire.length);
          switch (message.type) {
            case "bootstrap": {
              if (bootstrap || workerSequence !== 0 || parentSequence !== 0)
                fail("BOOTSTRAP_BARRIER");
              if (message.executionMode === "managed" && message.expectedCwd !== "/workspace")
                fail("CWD_MISMATCH");
              if ((expectedOperation?.operationKind === "prompt") !== (message.prompt !== null))
                fail("OPERATION_KIND");
              if (
                message.context.totalBytes + (message.prompt?.totalBytes ?? 0) >
                PI_WORKER_MAX_TEXT_BYTES
              )
                fail("TEXT_BYTE_LIMIT");
              const names = new Set(message.allowedTools.map((item) => item.name));
              if (names.size !== message.allowedTools.length) fail("DUPLICATE_TOOL");
              const schemaBytes = message.allowedTools.reduce(
                (total, item) => total + (item.inputSchema?.totalBytes ?? 0),
                0,
              );
              if (schemaBytes > PI_WORKER_MAX_TOOL_BYTES) fail("TOOL_SCHEMA_BYTE_LIMIT");
              if (
                new Set(message.resources?.skills.map((item) => item.key)).size !==
                (message.resources?.skills.length ?? 0)
              )
                fail("DUPLICATE_SKILL");
              bootstrap = message;
              registerTransfer(message.context, "context", "parent");
              initialTransfers++;
              if (message.prompt) {
                registerTransfer(message.prompt, "prompt", "parent");
                initialTransfers++;
              }
              for (const item of message.allowedTools)
                if (item.inputSchema) {
                  registerTransfer(item.inputSchema, "tool-schema", "parent");
                  initialTransfers++;
                }
              break;
            }
            case "transfer-chunk":
            case "transfer-end":
              acceptTransfer(message, "parent");
              break;
            case "control":
            case "interrupt": {
              if (message.type === "interrupt") {
                if (!bootstrap || operationSettled || canceled || operationFailed)
                  fail("CONTROL_BARRIER");
              } else {
                requireReady();
                if (expectedOperation?.operationKind !== "prompt") fail("CONTROL_BARRIER");
              }
              if (control) fail("CONTROL_RECEIPT_REQUIRED");
              if (message.controlId <= lastControlId) fail("CONTROL_ID_REUSE");
              lastControlId = message.controlId;
              control = {
                id: message.controlId,
                kind: message.type === "interrupt" ? "interrupt" : message.kind,
              };
              if (message.type === "interrupt") canceled = true;
              break;
            }
            case "tool-authorized": {
              const active = activeTool(message.callId);
              if (!active.inputDone || active.authorized || active.started)
                fail("TOOL_AUTHORIZATION_BARRIER");
              if (!message.allowed) {
                operationFailed = true;
                closeTool();
              } else active.authorized = true;
              break;
            }
            case "tool-result":
              acceptToolResult(message, "parent");
              break;
            case "tool-failure":
              activeTool(message.callId);
              operationFailed = true;
              closeTool();
              break;
          }
          parentSequence++;
          return;
        }
        const active = request(message.requestId);
        if (active.terminal) fail("REQUEST_TERMINAL");
        switch (message.type) {
          case "headers":
            if (active.headers) fail("DUPLICATE_HEADERS");
            active.headers = true;
            break;
          case "chunk": {
            if (!active.headers) fail("HEADERS_REQUIRED");
            if (active.unacked !== undefined) fail("CHUNK_ACK_REQUIRED");
            const size = Buffer.from(message.data, "base64").length;
            if (active.bytes + size > PI_WORKER_MAX_RESPONSE_BYTES) fail("RESPONSE_BYTE_LIMIT");
            active.bytes += size;
            active.unacked = frame.sequence;
            break;
          }
          case "end":
            if (!active.headers) fail("HEADERS_REQUIRED");
            active.terminal = "end";
            break;
          case "error":
            active.terminal = "error";
            if (expectedOperation) operationFailed = true;
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
        const wire = encodePiWorkerFrame(frame);
        frame = decodePiWorkerFrame(wire.toString("utf8").slice(0, -1));
        checkEnvelope(frame, workerSequence);
        const message = frame.message;
        if (expectedOperation) {
          if (
            canceled &&
            message.type !== "ack" &&
            message.type !== "control-receipt" &&
            message.type !== "worker-failure"
          )
            fail("OPERATION_CANCELED");
          if (
            operationSettled &&
            message.type !== "ack" &&
            message.type !== "done" &&
            message.type !== "worker-failure"
          )
            fail("OPERATION_SETTLED");
          accountEvent(wire.length);
        } else if (
          ![
            "request",
            "ack",
            "cancel",
            "agent_start",
            "agent_end",
            "agent_settled",
            "done",
            "worker-failure",
          ].includes(message.type)
        )
          fail("RUNTIME_OPERATION_REQUIRED");
        switch (message.type) {
          case "request":
            if (pending || canceled || tool) fail("REQUEST_BARRIER");
            if (expectedOperation) {
              requireReady();
              if (expectedOperation.operationKind === "initialize") fail("OPERATION_KIND");
            }
            if (lifecycle !== "running" || message.lifecycleId !== lifecycleId)
              fail("REQUEST_LIFECYCLE");
            if (message.requestId <= lastRequestId) fail("REQUEST_ID_REUSE");
            lastRequestId = message.requestId;
            pending = {
              id: message.requestId,
              headers: false,
              unacked: undefined,
              bytes: 0,
              terminal: undefined,
            };
            lastOutcome = undefined;
            lifecycleHasRequest = true;
            break;
          case "ack": {
            const active = request(message.requestId);
            if (active.unacked === undefined || message.chunkSequence !== active.unacked)
              fail("UNEXPECTED_ACK");
            active.unacked = undefined;
            drain();
            break;
          }
          case "cancel":
            request(message.requestId);
            if (canceled) fail("DUPLICATE_CANCEL");
            canceled = true;
            break;
          case "agent_start":
            beginLifecycle(message.lifecycleId, "prompt");
            break;
          case "agent_end":
            if (
              expectedOperation?.operationKind !== undefined &&
              expectedOperation.operationKind !== "prompt"
            )
              fail("OPERATION_KIND");
            if (lifecycle !== "running" || message.lifecycleId !== lifecycleId)
              fail("UNEXPECTED_AGENT_END");
            lifecycle = "ended";
            break;
          case "agent_settled":
            if (
              expectedOperation?.operationKind !== undefined &&
              expectedOperation.operationKind !== "prompt"
            )
              fail("OPERATION_KIND");
            if (lifecycle !== "ended" || message.lifecycleId !== lifecycleId)
              fail("UNEXPECTED_AGENT_SETTLED");
            lifecycle = "settled";
            break;
          case "done":
            if (!canFinishSuccessfully()) fail("SUCCESS_BARRIER");
            terminal = "done";
            break;
          case "worker-failure":
            if (expectedOperation) decodeFailure(message.code);
            terminal = "failed";
            break;
          case "ready":
            requireRuntime();
            if (!bootstrap || ready || initialTransfers !== 0) fail("READY_BARRIER");
            if (message.actualCwd !== bootstrap.expectedCwd) fail("CWD_MISMATCH");
            if (bootstrap.native) {
              sameNative(message.native, bootstrap.native);
              if (message.native.leafId !== bootstrap.native.leafId) fail("NATIVE_LEAF_MISMATCH");
            }
            nativeReference = message.native;
            lifecycleLeaf = message.native.leafId;
            ready = true;
            break;
          case "initialized":
            requireReady();
            if (
              expectedOperation?.operationKind !== "initialize" ||
              lifecycle !== "not-started" ||
              pending ||
              !message.native.persisted
            )
              fail("INITIALIZATION_BARRIER");
            receiveNative(message.native);
            terminal = "initialized";
            break;
          case "compaction_start":
            requireRuntime();
            beginLifecycle(message.lifecycleId, "compact");
            break;
          case "compaction_end":
            currentLifecycle(message.lifecycleId);
            if (expectedOperation?.operationKind !== "compact") fail("OPERATION_KIND");
            if (lifecycle !== "running") fail("COMPACTION_BARRIER");
            lifecycle = "ended";
            break;
          case "compacted":
            currentLifecycle(message.lifecycleId);
            if (
              expectedOperation?.operationKind !== "compact" ||
              lifecycle !== "ended" ||
              compacted ||
              !message.native.persisted
            )
              fail("COMPACTION_BARRIER");
            receiveNative(message.native);
            compacted = true;
            break;
          case "native":
            currentLifecycle(message.lifecycleId);
            receiveNative(message.native);
            break;
          case "operation_settled":
            requireReady();
            if (
              message.lifecycleId !== lifecycleId ||
              tool ||
              control ||
              (expectedOperation?.operationKind === "prompt"
                ? lifecycle !== "settled"
                : expectedOperation?.operationKind !== "compact" ||
                  lifecycle !== "ended" ||
                  !compacted)
            )
              fail("SETTLEMENT_BARRIER");
            if (message.outcome === "failure") operationFailed = true;
            operationSettled = true;
            lifecycle = "settled";
            break;
          case "control-receipt":
            requireRuntime();
            if (!control || message.controlId !== control.id || message.kind !== control.kind)
              fail("UNEXPECTED_CONTROL_RECEIPT");
            control = undefined;
            break;
          case "sdk-event": {
            currentLifecycle(message.lifecycleId);
            if (expectedOperation?.operationKind !== "prompt" || lifecycle !== "running")
              fail("EVENT_LIFECYCLE");
            const event = message.event;
            if (event.type === "assistant_result") {
              assistantSucceeded = event.stopReason === "stop";
              if (event.stopReason === "error" || event.stopReason === "aborted")
                operationFailed = true;
            } else if (event.type === "tool_start") {
              const active = activeTool(event.callId);
              if (!active.authorized || active.started || event.toolName !== active.call.toolName)
                fail("TOOL_START_BARRIER");
              active.started = true;
            } else if (event.type === "tool_end") {
              const active = activeTool(event.callId);
              if (!active.started || !active.outputDone || event.toolName !== active.call.toolName)
                fail("TOOL_END_BARRIER");
              if (event.isError) operationFailed = true;
              closeTool();
            }
            break;
          }
          case "tool-call":
            currentLifecycle(message.lifecycleId);
            if (expectedOperation?.operationKind !== "prompt" || lifecycle !== "running" || tool)
              fail("TOOL_CALL_BARRIER");
            if (message.callId <= lastCallId) fail("TOOL_CALL_ID_REUSE");
            if (
              !bootstrap?.allowedTools.some(
                (allowed) =>
                  allowed.name === message.toolName && allowed.execution === message.execution,
              )
            )
              fail("TOOL_NOT_ALLOWED");
            lastCallId = message.callId;
            registerTransfer(message.input, "tool-input", "worker");
            tool = {
              call: message,
              authorized: false,
              started: false,
              inputDone: false,
              outputDone: false,
            };
            break;
          case "tool-result":
            acceptToolResult(message, "worker");
            break;
          case "tool-failure":
            activeTool(message.callId);
            operationFailed = true;
            closeTool();
            break;
          case "transfer-chunk":
          case "transfer-end":
            acceptTransfer(message, "worker");
            break;
        }
        workerSequence++;
      } catch (error) {
        terminal = "failed";
        throw error;
      }
    },
    get canStartRequest() {
      return (
        terminal === undefined &&
        !pending &&
        !canceled &&
        lifecycle === "running" &&
        (!expectedOperation || (ready && !operationSettled && !operationFailed && !tool))
      );
    },
    get canFinishSuccessfully() {
      return canFinishSuccessfully();
    },
    get successful() {
      return terminal === "done" || terminal === "initialized";
    },
    get bootstrap() {
      return bootstrap === undefined ? undefined : decodeBootstrap(encodeBootstrap(bootstrap));
    },
    takeTransfer(transferId: string): PiWorkerTransfer {
      const transfer = transfers.get(transferId);
      if (!transfer?.value) return fail("TRANSFER_UNAVAILABLE");
      transfers.delete(transferId);
      return transfer.value;
    },
  };
}
