import * as Schema from "effect/Schema";
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
  type PiParentFrame,
  type PiWorkerFrame,
} from "./PiWorkerProtocol.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
