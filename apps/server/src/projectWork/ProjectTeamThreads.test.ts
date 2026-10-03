// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProjectWorkFoundationCommitCommand,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "@effect/vitest";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import type { ProjectTeamDispatchSnapshot } from "./ProjectTeamDispatch.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";
import { makeProjectTeamThreads } from "./ProjectTeamThreads.ts";

const at = "2026-01-01T00:00:00.000Z";
class RootDenied extends Schema.TaggedError<RootDenied>()("RootDenied", {
  reason: Schema.String,
}) {}
const projectId = ProjectId.make("team-project");
const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("pi"),
  model: "test-model",
  options: [{ id: "reasoningEffort", value: "high" }],
};

// Immutable metadata fixture only. Root admission and native execution proof remain separate.
const decodeClaim = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const snapshot = (): ProjectTeamDispatchSnapshot => {
  const claim = decodeClaim({
    type: "project-work.foundation.commit",
    projectId,
    commandId: "claim",
    expectedRevision: 1,
    attribution: {
      actor: { kind: "system", id: "root" },
      source: { kind: "system", id: "root" },
      recordedAt: at,
    },
    records: [],
    committedAt: at,
    transition: {
      kind: "claim",
      taskId: "task",
      expectedTaskRevision: 1,
      authorizationGateId: "grant",
      expectedGateRevision: 1,
      claim: {
        type: "project-work.task.claim",
        projectId,
        commandId: "task-claim",
        taskId: "task",
        attemptId: "attempt",
        leaseToken: "lease",
        leasedUntil: "2026-01-01T01:00:00.000Z",
        claimedAt: at,
      },
      binding: {
        kind: "run-binding",
        recordId: "binding",
        projectId,
        revision: 0,
        generation: 1,
        updatedAt: at,
        status: "reserved",
        taskId: "task",
        attemptId: "attempt",
        memberId: "member",
        roleRevisionId: "role",
        providerInstanceId: "pi",
        threadId: "team-thread",
        environmentId: "environment",
        model: selection.model,
        configuration: {
          instructionsHash: "instructions",
          toolIds: [],
          skillIds: [],
          runtimeVersion: "runtime",
          maxTokens: 1000,
          maxDurationMs: 1000,
          paidFallback: false,
        },
        worktree: "/assigned/worktree",
        branch: "refs/heads/assigned",
        leaseGeneration: 1,
        specRevision: 1,
        planRevision: 1,
      },
    },
  });
  if (claim.transition?.kind !== "claim") throw new Error("Fixture claim missing");
  return {
    fence: { dispatchId: "dispatch", revision: 1, claimGeneration: 1, stage: "workspace-ready" },
    intent: {
      compiledClaim: claim,
      request: {
        dispatchId: "dispatch",
        claim,
        git: {
          effectId: "dispatch",
          runId: "binding",
          generation: 1,
          primaryRoot: "/primary",
          commonGitDirectory: "/primary/.git",
          worktreePath: "/assigned/worktree",
          branchRef: "refs/heads/assigned",
          baseRef: "refs/heads/main",
          baseOid: "a".repeat(40),
          ownershipToken: "owner",
          policyHash: "b".repeat(64),
        },
        setupId: "setup",
        initializeOperationId: "initialize",
        assignmentOperationId: "assignment",
        assignment: "Approved assignment",
      },
      limits: {
        rootTaskId: claim.transition.taskId,
        maximumTokens: 1000,
        attemptMaximumTokens: 1000,
        rootDeadlineAtMs: Date.parse(at) + 1000,
        deadlineAtMs: Date.parse(at) + 1000,
        delegationDepth: 0,
        maximumDelegationDepth: 1,
        repairAllowance: 1,
        environmentModelCalls: 1,
        projectWritableWorkers: 1,
        modelCalls: 1,
        writable: false,
        limitsRecordId: "limits",
        limitsRevision: 0,
      },
      rootCaps: {
        maximumDelegationDepth: 1,
        repairAllowance: 1,
        environmentModelCalls: 1,
        projectWritableWorkers: 1,
        modelCalls: 1,
      },
    },
  };
};

const threadCommand = (s = snapshot()) => {
  const transition = s.intent.compiledClaim.transition;
  if (transition?.kind !== "claim") throw new Error("Fixture claim missing");
  return {
    type: "thread.create",
    commandId: CommandId.make(projectTeamDerivedRecordId(s.fence.dispatchId, "thread.create")),
    threadId: transition.binding.threadId,
    projectId,
    title: "Project team assignment",
    modelSelection: selection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: transition.binding.branch,
    worktreePath: transition.binding.worktree,
    createdAt: at,
  } as const;
};

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
    ),
    Layer.provideMerge(makeSqlitePersistenceLive(databasePath)),
    Layer.provideMerge(ServerConfig.layerTest("/primary", { prefix: "t3-team-threads-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const open = Effect.fn("threadsTest.open")(function* (databasePath: string) {
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const context = yield* Layer.buildWithScope(makeLayer(databasePath), scope);
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(context));
  const engine = yield* run(Effect.service(OrchestrationEngineService));
  const query = yield* run(Effect.service(ProjectionSnapshotQuery));
  const receipts = yield* run(Effect.service(OrchestrationCommandReceiptRepository));
  const make = <E, R>(
    assertCurrent: Parameters<typeof makeProjectTeamThreads<E, R>>[0]["assertCurrent"],
  ) => run(makeProjectTeamThreads({ assertCurrent }));
  const counts = () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          events:
            yield* sql`SELECT event_type FROM orchestration_events WHERE aggregate_kind='thread'`,
          receipts:
            yield* sql`SELECT command_id FROM orchestration_command_receipts WHERE aggregate_kind='thread'`,
        };
      }),
    );
  return { engine, query, receipts, make, counts, run, close: () => Scope.close(scope, Exit.void) };
});
type System = Effect.Success<ReturnType<typeof open>>;
const withSystem = Effect.fn("threadsTest.withSystem")(function* <E>(
  test: (system: System, databasePath: string) => Effect.Effect<void, E, Scope.Scope>,
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-threads-"))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
  const databasePath = NodePath.join(directory, "state.sqlite");
  const system = yield* open(databasePath);
  yield* system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("project-create"),
      projectId,
      title: "Team",
      workspaceRoot: "/primary",
      createdAt: at,
    }),
  );
  yield* test(system, databasePath);
}, Effect.scoped);
const originalEvents = (system: System) =>
  system.run(
    Effect.gen(function* () {
      return yield* Stream.runCollect(
        system.engine.readThreadEvents({
          threadId: threadCommand().threadId,
          fromSequenceExclusive: 0,
          toSequenceInclusive: yield* system.engine.latestSequence,
          limit: 10,
        }),
      );
    }),
  );

it.effect("creates the immutable thread once, with durable receipt and no execution events", () =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        let checks = 0;
        const factory = yield* system.make(() =>
          Effect.sync(() => {
            checks++;
          }),
        );
        const first = yield* system.run(factory.ensure(snapshot(), selection));
        const repeated = yield* system.run(factory.ensure(snapshot(), selection));
        expect(repeated).toEqual(first);
        expect(checks).toBe(5);
        const events = yield* originalEvents(system);
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("thread.created");
        expect(yield* system.counts()).toMatchObject({
          events: [expect.anything()],
          receipts: [expect.anything()],
        });
        const receipt = yield* system.run(
          system.receipts.getByCommandId({ commandId: first.commandId }),
        );
        expect(Option.isSome(receipt) && receipt.value.status).toBe("accepted");
        const thread = yield* system.run(system.query.getThreadShellById(first.threadId));
        expect(Option.isSome(thread) && thread.value).toMatchObject({
          projectId,
          modelSelection: selection,
          worktreePath: "/assigned/worktree",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: at,
        });
      }),
    );
  }),
);

it.effect("competing preparations converge through the real command receipt", () =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        yield* system.run(
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            let initialChecks = 0;
            const factory = yield* makeProjectTeamThreads({
              assertCurrent: () =>
                Effect.gen(function* () {
                  if (++initialChecks <= 2) {
                    if (initialChecks === 2) yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                }),
            });
            const first = yield* Effect.forkChild(factory.ensure(snapshot(), selection));
            const second = yield* Effect.forkChild(factory.ensure(snapshot(), selection));
            yield* Deferred.await(entered);
            yield* Deferred.succeed(release, undefined);
            expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(second));
          }),
        );
        expect(yield* originalEvents(system)).toHaveLength(1);
        expect((yield* system.counts()).receipts).toHaveLength(1);
      }),
    );
  }),
);

it.effect(
  "reconciles a lost dispatch response using the original persisted event without resending",
  () =>
    Effect.gen(function* () {
      yield* withSystem((system) =>
        Effect.gen(function* () {
          let dispatches = 0;
          const factory = yield* system.run(
            makeProjectTeamThreads({ assertCurrent: () => Effect.void }).pipe(
              Effect.provideService(OrchestrationEngineService, {
                ...system.engine,
                dispatch: (command) =>
                  Effect.gen(function* () {
                    dispatches++;
                    yield* system.engine.dispatch(command);
                    return yield* new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: "lost response",
                    });
                  }),
              }),
            ),
          );
          expect(yield* system.run(factory.ensure(snapshot(), selection))).toMatchObject({
            threadId: "team-thread",
          });
          expect(dispatches).toBe(1);
          expect(yield* originalEvents(system)).toHaveLength(1);
        }),
      );
    }),
);

it.effect("reconciles stable links after closing and reopening the migrated database", () =>
  Effect.gen(function* () {
    yield* withSystem((system, databasePath) =>
      Effect.gen(function* () {
        const factory = yield* system.make(() => Effect.void);
        const first = yield* system.run(factory.ensure(snapshot(), selection));
        yield* system.close();
        const reopened = yield* open(databasePath);
        try {
          const second = yield* reopened.make(() => Effect.void);
          expect(yield* reopened.run(second.ensure(snapshot(), selection))).toEqual(first);
          expect(yield* originalEvents(reopened)).toHaveLength(1);
          expect((yield* reopened.counts()).receipts).toHaveLength(1);
        } finally {
          yield* reopened.close();
        }
      }),
    );
  }),
);

it.effect.each(["revoked", "stale", "deleted project", "expired lease", "missing capability"])(
  "Root denial for %s prevents creation",
  (reason) =>
    Effect.gen(function* () {
      yield* withSystem((system) =>
        Effect.gen(function* () {
          const factory = yield* system.make(() => Effect.fail(new RootDenied({ reason })));
          const result = yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)));
          expect(Exit.isFailure(result)).toBe(true);
          expect(yield* originalEvents(system)).toHaveLength(0);
        }),
      );
    }),
);

it.effect("denies revocation between inspection and creation", () =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        let checks = 0;
        const factory = yield* system.make(() =>
          ++checks === 2 ? Effect.fail(new RootDenied({ reason: "revoked" })) : Effect.void,
        );
        expect(
          Exit.isFailure(yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)))),
        ).toBe(true);
        expect(yield* originalEvents(system)).toHaveLength(0);
      }),
    );
  }),
);

it.effect("a revoked post-create check returns failure while retaining the original thread", () =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        let checks = 0;
        const factory = yield* system.make(() =>
          ++checks === 3
            ? Effect.fail(new RootDenied({ reason: "revoked after creation" }))
            : Effect.void,
        );
        const result = yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)));
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* originalEvents(system)).toHaveLength(1);
        const denied = yield* system.make(() =>
          Effect.fail(new RootDenied({ reason: "still revoked" })),
        );
        expect(
          Exit.isFailure(yield* system.run(Effect.exit(denied.ensure(snapshot(), selection)))),
        ).toBe(true);
        expect(yield* originalEvents(system)).toHaveLength(1);
      }),
    );
  }),
);

it.effect.each([
  { instanceId: ProviderInstanceId.make("other"), model: selection.model },
  { instanceId: selection.instanceId, model: "other-model" },
])("denies a model selection outside the immutable binding: %j", (model) =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        const factory = yield* system.make(() => Effect.void);
        expect(
          Exit.isFailure(yield* system.run(Effect.exit(factory.ensure(snapshot(), model)))),
        ).toBe(true);
        expect(yield* originalEvents(system)).toHaveLength(0);
      }),
    );
  }),
);

it.effect("does not adopt an unrelated matching thread", () =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        yield* system.run(
          system.engine.dispatch({ ...threadCommand(), commandId: CommandId.make("unrelated") }),
        );
        const factory = yield* system.make(() => Effect.void);
        expect(
          Exit.isFailure(yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)))),
        ).toBe(true);
        expect(yield* originalEvents(system)).toHaveLength(1);
      }),
    );
  }),
);

it.effect(
  "denies changed retry options despite the engine accepting a same-aggregate command receipt",
  () =>
    Effect.gen(function* () {
      yield* withSystem((system) =>
        Effect.gen(function* () {
          const factory = yield* system.make(() => Effect.void);
          yield* system.run(factory.ensure(snapshot(), selection));
          const changed = { ...selection, options: [{ id: "reasoningEffort", value: "low" }] };
          // Actual engine dedup accepts this ID; the private consumer must still refuse it.
          yield* system.run(
            system.engine.dispatch({ ...threadCommand(), modelSelection: changed }),
          );
          expect(
            Exit.isFailure(yield* system.run(Effect.exit(factory.ensure(snapshot(), changed)))),
          ).toBe(true);
          expect(yield* originalEvents(system)).toHaveLength(1);
        }),
      );
    }),
);

it.effect(
  "rejects inconsistent retained assignment paths before calling Root or creating a thread",
  () =>
    Effect.gen(function* () {
      yield* withSystem((system) =>
        Effect.gen(function* () {
          const wrong = snapshot();
          const altered = {
            ...wrong,
            intent: {
              ...wrong.intent,
              request: {
                ...wrong.intent.request,
                git: { ...wrong.intent.request.git, worktreePath: "/arbitrary" },
              },
            },
          };
          let checks = 0;
          const factory = yield* system.make(() =>
            Effect.sync(() => {
              checks++;
            }),
          );
          expect(
            Exit.isFailure(yield* system.run(Effect.exit(factory.ensure(altered, selection)))),
          ).toBe(true);
          expect(checks).toBe(0);
          expect(yield* originalEvents(system)).toHaveLength(0);
        }),
      );
    }),
);

it.effect("reads only the first event while retaining legitimate later history", () =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        const factory = yield* system.make(() => Effect.void);
        yield* system.run(factory.ensure(snapshot(), selection));
        for (let index = 0; index < 12; index++) {
          yield* system.run(
            system.engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make(`history-${index}`),
              threadId: threadCommand().threadId,
              branch: threadCommand().branch,
            }),
          );
        }
        const ranges: number[] = [];
        const bounded = yield* system.run(
          makeProjectTeamThreads({ assertCurrent: () => Effect.void }).pipe(
            Effect.provideService(OrchestrationEngineService, {
              ...system.engine,
              readThreadEvents: (input) => {
                ranges.push(input.limit ?? -1);
                return system.engine.readThreadEvents(input);
              },
            }),
          ),
        );
        expect(yield* system.run(bounded.ensure(snapshot(), selection))).toMatchObject({
          threadId: "team-thread",
        });
        expect(ranges).toEqual([1, 1]);
        expect((yield* system.counts()).events).toHaveLength(13);
      }),
    );
  }),
);

const creationConflicts: readonly Partial<
  Extract<OrchestrationCommand, { type: "thread.create" }>
>[] = [
  { projectId: ProjectId.make("other-project") },
  { branch: "refs/heads/other" },
  { worktreePath: "/other/worktree" },
  { modelSelection: { ...selection, options: [{ id: "reasoningEffort", value: "low" }] } },
  { runtimeMode: "full-access" },
  { interactionMode: "plan" },
  { title: "Other title" },
  { createdAt: "2026-01-02T00:00:00.000Z" },
];
it.effect.each(creationConflicts)(
  "denies an original command with conflicting immutable content: %j",
  (conflict) =>
    Effect.gen(function* () {
      yield* withSystem((system) =>
        Effect.gen(function* () {
          yield* system.run(
            system.engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("other-project-create"),
              projectId: ProjectId.make("other-project"),
              title: "Other",
              workspaceRoot: "/other",
              createdAt: at,
            }),
          );
          yield* system.run(system.engine.dispatch({ ...threadCommand(), ...conflict }));
          const factory = yield* system.make(() => Effect.void);
          expect(
            Exit.isFailure(yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)))),
          ).toBe(true);
          expect(yield* originalEvents(system)).toHaveLength(1);
        }),
      );
    }),
);

it.effect.each(["thread.archive", "thread.delete"] as const)(
  "denies %s of the original thread",
  (type) =>
    Effect.gen(function* () {
      yield* withSystem((system) =>
        Effect.gen(function* () {
          const factory = yield* system.make(() => Effect.void);
          yield* system.run(factory.ensure(snapshot(), selection));
          yield* system.run(
            system.engine.dispatch({
              type,
              commandId: CommandId.make(type),
              threadId: threadCommand().threadId,
            }),
          );
          expect(
            Exit.isFailure(yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)))),
          ).toBe(true);
          expect(
            (yield* originalEvents(system)).filter((event) => event.type === "thread.created"),
          ).toHaveLength(1);
        }),
      );
    }),
);

it.effect("denies delete and recreation with identical fields and creation time", () =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        const factory = yield* system.make(() => Effect.void);
        yield* system.run(factory.ensure(snapshot(), selection));
        yield* system.run(
          system.engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("delete-original"),
            threadId: threadCommand().threadId,
          }),
        );
        yield* system.run(
          system.engine.dispatch({ ...threadCommand(), commandId: CommandId.make("recreate") }),
        );
        const result = yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)));
        expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain("was recreated");
        expect(
          (yield* originalEvents(system)).filter((event) => event.type === "thread.created"),
        ).toHaveLength(2);
      }),
    );
  }),
);

it.effect.each(["project", "createdAt"] as const)("denies a changed current shell %s", (field) =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        const factory = yield* system.make(() => Effect.void);
        yield* system.run(factory.ensure(snapshot(), selection));
        yield* system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("shell-other-project"),
            projectId: ProjectId.make("other-project"),
            title: "Other",
            workspaceRoot: "/other",
            createdAt: at,
          }),
        );
        yield* system.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            if (field === "project")
              yield* sql`UPDATE projection_threads SET project_id='other-project' WHERE thread_id=${threadCommand().threadId}`;
            else
              yield* sql`UPDATE projection_threads SET created_at='2026-01-02T00:00:00.000Z' WHERE thread_id=${threadCommand().threadId}`;
          }),
        );
        expect(
          Exit.isFailure(yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)))),
        ).toBe(true);
        expect(
          (yield* originalEvents(system)).filter((event) => event.type === "thread.created"),
        ).toHaveLength(1);
      }),
    );
  }),
);

it.effect.each([
  { branch: "refs/heads/changed" },
  { worktreePath: "/changed/worktree" },
  { modelSelection: { ...selection, options: [{ id: "reasoningEffort", value: "low" }] } },
  { title: "Changed title" },
])("denies current thread mutations after original creation: %j", (change) =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        const factory = yield* system.make(() => Effect.void);
        yield* system.run(factory.ensure(snapshot(), selection));
        yield* system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("change"),
            threadId: threadCommand().threadId,
            ...change,
          }),
        );
        expect(
          Exit.isFailure(yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)))),
        ).toBe(true);
        expect(
          (yield* originalEvents(system)).filter((event) => event.type === "thread.created"),
        ).toHaveLength(1);
      }),
    );
  }),
);

it.effect.each([
  { type: "thread.runtime-mode.set", runtimeMode: "full-access" },
  { type: "thread.interaction-mode.set", interactionMode: "plan" },
] as const)("denies changed current policy via $type", (change) =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        const factory = yield* system.make(() => Effect.void);
        yield* system.run(factory.ensure(snapshot(), selection));
        yield* system.run(
          system.engine.dispatch({
            ...change,
            commandId: CommandId.make("change-policy"),
            threadId: threadCommand().threadId,
            createdAt: "2026-01-01T00:00:01.000Z",
          }),
        );
        expect(
          Exit.isFailure(yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)))),
        ).toBe(true);
        expect(
          (yield* originalEvents(system)).filter((event) => event.type === "thread.created"),
        ).toHaveLength(1);
      }),
    );
  }),
);

it.effect("preserves dispatch and reconciliation failures", () =>
  Effect.gen(function* () {
    yield* withSystem((system) =>
      Effect.gen(function* () {
        const factory = yield* system.run(
          makeProjectTeamThreads({ assertCurrent: () => Effect.void }).pipe(
            Effect.provideService(OrchestrationEngineService, {
              ...system.engine,
              dispatch: () =>
                Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: "thread.create",
                    detail: "dispatch failed",
                  }),
                ),
            }),
          ),
        );
        const result = yield* system.run(Effect.exit(factory.ensure(snapshot(), selection)));
        expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain("dispatch failed");
        expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain(
          "missing, inactive, or changed",
        );
      }),
    );
  }),
);

it.effect(
  "interruption after durable creation reports no success; next ensure reconciles the same thread",
  () =>
    Effect.gen(function* () {
      yield* withSystem((system) =>
        Effect.gen(function* () {
          yield* system.run(
            Effect.gen(function* () {
              const persisted = yield* Deferred.make<void>();
              const held = yield* Deferred.make<void>();
              const factory = yield* makeProjectTeamThreads({
                assertCurrent: () => Effect.void,
              }).pipe(
                Effect.provideService(OrchestrationEngineService, {
                  ...system.engine,
                  dispatch: (command) =>
                    system.engine.dispatch(command).pipe(
                      Effect.tap(() => Deferred.succeed(persisted, undefined)),
                      Effect.tap(() => Deferred.await(held)),
                    ),
                }),
              );
              const worker = yield* Effect.forkChild(factory.ensure(snapshot(), selection));
              yield* Deferred.await(persisted);
              yield* Effect.sync(() => worker.interruptUnsafe());
              const interrupted = yield* Fiber.await(worker);
              expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(
                true,
              );
              const next = yield* makeProjectTeamThreads({ assertCurrent: () => Effect.void });
              expect(yield* next.ensure(snapshot(), selection)).toMatchObject({
                threadId: "team-thread",
              });
            }),
          );
          expect(yield* originalEvents(system)).toHaveLength(1);
        }),
      );
    }),
);
