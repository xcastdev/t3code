import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { encodeCompletionAuthority } from "./ProjectTerminalStore.ts";
import type { AdmissionResult, CheckInput } from "../orchestration-v2/RunAdmission.ts";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  RunId,
  RunAttemptId,
  type OrchestrationV2ServerCommand,
  type ProjectTerminalSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { projectTerminalMigration } from "../persistence/ProjectTerminalMigration.ts";
import {
  claimTerminalCompletion,
  cancelTerminalCompletion,
  deliverProjectTerminalCompletion,
} from "./ProjectTerminalCompletion.ts";

const terminal: ProjectTerminalSummary = {
  projectId: ProjectId.make("project"),
  terminalId: "shared",
  generation: "generation-1",
  creatingThreadId: ThreadId.make("creator"),
  title: null,
  command: null,
  args: [],
  cwd: "/tmp",
  label: "Shared",
  status: "exited",
  pid: null,
  exitCode: 0,
  exitSignal: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const ordinaryAuthority =
  '{"runId":"run","nativeTarget":{"runAttemptId":"attempt","providerThreadId":"provider-thread","providerSessionId":"session"}}';
const admission = { check: () => Effect.succeed({ _tag: "ordinary" as const }) };
const memory = NodeSqliteClient.layer({ filename: ":memory:" });
it.effect("late completion and repeated startup reuse one durable V2 notice/wake identity", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of projectTerminalMigration.statements) yield* sql.unsafe(statement);
    yield* sql`INSERT INTO t3_workflow_v2_terminal_completions VALUES('project','shared','generation-1','recipient','noticeAndWake',${ordinaryAuthority},'subscribed')`;
    const receipts = new Set<string>();
    const effects: string[] = [];
    const dispatch = (command: { readonly commandId: string }) =>
      Effect.sync(() => {
        if (!receipts.has(command.commandId)) {
          receipts.add(command.commandId);
          effects.push(command.commandId);
        }
        return { sequence: 1, storedEvents: [] };
      });
    const dependencies = { sql, admission, orchestrator: { dispatch }, threads: { dispatch } };
    yield* deliverProjectTerminalCompletion(terminal, dependencies);
    yield* deliverProjectTerminalCompletion(terminal, dependencies);
    assert.equal(effects.length, 2);
    assert.equal(
      (yield* sql`SELECT phase FROM t3_workflow_v2_terminal_completions`)[0]?.phase,
      "delivered",
    );
    // A crash after the V2 commit but before the feature acknowledgement replays the same receipts.
    yield* sql`UPDATE t3_workflow_v2_terminal_completions SET phase='pending'`;
    yield* deliverProjectTerminalCompletion(terminal, { ...dependencies, recoverPending: true });
    assert.equal(effects.length, 2);
    assert.equal(
      (yield* sql`SELECT phase FROM t3_workflow_v2_terminal_completions`)[0]?.phase,
      "delivered",
    );
  }).pipe(Effect.scoped, Effect.provide(memory)),
);
it.effect(
  "notice mode never wakes and unknown canonical outcomes are retained without resending",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const statement of projectTerminalMigration.statements) yield* sql.unsafe(statement);
      yield* sql`INSERT INTO t3_workflow_v2_terminal_completions VALUES('project','shared','generation-1','recipient','notice',${ordinaryAuthority},'subscribed')`;
      let notices = 0;
      let wakes = 0;
      const dependencies = {
        sql,
        admission,
        orchestrator: {
          dispatch: () =>
            Effect.sync(() => {
              notices++;
              return { sequence: 1, storedEvents: [] };
            }),
        },
        threads: {
          dispatch: () =>
            Effect.sync(() => {
              wakes++;
              return { sequence: 1, storedEvents: [] };
            }),
        },
      };
      yield* deliverProjectTerminalCompletion(terminal, dependencies);
      assert.equal(notices, 1);
      assert.equal(wakes, 0);
      yield* sql`UPDATE t3_workflow_v2_terminal_completions SET phase='unknown'`;
      yield* deliverProjectTerminalCompletion(terminal, dependencies);
      assert.equal(notices, 1);
      assert.equal(wakes, 0);
    }).pipe(Effect.scoped, Effect.provide(memory)),
);

it.effect("finished-run completions keep retained root limits and reject successor bindings", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of projectTerminalMigration.statements) yield* sql.unsafe(statement);
    const owner = {
      projectId: terminal.projectId,
      threadId: "recipient",
      rootId: "root",
      bindingId: "binding",
      generation: 2,
      fence: 3,
      expiresAt: "2026-01-01T00:30:00.000Z",
      runId: "run",
      runAttemptId: "attempt",
      providerThreadId: "provider-thread",
      providerSessionId: "ended-session",
    };
    const authorityJson = yield* encodeCompletionAuthority({
      runId: "run",
      nativeTarget: {
        runAttemptId: "attempt",
        providerThreadId: "provider-thread",
        providerSessionId: "ended-session",
      },
      owner,
    });
    yield* sql`INSERT INTO t3_workflow_v2_terminal_completions VALUES('project','shared','generation-1','recipient','noticeAndWake',${authorityJson},'subscribed')`;
    const admittedOwner = {
      ...owner,
      threadId: ThreadId.make(owner.threadId),
      runId: RunId.make(owner.runId),
      runAttemptId: RunAttemptId.make(owner.runAttemptId),
      configuration: {
        providerInstanceId: "codex",
        model: "model",
        instructionsHash: "hash",
        toolIds: [],
        skillIds: [],
        runtimeVersion: "test",
        maxTokens: 100,
        maxDurationMs: 1000,
        paidFallback: false as const,
      },
    };
    let decision: AdmissionResult = { _tag: "admitted", owner: admittedOwner };
    const checks: CheckInput[] = [];
    const commands: OrchestrationV2ServerCommand[] = [];
    const dependencies = {
      sql,
      admission: {
        check: (input: CheckInput) =>
          Effect.sync(() => {
            checks.push(input);
            return decision;
          }),
      },
      orchestrator: { dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }) },
      threads: {
        dispatch: (command: OrchestrationV2ServerCommand) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: 1, storedEvents: [] };
          }),
      },
    };
    yield* deliverProjectTerminalCompletion(terminal, dependencies);
    assert.equal(commands.length, 1);
    assert.equal(checks[0]?.operation, "completion");
    assert.equal(checks[0]?.retainedOwner?.expiresAt, owner.expiresAt);
    const wake = commands[0];
    assert.equal(wake?.type, "message.dispatch");
    if (wake?.type === "message.dispatch") assert.equal(wake.retainedOwner?.bindingId, "binding");
    yield* sql`UPDATE t3_workflow_v2_terminal_completions SET phase='pending'`;
    decision = { _tag: "admitted", owner: { ...admittedOwner, bindingId: "successor-binding" } };
    yield* deliverProjectTerminalCompletion(terminal, { ...dependencies, recoverPending: true });
    assert.equal(commands.length, 1);
    assert.equal(
      (yield* sql`SELECT phase FROM t3_workflow_v2_terminal_completions`)[0]?.phase,
      "unknown",
    );
  }).pipe(Effect.scoped, Effect.provide(memory)),
);

it.effect("an unsubscribe winning before the atomic claim prevents notice and wake delivery", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of projectTerminalMigration.statements) yield* sql.unsafe(statement);
    yield* sql`INSERT INTO t3_workflow_v2_terminal_completions VALUES('project','shared','generation-1','recipient','noticeAndWake',${ordinaryAuthority},'subscribed')`;
    const selected = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const claimed = yield* Effect.gen(function* () {
      const rows = yield* sql<
        Parameters<typeof claimTerminalCompletion>[0]["subscription"]
      >`SELECT * FROM t3_workflow_v2_terminal_completions`;
      yield* Deferred.succeed(selected, undefined);
      yield* Deferred.await(release);
      return yield* claimTerminalCompletion({ sql, subscription: rows[0]!, recoverPending: false });
    }).pipe(Effect.forkChild);
    yield* Deferred.await(selected);
    yield* cancelTerminalCompletion({
      sql,
      projectId: terminal.projectId,
      terminalId: terminal.terminalId,
      recipientThreadId: "recipient",
    });
    yield* Deferred.succeed(release, undefined);
    assert.equal(yield* Fiber.join(claimed), null);
    let commands = 0;
    const dispatch = () =>
      Effect.sync(() => {
        commands++;
        return { sequence: 1, storedEvents: [] };
      });
    yield* deliverProjectTerminalCompletion(terminal, {
      sql,
      admission,
      orchestrator: { dispatch },
      threads: { dispatch },
    });
    assert.equal(commands, 0);
    assert.equal(
      (yield* sql`SELECT phase FROM t3_workflow_v2_terminal_completions`)[0]?.phase,
      "cancelled",
    );
  }).pipe(Effect.scoped, Effect.provide(memory)),
);

it.effect(
  "an already claimed completion rejects cancellation and recovers with the same receipts",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const statement of projectTerminalMigration.statements) yield* sql.unsafe(statement);
      yield* sql`INSERT INTO t3_workflow_v2_terminal_completions VALUES('project','shared','generation-1','recipient','noticeAndWake',${ordinaryAuthority},'subscribed')`;
      const claimReady = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const worker = yield* Effect.gen(function* () {
        const rows = yield* sql<
          Parameters<typeof claimTerminalCompletion>[0]["subscription"]
        >`SELECT * FROM t3_workflow_v2_terminal_completions`;
        const claim = yield* claimTerminalCompletion({
          sql,
          subscription: rows[0]!,
          recoverPending: false,
        });
        assert.notEqual(claim, null);
        yield* Deferred.succeed(claimReady, undefined);
        yield* Deferred.await(release);
        const dispatch = () => Effect.succeed({ sequence: 1, storedEvents: [] });
        yield* deliverProjectTerminalCompletion(terminal, {
          sql,
          admission,
          orchestrator: { dispatch },
          threads: { dispatch },
          recoverPending: true,
        });
      }).pipe(Effect.forkChild);
      yield* Deferred.await(claimReady);
      const cancelled = yield* Effect.result(
        cancelTerminalCompletion({
          sql,
          projectId: terminal.projectId,
          terminalId: terminal.terminalId,
          recipientThreadId: "recipient",
        }),
      );
      assert.equal(cancelled._tag, "Failure");
      if (cancelled._tag === "Failure")
        assert.equal(cancelled.failure.reason, "completion-in-flight");
      assert.equal(
        (yield* sql`SELECT phase FROM t3_workflow_v2_terminal_completions`)[0]?.phase,
        "pending",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(worker);
      assert.equal(
        (yield* sql`SELECT phase FROM t3_workflow_v2_terminal_completions`)[0]?.phase,
        "delivered",
      );
    }).pipe(Effect.scoped, Effect.provide(memory)),
);
