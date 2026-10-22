import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectWorkRunAdmission from "../projectWork/ProjectWorkRunAdmission.ts";
import * as RunAdmission from "../orchestration-v2/RunAdmission.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  AuthSessionId,
  McpServerId,
  RunId,
  RunAttemptId,
  NodeId,
  ProviderThreadId,
  ProviderSessionId,
  type OrchestrationV2ServerCommand,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-orchestrator");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const projectId = ProjectId.make("project-1");
const execution: SecretRequests.SecretRequestExecution = {
  runId: RunId.make("run-1"),
  runAttemptId: RunAttemptId.make("attempt-1"),
  nodeId: NodeId.make("node-root"),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  providerSessionId: ProviderSessionId.make("native-session"),
};

const withService = <A, E>(
  body: (input: {
    readonly service: SecretRequests.SecretRequests["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Effect.Effect<A, E>,
  options: {
    readonly beforeRead?: () => Effect.Effect<void>;
    readonly activeAttemptId?: string;
    readonly currentRunId?: string;
    readonly providerSessionId?: string;
    readonly admissionCheck?: RunAdmission.RunAdmission["Service"]["check"];
    readonly threadId?: ThreadId;
    readonly runStatus?: string;
    readonly removeFails?: boolean;
    readonly closedFirst?: boolean;
    readonly failedRecords?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    let secretStatus = "pending";
    let failedRecords = options.failedRecords ?? 0;
    const requestThreadId = options.threadId ?? threadId;
    const layerDependencies = Layer.mergeAll(
      Layer.mock(RunAdmission.RunAdmission)({
        check: options.admissionCheck ?? (() => Effect.succeed({ _tag: "ordinary" })),
      }),
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) =>
            Effect.gen(function* () {
              yield* Effect.yieldNow;
              if (options.beforeRead !== undefined) yield* options.beforeRead();
              return Option.fromNullishOr(stored.get(name));
            }),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
          create: (name, value) =>
            stored.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "AlreadyExists",
                        module: "FileSystem",
                        method: "open",
                      }),
                    ),
                  } as never),
                )
              : Effect.sync(() => void stored.set(name, value)),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const existing = stored.get(name);
              if (existing) return existing;
              const value = new Uint8Array(bytes).fill(7);
              stored.set(name, value);
              return value;
            }),
          remove: (name) =>
            options.removeFails
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new Error("read-only"),
                  }),
                )
              : Effect.sync(() => void stored.delete(name)),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { projectId },
            runs: [
              {
                id:
                  (secretStatus === "saved" ? options.currentRunId : undefined) ?? execution.runId,
                status: options.runStatus ?? "running",
                rootNodeId: execution.nodeId,
                activeAttemptId:
                  (secretStatus === "saved" ? options.activeAttemptId : undefined) ??
                  execution.runAttemptId,
                providerThreadId: execution.providerThreadId,
              },
            ],
            providerThreads: [
              {
                id: execution.providerThreadId,
                providerSessionId:
                  (secretStatus === "saved" ? options.providerSessionId : undefined) ??
                  execution.providerSessionId,
              },
            ],
            providerSessions: [
              {
                id:
                  (secretStatus === "saved" ? options.providerSessionId : undefined) ??
                  execution.providerSessionId,
                status: "ready",
              },
            ],
            turnItems: [
              {
                id: turnItemId,
                threadId: requestThreadId,
                runId: "run-1",
                nodeId: "node-root",
                type: "secret_request",
                label: "GitHub token",
                reason: "Used as GH_TOKEN.",
                secretStatus,
              },
            ],
          } as never),
        dispatch: (command) => {
          if (command.type === "secret_request.record" && failedRecords > 0) {
            failedRecords -= 1;
            return Effect.fail(new Error("orchestrator unavailable") as never);
          }
          return Effect.sync(() => {
            dispatched.push(command);
            if (options.closedFirst && command.type === "secret_request.record") {
              secretStatus = "cancelled";
            } else if (command.type === "secret_request.record" && secretStatus === "pending") {
              secretStatus = command.secretStatus;
            }
            return {} as never;
          });
        },
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* SecretRequests.SecretRequests;
      return yield* body({ service, stored, dispatched });
    }).pipe(Effect.provide(SecretRequests.layer.pipe(Layer.provide(layerDependencies))));
  });

const valuesOf = (stored: Map<string, Uint8Array>) =>
  Array.from(stored.entries())
    .filter(([name]) => name !== "secret-request-salt")
    .map(([, bytes]) => new TextDecoder().decode(bytes));

it.effect("a saved answer becomes a one-use ref, and the thread only learns it was saved", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      assert.equal(dispatched.length, 1);
      assert.include(dispatched[0] as object, {
        type: "secret_request.record",
        secretStatus: "saved",
      });
      assert.notInclude(Object.values(dispatched[0] as object).map(String), "ghp_secret");

      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      const again = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
      assert.include(again.message, "already used");
    }),
  ),
);

it.effect("two concurrent uses of one ref hand the value out once", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const results = yield* Effect.all(
        [service.consume({ ref, projectId }), service.consume({ ref, projectId })].map(
          Effect.result,
        ),
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
    }),
  ),
);

it.effect("a save that loses to the card closing deletes the value and says so", () =>
  withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "agent_stopped");
        assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      }),
    { closedFirst: true },
  ),
);

it.effect("a save whose record failed can be saved again", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const failed = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "record_failed");
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { failedRecords: 1 },
  ),
);

it.effect("a ref only works in the project it was entered for", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const elsewhere = yield* service
        .consume({ ref, projectId: ProjectId.make("project-other") })
        .pipe(Effect.flip);
      assert.include(elsewhere.message, "does not exist");
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
    }),
  ),
);

it.effect("declining stores nothing, and a request is answered once", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      assert.deepEqual(valuesOf(stored), []);
      assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
      const late = yield* service
        .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
        .pipe(Effect.flip);
      assert.include(late.message, "already answered");
      assert.equal(dispatched.length, 1);
      assert.deepEqual(valuesOf(stored), []);
    }),
  ),
);

it.effect("traces and counts a saved answer without ever recording the value", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const counted = Metric.snapshot.pipe(
      Effect.map((snapshots) => {
        const found = snapshots.find(
          (snapshot) =>
            snapshot.id === "t3_secret_refs_consumed_total" &&
            snapshot.attributes?.result === "used",
        );
        return found?.type === "Counter" ? Number(found.state.count) : 0;
      }),
    );
    const before = yield* counted;
    yield* withService(({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        yield* service.consume({ ref, projectId });
      }),
    ).pipe(Effect.withTracer(tracer));
    assert.equal((yield* counted) - before, 1);
    const recorded = spans.flatMap((span) => [
      span.name,
      ...Array.from(span.attributes.values(), String),
    ]);
    assert.include(recorded, "SecretRequests.answer");
    assert.include(recorded, "SecretRequests.consume");
    assert.isFalse(recorded.some((value) => value.includes("ghp_secret")));
  }),
);

it.effect("works in threads with long ids, such as a delegated subagent's", () => {
  const delegatedThreadId = ThreadId.make(
    `thread:delegated-task:command%3Amcp%3A${"a".repeat(36)}%3Adelegate-task%3Arelease-notes-v0.2.0-${"b".repeat(40)}`,
  );
  return withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId: delegatedThreadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        assert.isTrue(Array.from(stored.keys()).every((name) => name.length < 100));
        const ref = Option.getOrThrow(
          yield* service.savedRef({ threadId: delegatedThreadId, turnItemId }),
        );
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { threadId: delegatedThreadId },
  );
});

it.effect("refuses an answer once the agent that asked has stopped", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const late = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.include(late.message, "has stopped");
        assert.deepEqual(valuesOf(stored), []);
        assert.equal(dispatched.length, 0);
      }),
    { runStatus: "completed" },
  ),
);

it.effect("a used value that cannot be deleted is not handed out", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const failed = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
        assert.include(failed.message, "Could not use");
      }),
    { removeFails: true },
  ),
);

it.effect.each(["archived", "revoked"] as const)(
  "keeps a %s owner's answer recorded without releasing its secret to an agent",
  (reason) =>
    withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "secret" },
          });
          assert.equal(dispatched.length, 1);
          assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
        }),
      {
        admissionCheck: (input) => {
          assert.equal(input.threadId, threadId);
          assert.equal(input.operation, "continue");
          return Effect.succeed({ _tag: "denied", reason });
        },
      },
    ),
);

it.effect("uses persisted ownership to withhold a secret after the owned thread was archived", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const admission = yield* RunAdmission.RunAdmission;
    const timestamp = "2026-01-01T00:00:00.000Z";
    yield* sql`INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, archived_at, payload_json
    ) VALUES (${threadId}, ${projectId}, 'Owned', 'codex', 'full-access', 'default',
      ${timestamp}, ${timestamp}, ${timestamp}, '{}')`;
    const configuration = JSON.stringify({
      providerInstanceId: "codex",
      model: "model",
      instructionsHash: "hash",
      toolIds: [],
      skillIds: [],
      runtimeVersion: "native",
      maxTokens: 100,
      maxDurationMs: 1000,
      paidFallback: false,
    });
    yield* sql`INSERT INTO t3_workflow_v2_run_admissions (
      admission_id, project_id, binding_id, root_id, root_task_id, thread_id, run_id, run_attempt_id,
      generation, fence, command_id, phase, depth, writable, root_deadline, expires_at,
      control_id, control_thread_id, snapshot_json, limits_json, parent_admission_id, uncertain
    ) VALUES ('admission', ${projectId}, 'binding', 'root', 'task', ${threadId}, 'run-1', NULL,
      1, 0, 'admitted-command', 'launched', 0, 0, '2099-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z', NULL, NULL, ${configuration}, '{}', NULL, 0)`;
    yield* withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "secret" },
          });
          assert.equal(dispatched.length, 1);
          assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
        }),
      { admissionCheck: admission.check },
    );
  }).pipe(
    Effect.provide(ProjectWorkRunAdmission.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
  ),
);

it.effect.each([
  { name: "replacement run", currentRunId: "run-2" },
  { name: "replacement attempt", activeAttemptId: "attempt-2" },
  { name: "replacement native session", providerSessionId: "native-session-2" },
])("withholds a saved request from a $name", (replacement) =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({ threadId, turnItemId, answer: { type: "save", secret: "secret" } });
        assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId, execution })));
      }),
    replacement,
  ),
);

it.effect("rechecks authority after a gated secret store read before releasing its ref", () =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let revoked = false;
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "secret" },
          });
          const pending = yield* service
            .savedRef({ threadId, turnItemId, execution })
            .pipe(Effect.forkChild);
          yield* Deferred.await(reading);
          revoked = true;
          yield* Deferred.succeed(release, undefined);
          assert.isTrue(Option.isNone(yield* Fiber.join(pending)));
        }),
      {
        beforeRead: () =>
          Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(release))),
        admissionCheck: (input) => {
          assert.equal(input.runId, execution.runId);
          assert.equal(input.originSessionId, execution.providerSessionId);
          return Effect.succeed(
            revoked ? { _tag: "denied", reason: "revoked" } : { _tag: "ordinary" },
          );
        },
      },
    );
  }),
);

it.effect(
  "checks the original native session atomically when it changes after the execution read",
  () =>
    Effect.gen(function* () {
      const checking = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let currentSession = execution.providerSessionId;
      yield* withService(
        ({ service }) =>
          Effect.gen(function* () {
            yield* service.answer({
              threadId,
              turnItemId,
              answer: { type: "save", secret: "secret" },
            });
            const pending = yield* service
              .savedRef({ threadId, turnItemId, execution })
              .pipe(Effect.forkChild);
            yield* Deferred.await(checking);
            currentSession = ProviderSessionId.make("replacement-session-same-attempt");
            yield* Deferred.succeed(release, undefined);
            assert.isTrue(Option.isNone(yield* Fiber.join(pending)));
          }),
        {
          admissionCheck: (input) =>
            Deferred.succeed(checking, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.map((): RunAdmission.AdmissionResult =>
                input.nativeTarget !== undefined &&
                input.nativeTarget.providerSessionId !== currentSession
                  ? { _tag: "denied", reason: "native-target-stale" }
                  : { _tag: "ordinary" },
              ),
            ),
        },
      );
    }),
);

it.effect.each(["global", "project", "session"] as const)(
  "Settings %s refs require every binding, expire, and are single-use",
  (scope) =>
    withService(({ service }) =>
      Effect.gen(function* () {
        const binding = {
          authSessionId: AuthSessionId.make("human"),
          scope,
          scopeId: "owner",
          expectedRevision: 3,
          logicalServerId: McpServerId.make("server"),
        };
        const secret = Redacted.make("private-settings-value");
        const ref = yield* service.prepareCatalog({ ...binding, secret });
        for (const changed of [
          { ...binding, authSessionId: "other" },
          { ...binding, scope: scope === "global" ? ("project" as const) : ("global" as const) },
          { ...binding, scopeId: "other" },
          { ...binding, expectedRevision: 4 },
          { ...binding, logicalServerId: "other" },
        ]) {
          assert.equal(
            (yield* Effect.result(service.consume({ ref, catalogBinding: changed })))._tag,
            "Failure",
          );
        }
        assert.equal((yield* Effect.result(service.consume({ ref, projectId })))._tag, "Failure");
        assert.equal(
          yield* service.consume({ ref, catalogBinding: binding }),
          "private-settings-value",
        );
        assert.equal(
          (yield* Effect.result(service.consume({ ref, catalogBinding: binding })))._tag,
          "Failure",
        );
        const expired = yield* service.prepareCatalog({ ...binding, secret });
        yield* TestClock.adjust("5 minutes");
        yield* TestClock.adjust(1);
        const result = yield* service
          .consume({ ref: expired, catalogBinding: binding })
          .pipe(Effect.flip);
        assert.equal(result.reason, "ref_expired");
      }),
    ),
);
