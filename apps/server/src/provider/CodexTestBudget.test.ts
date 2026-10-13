import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { makeCodexTestBudget } from "./CodexTestBudget.ts";

const policy = {
  environmentId: "isolated-environment",
  projectId: "greeting-project",
  taskId: "approved-greeting-task",
  model: "gpt-6-luna" as const,
  maximumTokens: 64_000 as const,
  deadlineAtMs: 300_100,
  memoryBytes: 2_147_483_648 as const,
};
const selection = (threadId: string) => ({
  threadId,
  model: "gpt-6-luna",
  reasoningEffort: "high",
  serviceTier: "default",
});
const run = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.scoped(body).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

it.effect(
  "shares reported usage, retains overshoot and refuses another launch after the threshold",
  () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(100);
        const budget = yield* makeCodexTestBudget({ policy, assertCurrent: Effect.void });
        yield* budget.authorize(selection("worker"));
        yield* budget.authorize(selection("reviewer"));
        expect((yield* budget.observe("worker", 40_000)).totalTokens).toBe(40_000);
        const stopped = yield* budget.observe("reviewer", 30_000);
        expect(stopped).toMatchObject({ totalTokens: 70_000, stopReason: "token-threshold" });
        expect((yield* Effect.result(budget.authorize(selection("worker"))))._tag).toBe("Failure");
        expect((yield* budget.observe("worker", 42_000)).totalTokens).toBe(72_000);
      }),
    ),
);

it.effect("replays cumulative reports without double charging or resetting a saved stop", () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100);
      const budget = yield* makeCodexTestBudget({ policy, assertCurrent: Effect.void });
      yield* budget.authorize(selection("worker"));
      yield* budget.observe("worker", 64_001);
      const resumed = yield* makeCodexTestBudget({ policy, assertCurrent: Effect.void });
      expect((yield* resumed.observe("worker", 64_001)).totalTokens).toBe(64_001);
      expect((yield* resumed.observe("worker", 63_000)).totalTokens).toBe(64_001);
      expect((yield* resumed.read()).stopReason).toBe("token-threshold");
      expect((yield* Effect.result(resumed.authorize(selection("later"))))._tag).toBe("Failure");
    }),
  ),
);

it.effect("freezes the original deadline, rejects renewal and persists deadline termination", () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100);
      const budget = yield* makeCodexTestBudget({ policy, assertCurrent: Effect.void });
      expect(
        (yield* Effect.result(
          makeCodexTestBudget({
            policy: { ...policy, deadlineAtMs: 600_100 },
            assertCurrent: Effect.void,
          }),
        ))._tag,
      ).toBe("Failure");
      yield* TestClock.setTime(policy.deadlineAtMs);
      expect((yield* Effect.result(budget.authorize(selection("worker"))))._tag).toBe("Failure");
      expect((yield* budget.read()).stopReason).toBe("deadline");
    }),
  ),
);

it.effect("denies model upgrades, unknown usage owners and revoked authority before launch", () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100);
      const budget = yield* makeCodexTestBudget({ policy, assertCurrent: Effect.void });
      expect(
        (yield* Effect.result(budget.authorize({ ...selection("worker"), model: "gpt-6-sol" })))
          ._tag,
      ).toBe("Failure");
      expect((yield* Effect.result(budget.observe("unowned", 100)))._tag).toBe("Failure");
      const revoked = yield* makeCodexTestBudget({ policy, assertCurrent: Effect.void });
      yield* revoked.halt("authority-lost");
      expect((yield* Effect.result(revoked.authorize(selection("worker"))))._tag).toBe("Failure");
      expect((yield* revoked.read()).totalTokens).toBe(0);
    }),
  ),
);

it.effect(
  "denies reopening a native session so a new cumulative counter cannot erase prior usage",
  () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(100);
        const budget = yield* makeCodexTestBudget({ policy, assertCurrent: Effect.void });
        yield* budget.authorize(selection("worker"));
        yield* budget.observe("worker", 20_000);
        expect((yield* Effect.result(budget.authorize(selection("worker"))))._tag).toBe("Failure");
        expect((yield* budget.read()).totalTokens).toBe(20_000);
      }),
    ),
);
