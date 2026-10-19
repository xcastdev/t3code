import * as Schema from "effect/Schema";
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { credential, sdkModel } from "./PiSubscriptionTestKit.ts";
import { toolStream } from "./fixtures/subscription-sse/streams.ts";
import * as Protocol from "./PiWorkerProtocol.ts";
import { projectTeamDerivedRecordId } from "../../projectWork/ProjectTeamPolicy.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  PI_WORKER_MAX_CHUNK_BYTES,
  PI_WORKER_MAX_FRAME_BYTES,
  PI_WORKER_MAX_REQUEST_BYTES,
  PI_WORKER_MAX_RESPONSE_BYTES,
  decodePiParentFrame,
  decodePiWorkerFrame,
  encodePiParentFrame,
  encodePiWorkerFrame,
  makePiWorkerLineFramer,
  makePiWorkerProtocol,
  type PiWorkerOperation,
  type PiParentFrame,
  type PiWorkerFrame,
} from "./PiWorkerProtocol.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeOperation = Schema.decodeUnknownSync(Protocol.PiWorkerOperation);
const decodeIdentity = Schema.decodeUnknownSync(Protocol.PiWorkerIdentity);
const decodeNative = Schema.decodeUnknownSync(Protocol.PiNativeReference);
const identity = { workerId: "owned-worker", generation: 3 };
const workerFrame = (message: PiWorkerFrame["message"], sequence = 0): PiWorkerFrame => ({
  version: 1,
  ...identity,
  sequence,
  message,
});
const parentFrame = (message: PiParentFrame["message"], sequence = 0): PiParentFrame => ({
  version: 1,
  ...identity,
  sequence,
  message,
});
const chunk = Buffer.from("native text delta").toString("base64");

const native = {
  sessionId: "native-session",
  sessionReference: "sessions/native-session.jsonl",
  leafId: "leaf-1",
  persisted: true,
};
const runtimeBootstrap = {
  type: "bootstrap" as const,
  executionMode: "managed" as const,
  expectedCwd: "/workspace",
  native: null,
  context: { transferId: "context", totalBytes: 0 },
  prompt: { transferId: "prompt", totalBytes: 0 },
  model: {
    provider: "commandcode",
    modelId: "inclusionai/ling-3.1-flash:free",
    api: "openai-completions" as const,
    contextWindow: 32_768,
    maxTokens: 512,
    reasoning: false,
  },
  allowedTools: [{ name: "read", execution: "local" as const, description: "read text" }],
};

describe("retained dispatch operation IDs", () => {
  it("preserves producer IDs through parent and worker frames and initialization", () => {
    for (const operationId of [
      projectTeamDerivedRecordId("approved-dispatch", "initialize"),
      "legacy_operation-1",
    ]) {
      const operation = { operationId, operationKind: "initialize" as const };
      expect(decodeOperation(operation)).toEqual(operation);
      const protocol = makePiWorkerProtocol(identity, operation);
      const bootstrap = { ...parentFrame({ ...runtimeBootstrap, prompt: null }), ...operation };
      const decodedParent = decodePiParentFrame(
        encodePiParentFrame(bootstrap).toString().trimEnd(),
      );
      expect(decodedParent).toEqual(bootstrap);
      protocol.acceptParent(decodedParent);
      protocol.acceptParent({
        ...parentFrame({ type: "transfer-end", transferId: "context" }, 1),
        ...operation,
      });
      protocol.acceptWorker({
        ...workerFrame({ type: "ready", actualCwd: "/workspace", native }),
        ...operation,
      });
      const initialized = { ...workerFrame({ type: "initialized", native }, 1), ...operation };
      const decodedWorker = decodePiWorkerFrame(
        encodePiWorkerFrame(initialized).toString().trimEnd(),
      );
      expect(decodedWorker).toEqual(initialized);
      protocol.acceptWorker(decodedWorker);
      expect(protocol.successful).toBe(true);
    }
  });

  it("rejects malformed operation IDs and keeps other identity tokens restricted", () => {
    const valid = projectTeamDerivedRecordId("approved-dispatch", "initialize");
    for (const operationId of [
      valid + "\n",
      valid + "\r",
      "guided:",
      "guided:" + "a".repeat(63),
      "guided:" + "a".repeat(65),
      "guided:" + "A".repeat(64),
      "guided:" + "g".repeat(64),
      "other:" + "a".repeat(64),
      "../operation",
      "a".repeat(129),
    ]) {
      expect(() =>
        decodeOperation({
          operationId,
          operationKind: "initialize",
        }),
      ).toThrow();
      expect(() =>
        decodePiWorkerFrame(
          json({
            ...workerFrame({ type: "initialized", native }),
            operationId,
            operationKind: "initialize",
          }),
        ),
      ).toThrow();
      expect(() =>
        decodePiParentFrame(
          json({ ...parentFrame(runtimeBootstrap), operationId, operationKind: "initialize" }),
        ),
      ).toThrow();
    }
    expect(() => decodeIdentity({ ...identity, workerId: valid })).toThrow();
    expect(() => decodeNative({ ...native, sessionId: valid })).toThrow();
  });
});

describe("subscription worker bootstrap", () => {
  it("accepts and retains the pinned Codex Responses route in its immutable bootstrap", () => {
    const subscriptionBootstrap = {
      ...runtimeBootstrap,
      model: {
        provider: "openai-codex",
        modelId: "gpt-6-luna",
        api: "openai-codex-responses" as const,
        contextWindow: 200_000,
        maxTokens: 2_048,
        reasoning: true,
        reasoningEffort: "high" as const,
        serviceTier: "default" as const,
      },
    };
    const frame = {
      ...parentFrame(subscriptionBootstrap),
      operationId: "subscription-bootstrap",
      operationKind: "prompt" as const,
    };
    expect(decodePiParentFrame(json(frame))).toEqual(frame);

    const protocol = makePiWorkerProtocol(identity, {
      operationId: "subscription-bootstrap",
      operationKind: "prompt",
    });
    protocol.acceptParent(frame);
    expect(protocol.bootstrap).toEqual(subscriptionBootstrap);
    expect(() =>
      protocol.acceptParent({
        ...frame,
        sequence: 1,
        message: { ...subscriptionBootstrap, model: runtimeBootstrap.model },
      }),
    ).toThrow("BOOTSTRAP_BARRIER");
    expect(protocol.bootstrap).toEqual(subscriptionBootstrap);
  });

  it("rejects unsupported API and non-pinned subscription routing fields", () => {
    const pinnedModel = {
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      api: "openai-codex-responses",
      contextWindow: 200_000,
      maxTokens: 2_048,
      reasoning: true,
      reasoningEffort: "high",
      serviceTier: "default",
    };
    for (const model of [
      { ...pinnedModel, api: "openai-responses" },
      { ...pinnedModel, provider: "openai" },
      { ...pinnedModel, modelId: "gpt-6-other" },
      { ...pinnedModel, reasoningEffort: "medium" },
      { ...pinnedModel, serviceTier: "flex" },
    ]) {
      expect(() =>
        decodePiParentFrame(
          JSON.stringify({
            ...parentFrame(runtimeBootstrap),
            message: { ...runtimeBootstrap, model },
          }),
        ),
      ).toThrow("INVALID_PARENT_FRAME");
    }
  });
});

function runtimePeers(operationKind: PiWorkerOperation["operationKind"] = "prompt") {
  const operation = { operationId: "operation-1", operationKind };
  const protocol = makePiWorkerProtocol(identity, operation);
  let workerSequence = 0;
  let parentSequence = 0;
  const workerFramer = makePiWorkerLineFramer((raw) =>
    protocol.acceptWorker(decodePiWorkerFrame(raw)),
  );
  const parentFramer = makePiWorkerLineFramer((raw) =>
    protocol.acceptParent(decodePiParentFrame(raw)),
  );
  return {
    operation,
    protocol,
    worker(message: PiWorkerFrame["message"]) {
      const frame = { ...workerFrame(message, workerSequence++), ...operation };
      workerFramer.push(encodePiWorkerFrame(frame));
      return frame;
    },
    parent(message: PiParentFrame["message"]) {
      const frame = { ...parentFrame(message, parentSequence++), ...operation };
      parentFramer.push(encodePiParentFrame(frame));
      return frame;
    },
    bootstrap(overrides: Partial<Extract<PiParentFrame["message"], { type: "bootstrap" }>> = {}) {
      this.parent({
        ...runtimeBootstrap,
        prompt: operationKind === "prompt" ? runtimeBootstrap.prompt : null,
        ...overrides,
      });
      this.parent({ type: "transfer-end", transferId: "context" });
      if (operationKind === "prompt") this.parent({ type: "transfer-end", transferId: "prompt" });
      this.worker({ type: "ready", actualCwd: "/workspace", native });
    },
  };
}

describe("parent-bound native operations", () => {
  it("initializes without inventing an agent or model request", () => {
    const peer = runtimePeers("initialize");
    peer.bootstrap();
    expect(peer.protocol.successful).toBe(false);
    peer.worker({ type: "initialized", native });
    expect(peer.protocol.successful).toBe(true);
    expect(() => peer.worker({ type: "agent_start", lifecycleId: 1 })).toThrow("WORKER_TERMINAL");
  });

  it("requires genuine compaction, persisted native receipt, idle and final request ACK", () => {
    const peer = runtimePeers("compact");
    peer.bootstrap();
    peer.worker({ type: "compaction_start", lifecycleId: 1 });
    peer.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
    peer.parent({ type: "headers", requestId: 1, status: 200 });
    const last = peer.parent({ type: "chunk", requestId: 1, data: chunk });
    peer.parent({ type: "end", requestId: 1 });
    peer.worker({ type: "compaction_end", lifecycleId: 1 });
    peer.worker({ type: "compacted", lifecycleId: 1, native: { ...native, leafId: "leaf-2" } });
    peer.worker({ type: "operation_settled", lifecycleId: 1, outcome: "success" });
    expect(peer.protocol.canFinishSuccessfully).toBe(false);
    peer.worker({ type: "ack", requestId: 1, chunkSequence: last.sequence });
    expect(peer.protocol.canFinishSuccessfully).toBe(true);
    peer.worker({ type: "done" });
    expect(peer.protocol.successful).toBe(true);
  });

  it.each(["initialize", "compact"] as const)("rejects agent lifecycle in %s", (kind) => {
    const peer = runtimePeers(kind);
    peer.bootstrap();
    expect(() => peer.worker({ type: "agent_start", lifecycleId: 1 })).toThrow("OPERATION_KIND");
    expect(peer.protocol.successful).toBe(false);
  });

  it("requires the latest real prompt cycle, assistant success and native persistence", () => {
    const peer = runtimePeers();
    peer.bootstrap();
    peer.worker({ type: "agent_start", lifecycleId: 1 });
    peer.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
    peer.parent({ type: "headers", requestId: 1, status: 200 });
    peer.parent({ type: "end", requestId: 1 });
    peer.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "assistant_result", stopReason: "stop" },
    });
    peer.worker({ type: "native", lifecycleId: 1, native: { ...native, leafId: "leaf-2" } });
    peer.worker({ type: "agent_end", lifecycleId: 1 });
    peer.worker({ type: "agent_settled", lifecycleId: 1 });
    expect(peer.protocol.canFinishSuccessfully).toBe(false);
    peer.worker({ type: "operation_settled", lifecycleId: 1, outcome: "success" });
    expect(peer.protocol.canFinishSuccessfully).toBe(true);
    peer.worker({ type: "done" });
    expect(peer.protocol.successful).toBe(true);
  });

  it("cannot use settlement alone as a manual compaction success", () => {
    const peer = runtimePeers("compact");
    peer.bootstrap();
    expect(() =>
      peer.worker({ type: "operation_settled", lifecycleId: 1, outcome: "success" }),
    ).toThrow("SETTLEMENT_BARRIER");
  });

  it.each(["prompt", "compact"] as const)(
    "requires fresh persisted native progress in every %s lifecycle",
    (kind) => {
      for (const secondLeaf of ["leaf-2", "leaf-3"]) {
        const peer = runtimePeers(kind);
        peer.bootstrap();
        const cycle = (id: number, leafId: string) => {
          peer.worker({
            type: kind === "prompt" ? "agent_start" : "compaction_start",
            lifecycleId: id,
          });
          peer.worker({ type: "request", lifecycleId: id, requestId: id, body: "{}" });
          peer.parent({ type: "headers", requestId: id, status: 200 });
          peer.parent({ type: "end", requestId: id });
          if (kind === "prompt") {
            peer.worker({
              type: "sdk-event",
              lifecycleId: id,
              event: { type: "assistant_result", stopReason: "stop" },
            });
            peer.worker({ type: "native", lifecycleId: id, native: { ...native, leafId } });
            peer.worker({ type: "agent_end", lifecycleId: id });
            peer.worker({ type: "agent_settled", lifecycleId: id });
          } else {
            peer.worker({ type: "compaction_end", lifecycleId: id });
            peer.worker({ type: "compacted", lifecycleId: id, native: { ...native, leafId } });
          }
        };
        cycle(1, "leaf-2");
        if (secondLeaf === "leaf-2") {
          expect(() => cycle(2, secondLeaf)).toThrow("NATIVE_PERSISTENCE_BARRIER");
          expect(peer.protocol.successful).toBe(false);
        } else {
          cycle(2, secondLeaf);
          peer.worker({ type: "operation_settled", lifecycleId: 2, outcome: "success" });
          peer.worker({ type: "done" });
          expect(peer.protocol.successful).toBe(true);
        }
      }
    },
  );

  it.each(["prompt", "compact"] as const)(
    "rejects an unchanged persisted native leaf in %s",
    (kind) => {
      const peer = runtimePeers(kind);
      peer.bootstrap();
      peer.worker({ type: kind === "prompt" ? "agent_start" : "compaction_start", lifecycleId: 1 });
      peer.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
      peer.parent({ type: "headers", requestId: 1, status: 200 });
      peer.parent({ type: "end", requestId: 1 });
      if (kind === "compact") peer.worker({ type: "compaction_end", lifecycleId: 1 });
      expect(() =>
        peer.worker({ type: kind === "prompt" ? "native" : "compacted", lifecycleId: 1, native }),
      ).toThrow("NATIVE_PERSISTENCE_BARRIER");
      expect(peer.protocol.successful).toBe(false);
    },
  );

  it.each(["prompt", "compact"] as const)(
    "rejects a missing persisted native leaf in %s",
    (kind) => {
      const peer = runtimePeers(kind);
      peer.bootstrap();
      peer.worker({ type: kind === "prompt" ? "agent_start" : "compaction_start", lifecycleId: 1 });
      if (kind === "compact") peer.worker({ type: "compaction_end", lifecycleId: 1 });
      expect(() =>
        peer.worker({
          type: kind === "prompt" ? "native" : "compacted",
          lifecycleId: 1,
          native: { ...native, leafId: null },
        }),
      ).toThrow("NATIVE_PERSISTENCE_BARRIER");
    },
  );

  it("rejects a foreign operation before native activity", () => {
    const peer = runtimePeers();
    peer.bootstrap();
    const frame = {
      ...workerFrame({ type: "agent_start", lifecycleId: 1 }, 1),
      ...peer.operation,
      operationId: "old-operation",
    };
    expect(() => peer.protocol.acceptWorker(decodePiWorkerFrame(json(frame)))).toThrow(
      "OPERATION_IDENTITY_MISMATCH",
    );
    expect(peer.protocol.successful).toBe(false);
  });

  it("rejects worker cwd and resumed native identity mismatches", () => {
    for (const bad of [
      { actualCwd: "/tmp", native },
      { actualCwd: "/workspace", native: { ...native, sessionId: "other-session" } },
    ]) {
      const peer = runtimePeers("initialize");
      peer.parent({ ...runtimeBootstrap, prompt: null, native });
      peer.parent({ type: "transfer-end", transferId: "context" });
      expect(() => peer.worker({ type: "ready", ...bad })).toThrow();
      expect(peer.protocol.successful).toBe(false);
    }
  });

  it("transfers a multibyte prompt without truncation and decodes UTF8 only after completion", () => {
    const peer = runtimePeers();
    const bytes = Buffer.from("😀".repeat(25_000));
    peer.parent({
      ...runtimeBootstrap,
      prompt: { transferId: "prompt", totalBytes: bytes.length },
    });
    peer.parent({ type: "transfer-end", transferId: "context" });
    for (let offset = 0, index = 0; offset < bytes.length; offset += 8192, index++) {
      peer.parent({
        type: "transfer-chunk",
        transferId: "prompt",
        index,
        offset,
        data: bytes.subarray(offset, offset + 8192).toString("base64"),
      });
    }
    peer.parent({ type: "transfer-end", transferId: "prompt" });
    expect(peer.protocol.takeTransfer("prompt")).toEqual({
      purpose: "prompt",
      text: "😀".repeat(25_000),
    });
    expect(() => peer.protocol.takeTransfer("prompt")).toThrow("TRANSFER_UNAVAILABLE");
    peer.worker({ type: "ready", actualCwd: "/workspace", native });
  });

  it("rejects combined accepted text over 128KiB before accepting any chunk", () => {
    const peer = runtimePeers();
    expect(() =>
      peer.parent({
        ...runtimeBootstrap,
        context: { transferId: "context", totalBytes: 100_000 },
        prompt: { transferId: "prompt", totalBytes: 32_000 },
      }),
    ).toThrow("TEXT_BYTE_LIMIT");
    expect(peer.protocol.successful).toBe(false);
  });

  it.each([
    { index: 1, offset: 0, data: Buffer.from("ab").toString("base64") },
    { index: 0, offset: 1, data: Buffer.from("ab").toString("base64") },
    { index: 0, offset: 0, data: Buffer.from("abc").toString("base64") },
  ])("rejects unordered or oversize transfers %j", (fields) => {
    const peer = runtimePeers();
    peer.parent({ ...runtimeBootstrap, prompt: { transferId: "prompt", totalBytes: 2 } });
    expect(() => peer.parent({ type: "transfer-chunk", transferId: "prompt", ...fields })).toThrow(
      "TRANSFER_ORDER_OR_LIMIT",
    );
  });

  it("rejects malformed transferred UTF8 at the completed byte barrier", () => {
    const peer = runtimePeers();
    peer.parent({ ...runtimeBootstrap, prompt: { transferId: "prompt", totalBytes: 2 } });
    peer.parent({
      type: "transfer-chunk",
      transferId: "prompt",
      index: 0,
      offset: 0,
      data: Buffer.from([0xc3, 0x28]).toString("base64"),
    });
    expect(() => peer.parent({ type: "transfer-end", transferId: "prompt" })).toThrow(
      "INVALID_TRANSFER_UTF8",
    );
  });

  it("preserves an accepted UTF8 byte order mark in prompt text", () => {
    const peer = runtimePeers();
    const text = "\uFEFFapproved scope";
    const bytes = Buffer.from(text);
    peer.parent({
      ...runtimeBootstrap,
      prompt: { transferId: "prompt", totalBytes: bytes.length },
    });
    peer.parent({
      type: "transfer-chunk",
      transferId: "prompt",
      index: 0,
      offset: 0,
      data: bytes.toString("base64"),
    });
    peer.parent({ type: "transfer-end", transferId: "prompt" });
    expect(peer.protocol.takeTransfer("prompt")).toEqual({ purpose: "prompt", text });
  });

  it("interrupt is irreversible even if late agent settlement succeeds", () => {
    const peer = runtimePeers();
    peer.bootstrap();
    peer.worker({ type: "agent_start", lifecycleId: 1 });
    peer.parent({ type: "interrupt", controlId: 1 });
    peer.worker({ type: "control-receipt", controlId: 1, kind: "interrupt" });
    expect(() => peer.worker({ type: "agent_end", lifecycleId: 1 })).toThrow("OPERATION_CANCELED");
    expect(peer.protocol.canFinishSuccessfully).toBe(false);
  });

  it("allows only one control until its exact receipt, and rejects receipt replay", () => {
    const peer = runtimePeers();
    peer.bootstrap();
    peer.worker({ type: "agent_start", lifecycleId: 1 });
    peer.parent({ type: "control", controlId: 1, kind: "steer", text: "keep scope" });
    peer.worker({ type: "control-receipt", controlId: 1, kind: "steer" });
    peer.parent({ type: "control", controlId: 2, kind: "follow-up", text: "validate" });
    expect(() => peer.worker({ type: "control-receipt", controlId: 1, kind: "steer" })).toThrow(
      "UNEXPECTED_CONTROL_RECEIPT",
    );
  });

  it.each(["initialize", "compact"] as const)("interrupts %s during worker startup", (kind) => {
    const peer = runtimePeers(kind);
    peer.parent({ ...runtimeBootstrap, prompt: null });
    peer.parent({ type: "interrupt", controlId: 1 });
    peer.worker({ type: "control-receipt", controlId: 1, kind: "interrupt" });
    expect(peer.protocol.successful).toBe(false);
    expect(() => peer.worker({ type: "ready", actualCwd: "/workspace", native })).toThrow(
      "OPERATION_CANCELED",
    );
  });

  it("cannot start another native request after parent request failure", () => {
    const peer = runtimePeers();
    peer.bootstrap();
    peer.worker({ type: "agent_start", lifecycleId: 1 });
    peer.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
    peer.parent({ type: "error", requestId: 1, code: "SDK_FAILURE" });
    expect(() =>
      peer.worker({ type: "request", lifecycleId: 1, requestId: 2, body: "{}" }),
    ).toThrow("OPERATION_FAILED");
  });
});

it("roundtrips the approved model request through an escaped frame larger than the former cap", () => {
  const body = JSON.stringify({ messages: [{ role: "user", content: '"\n'.repeat(3500) }] });
  expect(Buffer.byteLength(body)).toBeGreaterThan(12288);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16384);
  const frame = workerFrame({ type: "request", requestId: 1, lifecycleId: 1, body });
  const wire = encodePiWorkerFrame(frame);
  expect(wire.byteLength).toBeGreaterThan(16384);
  expect(wire.byteLength).toBeLessThanOrEqual(32768);
  expect(decodePiWorkerFrame(wire.toString().slice(0, -1))).toEqual(frame);
});

it("roundtrips a retained subscription history body within the approved request and frame limits", () => {
  const body = JSON.stringify({
    input: [
      { role: "assistant", content: [{ type: "output_text", text: "r".repeat(20_000) }] },
      { type: "reasoning", encrypted_content: "synthetic-retained-signature" },
      { type: "function_call", call_id: "call-1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "d".repeat(20_000) },
      { role: "user", content: [{ type: "input_text", text: "Continue" }] },
    ],
  });
  expect(Buffer.byteLength(body)).toBeGreaterThan(16_384);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65_536);
  const frame = workerFrame({ type: "request", requestId: 1, lifecycleId: 1, body });
  const wire = encodePiWorkerFrame(frame);
  expect(wire.byteLength).toBeGreaterThan(32_768);
  expect(wire.byteLength).toBeLessThanOrEqual(131_072);
  expect(decodePiWorkerFrame(wire.toString().slice(0, -1))).toEqual(frame);
});

it("keeps the original control-text limit after expanding model request frames", () => {
  const control = parentFrame({
    type: "control",
    controlId: 1,
    kind: "steer",
    text: "x".repeat(12288),
  });
  const wire = encodePiParentFrame(control);
  expect(decodePiParentFrame(wire.toString().slice(0, -1))).toEqual(control);
  expect(() =>
    encodePiParentFrame(
      parentFrame({
        type: "control",
        controlId: 2,
        kind: "steer",
        text: "x".repeat(12289),
      }),
    ),
  ).toThrow();
});

describe("bounded synchronous frame intake", () => {
  it("fails coalesced queue overflow while the consumer has not drained", async () => {
    const delivered: string[] = [];
    const queue = Protocol.makePiWorkerDispatchQueue((raw) => {
      delivered.push(raw);
    });
    const framer = makePiWorkerLineFramer(queue.push);
    const wire = encodePiWorkerFrame(workerFrame({ type: "done" }));
    expect(() => framer.push(Buffer.concat(Array.from({ length: 33 }, () => wire)))).toThrow(
      "DISPATCH_QUEUE_LIMIT",
    );
    await expect(queue.drain()).rejects.toThrow("DISPATCH_CLOSED");
    expect(delivered).toEqual([]);
  });

  it("drains frames in wire order without accepting a second drain", async () => {
    let release!: () => void;
    const receipt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];
    const queue = Protocol.makePiWorkerDispatchQueue(async (raw) => {
      delivered.push(raw);
      if (raw === "first") await receipt;
    });
    queue.push("first");
    queue.push("second");
    const drained = queue.drain();
    expect(delivered).toEqual(["first"]);
    await expect(queue.drain()).rejects.toThrow("DISPATCH_ALREADY_DRAINING");
    release();
    await drained;
    expect(delivered).toEqual(["first", "second"]);
    queue.finish();
    expect(() => queue.push("third")).toThrow("DISPATCH_CLOSED");
  });
});

describe("frozen tool manifest and bounded payloads", () => {
  function toolPeer(
    execution: "local" | "bridge" = "local",
    toolName: "read" | "write" | "lookup" = "read",
  ) {
    const peer = runtimePeers();
    peer.bootstrap({
      allowedTools: [{ name: toolName, execution, description: "workspace tool" }],
    });
    peer.worker({ type: "agent_start", lifecycleId: 1 });
    return peer;
  }
  function input(
    peer: ReturnType<typeof runtimePeers>,
    text = '{"arguments":{"path":"README.md"}}',
    callId = 1,
    nativeCallId = `native-call-${callId}`,
  ) {
    const call = peer.worker({
      type: "tool-call",
      lifecycleId: 1,
      callId,
      nativeCallId,
      toolName: peer.protocol.bootstrap!.allowedTools[0]!.name,
      execution: peer.protocol.bootstrap!.allowedTools[0]!.execution,
      input: { transferId: `input-${callId}`, totalBytes: Buffer.byteLength(text) },
    });
    for (let offset = 0, index = 0; offset < Buffer.byteLength(text); offset += 8192, index++)
      peer.worker({
        type: "transfer-chunk",
        transferId: `input-${callId}`,
        offset,
        index,
        data: Buffer.from(text)
          .subarray(offset, offset + 8192)
          .toString("base64"),
      });
    peer.worker({ type: "transfer-end", transferId: `input-${callId}` });
    return call;
  }
  it.each([
    "call_fixture|fc_fixture",
    "call.a:b/c+1=2-3_4|fc_1",
    "call_one/fc_one",
    "call_one|../fc_one",
    "call_one|fc_one|extra",
    "call_one|",
    "|fc_one",
    `${"a".repeat(63)}|${"b".repeat(64)}`,
    "é".repeat(64),
    "🛰".repeat(32),
  ])(
    "accepts opaque SDK native IDs through the encoded bridge approval/result lifecycle (%#)",
    (nativeCallId) => {
      const peer = toolPeer("bridge");
      const call = input(peer, '{"arguments":{"path":"README.md"}}', 1, nativeCallId);
      expect(decodePiWorkerFrame(encodePiWorkerFrame(call).toString().trimEnd())).toEqual(call);
      expect(peer.protocol.takeTransfer("input-1")).toEqual({
        purpose: "tool-input",
        value: { arguments: { path: "README.md" } },
      });

      peer.parent({ type: "tool-authorized", callId: 1, allowed: true });
      peer.worker({
        type: "sdk-event",
        lifecycleId: 1,
        event: { type: "tool_start", callId: 1, toolName: "read" },
      });
      const output = '{"kind":"text","text":"# T3"}';
      peer.parent({
        type: "tool-result",
        callId: 1,
        output: { transferId: "output", totalBytes: Buffer.byteLength(output) },
      });
      peer.parent({
        type: "transfer-chunk",
        transferId: "output",
        index: 0,
        offset: 0,
        data: Buffer.from(output).toString("base64"),
      });
      peer.parent({ type: "transfer-end", transferId: "output" });
      expect(peer.protocol.takeTransfer("output")).toEqual({
        purpose: "tool-result",
        value: { kind: "text", text: "# T3" },
      });
      peer.worker({
        type: "sdk-event",
        lifecycleId: 1,
        event: { type: "tool_end", callId: 1, toolName: "read", isError: false },
      });
      expect(peer.protocol.canStartRequest).toBe(true);
    },
  );
  it("preserves the pinned SDK's opaque tool ID through worker calls and replay requests", async () => {
    const sdk = streamCodexResponses(
      sdkModel,
      normalizeContext({ messages: [{ role: "user", content: "Read", timestamp: 1 }] }),
      {
        apiKey: credential,
        transport: "sse",
        maxRetries: 0,
        fetch: async () =>
          new Response(toolStream("punctuation"), {
            headers: { "content-type": "text/event-stream" },
          }),
      },
    );
    const result = await sdk.result();
    expect(result.stopReason).toBe("toolUse");
    const tool = result.content.find((part) => part.type === "toolCall");
    if (!tool) throw Error("Missing SDK tool call");
    expect(tool.id).toBe("call.a:b/c+1=2-3_4|fc_1");
    expect(tool.name).toBe("lookup");
    const peer = toolPeer("bridge", "lookup");
    const call = input(peer, JSON.stringify({ arguments: tool.arguments }), 1, tool.id);
    expect(call.message).toMatchObject({ nativeCallId: tool.id });

    const replay = convertResponsesMessages(
      sdkModel,
      normalizeContext({
        messages: [
          result,
          {
            role: "toolResult",
            toolCallId: tool.id,
            toolName: tool.name,
            content: [{ type: "text", text: "# T3" }],
            isError: false,
            timestamp: 2,
          },
        ],
      }),
      new Set([sdkModel.provider]),
    );
    const request = workerFrame({
      type: "request",
      requestId: 1,
      lifecycleId: 1,
      body: JSON.stringify({ input: replay }),
    });
    const decoded = decodePiWorkerFrame(encodePiWorkerFrame(request).toString().trimEnd());
    expect(decoded).toEqual(request);
    if (decoded.message.type !== "request") throw Error("Missing replay request");
    expect(JSON.parse(decoded.message.body).input).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call.a:b/c+1=2-3_4", id: "fc_1" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call.a:b/c+1=2-3_4" }),
    ]);
  });
  it("rejects empty, oversized and unsafe native IDs while generic frame tokens remain restricted", () => {
    const peer = toolPeer("bridge");
    const badNativeCallIds = [
      "",
      "a".repeat(129),
      "é".repeat(65),
      "🛰".repeat(33),
      "call_\ud800",
      "call_\udc00",
      ...["\r", "\n", "\t", " ", "\u0000", "\u007f", "\u0085", "\u200b", "\u202e", "\u00a0"].map(
        (control) => `call_one${control}|fc_one`,
      ),
    ];
    for (const nativeCallId of badNativeCallIds) {
      const frame = workerFrame({
        type: "tool-call",
        callId: 1,
        nativeCallId,
        lifecycleId: 1,
        toolName: "read",
        execution: "bridge",
        input: { transferId: "input", totalBytes: 0 },
      });
      expect(() => decodePiWorkerFrame(json(frame))).toThrow("INVALID_WORKER_FRAME");
      expect(() => encodePiWorkerFrame(frame)).toThrow();
    }
    expect(() =>
      decodePiWorkerFrame(
        json({
          ...workerFrame({ type: "done" }),
          workerId: "call_fixture|fc_fixture",
        }),
      ),
    ).toThrow();
    expect(() =>
      decodePiWorkerFrame(
        json(
          workerFrame({
            type: "tool-call",
            callId: 1,
            nativeCallId: "call_fixture|fc_fixture",
            lifecycleId: 1,
            toolName: "read|unexpected",
            execution: "bridge",
            input: { transferId: "input", totalBytes: 0 },
          }),
        ),
      ),
    ).toThrow();
    expect(peer.protocol.successful).toBe(false);
  });
  it.each(["local", "bridge"] as const)("delivers only authorized %s tool results", (execution) => {
    const peer = toolPeer(execution);
    input(peer);
    expect(peer.protocol.takeTransfer("input-1")).toEqual({
      purpose: "tool-input",
      value: { arguments: { path: "README.md" } },
    });
    peer.parent({ type: "tool-authorized", callId: 1, allowed: true });
    peer.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_start", callId: 1, toolName: "read" },
    });
    const output = '{"kind":"text","text":"# T3"}';
    const send = execution === "local" ? peer.worker.bind(peer) : peer.parent.bind(peer);
    send({
      type: "tool-result",
      callId: 1,
      output: { transferId: "output", totalBytes: Buffer.byteLength(output) },
    });
    send({
      type: "transfer-chunk",
      transferId: "output",
      index: 0,
      offset: 0,
      data: Buffer.from(output).toString("base64"),
    });
    send({ type: "transfer-end", transferId: "output" });
    expect(peer.protocol.takeTransfer("output")).toEqual({
      purpose: "tool-result",
      value: { kind: "text", text: "# T3" },
    });
    peer.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_end", callId: 1, toolName: "read", isError: false },
    });
    input(peer, '{"arguments":{}}', 2);
    expect(peer.protocol.successful).toBe(false);
  });
  it("allows a complete classified local read error result to continue the same operation", () => {
    const peer = toolPeer("local");
    input(peer, '{"arguments":{"path":"missing-leaf"}}');
    peer.parent({ type: "tool-authorized", callId: 1, allowed: true });
    peer.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_start", callId: 1, toolName: "read" },
    });

    const output = '{"kind":"error","code":"FILE_NOT_FOUND"}';
    peer.worker({
      type: "tool-result",
      callId: 1,
      output: { transferId: "output-1", totalBytes: Buffer.byteLength(output) },
    });
    peer.worker({
      type: "transfer-chunk",
      transferId: "output-1",
      index: 0,
      offset: 0,
      data: Buffer.from(output).toString("base64"),
    });
    peer.worker({ type: "transfer-end", transferId: "output-1" });
    expect(peer.protocol.takeTransfer("output-1")).toEqual({
      purpose: "tool-result",
      value: { kind: "error", code: "FILE_NOT_FOUND" },
    });
    peer.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_end", callId: 1, toolName: "read", isError: true },
    });

    peer.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
    peer.parent({ type: "headers", requestId: 1, status: 200 });
    peer.parent({ type: "end", requestId: 1 });
    peer.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "assistant_result", stopReason: "stop" },
    });
    peer.worker({ type: "native", lifecycleId: 1, native: { ...native, leafId: "leaf-2" } });
    peer.worker({ type: "agent_end", lifecycleId: 1 });
    peer.worker({ type: "agent_settled", lifecycleId: 1 });
    peer.worker({ type: "operation_settled", lifecycleId: 1, outcome: "success" });
    peer.worker({ type: "done" });
    expect(peer.protocol.successful).toBe(true);
  });
  it("rejects unknown classified read errors and error results from bridge tools", () => {
    const invalid = toolPeer("local");
    input(invalid);
    invalid.parent({ type: "tool-authorized", callId: 1, allowed: true });
    invalid.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_start", callId: 1, toolName: "read" },
    });
    const unknownOutput = '{"kind":"error","code":"UNCLASSIFIED"}';
    invalid.worker({
      type: "tool-result",
      callId: 1,
      output: { transferId: "unknown-output", totalBytes: Buffer.byteLength(unknownOutput) },
    });
    invalid.worker({
      type: "transfer-chunk",
      transferId: "unknown-output",
      index: 0,
      offset: 0,
      data: Buffer.from(unknownOutput).toString("base64"),
    });
    expect(() => invalid.worker({ type: "transfer-end", transferId: "unknown-output" })).toThrow(
      "INVALID_TOOL_JSON",
    );

    const bridge = toolPeer("bridge");
    input(bridge);
    bridge.parent({ type: "tool-authorized", callId: 1, allowed: true });
    bridge.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_start", callId: 1, toolName: "read" },
    });
    const output = '{"kind":"error","code":"FILE_NOT_FOUND"}';
    bridge.parent({
      type: "tool-result",
      callId: 1,
      output: { transferId: "bridge-output", totalBytes: Buffer.byteLength(output) },
    });
    bridge.parent({
      type: "transfer-chunk",
      transferId: "bridge-output",
      index: 0,
      offset: 0,
      data: Buffer.from(output).toString("base64"),
    });
    let bridgeStartedContinuation = false;
    try {
      bridge.parent({ type: "transfer-end", transferId: "bridge-output" });
      bridge.protocol.takeTransfer("bridge-output");
      bridge.worker({
        type: "sdk-event",
        lifecycleId: 1,
        event: { type: "tool_end", callId: 1, toolName: "read", isError: true },
      });
      bridge.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
      bridgeStartedContinuation = true;
    } catch {
      // Denial may occur while decoding the output or closing the classified lifecycle.
    }
    expect(bridgeStartedContinuation).toBe(false);
  });
  it("keeps generic SDK errors, non-read errors, denied calls, and tool-failure fatal", () => {
    const genericSdkError = toolPeer();
    input(genericSdkError);
    genericSdkError.parent({ type: "tool-authorized", callId: 1, allowed: true });
    genericSdkError.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_start", callId: 1, toolName: "read" },
    });
    const ordinary = '{"kind":"text","text":"ordinary result"}';
    genericSdkError.worker({
      type: "tool-result",
      callId: 1,
      output: { transferId: "ordinary-output", totalBytes: Buffer.byteLength(ordinary) },
    });
    genericSdkError.worker({
      type: "transfer-chunk",
      transferId: "ordinary-output",
      index: 0,
      offset: 0,
      data: Buffer.from(ordinary).toString("base64"),
    });
    genericSdkError.worker({ type: "transfer-end", transferId: "ordinary-output" });
    genericSdkError.protocol.takeTransfer("ordinary-output");
    genericSdkError.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_end", callId: 1, toolName: "read", isError: true },
    });
    expect(() =>
      genericSdkError.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" }),
    ).toThrow("OPERATION_FAILED");

    const writeError = toolPeer("local", "write");
    input(writeError, '{"arguments":{"path":"missing-leaf","content":"value"}}');
    writeError.parent({ type: "tool-authorized", callId: 1, allowed: true });
    writeError.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_start", callId: 1, toolName: "write" },
    });
    const classified = '{"kind":"error","code":"FILE_NOT_FOUND"}';
    writeError.worker({
      type: "tool-result",
      callId: 1,
      output: { transferId: "write-output", totalBytes: Buffer.byteLength(classified) },
    });
    writeError.worker({
      type: "transfer-chunk",
      transferId: "write-output",
      index: 0,
      offset: 0,
      data: Buffer.from(classified).toString("base64"),
    });
    let writeStartedContinuation = false;
    try {
      writeError.worker({ type: "transfer-end", transferId: "write-output" });
      writeError.protocol.takeTransfer("write-output");
      writeError.worker({
        type: "sdk-event",
        lifecycleId: 1,
        event: { type: "tool_end", callId: 1, toolName: "write", isError: true },
      });
      writeError.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
      writeStartedContinuation = true;
    } catch {
      // The write variant is refused before model continuation at either boundary.
    }
    expect(writeStartedContinuation).toBe(false);

    const denied = toolPeer();
    input(denied);
    denied.parent({ type: "tool-authorized", callId: 1, allowed: false });
    expect(() =>
      denied.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" }),
    ).toThrow("OPERATION_FAILED");

    const failed = toolPeer();
    input(failed);
    failed.worker({ type: "tool-failure", callId: 1, code: "TOOL_FAILURE" });
    expect(() =>
      failed.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" }),
    ).toThrow("OPERATION_FAILED");
  });
  it("rejects an unadvertised tool instead of granting authority from worker text", () => {
    const peer = toolPeer();
    expect(() =>
      peer.worker({
        type: "tool-call",
        lifecycleId: 1,
        callId: 1,
        nativeCallId: "call.a:b/c+1=2-3_4|fc_1",
        toolName: "shell",
        execution: "local",
        input: { transferId: "input", totalBytes: 0 },
      }),
    ).toThrow("TOOL_NOT_ALLOWED");
  });
  it("prevents execution before the completed input and parent authorization", () => {
    const peer = toolPeer();
    input(peer, undefined, 1, "call.a:b/c+1=2-3_4|fc_1");
    expect(() =>
      peer.worker({
        type: "sdk-event",
        lifecycleId: 1,
        event: { type: "tool_start", callId: 1, toolName: "read" },
      }),
    ).toThrow("TOOL_START_BARRIER");
  });
  it("fails a second active tool invocation", () => {
    const peer = toolPeer();
    input(peer);
    expect(() => input(peer, '{"arguments":{}}', 2)).toThrow("TOOL_CALL_BARRIER");
  });
  it.each([false, true])(
    "requires the prior tool to close before model dispatch (closed=%s)",
    (closed) => {
      const peer = toolPeer();
      input(peer);
      expect(peer.protocol.canStartRequest).toBe(false);
      if (!closed) {
        expect(() =>
          peer.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" }),
        ).toThrow("REQUEST_BARRIER");
        expect(peer.protocol.successful).toBe(false);
        return;
      }
      peer.parent({ type: "tool-authorized", callId: 1, allowed: true });
      peer.worker({
        type: "sdk-event",
        lifecycleId: 1,
        event: { type: "tool_start", callId: 1, toolName: "read" },
      });
      const output = Buffer.from('{"kind":"text","text":"ok"}');
      peer.worker({
        type: "tool-result",
        callId: 1,
        output: { transferId: "output", totalBytes: output.length },
      });
      peer.worker({
        type: "transfer-chunk",
        transferId: "output",
        index: 0,
        offset: 0,
        data: output.toString("base64"),
      });
      peer.worker({ type: "transfer-end", transferId: "output" });
      peer.worker({
        type: "sdk-event",
        lifecycleId: 1,
        event: { type: "tool_end", callId: 1, toolName: "read", isError: false },
      });
      expect(peer.protocol.canStartRequest).toBe(true);
      peer.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
      peer.parent({ type: "headers", requestId: 1, status: 200 });
      peer.parent({ type: "end", requestId: 1 });
      peer.worker({
        type: "sdk-event",
        lifecycleId: 1,
        event: { type: "assistant_result", stopReason: "stop" },
      });
      peer.worker({ type: "native", lifecycleId: 1, native: { ...native, leafId: "leaf-2" } });
      peer.worker({ type: "agent_end", lifecycleId: 1 });
      peer.worker({ type: "agent_settled", lifecycleId: 1 });
      peer.worker({ type: "operation_settled", lifecycleId: 1, outcome: "success" });
      peer.worker({ type: "done" });
      expect(peer.protocol.successful).toBe(true);
    },
  );
  it.each([
    '{"arguments":{},"url":"https://worker-chosen"}',
    '{"arguments":{"__proto__":{"polluted":true}}}',
    '{"arguments":{"constructor":{"prototype":{"polluted":true}}}}',
    '{"arguments":{"nested":' + "[".repeat(65) + "0" + "]".repeat(65) + "}}",
  ])("rejects malformed, excess-key or unsafe nested tool JSON %s", (text) => {
    const peer = toolPeer();
    expect(() => input(peer, text)).toThrow("INVALID_TOOL_JSON");
    expect(peer.protocol.successful).toBe(false);
  });
  it("checks the combined active input and output budget before result allocation", () => {
    const peer = toolPeer();
    input(peer, json({ arguments: { text: "x".repeat(40_000) } }));
    peer.parent({ type: "tool-authorized", callId: 1, allowed: true });
    peer.worker({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_start", callId: 1, toolName: "read" },
    });
    expect(() =>
      peer.worker({
        type: "tool-result",
        callId: 1,
        output: { transferId: "output", totalBytes: 30_000 },
      }),
    ).toThrow("TOOL_PAYLOAD_BYTE_LIMIT");
  });
  it("pins the accepted allowlist even when the parent caller edits its input object", () => {
    const peer = runtimePeers();
    const frame: PiParentFrame = {
      ...parentFrame({
        ...runtimeBootstrap,
        allowedTools: runtimeBootstrap.allowedTools.map((item) => ({ ...item })),
        prompt: runtimeBootstrap.prompt,
      }),
      ...peer.operation,
    };
    peer.protocol.acceptParent(frame);
    if (frame.message.type === "bootstrap")
      Object.assign(frame.message.allowedTools[0]!, { name: "shell" });
    peer.protocol.acceptParent({
      ...parentFrame({ type: "transfer-end", transferId: "context" }, 1),
      ...peer.operation,
    });
    peer.protocol.acceptParent({
      ...parentFrame({ type: "transfer-end", transferId: "prompt" }, 2),
      ...peer.operation,
    });
    peer.protocol.acceptWorker({
      ...workerFrame({ type: "ready", actualCwd: "/workspace", native }),
      ...peer.operation,
    });
    peer.protocol.acceptWorker({
      ...workerFrame({ type: "agent_start", lifecycleId: 1 }, 1),
      ...peer.operation,
    });
    expect(() =>
      peer.protocol.acceptWorker({
        ...workerFrame(
          {
            type: "tool-call",
            callId: 1,
            nativeCallId: "native-1",
            lifecycleId: 1,
            toolName: "shell",
            execution: "local",
            input: { transferId: "input", totalBytes: 0 },
          },
          2,
        ),
        ...peer.operation,
      }),
    ).toThrow("TOOL_NOT_ALLOWED");
  });
  it("charges bridged result bytes cumulatively even after each result is consumed", () => {
    const peer = toolPeer("bridge");
    const text = json({ kind: "text", text: "x".repeat(16_000) });
    const bytes = Buffer.from(text);
    let completed = 0;
    expect(() => {
      for (let callId = 1; callId <= 120; callId++) {
        input(peer, '{"arguments":{}}', callId);
        peer.protocol.takeTransfer(`input-${callId}`);
        peer.parent({ type: "tool-authorized", callId, allowed: true });
        peer.worker({
          type: "sdk-event",
          lifecycleId: 1,
          event: { type: "tool_start", callId, toolName: "read" },
        });
        peer.parent({
          type: "tool-result",
          callId,
          output: { transferId: `output-${callId}`, totalBytes: bytes.length },
        });
        for (let offset = 0, index = 0; offset < bytes.length; offset += 8192, index++)
          peer.parent({
            type: "transfer-chunk",
            transferId: `output-${callId}`,
            offset,
            index,
            data: bytes.subarray(offset, offset + 8192).toString("base64"),
          });
        peer.parent({ type: "transfer-end", transferId: `output-${callId}` });
        peer.protocol.takeTransfer(`output-${callId}`);
        peer.worker({
          type: "sdk-event",
          lifecycleId: 1,
          event: { type: "tool_end", callId, toolName: "read", isError: false },
        });
        completed++;
      }
    }).toThrow("EVENT_BYTE_LIMIT");
    expect(completed).toBeGreaterThan(50);
    expect(completed).toBeLessThan(120);
    expect(peer.protocol.successful).toBe(false);
  });
  it("counts the strict outer envelope in the JSON nesting cap", () => {
    const peer = toolPeer();
    const text = '{"arguments":{"nested":' + "[".repeat(64) + "0" + "]".repeat(64) + "}}";
    expect(() => input(peer, text)).toThrow("INVALID_TOOL_JSON");
  });
});

function peers() {
  const protocol = makePiWorkerProtocol(identity);
  let workerSequence = 0;
  let parentSequence = 0;
  const workerFramer = makePiWorkerLineFramer((raw) =>
    protocol.acceptWorker(decodePiWorkerFrame(raw)),
  );
  const parentFramer = makePiWorkerLineFramer((raw) =>
    protocol.acceptParent(decodePiParentFrame(raw)),
  );
  return {
    protocol,
    worker(message: PiWorkerFrame["message"]) {
      workerFramer.push(encodePiWorkerFrame(workerFrame(message, workerSequence++)));
    },
    parent(message: PiParentFrame["message"]) {
      const frame = parentFrame(message, parentSequence++);
      parentFramer.push(encodePiParentFrame(frame));
      return frame;
    },
    finish() {
      workerFramer.finish();
      parentFramer.finish();
    },
  };
}

function start(peer: ReturnType<typeof peers>) {
  peer.worker({ type: "agent_start", lifecycleId: 1 });
  peer.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
  peer.parent({ type: "headers", requestId: 1, status: 200 });
}
function settle(peer: ReturnType<typeof peers>, lifecycleId = 1) {
  peer.worker({ type: "agent_end", lifecycleId });
  peer.worker({ type: "agent_settled", lifecycleId });
}

describe("private worker wire bounds", () => {
  it("round-trips exact allowed envelopes and rejects unknown nested and outer fields", () => {
    const frame = workerFrame({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
    expect(decodePiWorkerFrame(encodePiWorkerFrame(frame).toString().trimEnd())).toEqual(frame);
    for (const invalid of [
      { ...frame, credential: "forbidden" },
      { ...frame, message: { ...frame.message, url: "https://forbidden" } },
      { ...frame, version: 2 },
      { ...frame, message: { type: "arbitrary_event", event: {} } },
      { ...frame, message: { type: "end", requestId: 1 } },
    ])
      expect(() => decodePiWorkerFrame(json(invalid))).toThrow("INVALID_WORKER_FRAME");
    const parent = parentFrame({ type: "end", requestId: 1 });
    expect(decodePiParentFrame(json(parent))).toEqual(parent);
    expect(() => decodePiParentFrame(json({ ...parent, extra: true }))).toThrow(
      "INVALID_PARENT_FRAME",
    );
    expect(() =>
      decodePiParentFrame(json({ ...parent, message: { ...parent.message, extra: true } })),
    ).toThrow("INVALID_PARENT_FRAME");
  });

  it("rejects invalid request IDs, worker tokens and response statuses", () => {
    for (const requestId of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        decodePiWorkerFrame(
          json(workerFrame({ type: "request", lifecycleId: 1, requestId, body: "{}" })),
        ),
      ).toThrow("INVALID_WORKER_FRAME");
    }
    for (const workerId of ["", "x".repeat(129), "worker with spaces"]) {
      expect(() =>
        decodePiWorkerFrame(json({ ...workerFrame({ type: "done" }), workerId })),
      ).toThrow("INVALID_WORKER_FRAME");
    }
    expect(() =>
      decodePiParentFrame(
        json({
          ...parentFrame({ type: "headers", requestId: 1, status: 200 }),
          message: { type: "headers", requestId: 1, status: 403 },
        }),
      ),
    ).toThrow("INVALID_PARENT_FRAME");
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects unsafe sequence and generation %s",
    (value) => {
      const frame = workerFrame({ type: "done" });
      expect(() => decodePiWorkerFrame(json({ ...frame, sequence: value }))).toThrow();
      expect(() => decodePiWorkerFrame(json({ ...frame, generation: value }))).toThrow();
    },
  );

  it("checks frame bytes before JSON decoding, including multibyte strings and LF", () => {
    expect(() => decodePiWorkerFrame("x".repeat(PI_WORKER_MAX_FRAME_BYTES))).toThrow(
      "FRAME_BYTE_LIMIT",
    );
    expect(() => decodePiWorkerFrame("😀".repeat(PI_WORKER_MAX_FRAME_BYTES / 4))).toThrow(
      "FRAME_BYTE_LIMIT",
    );
    const request = (body: string) =>
      workerFrame({ type: "request", lifecycleId: 1, requestId: 1, body });
    expect(() =>
      encodePiWorkerFrame(request("x".repeat(PI_WORKER_MAX_REQUEST_BYTES))),
    ).not.toThrow();
    const oversized = request("😀".repeat(PI_WORKER_MAX_REQUEST_BYTES / 4 + 1));
    expect(() => decodePiWorkerFrame(json(oversized))).toThrow("INVALID_WORKER_FRAME");
    // The body fits its own bound, but JSON escaping exceeds the outer frame budget.
    expect(() => encodePiWorkerFrame(request("\n".repeat(PI_WORKER_MAX_REQUEST_BYTES)))).toThrow(
      "FRAME_BYTE_LIMIT",
    );
  });

  it.each(["", "Zg", "Zh==", "Zg===", "Zg==\n", "-_==", "!!!!", "é"])(
    "rejects noncanonical base64 %s",
    (data) => {
      expect(() =>
        decodePiParentFrame(json(parentFrame({ type: "chunk", requestId: 1, data }))),
      ).toThrow("INVALID_PARENT_FRAME");
    },
  );

  it("checks both encoded and decoded chunk limits", () => {
    const data = Buffer.alloc(PI_WORKER_MAX_CHUNK_BYTES).toString("base64");
    expect(
      decodePiParentFrame(json(parentFrame({ type: "chunk", requestId: 1, data }))).message,
    ).toEqual({ type: "chunk", requestId: 1, data });
    for (const size of [PI_WORKER_MAX_CHUNK_BYTES + 1, PI_WORKER_MAX_CHUNK_BYTES + 3]) {
      const oversized = Buffer.alloc(size).toString("base64");
      expect(() =>
        decodePiParentFrame(json(parentFrame({ type: "chunk", requestId: 1, data: oversized }))),
      ).toThrow("INVALID_PARENT_FRAME");
    }
  });
});

describe("incremental LF framing", () => {
  it("handles every UTF8 split and coalesced frames without buffering completed frames", () => {
    const frame = workerFrame({ type: "request", lifecycleId: 1, requestId: 1, body: "😀é" });
    const wire = encodePiWorkerFrame(frame);
    for (let split = 0; split <= wire.length; split++) {
      const received: PiWorkerFrame[] = [];
      const framer = makePiWorkerLineFramer((raw) => received.push(decodePiWorkerFrame(raw)));
      framer.push(wire.subarray(0, split));
      framer.push(wire.subarray(split));
      framer.finish();
      expect(received).toEqual([frame]);
    }
    let received = 0;
    const framer = makePiWorkerLineFramer(() => received++);
    framer.push(Buffer.concat(Array.from({ length: 200 }, () => wire)));
    expect(received).toBe(200);
    framer.finish();
  });

  it("rejects oversized segmented and coalesced frames before callback delivery", () => {
    for (const coalesced of [true, false]) {
      let received = 0;
      const framer = makePiWorkerLineFramer(() => received++);
      if (coalesced) {
        expect(() =>
          framer.push(Buffer.from(`${"x".repeat(PI_WORKER_MAX_FRAME_BYTES)}\n`)),
        ).toThrow("FRAME_BYTE_LIMIT");
      } else {
        framer.push(Buffer.alloc(PI_WORKER_MAX_FRAME_BYTES - 1, 120));
        expect(() => framer.push(Buffer.from("x\n"))).toThrow("FRAME_BYTE_LIMIT");
      }
      expect(received).toBe(0);
      expect(() => framer.push(Buffer.from("{}\n"))).toThrow("FRAMER_CLOSED");
    }
  });

  it("rejects invalid UTF8, partial EOF, and use after EOF", () => {
    const invalid = makePiWorkerLineFramer(() => {
      throw new Error("must not deliver");
    });
    expect(() => invalid.push(Buffer.from([0xc3, 10]))).toThrow("INVALID_FRAME_UTF8");
    const partial = makePiWorkerLineFramer(() => {});
    partial.push(Buffer.from("{"));
    expect(() => partial.finish()).toThrow("INCOMPLETE_FRAME");
    expect(() => partial.push(Buffer.from("}\n"))).toThrow("FRAMER_CLOSED");
    const complete = makePiWorkerLineFramer(() => {});
    complete.finish();
    expect(() => complete.push(Buffer.from("{}\n"))).toThrow("FRAMER_CLOSED");
  });

  it("stops on callback failure without delivering later coalesced frames", () => {
    let calls = 0;
    const framer = makePiWorkerLineFramer(() => {
      calls++;
      throw new Error("consumer failed");
    });
    expect(() => framer.push(Buffer.from("{}\n{}\n"))).toThrow("consumer failed");
    expect(calls).toBe(1);
    expect(() => framer.finish()).toThrow("FRAMER_CLOSED");
  });
});

describe("SDK settlement and parent drain barrier", () => {
  describe("review regressions", () => {
    it("requires an explicit safe ACK chunk sequence and lifecycle identity", () => {
      const messages = [
        { type: "ack", requestId: 1 },
        { type: "request", requestId: 1, body: "{}" },
        ...["agent_start", "agent_end", "agent_settled"].map((type) => ({ type })),
      ];
      for (const message of messages) {
        expect(() =>
          decodePiWorkerFrame(json({ ...workerFrame({ type: "done" }), message })),
        ).toThrow("INVALID_WORKER_FRAME");
      }
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() =>
          decodePiWorkerFrame(
            json(workerFrame({ type: "ack", requestId: 1, chunkSequence: value })),
          ),
        ).toThrow("INVALID_WORKER_FRAME");
      }
      for (const lifecycleId of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() =>
          decodePiWorkerFrame(json(workerFrame({ type: "agent_start", lifecycleId }))),
        ).toThrow("INVALID_WORKER_FRAME");
      }
    });

    it("rejects repeated ACK for the prior chunk at a fresh worker sequence", () => {
      const peer = peers();
      start(peer);
      const firstChunk = peer.parent({ type: "chunk", requestId: 1, data: chunk });
      const ack = { type: "ack", requestId: 1, chunkSequence: firstChunk.sequence } as const;
      peer.worker(ack);
      peer.parent({ type: "chunk", requestId: 1, data: chunk });
      expect(() => peer.worker(ack)).toThrow("UNEXPECTED_ACK");
      expect(peer.protocol.successful).toBe(false);
    });

    it("rejects a request using an already settled SDK lifecycle", () => {
      const peer = peers();
      start(peer);
      peer.parent({ type: "end", requestId: 1 });
      settle(peer);
      expect(() =>
        peer.worker({ type: "request", lifecycleId: 1, requestId: 2, body: "{}" }),
      ).toThrow("REQUEST_LIFECYCLE");
      expect(peer.protocol.successful).toBe(false);
    });

    it("does not reuse old transport success for an empty fresh SDK cycle", () => {
      const peer = peers();
      start(peer);
      peer.parent({ type: "end", requestId: 1 });
      settle(peer);
      peer.worker({ type: "agent_start", lifecycleId: 2 });
      settle(peer, 2);
      expect(() => peer.worker({ type: "done" })).toThrow("SUCCESS_BARRIER");
      expect(peer.protocol.successful).toBe(false);
    });

    it.each(["agent_end", "agent_settled"] as const)(
      "rejects delayed old %s at a fresh worker sequence during a new lifecycle",
      (type) => {
        const peer = peers();
        start(peer);
        peer.parent({ type: "end", requestId: 1 });
        settle(peer);
        peer.worker({ type: "agent_start", lifecycleId: 2 });
        peer.worker({ type: "request", lifecycleId: 2, requestId: 2, body: "{}" });
        peer.parent({ type: "headers", requestId: 2, status: 200 });
        peer.parent({ type: "end", requestId: 2 });
        if (type === "agent_settled") peer.worker({ type: "agent_end", lifecycleId: 2 });
        expect(() => peer.worker({ type, lifecycleId: 1 })).toThrow(
          type === "agent_end" ? "UNEXPECTED_AGENT_END" : "UNEXPECTED_AGENT_SETTLED",
        );
        expect(peer.protocol.successful).toBe(false);
      },
    );

    it("rejects a stale request lifecycle and reused lifecycle start", () => {
      for (const reuse of [false, true]) {
        const peer = peers();
        start(peer);
        peer.parent({ type: "end", requestId: 1 });
        settle(peer);
        if (reuse) {
          expect(() => peer.worker({ type: "agent_start", lifecycleId: 1 })).toThrow(
            "LIFECYCLE_ID_REUSE",
          );
        } else {
          peer.worker({ type: "agent_start", lifecycleId: 2 });
          expect(() =>
            peer.worker({ type: "request", lifecycleId: 1, requestId: 2, body: "{}" }),
          ).toThrow("REQUEST_LIFECYCLE");
        }
      }
    });

    it("does not reuse a previous lifecycle's delayed transport end for an empty cycle", () => {
      const peer = peers();
      start(peer);
      settle(peer);
      peer.worker({ type: "agent_start", lifecycleId: 2 });
      peer.parent({ type: "end", requestId: 1 });
      settle(peer, 2);
      expect(() => peer.worker({ type: "done" })).toThrow("SUCCESS_BARRIER");
      expect(peer.protocol.successful).toBe(false);
    });

    it("allows a fresh complete lifecycle and a transport retry within a running lifecycle", () => {
      const peer = peers();
      start(peer);
      peer.parent({ type: "end", requestId: 1 });
      settle(peer);
      expect(peer.protocol.canStartRequest).toBe(false);
      peer.worker({ type: "agent_start", lifecycleId: 2 });
      for (const requestId of [2, 3]) {
        peer.worker({ type: "request", lifecycleId: 2, requestId, body: "{}" });
        peer.parent({ type: "headers", requestId, status: 200 });
        if (requestId === 2) peer.parent({ type: "error", requestId, code: "TRANSIENT" });
        else {
          const received = peer.parent({ type: "chunk", requestId, data: chunk });
          peer.worker({ type: "ack", requestId, chunkSequence: received.sequence });
          peer.parent({ type: "end", requestId });
        }
      }
      settle(peer, 2);
      peer.worker({ type: "done" });
      expect(peer.protocol.successful).toBe(true);
    });

    it("allows the matching ACK for the next chunk after the prior ACK was consumed", () => {
      const peer = peers();
      start(peer);
      for (let count = 0; count < 2; count++) {
        const received = peer.parent({ type: "chunk", requestId: 1, data: chunk });
        peer.worker({ type: "ack", requestId: 1, chunkSequence: received.sequence });
      }
      peer.parent({ type: "end", requestId: 1 });
      settle(peer);
      peer.worker({ type: "done" });
      expect(peer.protocol.successful).toBe(true);
    });
  });

  it("accepts early SDK settlement but waits for parent end, final ACK and done", () => {
    const peer = peers();
    start(peer);
    const received = peer.parent({ type: "chunk", requestId: 1, data: chunk });
    settle(peer);
    expect(peer.protocol.canFinishSuccessfully).toBe(false);
    expect(peer.protocol.canStartRequest).toBe(false);
    peer.parent({ type: "end", requestId: 1 });
    expect(peer.protocol.canFinishSuccessfully).toBe(false);
    peer.worker({ type: "ack", requestId: 1, chunkSequence: received.sequence });
    expect(peer.protocol.canFinishSuccessfully).toBe(true);
    expect(peer.protocol.successful).toBe(false);
    peer.worker({ type: "done" });
    expect(peer.protocol.successful).toBe(true);
    peer.finish();
  });

  it.each(["missing-end", "missing-ack", "agent-end-only", "error"] as const)(
    "rejects premature done for %s and permanently closes the validator",
    (control) => {
      const peer = peers();
      start(peer);
      const received = peer.parent({ type: "chunk", requestId: 1, data: chunk });
      peer.worker({ type: "agent_end", lifecycleId: 1 });
      if (control !== "agent-end-only") peer.worker({ type: "agent_settled", lifecycleId: 1 });
      if (control === "error")
        peer.parent({ type: "error", requestId: 1, code: "TRANSPORT_FAILED" });
      else if (control !== "missing-end") peer.parent({ type: "end", requestId: 1 });
      if (control !== "missing-ack")
        peer.worker({ type: "ack", requestId: 1, chunkSequence: received.sequence });
      expect(() => peer.worker({ type: "done" })).toThrow("SUCCESS_BARRIER");
      expect(peer.protocol.successful).toBe(false);
      expect(() => peer.worker({ type: "agent_start", lifecycleId: 1 })).toThrow("FRAMER_CLOSED");
      expect(() =>
        peer.protocol.acceptWorker(workerFrame({ type: "agent_start", lifecycleId: 1 })),
      ).toThrow("WORKER_TERMINAL");
    },
  );

  it("permits multiple sequential calls, steering and a successful retry before final settlement", () => {
    const peer = peers();
    start(peer);
    peer.parent({ type: "error", requestId: 1, code: "TRANSIENT_ERROR" });
    peer.worker({ type: "agent_end", lifecycleId: 1 });
    expect(peer.protocol.canFinishSuccessfully).toBe(false);
    peer.worker({ type: "agent_start", lifecycleId: 2 });
    for (const requestId of [2, 3]) {
      peer.worker({ type: "request", lifecycleId: 2, requestId, body: "{}" });
      peer.parent({ type: "headers", requestId, status: 200 });
      const received = peer.parent({ type: "chunk", requestId, data: chunk });
      peer.worker({ type: "ack", requestId, chunkSequence: received.sequence });
      peer.parent({ type: "end", requestId });
      expect(peer.protocol.canFinishSuccessfully).toBe(false);
    }
    settle(peer, 2);
    peer.worker({ type: "done" });
    expect(peer.protocol.successful).toBe(true);
  });

  it("blocks the next dispatch after early settle until the last receipt drains", () => {
    const peer = peers();
    start(peer);
    settle(peer);
    expect(() =>
      peer.worker({ type: "request", lifecycleId: 1, requestId: 2, body: "{}" }),
    ).toThrow("REQUEST_BARRIER");
  });

  it("cancellation consumes end and ACK drain but cannot become success or dispatch again", () => {
    const peer = peers();
    start(peer);
    const received = peer.parent({ type: "chunk", requestId: 1, data: chunk });
    peer.worker({ type: "cancel", requestId: 1 });
    settle(peer);
    peer.parent({ type: "end", requestId: 1 });
    peer.worker({ type: "ack", requestId: 1, chunkSequence: received.sequence });
    expect(peer.protocol.canFinishSuccessfully).toBe(false);
    expect(peer.protocol.canStartRequest).toBe(false);
    peer.worker({ type: "worker-failure", code: "CANCELED" });
    expect(peer.protocol.successful).toBe(false);
    expect(() =>
      peer.worker({ type: "request", lifecycleId: 1, requestId: 2, body: "{}" }),
    ).toThrow("WORKER_TERMINAL");
  });

  it("rejects request reuse and late receipts for the previous request", () => {
    const reused = peers();
    start(reused);
    reused.parent({ type: "end", requestId: 1 });
    expect(() =>
      reused.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" }),
    ).toThrow("REQUEST_ID_REUSE");
    const delayed = peers();
    start(delayed);
    delayed.parent({ type: "end", requestId: 1 });
    delayed.worker({ type: "request", lifecycleId: 1, requestId: 2, body: "{}" });
    expect(() => delayed.parent({ type: "error", requestId: 1, code: "OLD_ERROR" })).toThrow(
      "UNEXPECTED_REQUEST_ID",
    );
  });

  it("bounds cumulative response bytes despite individual chunk ACKs", () => {
    const peer = peers();
    start(peer);
    const data = Buffer.alloc(PI_WORKER_MAX_CHUNK_BYTES).toString("base64");
    for (let bytes = 0; bytes < PI_WORKER_MAX_RESPONSE_BYTES; bytes += PI_WORKER_MAX_CHUNK_BYTES) {
      const received = peer.parent({ type: "chunk", requestId: 1, data });
      peer.worker({ type: "ack", requestId: 1, chunkSequence: received.sequence });
    }
    expect(() => peer.parent({ type: "chunk", requestId: 1, data: chunk })).toThrow(
      "RESPONSE_BYTE_LIMIT",
    );
  });
});

describe("identity, ordering and lifecycle failures", () => {
  it("rejects duplicate sequence numbers independently in each direction", () => {
    const worker = makePiWorkerProtocol(identity);
    const startFrame = workerFrame({ type: "agent_start", lifecycleId: 1 });
    worker.acceptWorker(startFrame);
    expect(() => worker.acceptWorker(startFrame)).toThrow("FRAME_ORDER");
    const parent = makePiWorkerProtocol(identity);
    parent.acceptWorker(workerFrame({ type: "agent_start", lifecycleId: 1 }));
    parent.acceptWorker(
      workerFrame({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" }, 1),
    );
    const headers = parentFrame({ type: "headers", requestId: 1, status: 200 });
    parent.acceptParent(headers);
    expect(() => parent.acceptParent(headers)).toThrow("FRAME_ORDER");
  });
  it.each(["worker", "parent"] as const)(
    "rejects foreign %s identity and out-of-order frames",
    (direction) => {
      for (const override of [{ workerId: "other" }, { generation: 2 }, { sequence: 1 }]) {
        const protocol = makePiWorkerProtocol(identity);
        if (direction === "worker") {
          expect(() =>
            protocol.acceptWorker({
              ...workerFrame({ type: "agent_start", lifecycleId: 1 }),
              ...override,
            }),
          ).toThrow();
        } else {
          protocol.acceptWorker(workerFrame({ type: "agent_start", lifecycleId: 1 }));
          protocol.acceptWorker(
            workerFrame({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" }, 1),
          );
          expect(() =>
            protocol.acceptParent({
              ...parentFrame({ type: "headers", requestId: 1, status: 200 }),
              ...override,
            }),
          ).toThrow();
        }
        expect(protocol.successful).toBe(false);
        expect(protocol.canStartRequest).toBe(false);
      }
    },
  );

  it.each([
    "duplicate-headers",
    "missing-headers",
    "unacked-chunk",
    "unexpected-ack",
    "duplicate-end",
    "duplicate-cancel",
  ] as const)("rejects %s", (control) => {
    const peer = peers();
    peer.worker({ type: "agent_start", lifecycleId: 1 });
    peer.worker({ type: "request", lifecycleId: 1, requestId: 1, body: "{}" });
    if (control !== "missing-headers") peer.parent({ type: "headers", requestId: 1, status: 200 });
    if (control === "duplicate-headers")
      expect(() => peer.parent({ type: "headers", requestId: 1, status: 200 })).toThrow(
        "DUPLICATE_HEADERS",
      );
    if (control === "missing-headers")
      expect(() => peer.parent({ type: "chunk", requestId: 1, data: chunk })).toThrow(
        "HEADERS_REQUIRED",
      );
    if (control === "unacked-chunk") {
      peer.parent({ type: "chunk", requestId: 1, data: chunk });
      expect(() => peer.parent({ type: "chunk", requestId: 1, data: chunk })).toThrow(
        "CHUNK_ACK_REQUIRED",
      );
    }
    if (control === "unexpected-ack")
      expect(() => peer.worker({ type: "ack", requestId: 1, chunkSequence: 0 })).toThrow(
        "UNEXPECTED_ACK",
      );
    if (control === "duplicate-end") {
      peer.parent({ type: "end", requestId: 1 });
      expect(() => peer.parent({ type: "end", requestId: 1 })).toThrow("UNEXPECTED_REQUEST_ID");
    }
    if (control === "duplicate-cancel") {
      peer.worker({ type: "cancel", requestId: 1 });
      expect(() => peer.worker({ type: "cancel", requestId: 1 })).toThrow("DUPLICATE_CANCEL");
    }
  });

  it("requires paired agent lifecycle and prevents resurrection after done or failure", () => {
    for (const type of ["agent_end", "agent_settled"] as const) {
      const peer = peers();
      expect(() => peer.worker({ type, lifecycleId: 1 })).toThrow();
    }
    for (const succeeded of [true, false]) {
      const peer = peers();
      if (succeeded) {
        start(peer);
        peer.parent({ type: "end", requestId: 1 });
        settle(peer);
        peer.worker({ type: "done" });
      } else peer.worker({ type: "worker-failure", code: "STARTUP_FAILED" });
      expect(peer.protocol.successful).toBe(succeeded);
      expect(() => peer.parent({ type: "error", requestId: 1, code: "LATE" })).toThrow(
        "WORKER_TERMINAL",
      );
      expect(peer.protocol.successful).toBe(false);
    }
  });
});
