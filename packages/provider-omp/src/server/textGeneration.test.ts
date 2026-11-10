import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import type { OmpRpcError } from "./rpc.ts";
import { collectOmpText } from "./textGeneration.ts";
it.effect(
  "collects final native helper text only after its correlated prompt_result, not an ack or agent_end",
  () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<
        { type: string; [key: string]: unknown },
        OmpRpcError
      >();
      const writes = yield* Queue.unbounded<{ type: string; [key: string]: unknown }>();
      const result = yield* collectOmpText(
        { events, send: (r) => Queue.offer(writes, r).pipe(Effect.asVoid) },
        "title prompt",
      ).pipe(Effect.forkChild);
      const prompt = yield* Queue.take(writes);
      yield* Queue.offer(events, {
        type: "response",
        id: prompt.id,
        command: "prompt",
        success: true,
      });
      yield* Queue.offer(events, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Correct title" }] },
      });
      yield* Queue.offer(events, { type: "agent_end" });
      yield* Queue.offer(events, {
        type: "prompt_result",
        id: "stale",
        status: "error",
        sessionSettled: true,
      });
      yield* Queue.offer(events, {
        type: "prompt_result",
        id: prompt.id,
        status: "completed",
        sessionSettled: true,
      });
      expect(yield* Fiber.join(result)).toBe("Correct title");
      expect(
        (yield* collectOmpText({ events, send: () => Effect.void }, "").pipe(Effect.flip))
          .operation,
      ).toBe("helper");
    }),
);
it.effect("fails helper immediately on native runtime or persistence failure", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<{ type: string; [key: string]: unknown }, OmpRpcError>();
    const writes = yield* Queue.unbounded<{ type: string; [key: string]: unknown }>();
    const task = yield* collectOmpText(
      { events, send: (r) => Queue.offer(writes, r).pipe(Effect.asVoid) },
      "prompt",
    ).pipe(Effect.flip, Effect.forkChild);
    const prompt = yield* Queue.take(writes);
    yield* Queue.offer(events, {
      type: "notice",
      level: "error",
      source: "persist",
      message: "private path",
    });
    // A subsequent success must not hide an earlier persistence failure.
    yield* Queue.offer(events, {
      type: "prompt_result",
      id: prompt.id,
      status: "completed",
      sessionSettled: true,
    });
    expect((yield* Fiber.join(task)).detail).toBe("Native helper runtime or persistence failed");
  }),
);
