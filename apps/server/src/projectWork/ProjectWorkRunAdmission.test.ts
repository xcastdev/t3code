import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectWorkAttemptId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  NodeId,
  EventId,
  ProjectId,
  ProjectWorkTaskId,
  RunId,
  RunAttemptId,
  ThreadId,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import {
  ResourceInstructionComposition,
  composeInstructionSnapshot,
} from "../orchestration-v2/ResourceInstructionComposition.ts";
import {
  SkillCatalogRevision,
  ManagedSkillId,
  ManagedSkillKey,
  SkillContentHash,
} from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RunAdmission from "../orchestration-v2/RunAdmission.ts";
import * as Admission from "./ProjectWorkRunAdmission.ts";
import * as ResourceComposition from "../orchestration-v2/ResourceInstructionComposition.ts";
import { SkillCatalogService } from "../skills/SkillCatalogService.ts";
import {
  appendAdmissionFoundationRecords,
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
const workDeadline = (expiresAt: string | null) => {
  if (expiresAt === null) throw new Error("A Work owner must retain its deadline.");
  return expiresAt;
};

const projectId = ProjectId.make("admission-project"),
  taskId = ProjectWorkTaskId.make("task"),
  threadId = ThreadId.make("owned"),
  runId = RunId.make("run");
const now = "2026-01-01T00:00:00.000Z";
const workRootTaskId = ProjectWorkTaskId.make("root-task");
const base = ProjectStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const layer = Layer.merge(Admission.layer, ProjectWorkRepositoryLive).pipe(
  Layer.provideMerge(base),
);
const seed = Effect.fn("AdmissionTest.seed")(function* (workParent = false, selectedSkill = false) {
  const sql = yield* SqlClient.SqlClient;
  yield* (yield* ProjectStore.ProjectStoreV2).apply({
    sequence: 1,
    eventId: EventId.make("project-create"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Admission",
      workspaceRoot: "/tmp/admission",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${threadId},${projectId},'Owned','codex','full-access','default',${now},${now},'{}')`;
  yield* (yield* ProjectWorkRepository).execute({
    type: "project-work.task.create",
    commandId: CommandId.make("task-create"),
    projectId,
    taskId,
    title: "Research",
    createdAt: now,
  });
  if (workParent)
    yield* (yield* ProjectWorkRepository).execute({
      type: "project-work.task.create",
      commandId: CommandId.make("root-task-create"),
      projectId,
      taskId: workRootTaskId,
      title: "Human-owned root",
      createdAt: now,
    });
  const state = yield* readCurrentState(sql, projectId);
  const common = { projectId, revision: 0, generation: 0, updatedAt: now };
  const records: Array<ProjectTeamRecord> = [
    ...(workParent
      ? [
          {
            ...common,
            kind: "task-membership" as const,
            recordId: "root-membership",
            taskId: workRootTaskId,
            status: "active" as const,
            executionKind: "human" as const,
            deliverableKind: "reminder" as const,
          },
        ]
      : []),
    {
      ...common,
      kind: "task-membership",
      recordId: "membership",
      taskId,
      ...(workParent ? { parentTaskId: workRootTaskId } : {}),
      status: "active",
      executionKind: "managed",
      deliverableKind: "research",
      assignment: { authorizationGateId: "grant", outputDescriptions: ["Findings"] },
    },
    {
      ...common,
      kind: "role-revision",
      recordId: "role",
      roleId: "investigator",
      roleRevision: 0,
      status: "available",
      role: "investigator",
      instructions: "Read the code",
      skills: selectedSkill ? ["review"] : [],
      tools: ["read"],
      model: "model",
      memoryAccess: "none",
      delegationDepth: 2,
    },
    {
      ...common,
      kind: "member",
      recordId: "member",
      status: "active",
      name: "Investigator",
      coordinator: false,
      roleRevisionId: "role",
    },
    {
      ...common,
      kind: "limits",
      recordId: "limits",
      status: "configured",
      model: "model",
      tokenLimit: 1000,
      durationLimitMs: 10000,
      delegationDepth: 2,
      repairAllowance: 1,
      environmentModelCalls: 3,
      modelCalls: 3,
      projectWritableWorkers: 1,
    },
  ];
  const hash = projectTeamScopeHash({ ...state, foundationRecords: records }, taskId);
  records.push({
    ...common,
    kind: "gate",
    recordId: "grant",
    taskId,
    status: "consumed",
    gate: "investigation",
    specRevision: 0,
    planRevision: 0,
    contentHash: hash,
    evidenceIds: [],
    consumedByRunId: RunId.make("binding"),
    consumedByCommandId: CommandId.make("prepared"),
    attribution: {
      actor: { kind: "human", id: "human" },
      source: { kind: "web", id: "client" },
      recordedAt: now,
    },
  });
  records.push({
    ...common,
    kind: "run-binding",
    recordId: "binding",
    taskId,
    status: "reserved",
    attemptId: ProjectWorkAttemptId.make("attempt"),
    memberId: "member",
    roleRevisionId: "role",
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId,
    environmentId: EnvironmentId.make("env"),
    model: "model",
    configuration: {
      instructionsHash: "hash",
      toolIds: ["read"],
      skillIds: selectedSkill ? ["review"] : [],
      runtimeVersion: "native",
      maxTokens: 1000,
      maxDurationMs: 10000,
      paidFallback: false,
    },
    worktree: "/tmp/admission",
    branch: "main",
    leaseGeneration: 0,
    specRevision: 0,
    planRevision: 0,
    authorizationGateId: "grant",
    scopeHash: hash,
  });
  if (selectedSkill)
    yield* sql`INSERT INTO t3_workflow_v2_skill_catalog_revision (id, revision) VALUES (1,0) ON CONFLICT(id) DO NOTHING`;
  yield* sql.withTransaction(
    appendAdmissionFoundationRecords(sql, projectId, "seed", records, now),
  );
});
const admit = (commandId = "launch", target = threadId, run = runId, originThreadId?: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const admission = yield* RunAdmission.RunAdmission;
    const input: RunAdmission.CommitInput = {
      commandId,
      threadId: target,
      runId: run,
      now,
      operation: "create",
      ...(originThreadId === undefined ? {} : { originThreadId }),
    };
    const preparedResources = yield* (
      admission.prepareResources?.(input) ?? Effect.succeed(undefined)
    );
    return yield* sql.withTransaction(
      admission.commit({
        ...input,
        ...(preparedResources === undefined ? {} : { preparedResources }),
      }),
    );
  });

it.effect("binds the real V2 run atomically and duplicate intent does not reserve twice", () =>
  Effect.gen(function* () {
    yield* seed();
    const admission = yield* RunAdmission.RunAdmission;
    const first = yield* admit();
    const replay = yield* admit();
    assert.equal(first._tag, "admitted");
    assert.deepStrictEqual(replay, first);
    const sql = yield* SqlClient.SqlClient;
    assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_run_admissions`).length, 1);
    const state = yield* readCurrentState(sql, projectId);
    assert.equal(
      state.foundationRecords?.find((record) => record.kind === "run-binding")?.runId,
      runId,
    );
    assert.equal((yield* admission.check({ threadId, runId, now }))._tag, "admitted");
  }).pipe(Effect.provide(layer)),
);
it.effect("rechecks revocation and configuration at delayed start and forbids owner escape", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* admit();
    const admission = yield* RunAdmission.RunAdmission;
    const sql = yield* SqlClient.SqlClient;
    assert.equal((yield* admission.check({ threadId, now, operation: "escape" }))._tag, "denied");
    const state = yield* readCurrentState(sql, projectId);
    const member = state.foundationRecords!.find((r) => r.kind === "member")!;
    assert.equal(member.kind, "member");
    yield* sql.withTransaction(
      appendAdmissionFoundationRecords(
        sql,
        projectId,
        "revoke",
        [{ ...member, status: "paused", revision: member.revision + 1 }],
        now,
      ),
    );
    assert.equal((yield* admission.check({ threadId, runId, now }))._tag, "denied");
    assert.equal((yield* admit("after-revoke", threadId, RunId.make("later")))._tag, "denied");
  }).pipe(Effect.provide(layer)),
);
it.effect("retains the original deadline across restart and rejects stale controls", () =>
  Effect.gen(function* () {
    yield* seed();
    const first = yield* admit();
    assert.equal(first._tag, "admitted");
    if (first._tag !== "admitted" || !first.control) return;
    const admission = yield* RunAdmission.RunAdmission;
    const sql = yield* SqlClient.SqlClient;
    const restarted = yield* sql.withTransaction(
      admission.commit({
        commandId: "restart",
        threadId,
        runId,
        now: "2026-01-01T00:00:05.000Z",
        operation: "restart",
      }),
    );
    assert.equal(restarted._tag, "admitted");
    if (restarted._tag !== "admitted" || !restarted.control) return;
    assert.equal(restarted.owner.expiresAt, first.owner.expiresAt);
    assert.equal(
      (yield* admission.deadline({ ...first.control, now: "2026-01-01T00:00:11.000Z" }))._tag,
      "stale",
    );
    assert.equal((yield* admission.deadline({ ...restarted.control, now }))._tag, "early");
    assert.equal(
      (yield* admission.check({ threadId, runId, now: workDeadline(first.owner.expiresAt) }))._tag,
      "expired",
    );
    assert.equal(
      (yield* admission.deadline({
        ...restarted.control,
        now: workDeadline(first.owner.expiresAt),
      }))._tag,
      "stop",
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("reserves inherited depth and model concurrency atomically", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* admit();
    const sql = yield* SqlClient.SqlClient;
    const child = ThreadId.make("child"),
      grandchild = ThreadId.make("grandchild");
    for (const target of [child, grandchild, ThreadId.make("too-deep"), ThreadId.make("parallel")])
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${target},${projectId},'Child','codex','full-access','default',${now},${now},${JSON.stringify({ lineage: { parentThreadId: target === grandchild ? child : target === ThreadId.make("too-deep") ? grandchild : threadId } })})`;
    assert.equal(
      (yield* admit("child", child, RunId.make("child-run"), threadId))._tag,
      "admitted",
    );
    assert.equal(
      (yield* admit("grandchild", grandchild, RunId.make("grandchild-run"), child))._tag,
      "admitted",
    );
    assert.deepStrictEqual(
      yield* admit("deep", ThreadId.make("too-deep"), RunId.make("deep-run"), grandchild),
      { _tag: "denied", reason: "delegation-depth-exceeded" },
    );
    assert.deepStrictEqual(
      yield* admit("parallel", ThreadId.make("parallel"), RunId.make("parallel-run"), threadId),
      { _tag: "denied", reason: "model-capacity-exhausted" },
    );
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "uncertain native acceptance retains the slot and linked deadline after terminal evidence",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const result = yield* admit();
      const admission = yield* RunAdmission.RunAdmission;
      if (result._tag !== "admitted") return;
      yield* admission.reconcileNative({
        threadId,
        runId,
        now: workDeadline(result.owner.expiresAt),
        accepted: true,
        uncertain: false,
      });
      assert.deepStrictEqual(
        yield* admission.settle({ threadId, runId, now: workDeadline(result.owner.expiresAt) }),
        [],
      );
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT uncertain FROM t3_workflow_v2_run_admissions`)[0]?.uncertain,
        1,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("inert binding is idempotent and first admission establishes the deadline", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    const admission = yield* RunAdmission.RunAdmission;
    const prepare = { commandId: "inert", threadId, now, operation: "bind-thread" as const };
    assert.equal((yield* sql.withTransaction(admission.commit(prepare)))._tag, "admitted");
    assert.equal((yield* sql.withTransaction(admission.commit(prepare)))._tag, "admitted");
    assert.equal((yield* admission.check({ threadId, now }))._tag, "denied");
    const launched = yield* sql.withTransaction(
      admission.commit({
        commandId: "later-launch",
        threadId,
        runId,
        now: "2026-01-01T00:01:00.000Z",
        operation: "create",
      }),
    );
    assert.equal(launched._tag, "admitted");
    if (launched._tag === "admitted")
      assert.equal(launched.owner.expiresAt, "2026-01-01T00:01:10.000Z");
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "concurrent duplicate deliveries share one reservation and rejected transaction rolls back bindings",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const results = yield* Effect.all([admit(), admit()], { concurrency: "unbounded" });
      assert.deepStrictEqual(results[0], results[1]);
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const rolledBack = yield* Effect.result(
        sql.withTransaction(
          Effect.gen(function* () {
            const result = yield* admission.commit({
              commandId: "rollback",
              threadId,
              runId: RunId.make("rollback-run"),
              now,
              operation: "create",
            });
            assert.equal(result._tag, "admitted");
            return yield* Effect.fail("reject-later-in-command");
          }),
        ),
      );
      assert.equal(rolledBack._tag, "Failure");
      assert.equal(
        (yield* sql`SELECT * FROM t3_workflow_v2_run_admissions WHERE run_id='rollback-run'`)
          .length,
        0,
      );
      assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_run_admissions`).length, 1);
    }).pipe(Effect.provide(layer)),
);
it.effect("disable after queue insertion blocks promotion and native launch", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    const admission = yield* RunAdmission.RunAdmission;
    const queued = yield* sql.withTransaction(
      admission.commit({
        commandId: "queued",
        threadId,
        runId,
        now,
        operation: "create",
        queued: true,
      }),
    );
    assert.equal(queued._tag, "admitted");
    const state = yield* readCurrentState(sql, projectId);
    const limits = state.foundationRecords!.find((record) => record.kind === "limits")!;
    yield* sql.withTransaction(
      appendAdmissionFoundationRecords(
        sql,
        projectId,
        "disable",
        [{ ...limits, status: "disabled", revision: limits.revision + 1 }],
        now,
      ),
    );
    assert.deepStrictEqual(
      yield* sql.withTransaction(
        admission.commit({ commandId: "promote", threadId, runId, now, operation: "promote" }),
      ),
      { _tag: "denied", reason: "owner-configuration-disabled" },
    );
    assert.equal((yield* admission.check({ threadId, runId, now }))._tag, "denied");
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "settlement cancels every generation while stale native evidence cannot settle a successor",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const first = yield* sql.withTransaction(
        admission.commit({
          commandId: "start",
          threadId,
          runId,
          runAttemptId: RunAttemptId.make("attempt-1"),
          now,
          operation: "create",
        }),
      );
      const second = yield* sql.withTransaction(
        admission.commit({
          commandId: "restart",
          threadId,
          runId,
          runAttemptId: RunAttemptId.make("attempt-2"),
          now,
          operation: "restart",
        }),
      );
      assert.equal(first._tag, "admitted");
      assert.equal(second._tag, "admitted");
      assert.deepStrictEqual(
        yield* sql.withTransaction(
          admission.observeNativeTurn({
            threadId,
            runId,
            runAttemptId: RunAttemptId.make("attempt-1"),
            now,
            terminal: true,
          }),
        ),
        { stop: true, cancelControlIds: [] },
      );
      assert.equal((yield* admission.check({ threadId, runId, now }))._tag, "admitted");
      const terminal = yield* sql.withTransaction(
        admission.observeNativeTurn({
          threadId,
          runId,
          runAttemptId: RunAttemptId.make("attempt-2"),
          now,
          terminal: true,
        }),
      );
      assert.equal(terminal.cancelControlIds.length, 2);
      assert.equal((yield* admission.check({ threadId, runId, now }))._tag, "denied");
    }).pipe(Effect.provide(layer)),
);
it.effect("root expiry selects descendants and child expiry never stops sibling branches", () =>
  Effect.gen(function* () {
    yield* seed();
    const root = yield* admit();
    if (root._tag !== "admitted" || !root.control) return;
    const sql = yield* SqlClient.SqlClient;
    const admission = yield* RunAdmission.RunAdmission;
    const controls: RunAdmission.OwnerDeadlineControl[] = [];
    for (const name of ["left", "right"]) {
      const target = ThreadId.make(name);
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${target},${projectId},'Child','codex','full-access','default',${now},${now},${JSON.stringify({ lineage: { parentThreadId: threadId } })})`;
      const child = yield* admit(name, target, RunId.make(`${name}-run`), threadId);
      if (child._tag === "admitted" && child.control) controls.push(child.control);
    }
    assert.equal(controls.length, 2);
    const childExpiry = yield* admission.deadline({
      ...controls[0]!,
      now: workDeadline(root.owner.expiresAt),
    });
    assert.equal(childExpiry._tag, "stop");
    if (childExpiry._tag === "stop") assert.equal(childExpiry.targets.length, 1);
    const rootExpiry = yield* admission.deadline({
      ...root.control,
      now: workDeadline(root.owner.expiresAt),
    });
    assert.equal(rootExpiry._tag, "stop");
    if (rootExpiry._tag === "stop") assert.equal(rootExpiry.targets.length, 3);
  }).pipe(Effect.provide(layer)),
);
it.effect("native terminal before start promise completion is monotonic", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    const admission = yield* RunAdmission.RunAdmission;
    const runAttemptId = RunAttemptId.make("native-attempt");
    yield* sql.withTransaction(
      admission.commit({
        commandId: "native-start",
        threadId,
        runId,
        runAttemptId,
        now,
        operation: "create",
      }),
    );
    yield* admission.reconcileNative({
      threadId,
      runId,
      runAttemptId,
      now,
      accepted: false,
      uncertain: true,
    });
    assert.deepStrictEqual(yield* admission.settle({ threadId, runId, now }), []);
    const proof = yield* sql.withTransaction(
      admission.observeNativeTurn({ threadId, runId, runAttemptId, now, terminal: true }),
    );
    assert.equal(proof.cancelControlIds.length, 1);
    yield* admission.reconcileNative({
      threadId,
      runId,
      runAttemptId,
      now,
      accepted: true,
      uncertain: true,
    });
    yield* sql.withTransaction(
      admission.observeNativeTurn({ threadId, runId, runAttemptId, now, terminal: false }),
    );
    const rows =
      yield* sql`SELECT phase,uncertain,native_terminal FROM t3_workflow_v2_run_admissions`;
    assert.deepStrictEqual(rows, [{ phase: "settled", uncertain: 0, native_terminal: 1 }]);
  }).pipe(Effect.provide(layer)),
);
it.effect("reassignment and retry inherit the original root deadline and frozen limits", () =>
  Effect.gen(function* () {
    yield* seed();
    const first = yield* admit();
    if (first._tag !== "admitted") return;
    const sql = yield* SqlClient.SqlClient;
    const admission = yield* RunAdmission.RunAdmission;
    yield* admission.settle({ threadId, runId, now });
    const state = yield* readCurrentState(sql, projectId);
    const binding = state.foundationRecords!.find((record) => record.kind === "run-binding")!;
    assert.equal(binding.kind, "run-binding");
    if (binding.kind !== "run-binding") return;
    yield* sql.withTransaction(
      appendAdmissionFoundationRecords(
        sql,
        projectId,
        "reassign",
        [
          {
            ...binding,
            leaseGeneration: binding.leaseGeneration + 1,
            revision: binding.revision + 1,
          },
        ],
        now,
      ),
    );
    assert.deepStrictEqual(yield* admission.check({ threadId, runId, now }), {
      _tag: "denied",
      reason: "owner-fence-stale",
    });
    const retry = yield* sql.withTransaction(
      admission.commit({
        commandId: "retry",
        threadId,
        runId: RunId.make("retry-run"),
        now: "2026-01-01T00:00:05.000Z",
        operation: "create",
      }),
    );
    assert.equal(retry._tag, "admitted");
    if (retry._tag === "admitted") assert.equal(retry.owner.expiresAt, first.owner.expiresAt);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "later inherited child admissions and queued restarts derive durable owner without caller origin",
  () =>
    Effect.gen(function* () {
      yield* seed();
      yield* admit();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const child = ThreadId.make("durable-child"),
        firstRun = RunId.make("first-child"),
        secondRun = RunId.make("second-child");
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${child},${projectId},'Child','codex','full-access','default',${now},${now},${JSON.stringify({ lineage: { parentThreadId: threadId } })})`;
      const first = yield* admit("child-first", child, firstRun, threadId);
      assert.equal(first._tag, "admitted");
      yield* admission.settle({ threadId: child, runId: firstRun, now });
      assert.deepStrictEqual(yield* admission.check({ threadId: child, runId: secondRun, now }), {
        _tag: "denied",
        reason: "run-not-admitted",
      });
      const second = yield* sql.withTransaction(
        admission.commit({
          commandId: "child-second",
          threadId: child,
          runId: secondRun,
          now,
          operation: "create",
          queued: true,
        }),
      );
      assert.equal(second._tag, "admitted");
      if (first._tag !== "admitted" || second._tag !== "admitted") return;
      assert.equal(second.owner.rootId, first.owner.rootId);
      assert.equal(second.owner.expiresAt, first.owner.expiresAt);
      assert.equal(
        (yield* sql.withTransaction(
          admission.commit({
            commandId: "child-promote",
            threadId: child,
            runId: secondRun,
            now,
            operation: "promote",
          }),
        ))._tag,
        "admitted",
      );
      assert.equal(
        (yield* sql.withTransaction(
          admission.commit({
            commandId: "child-restart",
            threadId: child,
            runId: secondRun,
            runAttemptId: RunAttemptId.make("child-next-attempt"),
            now,
            operation: "restart",
          }),
        ))._tag,
        "admitted",
      );
      assert.equal(
        (yield* admission.check({ threadId: child, runId: secondRun, now, operation: "start" }))
          ._tag,
        "admitted",
      );
      const state = yield* readCurrentState(sql, projectId);
      const member = state.foundationRecords!.find((record) => record.kind === "member")!;
      yield* sql.withTransaction(
        appendAdmissionFoundationRecords(
          sql,
          projectId,
          "revoke-child-root",
          [{ ...member, status: "paused", revision: member.revision + 1 }],
          now,
        ),
      );
      assert.equal(
        (yield* admission.check({ threadId: child, runId: secondRun, now, operation: "start" }))
          ._tag,
        "denied",
      );
      assert.equal((yield* admit("third-child", child, RunId.make("third-child")))._tag, "denied");
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["deleted", "missing"] as const)(
  "new owned admissions reject %s project authority before writing",
  (mode) =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      if (mode === "deleted")
        yield* sql`UPDATE projection_projects SET deleted_at=${now} WHERE project_id=${projectId}`;
      else yield* sql`DELETE FROM projection_projects WHERE project_id=${projectId}`;
      assert.deepStrictEqual(yield* admit(), {
        _tag: "denied",
        reason: "owner-target-unavailable",
      });
      assert.deepStrictEqual(
        yield* sql.withTransaction(
          admission.commit({
            commandId: "inert-deleted",
            threadId,
            projectId,
            now,
            operation: "bind-thread",
          }),
        ),
        { _tag: "denied", reason: "owner-target-unavailable" },
      );
      assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_run_admissions`).length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "lineage alone preserves ownership and opaque MCP registry identity never grants authority",
  () =>
    Effect.gen(function* () {
      yield* seed();
      yield* admit();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const child = ThreadId.make("unadmitted-child");
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${child},${projectId},'Child','codex','full-access','default',${now},${now},${JSON.stringify({ lineage: { parentThreadId: threadId } })})`;
      assert.deepStrictEqual(
        yield* admission.check({ threadId: child, runId: RunId.make("new-child"), now }),
        { _tag: "denied", reason: "run-not-admitted" },
      );
      assert.equal(
        (yield* admission.check({
          threadId,
          runId,
          now,
          originSessionId: "opaque-mcp-registry-id",
        }))._tag,
        "admitted",
      );
      assert.deepStrictEqual(
        yield* admission.check({
          threadId: ThreadId.make("ordinary"),
          now,
          originSessionId: "opaque-mcp-registry-id",
        }),
        { _tag: "ordinary" },
      );
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "final native authorization checks exact attempt, turn and current session in one SQL snapshot",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const runAttemptId = RunAttemptId.make("native-attempt"),
        providerThreadId = ProviderThreadId.make("native-thread"),
        providerSessionId = ProviderSessionId.make("session-1"),
        providerTurnId = ProviderTurnId.make("native-turn"),
        nodeId = NodeId.make("native-node");
      yield* sql.withTransaction(
        admission.commit({
          commandId: "native-target-start",
          threadId,
          runId,
          runAttemptId,
          now,
          operation: "create",
        }),
      );
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,payload_json) VALUES (${runId},${threadId},0,'codex',${providerThreadId},'running',${now},${JSON.stringify({ activeAttemptId: runAttemptId })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,provider_turn_id,status,payload_json) VALUES (${runAttemptId},${threadId},${runId},0,${nodeId},'codex',${providerThreadId},${providerTurnId},'running','{}')`;
      for (const session of [providerSessionId, ProviderSessionId.make("session-2")])
        yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES (${session},${threadId},'codex','running',${now},'{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_session_id,status,updated_at,payload_json) VALUES (${providerThreadId},${threadId},'codex',${providerSessionId},'active',${now},'{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES (${providerTurnId},${threadId},${providerThreadId},${nodeId},${runAttemptId},0,'running','{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,payload_json) VALUES (${nodeId},${threadId},${runId},${nodeId},'root_turn','running',${providerThreadId},${providerTurnId},'{}')`;
      const nativeTarget = {
        runAttemptId,
        providerThreadId,
        providerSessionId,
        providerTurnId,
        nodeId,
      };
      assert.equal(
        (yield* admission.check({ threadId, runId, now, operation: "continue", nativeTarget }))
          ._tag,
        "admitted",
      );
      for (const status of ["stopped", "error"]) {
        yield* sql`UPDATE orchestration_v2_projection_provider_sessions SET status=${status} WHERE provider_session_id=${providerSessionId}`;
        assert.deepStrictEqual(yield* admission.check({ threadId, runId, now, nativeTarget }), {
          _tag: "denied",
          reason: "native-target-stale",
        });
      }
      yield* sql`UPDATE orchestration_v2_projection_provider_sessions SET status='waiting' WHERE provider_session_id=${providerSessionId}`;
      for (const status of ["not_loaded", "archived", "closed", "error"]) {
        yield* sql`UPDATE orchestration_v2_projection_provider_threads SET status=${status} WHERE provider_thread_id=${providerThreadId}`;
        assert.deepStrictEqual(yield* admission.check({ threadId, runId, now, nativeTarget }), {
          _tag: "denied",
          reason: "native-target-stale",
        });
      }
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET status='idle' WHERE provider_thread_id=${providerThreadId}`;
      for (const status of ["completed", "interrupted", "failed", "cancelled", "superseded"]) {
        yield* sql`UPDATE orchestration_v2_projection_run_attempts SET status=${status} WHERE attempt_id=${runAttemptId}`;
        assert.deepStrictEqual(yield* admission.check({ threadId, runId, now, nativeTarget }), {
          _tag: "denied",
          reason: "native-target-stale",
        });
      }
      yield* sql`UPDATE orchestration_v2_projection_run_attempts SET status='pending' WHERE attempt_id=${runAttemptId}`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='waiting' WHERE run_id=${runId}`;
      yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status='pending' WHERE provider_turn_id=${providerTurnId}`;
      assert.equal(
        (yield* admission.check({ threadId, runId, now, nativeTarget }))._tag,
        "admitted",
      );
      for (const status of ["completed", "interrupted", "failed", "cancelled"]) {
        yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status=${status} WHERE provider_turn_id=${providerTurnId}`;
        assert.deepStrictEqual(yield* admission.check({ threadId, runId, now, nativeTarget }), {
          _tag: "denied",
          reason: "native-target-stale",
        });
      }
      yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status='running' WHERE provider_turn_id=${providerTurnId}`;
      const requestNode = NodeId.make("resolved-request-node");
      const requestId = "resolved-request";
      const requestPayload = {
        id: requestId,
        nodeId: requestNode,
        providerTurnId,
        nativeRequestRef: null,
        kind: "user_input",
        status: "resolved",
        responseCapability: { type: "live", providerSessionId },
        createdAt: now,
        resolvedAt: now,
      };
      yield* sql`INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,runtime_request_id,completed_at,payload_json) VALUES (${requestNode},${threadId},${runId},${nodeId},'user_input_request','completed',${providerThreadId},${providerTurnId},${requestId},${now},'{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,provider_turn_id,kind,status,created_at,resolved_at,payload_json) VALUES (${requestId},${threadId},${requestNode},${providerTurnId},'user_input','resolved',${now},${now},${JSON.stringify(requestPayload)})`;
      const requestTarget = { ...nativeTarget, nodeId: requestNode };
      assert.equal(
        (yield* admission.check({ threadId, runId, now, nativeTarget: requestTarget }))._tag,
        "admitted",
      );
      yield* sql`UPDATE orchestration_v2_projection_nodes SET status='cancelled' WHERE node_id=${requestNode}`;
      assert.equal(
        (yield* admission.check({ threadId, runId, now, nativeTarget: requestTarget }))._tag,
        "admitted",
      );
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status='cancelled' WHERE runtime_request_id=${requestId}`;
      assert.deepStrictEqual(
        yield* admission.check({ threadId, runId, now, nativeTarget: requestTarget }),
        { _tag: "denied", reason: "native-target-stale" },
      );
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status='resolved' WHERE runtime_request_id=${requestId}`;
      yield* sql`UPDATE orchestration_v2_projection_nodes SET kind='tool_call' WHERE node_id=${requestNode}`;
      assert.deepStrictEqual(
        yield* admission.check({ threadId, runId, now, nativeTarget: requestTarget }),
        { _tag: "denied", reason: "native-target-stale" },
      );
      for (const stale of [
        { ...nativeTarget, runAttemptId: RunAttemptId.make("old-attempt") },
        { ...nativeTarget, providerThreadId: ProviderThreadId.make("old-thread") },
        { ...nativeTarget, providerSessionId: ProviderSessionId.make("old-session") },
        { ...nativeTarget, providerTurnId: ProviderTurnId.make("old-turn") },
        { ...nativeTarget, nodeId: NodeId.make("old-node") },
      ])
        assert.deepStrictEqual(
          yield* admission.check({ threadId, runId, now, nativeTarget: stale }),
          { _tag: "denied", reason: "native-target-stale" },
        );
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET provider_session_id='session-2' WHERE provider_thread_id=${providerThreadId}`;
      assert.deepStrictEqual(yield* admission.check({ threadId, runId, now, nativeTarget }), {
        _tag: "denied",
        reason: "native-target-stale",
      });
      assert.equal(
        (yield* admission.check({
          threadId,
          runId,
          now,
          nativeTarget: { ...nativeTarget, providerSessionId: ProviderSessionId.make("session-2") },
        }))._tag,
        "admitted",
      );
      yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json=${JSON.stringify({ activeAttemptId: "successor" })} WHERE run_id=${runId}`;
      assert.deepStrictEqual(
        yield* admission.check({
          threadId,
          runId,
          now,
          nativeTarget: { ...nativeTarget, providerSessionId: ProviderSessionId.make("session-2") },
        }),
        { _tag: "denied", reason: "native-target-stale" },
      );
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "owned control operations require an existing exact admitted run while ordinary controls remain ordinary",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      for (const operation of ["steer", "runtime-answer", "promote", "restart"] as const) {
        assert.deepStrictEqual(
          yield* sql.withTransaction(
            admission.commit({ commandId: `missing-${operation}`, threadId, now, operation }),
          ),
          { _tag: "denied", reason: "run-not-admitted" },
        );
        assert.deepStrictEqual(
          yield* sql.withTransaction(
            admission.commit({
              commandId: `ordinary-${operation}`,
              threadId: ThreadId.make("ordinary"),
              now,
              operation,
            }),
          ),
          { _tag: "ordinary" },
        );
      }
      yield* admit();
      assert.deepStrictEqual(
        yield* sql.withTransaction(
          admission.commit({
            commandId: "unadmitted-control",
            threadId,
            runId: RunId.make("unadmitted-run"),
            now,
            operation: "runtime-answer",
          }),
        ),
        { _tag: "denied", reason: "run-not-admitted" },
      );
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "thread metadata changes cannot turn an owned target ordinary or preserve a false parent",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      yield* sql`UPDATE orchestration_v2_projection_threads SET project_id='moved-project' WHERE thread_id=${threadId}`;
      assert.deepStrictEqual(yield* admit(), {
        _tag: "denied",
        reason: "owner-target-unavailable",
      });
      yield* sql`UPDATE orchestration_v2_projection_threads SET project_id=${projectId} WHERE thread_id=${threadId}`;
      yield* admit();
      const child = ThreadId.make("changed-parent"),
        childRun = RunId.make("changed-parent-run");
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${child},${projectId},'Child','codex','full-access','default',${now},${now},${JSON.stringify({ lineage: { parentThreadId: threadId } })})`;
      assert.equal(
        (yield* admit("changed-parent-first", child, childRun, threadId))._tag,
        "admitted",
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json='{}' WHERE thread_id=${child}`;
      assert.deepStrictEqual(yield* admission.check({ threadId: child, runId: childRun, now }), {
        _tag: "denied",
        reason: "owner-target-lineage-mismatch",
      });
      assert.deepStrictEqual(
        yield* admit("changed-parent-next", child, RunId.make("changed-parent-next")),
        { _tag: "denied", reason: "owner-target-lineage-mismatch" },
      );
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "new inert descendant and its run share a transaction before the thread projection exists",
  () =>
    Effect.gen(function* () {
      yield* seed();
      yield* admit();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const child = ThreadId.make("new-inert-child");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          assert.equal(
            (yield* admission.commit({
              commandId: "new-child-prepare",
              threadId: child,
              projectId,
              originThreadId: threadId,
              operation: "bind-thread",
              now,
            }))._tag,
            "admitted",
          );
          assert.equal(
            (yield* admission.commit({
              commandId: "new-child-run",
              threadId: child,
              runId: RunId.make("new-inert-run"),
              originThreadId: threadId,
              operation: "create",
              now,
            }))._tag,
            "admitted",
          );
        }),
      );
    }).pipe(Effect.provide(layer)),
);
it.effect.each([
  ["root", "archive"],
  ["root", "delete"],
  ["root", "move"],
  ["root", "missing"],
  ["middle", "archive"],
  ["middle", "delete"],
  ["middle", "move"],
  ["middle", "missing"],
] as const)(
  "existing descendant rejects %s ancestor %s in admission and provider checks",
  ([scope, mutation]) =>
    Effect.gen(function* () {
      yield* seed();
      yield* admit();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const middle = ThreadId.make("chain-middle"),
        leaf = ThreadId.make("chain-leaf"),
        leafRun = RunId.make("chain-leaf-run");
      for (const [target, parent] of [
        [middle, threadId],
        [leaf, middle],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${target},${projectId},'Child','codex','full-access','default',${now},${now},${JSON.stringify({ lineage: { parentThreadId: parent } })})`;
        assert.equal(
          (yield* admit(
            `chain-${target}`,
            target,
            target === leaf ? leafRun : RunId.make("chain-middle-run"),
            parent,
          ))._tag,
          "admitted",
        );
      }
      const target = scope === "root" ? threadId : middle;
      if (mutation === "archive")
        yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at=${now} WHERE thread_id=${target}`;
      else if (mutation === "delete")
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at=${now} WHERE thread_id=${target}`;
      else if (mutation === "move")
        yield* sql`UPDATE orchestration_v2_projection_threads SET project_id='moved' WHERE thread_id=${target}`;
      else yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id=${target}`;
      assert.deepStrictEqual(
        yield* admission.check({ threadId: leaf, runId: leafRun, now, operation: "start" }),
        { _tag: "denied", reason: "owner-target-unavailable" },
      );
      assert.deepStrictEqual(
        yield* sql.withTransaction(
          admission.commit({
            commandId: "invalid-chain-existing",
            threadId: leaf,
            runId: leafRun,
            now,
            operation: "promote",
          }),
        ),
        { _tag: "denied", reason: "owner-target-unavailable" },
      );
      assert.deepStrictEqual(
        yield* admit("invalid-chain-new", leaf, RunId.make("chain-leaf-next")),
        { _tag: "denied", reason: "owner-target-unavailable" },
      );
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "settled ancestor remains ownership evidence but stopped or missing retained ancestors fail closed",
  () =>
    Effect.gen(function* () {
      yield* seed();
      yield* admit();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const child = ThreadId.make("historical-child"),
        childRun = RunId.make("historical-child-run");
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${child},${projectId},'Child','codex','full-access','default',${now},${now},${JSON.stringify({ lineage: { parentThreadId: threadId } })})`;
      yield* admit("historical-child", child, childRun, threadId);
      yield* admission.settle({ threadId, runId, now });
      assert.equal(
        (yield* admission.check({ threadId: child, runId: childRun, now }))._tag,
        "admitted",
      );
      yield* sql`UPDATE t3_workflow_v2_run_admissions SET phase='stopping' WHERE thread_id=${threadId}`;
      assert.deepStrictEqual(yield* admission.check({ threadId: child, runId: childRun, now }), {
        _tag: "denied",
        reason: "owner-not-active",
      });
      yield* sql`DELETE FROM t3_workflow_v2_run_admissions WHERE thread_id=${threadId}`;
      assert.deepStrictEqual(yield* admission.check({ threadId: child, runId: childRun, now }), {
        _tag: "denied",
        reason: "owner-target-lineage-mismatch",
      });
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "direct Work child assignments retain task ancestry without a conversational parent",
  () =>
    Effect.gen(function* () {
      yield* seed(true);
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const first = yield* admit();
      assert.equal(first._tag, "admitted");
      if (first._tag !== "admitted") return;
      const rows =
        yield* sql`SELECT depth,root_task_id,parent_admission_id FROM t3_workflow_v2_run_admissions WHERE thread_id=${threadId}`;
      assert.deepStrictEqual(rows, [
        { depth: 1, root_task_id: workRootTaskId, parent_admission_id: null },
      ]);
      assert.equal(
        (yield* admission.check({ threadId, runId, now, operation: "start" }))._tag,
        "admitted",
      );
      assert.equal(
        (yield* sql.withTransaction(
          admission.commit({
            commandId: "work-child-promote",
            threadId,
            runId,
            now,
            operation: "promote",
          }),
        ))._tag,
        "admitted",
      );
      const child = ThreadId.make("direct-work-conversation-child"),
        tooDeep = ThreadId.make("direct-work-too-deep");
      for (const [target, parent] of [
        [child, threadId],
        [tooDeep, child],
      ] as const)
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${target},${projectId},'Child','codex','full-access','default',${now},${now},${JSON.stringify({ lineage: { parentThreadId: parent } })})`;
      const descendant = yield* admit(
        "work-child-delegate",
        child,
        RunId.make("work-child-delegate"),
        threadId,
      );
      assert.equal(descendant._tag, "admitted");
      assert.equal(
        (yield* admission.check({ threadId: child, runId: RunId.make("work-child-delegate"), now }))
          ._tag,
        "admitted",
      );
      assert.deepStrictEqual(
        yield* admit("work-child-too-deep", tooDeep, RunId.make("work-child-too-deep"), child),
        { _tag: "denied", reason: "delegation-depth-exceeded" },
      );
      yield* admission.settle({ threadId, runId, now });
      const retried = yield* sql.withTransaction(
        admission.commit({
          commandId: "work-child-retry",
          threadId,
          runId: RunId.make("work-child-retry"),
          now: "2026-01-01T00:00:05.000Z",
          operation: "create",
        }),
      );
      assert.equal(retried._tag, "admitted");
      if (retried._tag === "admitted") assert.equal(retried.owner.expiresAt, first.owner.expiresAt);
    }).pipe(Effect.provide(layer)),
);
it.effect.each(["paused", "removed"] as const)(
  "direct Work child denies %s root membership authority",
  (status) =>
    Effect.gen(function* () {
      yield* seed(true);
      yield* admit();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const state = yield* readCurrentState(sql, projectId);
      const root = state.foundationRecords!.find(
        (record) => record.kind === "task-membership" && record.taskId === workRootTaskId,
      )!;
      assert.equal(root.kind, "task-membership");
      if (root.kind !== "task-membership") return;
      const next =
        status === "removed"
          ? { ...root, status: "removed" as const, revision: root.revision + 1 }
          : { ...root, controlState: "paused" as const, revision: root.revision + 1 };
      yield* sql.withTransaction(
        appendAdmissionFoundationRecords(sql, projectId, "root-work-revoke", [next], now),
      );
      assert.equal(
        (yield* admission.check({ threadId, runId, now, operation: "start" }))._tag,
        "denied",
      );
      assert.equal(
        (yield* admit("inactive-work-root-next", threadId, RunId.make("inactive-work-root-next")))
          ._tag,
        "denied",
      );
    }).pipe(Effect.provide(layer)),
);
it.effect.each(["depth", "root-task", "root-binding", "fence"] as const)(
  "direct Work child rejects corrupted %s authority",
  (corruption) =>
    Effect.gen(function* () {
      yield* seed(true);
      yield* admit();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      if (corruption === "depth")
        yield* sql`UPDATE t3_workflow_v2_run_admissions SET depth=0 WHERE thread_id=${threadId}`;
      else if (corruption === "root-task")
        yield* sql`UPDATE t3_workflow_v2_run_admissions SET root_task_id='another-root' WHERE thread_id=${threadId}`;
      else if (corruption === "root-binding")
        yield* sql`UPDATE t3_workflow_v2_run_admissions SET root_id='another-binding' WHERE thread_id=${threadId}`;
      else
        yield* sql`UPDATE t3_workflow_v2_run_admissions SET fence=17 WHERE thread_id=${threadId}`;
      assert.equal(
        (yield* admission.check({ threadId, runId, now, operation: "start" }))._tag,
        "denied",
      );
      assert.equal(
        (yield* sql.withTransaction(
          admission.commit({
            commandId: "corrupt-work-child-promote",
            threadId,
            runId,
            now,
            operation: "promote",
          }),
        ))._tag,
        "denied",
      );
    }).pipe(Effect.provide(layer)),
);
it.effect("direct Work child rejects cancellation of its durable root task", () =>
  Effect.gen(function* () {
    yield* seed(true);
    yield* admit();
    const admission = yield* RunAdmission.RunAdmission;
    yield* (yield* ProjectWorkRepository).execute({
      type: "project-work.task.cancel",
      commandId: CommandId.make("cancel-work-root"),
      projectId,
      taskId: workRootTaskId,
      canceledAt: now,
    });
    assert.equal(
      (yield* admission.check({ threadId, runId, now, operation: "start" }))._tag,
      "denied",
    );
    assert.equal(
      (yield* admit("canceled-root-next", threadId, RunId.make("canceled-root-next")))._tag,
      "denied",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("retains actual admitted role text when the current role body changes", () =>
  Effect.gen(function* () {
    yield* seed();
    const first = yield* admit();
    assert.equal(first._tag, "admitted");
    if (first._tag !== "admitted") return;
    const frozen = first.owner.configuration.instructionSnapshot;
    assert.equal(frozen?.roleInstructions, "Read the code");
    assert.equal(frozen?.memoryEpoch, 0);
    const sql = yield* SqlClient.SqlClient;
    const state = yield* readCurrentState(sql, projectId);
    const role = state.foundationRecords!.find((record) => record.kind === "role-revision");
    if (role?.kind !== "role-revision") return assert.fail("Missing role");
    yield* sql.withTransaction(
      appendAdmissionFoundationRecords(
        sql,
        projectId,
        "new-role-body",
        [{ ...role, revision: role.revision + 1, instructions: "Different instructions" }],
        now,
      ),
    );
    const admission = yield* RunAdmission.RunAdmission;
    const retained = yield* admission.check({ threadId, runId, now });
    assert.equal(retained._tag, "admitted");
    if (retained._tag !== "admitted") return;
    assert.deepEqual(retained.owner.configuration.instructionSnapshot, frozen);
  }).pipe(Effect.provide(layer)),
);

it.effect("freezes admitted resource bodies and resolves edited resources for the next run", () =>
  Effect.gen(function* () {
    const revision = yield* Ref.make(1);
    const composition = ResourceInstructionComposition.of({
      compose: (input) =>
        Ref.get(revision).pipe(
          Effect.map((value) => ({
            catalogRevision: 0,
            snapshot: composeInstructionSnapshot(input, [
              {
                id: ManagedSkillId.make("skill-review"),
                key: ManagedSkillKey.make("review"),
                hash: SkillContentHash.make(String(value).repeat(64)),
                revision: value,
                body: `Skill body ${value}`,
                packagePath: "/managed/review",
              },
            ]),
          })),
        ),
    });
    yield* Effect.gen(function* () {
      yield* seed(false, true);
      const first = yield* admit();
      assert.equal(first._tag, "admitted");
      if (first._tag !== "admitted") return;
      const frozen = first.owner.configuration.instructionSnapshot;
      assert.include(frozen!.roleInstructions, "Skill body 1");
      yield* Ref.set(revision, 2);
      const admission = yield* RunAdmission.RunAdmission;
      const retained = yield* admission.check({ threadId, runId, now });
      assert.equal(retained._tag, "admitted");
      if (retained._tag !== "admitted") return;
      assert.deepEqual(retained.owner.configuration.instructionSnapshot, frozen);
      yield* admission.settle({ threadId, runId, now });
      const sql = yield* SqlClient.SqlClient;
      const state = yield* readCurrentState(sql, projectId);
      const role = state.foundationRecords!.find((record) => record.kind === "role-revision");
      if (role?.kind !== "role-revision") return assert.fail("Missing role");
      yield* sql.withTransaction(
        appendAdmissionFoundationRecords(
          sql,
          projectId,
          "edited-role",
          [{ ...role, revision: role.revision + 1, instructions: "Unapproved changed role" }],
          now,
        ),
      );
      const next = yield* admit("next-resource-run", threadId, RunId.make("next-resource-run"));
      assert.equal(next._tag, "admitted");
      if (next._tag !== "admitted") return;
      assert.include(
        next.owner.configuration.instructionSnapshot!.roleInstructions,
        "Skill body 2",
      );
      assert.notEqual(
        next.owner.configuration.instructionSnapshot!.resourceRevision,
        frozen!.resourceRevision,
      );
      assert.equal(next.owner.expiresAt, first.owner.expiresAt);
      assert.include(
        next.owner.configuration.instructionSnapshot!.roleInstructions,
        "Read the code",
      );
      assert.notInclude(
        next.owner.configuration.instructionSnapshot!.roleInstructions,
        "Unapproved changed role",
      );
      assert.notInclude(
        next.owner.configuration.instructionSnapshot!.roleInstructions,
        "Skill body 1",
      );
    }).pipe(
      Effect.provide(
        layer.pipe(Layer.provide(Layer.succeed(ResourceInstructionComposition, composition))),
      ),
    );
  }),
);

it.effect("fails closed on selected managed resources without composition", () =>
  Effect.gen(function* () {
    yield* seed(false, true);
    const result = yield* admit();
    assert.deepEqual(result, {
      _tag: "denied",
      reason: "managed-resource-preparation-unavailable",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "resource preparation releases SQL so unrelated writes and deadline stops finish while package reads block",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const block = yield* Ref.make(false);
      const composition = Layer.effect(
        ResourceInstructionComposition,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return ResourceInstructionComposition.of({
            compose: (input) =>
              Effect.gen(function* () {
                assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
                if (yield* Ref.get(block)) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                return {
                  catalogRevision: 0,
                  snapshot: composeInstructionSnapshot(input, [
                    {
                      id: ManagedSkillId.make("review-id"),
                      key: ManagedSkillKey.make("review"),
                      hash: SkillContentHash.make("a".repeat(64)),
                      revision: 1,
                      body: "Review safely",
                      packagePath: "/managed/review",
                    },
                  ]),
                };
              }),
          });
        }),
      );
      yield* Effect.gen(function* () {
        yield* seed(false, true);
        const first = yield* admit();
        if (first._tag !== "admitted" || first.control === undefined)
          return assert.fail("Expected admission control");
        yield* Ref.set(block, true);
        const sql = yield* SqlClient.SqlClient;
        const admission = yield* RunAdmission.RunAdmission;
        const preparing = yield* Effect.forkChild(
          admission.prepareResources!({
            commandId: "blocked-next",
            threadId,
            runId: RunId.make("blocked-next"),
            now,
            operation: "create",
          }),
        );
        yield* Deferred.await(entered);
        yield* sql.withTransaction(
          sql`CREATE TABLE resource_preflight_probe (id INTEGER PRIMARY KEY)`,
        );
        const stop = yield* sql.withTransaction(
          admission.deadline({ ...first.control, now: workDeadline(first.owner.expiresAt) }),
        );
        assert.equal(stop._tag, "stop");
        yield* Deferred.succeed(release, undefined);
        const prepared = yield* Fiber.join(preparing);
        assert.isDefined(prepared);
        const result = yield* sql.withTransaction(
          admission.commit({
            commandId: "blocked-next",
            threadId,
            runId: RunId.make("blocked-next"),
            now: workDeadline(first.owner.expiresAt),
            operation: "create",
            preparedResources: prepared!,
          }),
        );
        assert.notEqual(result._tag, "admitted");
      }).pipe(Effect.provide(layer.pipe(Layer.provide(composition.pipe(Layer.provide(base))))));
    }),
);

it.effect("SQL commit rejects catalog revision and role authority changes after preparation", () =>
  Effect.gen(function* () {
    const composition = ResourceInstructionComposition.of({
      compose: (input) =>
        Effect.succeed({
          catalogRevision: 0,
          snapshot: composeInstructionSnapshot(input, [
            {
              id: ManagedSkillId.make("review-id"),
              key: ManagedSkillKey.make("review"),
              hash: SkillContentHash.make("a".repeat(64)),
              revision: 1,
              body: "Review safely",
              packagePath: "/managed/review",
            },
          ]),
        }),
    });
    yield* Effect.gen(function* () {
      yield* seed(false, true);
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const input: RunAdmission.CommitInput = {
        commandId: "catalog-race",
        threadId,
        runId,
        now,
        operation: "create",
      };
      const preparedResources = yield* admission.prepareResources!(input);
      assert.isDefined(preparedResources);
      yield* sql`UPDATE t3_workflow_v2_skill_catalog_revision SET revision=1 WHERE id=1`;
      const result = yield* sql.withTransaction(
        admission.commit({ ...input, preparedResources: preparedResources! }),
      );
      assert.deepEqual(result, { _tag: "denied", reason: "managed-resource-revision-changed" });
      yield* sql`UPDATE t3_workflow_v2_skill_catalog_revision SET revision=0 WHERE id=1`;
      const state = yield* readCurrentState(sql, projectId);
      const role = state.foundationRecords!.find((record) => record.kind === "role-revision");
      if (role?.kind !== "role-revision") return assert.fail("Missing role");
      yield* sql.withTransaction(
        appendAdmissionFoundationRecords(
          sql,
          projectId,
          "role-race",
          [
            {
              ...role,
              revision: role.revision + 1,
              instructions: "Changed during resource capture",
            },
          ],
          now,
        ),
      );
      const changedBase = yield* sql.withTransaction(
        admission.commit({ ...input, preparedResources: preparedResources! }),
      );
      assert.deepEqual(changedBase, {
        _tag: "denied",
        reason: "managed-resource-authority-changed",
      });
      assert.deepEqual(yield* sql`SELECT * FROM t3_workflow_v2_run_admissions`, []);
    }).pipe(
      Effect.provide(
        layer.pipe(Layer.provide(Layer.succeed(ResourceInstructionComposition, composition))),
      ),
    );
  }),
);

it.effect("first actual run refreshes skills after bind while retaining the bound raw role", () =>
  Effect.gen(function* () {
    const revision = yield* Ref.make(1);
    const captures = yield* Ref.make(0);
    const composition = ResourceInstructionComposition.of({
      compose: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(captures, (count) => count + 1);
          const value = yield* Ref.get(revision);
          return {
            catalogRevision: value,
            snapshot: composeInstructionSnapshot(input, [
              {
                id: ManagedSkillId.make("review-id"),
                key: ManagedSkillKey.make("review"),
                hash: SkillContentHash.make(String(value).repeat(64)),
                revision: value,
                body: `Skill body ${value}`,
                packagePath: "/managed/review",
              },
            ]),
          };
        }),
    });
    yield* Effect.gen(function* () {
      yield* seed(false, true);
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const bind: RunAdmission.CommitInput = {
        commandId: "bind-only",
        threadId,
        now,
        operation: "bind-thread",
      };
      assert.isUndefined(yield* admission.prepareResources!(bind));
      const bound = yield* sql.withTransaction(admission.commit(bind));
      assert.equal(bound._tag, "admitted");
      assert.equal(yield* Ref.get(captures), 0);
      yield* Ref.set(revision, 2);
      yield* sql`UPDATE t3_workflow_v2_skill_catalog_revision SET revision=2 WHERE id=1`;
      const state = yield* readCurrentState(sql, projectId);
      const role = state.foundationRecords!.find((record) => record.kind === "role-revision");
      if (role?.kind !== "role-revision") return assert.fail("Missing role");
      yield* sql.withTransaction(
        appendAdmissionFoundationRecords(
          sql,
          projectId,
          "role-after-bind",
          [{ ...role, revision: role.revision + 1, instructions: "Changed after binding" }],
          now,
        ),
      );
      const first = yield* admit();
      assert.equal(first._tag, "admitted");
      if (first._tag !== "admitted") return;
      assert.include(
        first.owner.configuration.instructionSnapshot!.roleInstructions,
        "Skill body 2",
      );
      assert.include(
        first.owner.configuration.instructionSnapshot!.roleInstructions,
        "Read the code",
      );
      assert.notInclude(
        first.owner.configuration.instructionSnapshot!.roleInstructions,
        "Changed after binding",
      );
      assert.equal(yield* Ref.get(captures), 1);
      yield* admit();
      assert.equal(yield* Ref.get(captures), 1);
    }).pipe(
      Effect.provide(
        layer.pipe(Layer.provide(Layer.succeed(ResourceInstructionComposition, composition))),
      ),
    );
  }),
);

it.effect("prepares a delegated first run before its thread binding transaction exists", () =>
  Effect.gen(function* () {
    const composition = ResourceInstructionComposition.of({
      compose: (input) =>
        Effect.succeed({
          catalogRevision: 0,
          snapshot: composeInstructionSnapshot(input, [
            {
              id: ManagedSkillId.make("review-id"),
              key: ManagedSkillKey.make("review"),
              hash: SkillContentHash.make("a".repeat(64)),
              revision: 1,
              body: "Fresh child skill",
              packagePath: "/managed/review",
            },
          ]),
        }),
    });
    yield* Effect.gen(function* () {
      yield* seed(false, true);
      yield* admit();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const childId = ThreadId.make("preflight-child");
      const input: RunAdmission.CommitInput = {
        commandId: "child-batch",
        threadId: childId,
        originThreadId: threadId,
        runId: RunId.make("child-batch-run"),
        now,
        operation: "create",
      };
      const preparedResources = yield* admission.prepareResources!(input);
      assert.isDefined(preparedResources);
      const child = yield* sql.withTransaction(
        Effect.gen(function* () {
          const bound = yield* admission.commit({
            commandId: input.commandId,
            threadId: childId,
            originThreadId: threadId,
            now,
            operation: "bind-thread",
          });
          assert.equal(bound._tag, "admitted");
          return yield* admission.commit({ ...input, preparedResources: preparedResources! });
        }),
      );
      assert.equal(child._tag, "admitted");
      if (child._tag === "admitted")
        assert.include(
          child.owner.configuration.instructionSnapshot!.roleInstructions,
          "Fresh child skill",
        );
    }).pipe(
      Effect.provide(
        layer.pipe(Layer.provide(Layer.succeed(ResourceInstructionComposition, composition))),
      ),
    );
  }),
);

it.effect(
  "composes existing and proposed delegated overrides from their own worktrees and rejects target drift",
  () =>
    Effect.gen(function* () {
      const catalog = Layer.mock(SkillCatalogService, {
        currentRevision: Effect.succeed(SkillCatalogRevision.make(0)),
        prepareSession: (input) =>
          Effect.succeed({
            resources: [
              {
                id: ManagedSkillId.make("review-id"),
                key: ManagedSkillKey.make("review"),
                hash: SkillContentHash.make("a".repeat(64)),
                revision: 1,
                body:
                  input.projectRoot === "/tmp/admission"
                    ? "Base checkout override"
                    : `Override at ${input.projectRoot}`,
                packagePath: `${input.projectRoot}/.t3code/skills/review`,
              },
            ],
            application: {
              threadId: ThreadId.make(input.threadId),
              providerInstanceId: input.providerInstanceId,
              desiredRevision: input.desiredRevision,
              appliedRevision: input.appliedRevision,
              status: "pending_new_session",
              outcomes: [],
            },
          }),
        recordPreparedResources: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        yield* seed(false, true);
        const sql = yield* SqlClient.SqlClient;
        const admission = yield* RunAdmission.RunAdmission;
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.worktreePath','/tmp/existing-worktree') WHERE thread_id=${threadId}`;
        const existing = yield* admit();
        assert.equal(existing._tag, "admitted");
        if (existing._tag !== "admitted") return;
        assert.include(
          existing.owner.configuration.instructionSnapshot!.roleInstructions,
          "Override at /tmp/existing-worktree",
        );
        assert.notInclude(
          existing.owner.configuration.instructionSnapshot!.roleInstructions,
          "Base checkout override",
        );
        const childId = ThreadId.make("worktree-child");
        const input: RunAdmission.CommitInput = {
          commandId: "worktree-child",
          threadId: childId,
          originThreadId: threadId,
          proposedWorktreePath: "/tmp/child-worktree",
          runId: RunId.make("worktree-child"),
          now,
          operation: "create",
        };
        const preparedResources = yield* admission.prepareResources!(input);
        assert.isDefined(preparedResources);
        const child = yield* sql.withTransaction(
          Effect.gen(function* () {
            const bound = yield* admission.commit({
              commandId: input.commandId,
              threadId: childId,
              originThreadId: threadId,
              ...(input.proposedWorktreePath === undefined
                ? {}
                : { proposedWorktreePath: input.proposedWorktreePath }),
              now,
              operation: "bind-thread",
            });
            assert.equal(bound._tag, "admitted");
            return yield* admission.commit({ ...input, preparedResources: preparedResources! });
          }),
        );
        assert.equal(child._tag, "admitted");
        if (child._tag !== "admitted") return;
        assert.include(
          child.owner.configuration.instructionSnapshot!.roleInstructions,
          "Override at /tmp/child-worktree",
        );
        assert.notInclude(
          child.owner.configuration.instructionSnapshot!.roleInstructions,
          "Base checkout override",
        );
        const nextInput: RunAdmission.CommitInput = {
          commandId: "worktree-drift",
          threadId,
          runId: RunId.make("worktree-drift"),
          now,
          operation: "create",
        };
        const beforeDrift = yield* admission.prepareResources!(nextInput);
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.worktreePath','/tmp/moved-worktree') WHERE thread_id=${threadId}`;
        const moved = yield* sql.withTransaction(
          admission.commit({ ...nextInput, preparedResources: beforeDrift! }),
        );
        assert.deepEqual(moved, { _tag: "denied", reason: "managed-resource-authority-changed" });
        const proposalInput: RunAdmission.CommitInput = {
          ...input,
          commandId: "proposal-drift",
          threadId: ThreadId.make("proposal-drift"),
          runId: RunId.make("proposal-drift"),
        };
        const proposalResources = yield* admission.prepareResources!(proposalInput);
        const changedProposal = yield* sql.withTransaction(
          Effect.gen(function* () {
            const bound = yield* admission.commit({
              commandId: proposalInput.commandId,
              threadId: proposalInput.threadId,
              originThreadId: threadId,
              ...(proposalInput.proposedWorktreePath === undefined
                ? {}
                : { proposedWorktreePath: proposalInput.proposedWorktreePath }),
              now,
              operation: "bind-thread",
            });
            assert.equal(bound._tag, "admitted");
            return yield* admission.commit({
              ...proposalInput,
              proposedWorktreePath: "/tmp/changed-proposed-path",
              preparedResources: proposalResources!,
            });
          }),
        );
        assert.deepEqual(changedProposal, {
          _tag: "denied",
          reason: "managed-resource-authority-changed",
        });
      }).pipe(
        Effect.provide(
          layer.pipe(Layer.provide(ResourceComposition.layer.pipe(Layer.provide(catalog)))),
        ),
      );
    }),
);

it.effect(
  "retained completion authority accepts a settled original attempt and rejects stale attempt, expiry, rebind and fence",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const originalAttempt = RunAttemptId.make("completion-original");
      const original = yield* sql.withTransaction(
        admission.commit({
          commandId: "completion-original",
          threadId,
          runId,
          runAttemptId: originalAttempt,
          now,
          operation: "create",
        }),
      );
      if (original._tag !== "admitted") return assert.fail("Expected original admission");
      yield* admission.settle({ threadId, runId, now });
      const input: RunAdmission.CheckInput = {
        threadId,
        runId,
        now,
        operation: "completion",
        nativeTarget: {
          runAttemptId: originalAttempt,
          providerThreadId: ProviderThreadId.make("ended-thread"),
          providerSessionId: ProviderSessionId.make("ended-session"),
        },
      };
      const completion = yield* admission.check(input);
      assert.equal(completion._tag, "admitted");
      if (completion._tag === "admitted") {
        assert.equal(completion.owner.rootId, original.owner.rootId);
        assert.equal(completion.owner.generation, original.owner.generation);
        assert.equal(completion.owner.expiresAt, original.owner.expiresAt);
      }
      assert.equal((yield* admission.check({ ...input, operation: "continue" }))._tag, "denied");
      assert.deepEqual(
        yield* admission.check({
          ...input,
          nativeTarget: {
            ...input.nativeTarget!,
            runAttemptId: RunAttemptId.make("other-attempt"),
          },
        }),
        { _tag: "denied", reason: "native-target-stale" },
      );
      assert.equal(
        (yield* admission.check({ ...input, now: workDeadline(original.owner.expiresAt) }))._tag,
        "expired",
      );
      const state = yield* readCurrentState(sql, projectId);
      const binding = state.foundationRecords!.find((record) => record.kind === "run-binding");
      if (binding?.kind !== "run-binding") return assert.fail("Missing binding");
      yield* sql.withTransaction(
        appendAdmissionFoundationRecords(
          sql,
          projectId,
          "completion-rebound",
          [
            {
              ...binding,
              revision: binding.revision + 1,
              threadId: ThreadId.make("rebound-thread"),
            },
          ],
          now,
        ),
      );
      assert.equal((yield* admission.check(input))._tag, "denied");
      yield* sql.withTransaction(
        appendAdmissionFoundationRecords(
          sql,
          projectId,
          "completion-fence",
          [
            {
              ...binding,
              revision: binding.revision + 2,
              leaseGeneration: binding.leaseGeneration + 1,
            },
          ],
          now,
        ),
      );
      assert.deepEqual(yield* admission.check(input), {
        _tag: "denied",
        reason: "owner-fence-stale",
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "completion successor commits under the exact retained owner without renewing expiry and rejects a reassignment race",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const initialState = yield* readCurrentState(sql, projectId);
      const initialLimits = initialState.foundationRecords!.find(
        (record) => record.kind === "limits",
      );
      if (initialLimits?.kind !== "limits") return assert.fail("Missing limits");
      yield* sql.withTransaction(
        appendAdmissionFoundationRecords(
          sql,
          projectId,
          "short-completion-deadline",
          [{ ...initialLimits, revision: initialLimits.revision + 1, durationLimitMs: 1000 }],
          now,
        ),
      );
      const runAttemptId = RunAttemptId.make("retained-original-attempt");
      const first = yield* sql.withTransaction(
        admission.commit({
          commandId: "retained-original",
          threadId,
          runId,
          runAttemptId,
          now,
          operation: "create",
        }),
      );
      if (first._tag !== "admitted") return assert.fail("Missing original");
      yield* admission.settle({ threadId, runId, now });
      const roots = yield* sql<{
        root_deadline: string;
      }>`SELECT root_deadline FROM t3_workflow_v2_run_admissions WHERE run_id=${runId}`;
      assert.isTrue(
        Date.parse(roots[0]!.root_deadline) > Date.parse(workDeadline(first.owner.expiresAt)),
      );
      const retainedOwner: RunAdmission.RetainedOwnerConstraint = {
        ...first.owner,
        runId,
        runAttemptId,
      };
      const input: RunAdmission.CommitInput = {
        commandId: "retained-successor",
        threadId,
        runId: RunId.make("retained-successor"),
        runAttemptId: RunAttemptId.make("retained-successor-attempt"),
        operation: "create",
        now: "2026-01-01T00:00:00.500Z",
        retainedOwner,
      };
      const preparedResources = yield* admission.prepareResources!(input);
      const successor = yield* sql.withTransaction(
        admission.commit({
          ...input,
          ...(preparedResources === undefined ? {} : { preparedResources }),
        }),
      );
      assert.equal(successor._tag, "admitted");
      if (successor._tag === "admitted")
        assert.equal(successor.owner.expiresAt, first.owner.expiresAt);
      const expired = yield* sql.withTransaction(
        admission.commit({
          ...input,
          commandId: "expired-retained",
          runId: RunId.make("expired-retained"),
          now: workDeadline(first.owner.expiresAt),
        }),
      );
      assert.equal(expired._tag, "expired");
      const raceInput: RunAdmission.CommitInput = {
        ...input,
        commandId: "retained-race",
        runId: RunId.make("retained-race"),
      };
      yield* admission.prepareResources!(raceInput);
      const state = yield* readCurrentState(sql, projectId);
      const binding = state.foundationRecords!.find((record) => record.kind === "run-binding");
      if (binding?.kind !== "run-binding") return assert.fail("Missing binding");
      yield* sql.withTransaction(
        appendAdmissionFoundationRecords(
          sql,
          projectId,
          "retained-rebind",
          [
            {
              ...binding,
              revision: binding.revision + 1,
              threadId: ThreadId.make("new-recipient"),
            },
          ],
          now,
        ),
      );
      const raced = yield* sql.withTransaction(admission.commit(raceInput));
      assert.equal(raced._tag, "denied");
      assert.deepEqual(
        yield* sql`SELECT run_id FROM t3_workflow_v2_run_admissions WHERE run_id='retained-race'`,
        [],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "ordinary completion constraint stays ordinary and rejects assignment between precheck and SQL commit",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const input: RunAdmission.CommitInput = {
        commandId: "ordinary-completion",
        threadId,
        runId,
        now,
        operation: "create",
        retainedOwner: null,
      };
      assert.deepEqual(
        yield* admission.check({ threadId, now, operation: "completion", retainedOwner: null }),
        { _tag: "ordinary" },
      );
      assert.deepEqual(yield* sql.withTransaction(admission.commit(input)), { _tag: "ordinary" });
      yield* admission.prepareResources!(input);
      yield* seed();
      assert.deepEqual(yield* sql.withTransaction(admission.commit(input)), {
        _tag: "denied",
        reason: "retained-owner-changed",
      });
      assert.deepEqual(yield* sql`SELECT * FROM t3_workflow_v2_run_admissions`, []);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "observed V2 usage blocks later inference and restart without blocking exact completion or the independent expiry control",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const owner = yield* admit();
      assert.equal(owner._tag, "admitted");
      if (owner._tag !== "admitted" || owner.control === undefined) return;
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* RunAdmission.RunAdmission;
      const attempt = RunAttemptId.make("usage-attempt");
      const providerThread = ProviderThreadId.make("usage-provider-thread");
      const session = ProviderSessionId.make("usage-session");
      yield* sql`UPDATE t3_workflow_v2_run_admissions SET run_attempt_id=${attempt} WHERE run_id=${runId}`;
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES (${attempt},${threadId},${runId},1,'usage-node','codex',${providerThread},'completed','{}')`;
      const complete = JSON.stringify({
        turnTokenUsage: {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 1000,
          outputTokens: 0,
          hasSubagents: false,
        },
      });
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES ('usage-turn',${threadId},${providerThread},'usage-node',${attempt},1,'completed',${complete})`;
      assert.deepEqual(yield* admission.check({ threadId, runId, now, operation: "start" }), {
        _tag: "denied",
        reason: "threshold-reached",
      });
      assert.deepEqual(
        yield* sql.withTransaction(
          admission.commit({
            threadId,
            runId,
            now,
            operation: "restart",
            commandId: "retry-after-observed-cap",
            runAttemptId: RunAttemptId.make("next-attempt"),
          }),
        ),
        { _tag: "denied", reason: "threshold-reached" },
      );
      const completion = yield* admission.check({
        threadId,
        runId,
        now,
        operation: "completion",
        nativeTarget: {
          runAttemptId: attempt,
          providerThreadId: providerThread,
          providerSessionId: session,
        },
      });
      assert.equal(completion._tag, "admitted");
      const expired = yield* admission.check({
        threadId,
        runId,
        now: workDeadline(owner.owner.expiresAt),
        operation: "start",
      });
      assert.equal(expired._tag, "expired");
      const stop = yield* admission.deadline({
        ...owner.control,
        now: workDeadline(owner.owner.expiresAt),
      });
      assert.equal(stop._tag, "stop");
      const rows = yield* sql<{
        root_deadline: string;
      }>`SELECT root_deadline FROM t3_workflow_v2_run_admissions WHERE run_id=${runId}`;
      assert.equal(rows[0]?.root_deadline, owner.owner.expiresAt);
    }).pipe(Effect.provide(layer)),
);
