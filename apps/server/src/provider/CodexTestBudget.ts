import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const StopReason = Schema.Literals([
  "token-threshold",
  "deadline",
  "authority-lost",
  "invalid-usage",
  "model-changed",
  "unapproved-agent",
]);
const Policy = Schema.Struct({
  environmentId: Id,
  projectId: Id,
  taskId: Id,
  model: Schema.Literal("gpt-6-luna"),
  maximumTokens: Schema.Literal(64_000),
  deadlineAtMs: Safe.check(Schema.isGreaterThan(0)),
  memoryBytes: Schema.Literal(2_147_483_648),
});
const State = Schema.Struct({ totalTokens: Safe, stopReason: Schema.NullOr(StopReason) });
const Selection = Schema.Struct({
  threadId: Id,
  model: Schema.Literal("gpt-6-luna"),
  reasoningEffort: Schema.Literal("high"),
  serviceTier: Schema.Literal("default"),
});
const decodePolicy = Schema.decodeUnknownEffect(Policy, { onExcessProperty: "error" });
const decodeSelection = Schema.decodeUnknownEffect(Selection, { onExcessProperty: "error" });
const decodeState = Schema.decodeUnknownEffect(State);
const decodeSafe = Schema.decodeUnknownEffect(Safe);
const decodeId = Schema.decodeUnknownEffect(Id);
const decodeReason = Schema.decodeUnknownEffect(StopReason);

export class CodexTestBudgetError extends Schema.TaggedError<CodexTestBudgetError>()(
  "CodexTestBudgetError",
  { reason: Schema.String },
) {}
const denied = (reason: string) => new CodexTestBudgetError({ reason });

/** Private test-only owner. The caller must supply the current approved task authority;
 * this ledger permits monitored overshoot and cannot authorize a model or process launch. */
export const makeCodexTestBudget = Effect.fn("makeCodexTestBudget")(function* (options: {
  readonly policy: typeof Policy.Type;
  readonly assertCurrent: Effect.Effect<void, CodexTestBudgetError>;
}) {
  const policy = Object.freeze(
    yield* decodePolicy(options.policy).pipe(Effect.mapError(() => denied("Invalid test policy"))),
  );
  const assertCurrent = options.assertCurrent;
  const sql = yield* SqlClient.SqlClient;
  const identity = canonicalProjectWorkPayload([
    policy.environmentId,
    policy.projectId,
    policy.taskId,
  ]);
  const frozen = canonicalProjectWorkPayload(policy);
  yield* assertCurrent;
  yield* sql`CREATE TABLE IF NOT EXISTS codex_test_task_budget (
    identity TEXT PRIMARY KEY, policy_json TEXT NOT NULL, total_tokens INTEGER NOT NULL,
    stop_reason TEXT)`;
  yield* sql`CREATE TABLE IF NOT EXISTS codex_test_thread_budget (
    identity TEXT NOT NULL, thread_id TEXT NOT NULL, total_tokens INTEGER NOT NULL,
    PRIMARY KEY(identity,thread_id))`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const prior = yield* sql<{
        policy_json: string;
      }>`SELECT policy_json FROM codex_test_task_budget WHERE identity=${identity}`;
      if (prior.length > 0) {
        if (prior[0]!.policy_json !== frozen)
          return yield* denied("Original test policy cannot change");
      } else {
        const now = yield* Clock.currentTimeMillis;
        if (policy.deadlineAtMs <= now || policy.deadlineAtMs > now + 300_000)
          return yield* denied("A new test requires its original five-minute deadline");
        yield* sql`INSERT INTO codex_test_task_budget VALUES (${identity},${frozen},0,NULL)`;
      }
    }),
  );
  const read = Effect.fn("CodexTestBudget.read")(function* () {
    const rows = yield* sql<{
      policy_json: string;
      total_tokens: number;
      stop_reason: string | null;
    }>`SELECT policy_json,total_tokens,stop_reason FROM codex_test_task_budget WHERE identity=${identity}`;
    if (rows.length !== 1 || rows[0]!.policy_json !== frozen)
      return yield* denied("Original test owner is unavailable");
    return yield* decodeState({
      totalTokens: rows[0]!.total_tokens,
      stopReason: rows[0]!.stop_reason,
    }).pipe(Effect.mapError(() => denied("Retained test budget is invalid")));
  });
  const halt = Effect.fn("CodexTestBudget.halt")(function* (reason: typeof StopReason.Type) {
    const validated = yield* decodeReason(reason).pipe(
      Effect.mapError(() => denied("Invalid stop reason")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* read();
        yield* sql`UPDATE codex_test_task_budget SET stop_reason=COALESCE(stop_reason,${validated}) WHERE identity=${identity}`;
        return yield* read();
      }),
    );
  });
  const authorize = Effect.fn("CodexTestBudget.authorize")(function* (
    input: {
      readonly threadId: string;
      readonly model: string;
      readonly reasoningEffort: string;
      readonly serviceTier: string;
    },
    phase: "initialize" | "turn" = "initialize",
  ) {
    const selected = yield* decodeSelection(input).pipe(
      Effect.mapError(() => denied("Test model or launch selection changed")),
    );
    const authority = yield* Effect.result(assertCurrent);
    if (authority._tag === "Failure") {
      yield* halt("authority-lost");
      return yield* denied("Approved test authority is no longer current");
    }
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* read();
        if (state.stopReason !== null) return state;
        if ((yield* Clock.currentTimeMillis) >= policy.deadlineAtMs) {
          yield* sql`UPDATE codex_test_task_budget SET stop_reason='deadline' WHERE identity=${identity}`;
          return yield* read();
        }
        const prior =
          yield* sql`SELECT thread_id FROM codex_test_thread_budget WHERE identity=${identity} AND thread_id=${selected.threadId}`;
        if (phase === "initialize") {
          if (prior.length !== 0)
            return yield* denied("The original Codex test session cannot restart");
          yield* sql`INSERT INTO codex_test_thread_budget VALUES (${identity},${selected.threadId},0)`;
        } else if (phase !== "turn" || prior.length !== 1) {
          return yield* denied("Turn has no original authorized test session");
        }
        return state;
      }),
    );
    if (result.stopReason !== null)
      return yield* denied(`Codex test stopped: ${result.stopReason}`);
  });
  const observe = Effect.fn("CodexTestBudget.observe")(function* (
    threadId: string,
    cumulativeTokens: unknown,
  ) {
    const validatedThread = yield* decodeId(threadId).pipe(
      Effect.mapError(() => denied("Invalid usage owner")),
    );
    const decoded = yield* Effect.result(decodeSafe(cumulativeTokens));
    if (decoded._tag === "Failure") {
      yield* halt("invalid-usage");
      return yield* denied("Invalid cumulative token report");
    }
    // Keep late receipts after stopping, without reopening authority or refunding usage.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* read();
        const rows = yield* sql<{
          total_tokens: number;
        }>`SELECT total_tokens FROM codex_test_thread_budget WHERE identity=${identity} AND thread_id=${validatedThread}`;
        if (rows.length !== 1) return yield* denied("Token report has no authorized test thread");
        const prior = yield* decodeSafe(rows[0]!.total_tokens).pipe(
          Effect.mapError(() => denied("Retained usage is invalid")),
        );
        const next = Math.max(prior, decoded.success);
        const totalTokens = state.totalTokens + next - prior;
        if (!Number.isSafeInteger(totalTokens))
          return yield* denied("Token sum exceeds supported accounting");
        const stopReason =
          state.stopReason ??
          (totalTokens >= policy.maximumTokens
            ? "token-threshold"
            : (yield* Clock.currentTimeMillis) >= policy.deadlineAtMs
              ? "deadline"
              : null);
        yield* sql`UPDATE codex_test_thread_budget SET total_tokens=${next} WHERE identity=${identity} AND thread_id=${validatedThread}`;
        yield* sql`UPDATE codex_test_task_budget SET total_tokens=${totalTokens},stop_reason=${stopReason} WHERE identity=${identity}`;
        return { totalTokens, stopReason };
      }),
    );
  });
  return { policy, read, halt, authorize, observe };
});
