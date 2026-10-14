import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProjectTeamRunBinding,
  ProjectVerificationJobManifest,
  ProjectTeamGate,
  ThreadId,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeProjectTaskResources, PROJECT_TASK_MEMORY_BYTES } from "./ProjectTaskResources.ts";
import type {
  PiManagedDrain,
  PiManagedProcessAllocation,
  PiManagedProcessOwner,
} from "../provider/pi/PiManagedProcess.ts";
import {
  at,
  attribution,
  createManagedAssignment,
  decodeRecord,
  projectId,
  providerInstanceId,
  scoped,
  taskId,
  threadId,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamPiOperations } from "./ProjectTeamPiOperations.ts";
import { projectTeamDerivedRecordId, projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";

const decodeResourceBinding = Schema.decodeUnknownSync(ProjectTeamRunBinding);
const decodeResourceManifest = Schema.decodeUnknownSync(ProjectVerificationJobManifest);
const decodeResourceGate = Schema.decodeUnknownSync(ProjectTeamGate);

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  const now = yield* Clock.currentTimeMillis;
  const taskDeadline = now + 100000;
  yield* sql`INSERT INTO project_task_resource_budget VALUES('environment','project','task',${taskDeadline},2147483648)`;
  const resources = yield* makeProjectTaskResources("environment");
  // These bounded SQL custody fixtures grant no approval or native activation.
  // The journal suites exercise production current-approval checks separately.
  const child = Effect.fn("resourceFixture.child")(function* (
    number: number,
    memoryBytes = PROJECT_TASK_MEMORY_BYTES / 2,
    scope = { environment: "environment", project: "project", task: "task" },
    nonceOverride?: string,
  ) {
    const nonce = nonceOverride ?? `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const allocation: PiManagedProcessAllocation = {
      version: 1,
      nonce,
      unit: `t3-pi-managed-${nonce}.service`,
      policy: { memoryBytes, runtimeSeconds: 30 },
      launch: {
        workspaceRoot: "/workspace",
        workspaceAccess: "readonly",
        protectedRoots: ["/protected"],
        runtimeFiles: [{ source: "/runtime/true", target: "/bin/true", dev: 1, ino: 1 }],
        argv: ["/bin/true"],
        memoryBytes,
        runtimeSeconds: 30,
        workspace: { path: "/workspace", dev: 1, ino: 1 },
        protectedWorkspaceEntries: [],
      },
    };
    const id = `verification-${number}`;
    const deadline = now + 30000;
    const binding = decodeResourceBinding({
      kind: "run-binding",
      projectId: scope.project,
      taskId: scope.task,
      recordId: `custody-binding-${number}`,
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "reserved",
      attemptId: id,
      memberId: "custody-member",
      roleRevisionId: "custody-role",
      providerInstanceId: "pi",
      threadId: `custody-thread-${number}`,
      environmentId: scope.environment,
      model: "custody",
      configuration: {
        instructionsHash: "a".repeat(64),
        toolIds: [],
        skillIds: [],
        runtimeVersion: "0.99.1",
        maxTokens: 100,
        maxDurationMs: 100000,
        paidFallback: false,
      },
      worktree: `/custody-${number}`,
      branch: `refs/heads/custody-${number}`,
      leaseGeneration: 0,
      specRevision: 0,
      planRevision: 0,
      authorizationGateId: "custody-gate",
      scopeHash: "a".repeat(64),
    });
    const dispatchId = `custody-dispatch-${number}`;
    const dispatchIntent = {
      request: { setupId: `custody-setup-${number}`, dispatchId },
      compiledClaim: { transition: { kind: "claim", binding } },
      limits: { rootTaskId: scope.task, rootDeadlineAtMs: taskDeadline, deadlineAtMs: deadline },
    };
    yield* sql`INSERT INTO project_team_run_binding(record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES(${binding.recordId},${scope.project},'reserved',0,0,${at},${canonicalProjectWorkPayload(binding)})`;
    yield* sql`INSERT OR IGNORE INTO project_team_model_budget VALUES(${scope.environment},${scope.project},${scope.task},100,${taskDeadline})`;
    yield* sql`INSERT INTO project_team_dispatch(dispatch_id,environment_id,project_id,binding_id,generation,task_id,attempt_id,worktree,branch,root_task_id,root_maximum_tokens,root_deadline_at_ms,attempt_maximum_tokens,attempt_deadline_at_ms,delegation_depth,maximum_delegation_depth,repair_allowance,stage,revision,claim_generation,intent_json,created_at,updated_at)
      VALUES(${dispatchId},${scope.environment},${scope.project},${binding.recordId},0,${scope.task},${id},${binding.worktree},${binding.branch},${scope.task},100,${taskDeadline},100,${deadline},0,2,2,'reserved',0,0,${canonicalProjectWorkPayload(dispatchIntent)},${at},${at})`;
    yield* sql`INSERT INTO project_work_verification_execution(environment_id,job_id,project_id,task_id,attempt_id,manifest_hash,gate_id,gate_revision,intent_json,intent_hash,allocation_hash,deadline_at_ms,phase,revision)
      VALUES(${scope.environment},${id},${scope.project},${scope.task},${id},${"a".repeat(64)},'gate',0,${canonicalProjectWorkPayload({ allocation, receipt: { manifest: { environmentId: scope.environment, projectId: scope.project, taskId: scope.task, dispatchId, bindingId: binding.recordId, generation: binding.generation } } })},${"a".repeat(64)},${"a".repeat(64)},${deadline},'claimed',0)`;
    const owner: PiManagedProcessOwner = {
      type: "owner",
      unit: allocation.unit,
      nonce,
      invocation: String(number).padStart(32, "a"),
      cgroup: `/sys/fs/cgroup/controlled/${allocation.unit}`,
      pid: number,
      memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
    };
    const loan = resources.verification(id, allocation);
    const drain = {
      state: "drained" as const,
      unit: owner.unit,
      invocation: owner.invocation,
      cgroup: owner.cgroup,
      kernel: "removed",
    };
    return { allocation, owner, loan, drain, id, deadline };
  });
  return { sql, resources, child, now, taskDeadline };
});
const test = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  body.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
const rejected = <A, E>(body: Effect.Effect<A, E>) =>
  body.pipe(
    Effect.result,
    Effect.map((result) => expect(result._tag).toBe("Failure")),
  );

it.effect("task resources atomically admit two children and reject combined excess", () =>
  test(
    Effect.gen(function* () {
      const f = yield* fixture;
      const children = yield* Effect.forEach([1, 2, 3], (id) => f.child(id));
      const results = yield* Effect.all(
        children.map((c) => f.sql.withTransaction(c.loan.reserve).pipe(Effect.result)),
        { concurrency: "unbounded" },
      );
      expect(results.filter((r) => r._tag === "Success")).toHaveLength(2);
      expect(results.filter((r) => r._tag === "Failure")).toHaveLength(1);
      expect(
        yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
      ).toEqual([{ held: PROJECT_TASK_MEMORY_BYTES }]);
    }),
  ),
);

it.effect(
  "task resources retain expired uncaptured reservations through restart and reject renewal",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.child(1, PROJECT_TASK_MEMORY_BYTES);
        yield* f.sql.withTransaction(first.loan.reserve);
        yield* f.sql.withTransaction(first.loan.reserve);
        yield* rejected(first.loan.reserve);
        yield* TestClock.setTime(first.deadline);
        yield* rejected(f.sql.withTransaction(first.loan.reserve));
        const resumed = yield* makeProjectTaskResources("environment");
        yield* rejected(
          f.sql.withTransaction(
            resumed.verification(first.id, first.allocation).drain(first.drain),
          ),
        );
        yield* rejected(
          f.sql`UPDATE project_task_resource_budget SET deadline_at_ms=${f.taskDeadline + 1}`,
        );
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: PROJECT_TASK_MEMORY_BYTES }]);
      }),
    ),
);

it.effect(
  "task resources release only matched captured kernel drain and reuse it after restart",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.child(1, PROJECT_TASK_MEMORY_BYTES);
        const waiting = yield* f.child(2);
        yield* f.sql.withTransaction(first.loan.reserve);
        yield* f.sql.withTransaction(first.loan.capture(first.owner));
        for (const receipt of [
          { ...first.drain, kernel: "populated 1" },
          { ...first.drain, invocation: "b".repeat(32) },
          { ...first.drain, cgroup: "/sys/fs/cgroup/foreign" },
          { ...first.drain, state: "owned" as const },
        ])
          yield* rejected(f.sql.withTransaction(first.loan.drain(receipt)));
        yield* rejected(f.sql.withTransaction(waiting.loan.reserve));
        yield* TestClock.setTime(first.deadline + 1);
        const resumed = yield* makeProjectTaskResources("environment");
        const loan = resumed.verification(first.id, first.allocation);
        const liveDrain = {
          unit: first.owner.unit,
          invocation: first.owner.invocation,
          cgroup: first.owner.cgroup,
          ownerPid: first.owner.pid,
          memoryBytes: first.owner.memoryBytes,
          swapBytes: 0,
          oomGroup: 1,
          launcherPid: 100,
          childPid: 101,
          childExitCode: 0,
          kernel: "removed",
        };
        yield* f.sql.withTransaction(loan.drain(liveDrain));
        yield* f.sql.withTransaction(loan.drain(first.drain));
        yield* rejected(f.sql.withTransaction(loan.reserve));
        expect(yield* f.sql`SELECT drain_json FROM project_task_resource_child`).toEqual([
          { drain_json: canonicalProjectWorkPayload(liveDrain) },
        ]);
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: null }]);
      }),
    ),
);

it.effect("task resources reject foreign partitions, allocation changes and nonce collisions", () =>
  test(
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.child(1);
      yield* f.sql.withTransaction(first.loan.reserve);
      const foreign = yield* makeProjectTaskResources("foreign-environment");
      yield* rejected(
        f.sql.withTransaction(foreign.verification(first.id, first.allocation).reserve),
      );
      const changed = {
        ...first.allocation,
        policy: { ...first.allocation.policy, memoryBytes: 33554432 },
      };
      yield* rejected(f.sql.withTransaction(f.resources.verification(first.id, changed).reserve));
      for (const scope of [
        { environment: "environment", project: "project", task: "other-task" },
        { environment: "environment", project: "other-project", task: "task" },
      ]) {
        yield* f.sql`INSERT INTO project_task_resource_budget VALUES(${scope.environment},${scope.project},${scope.task},${f.taskDeadline},2147483648)`;
        const second = yield* f.child(
          scope.task === "other-task" ? 2 : 3,
          PROJECT_TASK_MEMORY_BYTES,
          scope,
        );
        yield* f.sql.withTransaction(second.loan.reserve);
        // A separate immutable authority retains the colliding physical unit under
        // its foreign partition; exact allocation matching alone must not move it.
        const collision = yield* f.child(
          scope.task === "other-task" ? 4 : 5,
          first.allocation.policy.memoryBytes,
          scope,
          first.allocation.nonce,
        );
        yield* rejected(f.sql.withTransaction(collision.loan.reserve));
      }
      expect(yield* f.sql`SELECT COUNT(*) AS children FROM project_task_resource_child`).toEqual([
        { children: 3 },
      ]);
    }),
  ),
);

it.effect(
  "task resources hold canceled children and deny forward authority after project deletion",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.child(1);
        yield* f.sql.withTransaction(first.loan.reserve);
        yield* f.sql.withTransaction(first.loan.capture(first.owner));
        yield* f.sql`UPDATE project_work_verification_execution SET phase='quarantine',reason='canceled',revision=revision+1 WHERE attempt_id=${first.id}`;
        yield* rejected(f.sql.withTransaction(first.loan.reserve));
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: PROJECT_TASK_MEMORY_BYTES / 2 }]);
        const next = yield* f.child(2);
        yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at,tombstone_json)
      VALUES('project','tombstoned','/workspace',1,'2026-10-11T00:00:00.000Z','{}')`;
        yield* rejected(f.sql.withTransaction(next.loan.reserve));
        yield* rejected(f.sql.withTransaction(first.loan.capture(first.owner)));
        // Cleanup can observe the already captured drain after cancellation/deletion.
        yield* f.sql.withTransaction(first.loan.drain(first.drain));
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: null }]);
      }),
    ),
);

it.effect("unattributed historical custody blocks allocation without rewriting its partition", () =>
  test(
    Effect.gen(function* () {
      const f = yield* fixture;
      const held = yield* f.child(1);
      const waiting = yield* f.child(2);
      yield* f.sql`INSERT INTO project_task_resource_budget VALUES('environment','project','historical-task',${f.taskDeadline},${PROJECT_TASK_MEMORY_BYTES})`;
      // The original journal is unavailable; no trusted association proves a separate root.
      yield* f.sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
        VALUES(${held.allocation.unit},${held.allocation.nonce},'environment','project','historical-task','verification','unavailable-attempt',${canonicalProjectWorkPayload(held.allocation)},${held.allocation.policy.memoryBytes},${held.deadline})`;
      const before = yield* f.sql`SELECT * FROM project_task_resource_child`;
      const blocked = yield* f.sql.withTransaction(waiting.loan.reserve).pipe(Effect.result);
      expect(blocked).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "PiManagedProcessError",
          message: "Original task contains an unaccounted native child",
        },
      });
      yield* rejected(f.sql.withTransaction(held.loan.cleanupDrain(held.drain)));
      expect(yield* f.sql`SELECT * FROM project_task_resource_child`).toEqual(before);
    }),
  ),
);

const decodeResourceCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const resourceTime = Date.parse(at);
const resourceModel = "inclusionai/ling-3.1-flash:free";
const resourceHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
const controlledResourceProcess = (
  source: {
    allocation: PiManagedProcessAllocation;
    owner: PiManagedProcessOwner;
    drain: PiManagedDrain;
  },
  number: number,
  memoryBytes: number,
) => {
  const nonce = `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const unit = `t3-pi-managed-${nonce}.service`;
  const allocation = {
    ...structuredClone(source.allocation),
    nonce,
    unit,
    policy: { ...source.allocation.policy, memoryBytes },
    launch: { ...structuredClone(source.allocation.launch), memoryBytes },
  };
  const owner = {
    ...source.owner,
    nonce,
    unit,
    memoryBytes,
    pid: number,
    invocation: String(number).padStart(32, "a"),
    cgroup: `/sys/fs/cgroup/controlled/${unit}`,
  };
  const drain = {
    ...source.drain,
    unit,
    memoryBytes,
    ownerPid: number,
    invocation: owner.invocation,
    cgroup: owner.cgroup,
  };
  return { allocation, owner, drain };
};

/** Approval, dispatch and operation authority are real; only physical process receipts are controlled. */
const approvedPiResourceFixture = Effect.gen(function* () {
  yield* TestClock.setTime(resourceTime);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Resource ancestry','/workspace','[]',${at},${at})`;
  const human = {
    actor: { kind: "human", id: "fixture-human" },
    source: { kind: "web", id: "fixture-browser" },
    recordedAt: at,
  } as const;
  const common = { projectId, revision: 0, generation: 0, updatedAt: at };
  const role = decodeRecord({
    ...common,
    kind: "role-revision",
    recordId: "resource-role",
    status: "available",
    roleId: "resource-investigator",
    roleRevision: 1,
    role: "investigator",
    instructions: "Inspect the approved task without launching a process",
    skills: [],
    tools: [],
    model: resourceModel,
    memoryAccess: "none",
    delegationDepth: 2,
  });
  if (role.kind !== "role-revision") return yield* Effect.die("Missing resource fixture role");
  const commitRecords = Effect.fn("resourceFixture.commitRecords")(function* (
    commandId: string,
    records: ReadonlyArray<Parameters<typeof decodeRecord>[0]>,
  ) {
    const recordedAt = DateTime.formatIso(yield* DateTime.now);
    yield* repository.execute(
      yield* decodeResourceCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId,
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution: { ...human, recordedAt },
        records,
        committedAt: recordedAt,
      }),
    );
  });
  yield* commitRecords("resource-configuration", [
    role,
    {
      ...common,
      kind: "member",
      recordId: "resource-member",
      status: "active",
      name: "Resource investigator",
      coordinator: false,
      roleRevisionId: role.recordId,
    },
    {
      ...common,
      kind: "limits",
      recordId: "resource-limits",
      status: "configured",
      model: resourceModel,
      tokenLimit: 20000,
      durationLimitMs: 300000,
      environmentModelCalls: 4,
      modelCalls: 4,
      projectWritableWorkers: 1,
      delegationDepth: 2,
      repairAllowance: 2,
    },
  ]);
  const configuration = {
    instructionsHash: NodeCrypto.createHash("sha256").update(role.instructions).digest("hex"),
    toolIds: [],
    skillIds: [],
    runtimeVersion: "0.99.1",
    maxTokens: 20000,
    maxDurationMs: 300000,
    paidFallback: false as const,
  };
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
  const admit = Effect.fn("resourceFixture.admit")(function* (
    pending: typeof ProjectWorkFoundationCommitCommand.Type,
    number: number,
    memoryBytes: number,
  ) {
    if (pending.transition?.kind !== "claim") return yield* Effect.die("Missing resource claim");
    const now = yield* Clock.currentTimeMillis;
    const claimedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
    const binding = {
      ...pending.transition.binding,
      updatedAt: claimedAt,
      worktree: `/workspace-resource-${number}`,
      branch: `refs/heads/resource-${number}`,
    };
    const dispatchId = `resource-dispatch-${number}`;
    const request: ProjectTeamDispatchRequest = {
      dispatchId,
      claim: {
        ...pending,
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution: { ...attribution, recordedAt: claimedAt },
        committedAt: claimedAt,
        transition: {
          ...pending.transition,
          binding,
          claim: {
            ...pending.transition.claim,
            claimedAt,
            leasedUntil: DateTime.formatIso(DateTime.makeUnsafe(now + 300000)),
          },
        },
      },
      git: {
        effectId: dispatchId,
        runId: binding.recordId,
        generation: binding.generation,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: binding.worktree,
        branchRef: binding.branch,
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: `resource-owner-${number}`,
        policyHash: "b".repeat(64),
      },
      setupId: `resource-setup-${number}`,
      initializeOperationId: `resource-initialize-${number}`,
      assignmentOperationId: `resource-assignment-${number}`,
      assignment: "Inspect the original approved scope",
    };
    const reserved = yield* journal.reserve(request);
    const admitted = yield* journal.claimEffect(reserved.fence);
    // Allocation is controlled; no native launcher, Git operation or model transport is invoked.
    const nonce = `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const allocation: PiManagedProcessAllocation = {
      version: 1,
      nonce,
      unit: `t3-pi-managed-${nonce}.service`,
      policy: { memoryBytes, runtimeSeconds: 30 },
      launch: {
        workspaceRoot: binding.worktree,
        workspaceAccess: "readonly",
        nativeStateRoot: `/native-resource-${number}`,
        protectedRoots: ["/protected"],
        runtimeFiles: [{ source: "/runtime/true", target: "/bin/true", dev: 1, ino: 1 }],
        argv: ["/bin/true"],
        memoryBytes,
        runtimeSeconds: 30,
        workspace: { path: binding.worktree, dev: 1, ino: number },
        nativeState: { path: `/native-resource-${number}`, dev: 1, ino: number },
        protectedWorkspaceEntries: [],
      },
    };
    const op = yield* operations.prepare(
      { providerInstanceId, threadId: binding.threadId },
      { threadId: binding.threadId, kind: "initialize" },
      `resource-request-${number}`,
      {
        allocation,
        workerId: `resource-worker-${number}`,
        operationId: request.initializeOperationId,
      },
    );
    const owner: PiManagedProcessOwner = {
      type: "owner",
      unit: allocation.unit,
      nonce,
      invocation: String(number).padStart(32, "a"),
      cgroup: `/sys/fs/cgroup/controlled/${allocation.unit}`,
      pid: number,
      memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
    };
    const drain: PiManagedDrain = {
      unit: owner.unit,
      invocation: owner.invocation,
      cgroup: owner.cgroup,
      ownerPid: owner.pid,
      memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
      launcherPid: 100 + number,
      childPid: 200 + number,
      childExitCode: 0,
      kernel: "removed",
    };
    return {
      admitted,
      request,
      allocation,
      op,
      owner,
      drain,
      persistence: operations.persistence(op),
    };
  });
  const approvedRoot = Effect.fn("resourceFixture.approvedRoot")(function* (
    id: ProjectWorkTaskId,
    nativeThreadId: ThreadId,
    number: number,
    memoryBytes: number,
  ) {
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    // Retain only the final claim; the shared fixture commits real specification/plan approvals.
    const result = yield* createManagedAssignment({
      taskId: id,
      recordId: `resource-root-${number}`,
      attemptId: `resource-attempt-${number}`,
      commandId: `resource-claim-${number}`,
      providerInstanceId,
      threadId: nativeThreadId,
      role,
      memberId: "resource-member",
      status: "reserved",
      configuration,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (command) => {
          if (
            command.type === "project-work.foundation.commit" &&
            command.transition?.kind === "claim"
          ) {
            pending = command;
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Retain resource claim"),
            );
          }
          return repository.execute(command);
        },
      }),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (!pending) return yield* Effect.die("Approved resource root did not reach its claim");
    return yield* admit(pending, number, memoryBytes);
  });
  const root = yield* approvedRoot(taskId, threadId, 1, (PROJECT_TASK_MEMORY_BYTES * 3) / 4);
  yield* root.persistence.claimActivation(root.allocation);
  yield* root.persistence.beforeStart(root.owner);
  yield* operations.persistNative(root.op, {
    sessionId: "resource-root-native",
    sessionReference: "sessions/resource-root-native.jsonl",
    leafId: "root-leaf",
    persisted: true,
  });
  const independentTaskId = ProjectWorkTaskId.make("resource-independent-task");
  const independent = yield* approvedRoot(
    independentTaskId,
    ThreadId.make("resource-independent-thread"),
    3,
    PROJECT_TASK_MEMORY_BYTES,
  );
  yield* independent.persistence.claimActivation(independent.allocation);
  yield* independent.persistence.beforeStart(independent.owner);

  // Issue a real inherited planning grant against the root's exact human approvals.
  yield* TestClock.setTime(resourceTime + 1000);
  let state = yield* readCurrentState(sql, projectId);
  const parent = state.tasks.find((t) => t.taskId === taskId);
  const specificationGate = state.foundationRecords?.find(
    (r) => r.kind === "gate" && r.recordId === root.op.authority.binding.specificationGateId,
  );
  const plan = state.foundationRecords?.find(
    (r) => r.kind === "plan-revision" && r.taskId === taskId && r.status === "proposed",
  );
  const planGate = state.foundationRecords?.find(
    (r) => r.kind === "gate" && r.recordId === root.op.authority.binding.planGateId,
  );
  if (
    !parent ||
    specificationGate?.kind !== "gate" ||
    plan?.kind !== "plan-revision" ||
    planGate?.kind !== "gate"
  )
    return yield* Effect.die("Missing approved parent scope");
  const childCommandId = "resource-inherited-child";
  const childAt = DateTime.formatIso(DateTime.makeUnsafe(resourceTime + 1000));
  yield* repository.execute(
    yield* decodeResourceCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: childCommandId,
      expectedRevision: state.revision,
      attribution: { ...human, recordedAt: childAt },
      records: [],
      committedAt: childAt,
      guided: {
        intent: {
          type: "project-team.assignment.start",
          commandId: childCommandId,
          projectId,
          taskId,
          expectedRevision: state.revision,
          expectedTaskRevision: parent.revision,
          assignmentKind: "planning",
          objective: "Inspect the original approved plan",
          outputDescriptions: ["Retained plan findings"],
          specRevision: parent.specRevision,
          specificationGateId: specificationGate.recordId,
          expectedSpecificationGateRevision: specificationGate.revision,
          parentPlan: {
            recordId: plan.recordId,
            expectedRecordRevision: plan.revision,
            planRevision: plan.planRevision,
            gateId: planGate.recordId,
            expectedGateRevision: planGate.revision,
          },
        },
      },
    }),
  );
  state = yield* readCurrentState(sql, projectId);
  const grant = state.foundationRecords?.find(
    (r) => r.recordId === projectTeamDerivedRecordId(childCommandId, "assignment"),
  );
  const generatedRole = state.foundationRecords?.find(
    (r) => r.recordId === projectTeamDerivedRecordId(childCommandId, "investigator-role"),
  );
  if (grant?.kind !== "gate" || generatedRole?.kind !== "role-revision")
    return yield* Effect.die("Missing genuine inherited assignment issuance");
  const childRole = {
    ...generatedRole,
    recordId: "resource-child-role",
    roleRevision: 1,
    model: resourceModel,
    delegationDepth: 2,
  };
  yield* commitRecords("resource-child-configuration", [
    childRole,
    {
      ...common,
      kind: "member",
      recordId: "resource-child-member",
      status: "active",
      name: "Inherited planner",
      coordinator: false,
      roleRevisionId: childRole.recordId,
    },
  ]);
  state = yield* readCurrentState(sql, projectId);
  const childTask = state.tasks.find((t) => t.taskId === grant.taskId);
  if (!childTask) return yield* Effect.die("Missing inherited child task");
  const childBinding = {
    ...common,
    kind: "run-binding",
    recordId: "resource-child-binding",
    status: "reserved",
    taskId: childTask.taskId,
    attemptId: "resource-child-attempt",
    memberId: "resource-child-member",
    parentRunId: root.op.authority.binding.recordId,
    roleRevisionId: childRole.recordId,
    providerInstanceId,
    threadId: ThreadId.make("resource-child-thread"),
    environmentId: "environment",
    model: resourceModel,
    configuration: {
      ...configuration,
      instructionsHash: NodeCrypto.createHash("sha256")
        .update(childRole.instructions)
        .digest("hex"),
    },
    worktree: "/workspace-resource-2",
    branch: "refs/heads/resource-2",
    leaseGeneration: 0,
    specRevision: childTask.specRevision,
    planRevision: 0,
    authorizationGateId: grant.recordId,
    scopeHash: projectTeamScopeHash(state, childTask.taskId),
  };
  const child = yield* admit(
    yield* decodeResourceCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "resource-child-claim",
      expectedRevision: state.revision,
      attribution,
      records: [],
      committedAt: at,
      transition: {
        kind: "claim",
        taskId: childTask.taskId,
        expectedTaskRevision: childTask.revision,
        authorizationGateId: grant.recordId,
        expectedGateRevision: grant.revision,
        binding: childBinding,
        claim: {
          type: "project-work.task.claim",
          projectId,
          taskId: childTask.taskId,
          commandId: "resource-child-claim",
          attemptId: childBinding.attemptId,
          leaseToken: "resource-child-lease",
          leasedUntil: "2030-01-01T00:00:00.000Z",
          claimedAt: at,
        },
      },
    }),
    2,
    PROJECT_TASK_MEMORY_BYTES / 2,
  );
  const resources = yield* makeProjectTaskResources("environment");
  // Setup state and verification receipts are controlled custody, attached to real approved
  // dispatches. These helpers never assert verification approval or native activation.
  const setup = Effect.fn("resourceFixture.setup")(function* (
    source: typeof child,
    number: number,
    memoryBytes: number,
    retainInput = true,
  ) {
    const process = controlledResourceProcess(source, number, memoryBytes);
    const binding = source.op.authority.binding;
    const id = source.request.setupId;
    const input = {
      setupId: id,
      bindingId: binding.recordId,
      generation: binding.generation,
      threadId: binding.threadId,
      worktreePath: binding.worktree,
      deadlineAtMs: source.admitted.intent.limits.deadlineAtMs,
    };
    yield* sql`UPDATE project_team_dispatch SET stage='workspace-ready',revision=revision+1 WHERE dispatch_id=${source.request.dispatchId}`;
    yield* sql`INSERT INTO project_team_setup_process(setup_id,dispatch_id,unit,selection_json,allocation_json,status,input_json,activation)
      VALUES(${id},${source.request.dispatchId},${process.allocation.unit},'{}',${canonicalProjectWorkPayload(process.allocation)},'allocated',${retainInput ? canonicalProjectWorkPayload(input) : null},'unlaunched')`;
    const captureOwner = sql`UPDATE project_team_setup_process SET status='captured',activation='owned',owner_json=${canonicalProjectWorkPayload(process.owner)} WHERE setup_id=${id}`;
    return {
      ...process,
      id,
      deadline: input.deadlineAtMs,
      loan: resources.setup(id, process.allocation),
      captureOwner,
    };
  });
  const verification = Effect.fn("resourceFixture.verification")(function* (
    source: typeof child,
    number: number,
    memoryBytes: number,
    provenance: {
      dispatchId?: string;
      bindingId?: string;
      generation?: number;
      taskId?: typeof ProjectWorkTaskId.Type;
    } = {},
    deadline = resourceTime + 31000,
  ) {
    const process = controlledResourceProcess(source, number, memoryBytes);
    const binding = source.op.authority.binding;
    const id = `resource-verification-${number}`;
    const manifest = decodeResourceManifest({
      version: 1,
      jobId: id,
      environmentId: "environment",
      projectId,
      taskId: provenance.taskId ?? binding.taskId,
      specRevision: binding.specRevision,
      specificationHash: "a".repeat(64),
      planRevision: binding.planRevision,
      planHash: "b".repeat(64),
      criteria: [{ criterionId: ProjectWorkCriterionId.make("resource-criterion"), revision: 0 }],
      dispatchId: provenance.dispatchId ?? source.request.dispatchId,
      bindingId: provenance.bindingId ?? binding.recordId,
      generation: provenance.generation ?? binding.generation,
      workspaceReceiptHash: "c".repeat(64),
      command: {
        executable: "/bin/true",
        argv: [],
        limits: { maxDurationMs: 30000, maxOutputBytes: 1024 },
        environment: "clean",
      },
      target: {
        repository: "/workspace",
        worktree: binding.worktree,
        branchRef: binding.branch,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        testedCommit: "b".repeat(40),
        testedTree: "c".repeat(40),
        workspaceState: "clean-committed",
      },
      executable: {
        target: "/bin/true",
        sha256: "d".repeat(64),
        runtimeClosureSha256: "e".repeat(64),
      },
    });
    const gate = decodeResourceGate({
      kind: "gate",
      recordId: `resource-verification-gate-${number}`,
      projectId,
      taskId: provenance.taskId ?? binding.taskId,
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "approved",
      gate: "verification",
      specRevision: binding.specRevision,
      planRevision: binding.planRevision,
      contentHash: resourceHash(manifest),
      verificationJobId: id,
      attribution: human,
      evidenceIds: [],
    });
    const intent = {
      allocation: process.allocation,
      deadlineAtMs: deadline,
      receipt: { manifest, sha256: resourceHash(manifest) },
      gate,
    };
    yield* sql`INSERT INTO project_work_verification_execution(environment_id,job_id,project_id,task_id,attempt_id,manifest_hash,gate_id,gate_revision,intent_json,intent_hash,allocation_hash,deadline_at_ms,phase,revision)
      VALUES('environment',${id},${projectId},${provenance.taskId ?? binding.taskId},${id},${resourceHash(manifest)},${gate.recordId},0,${canonicalProjectWorkPayload(intent)},${resourceHash(intent)},${resourceHash(process.allocation)},${deadline},'claimed',0)`;
    const captureOwner = Effect.gen(function* () {
      yield* sql`UPDATE project_work_verification_execution SET phase='activating',revision=revision+1 WHERE attempt_id=${id}`;
      yield* sql`UPDATE project_work_verification_execution SET phase='owner-captured',owner_json=${canonicalProjectWorkPayload(process.owner)},revision=revision+1 WHERE attempt_id=${id}`;
    });
    return {
      ...process,
      id,
      deadline,
      loan: resources.verification(id, process.allocation),
      captureOwner,
    };
  });
  return {
    sql,
    operations,
    resources,
    root,
    child,
    independent,
    independentTaskId,
    setup,
    verification,
  };
});

it.effect(
  "approved Pi descendants share the original 2 GiB cap and deadline until their exact kernel drain",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* approvedPiResourceFixture;
        const deadline = resourceTime + 300000;
        expect(f.root.op.deadlineAtMs).toBe(deadline);
        expect(f.child.admitted.intent.limits.rootTaskId).toBe(taskId);
        expect(f.child.admitted.intent.limits.rootDeadlineAtMs).toBe(deadline);
        expect(f.child.persistence.deadlineAtMs).toBe(deadline);
        expect(f.child.op.authority.binding.taskId).not.toBe(taskId);
        yield* f.operations.authorize(f.child.op);
        // Root holds 1.5 GiB; this inherited 1 GiB must fail despite its different task ID.
        const denied = yield* f.child.persistence
          .claimActivation(f.child.allocation)
          .pipe(Effect.result);
        expect(denied).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PiManagedProcessError", phase: "startup" },
        });
        expect(
          yield* f.sql`SELECT task_id,memory_bytes,deadline_at_ms FROM project_task_resource_budget ORDER BY task_id`,
        ).toEqual([
          { task_id: taskId, memory_bytes: PROJECT_TASK_MEMORY_BYTES, deadline_at_ms: deadline },
          {
            task_id: f.independentTaskId,
            memory_bytes: PROJECT_TASK_MEMORY_BYTES,
            deadline_at_ms: deadline,
          },
        ]);
        const heldUnits = () =>
          f.sql`SELECT unit FROM project_task_resource_child WHERE drain_json IS NULL ORDER BY unit`;
        const deniedDrain = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.result,
            Effect.map((result) =>
              expect(result).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "PiManagedProcessError", phase: "quarantine" },
              }),
            ),
          );
        yield* deniedDrain(
          f.root.persistence.afterDrain({ ...f.root.drain, invocation: "b".repeat(32) }),
        );
        yield* rejected(f.child.persistence.claimActivation(f.child.allocation));
        yield* f.root.persistence.afterDrain(f.root.drain);
        // Only the captured root unit is released. Its child can now use that capacity.
        yield* f.child.persistence.claimActivation(f.child.allocation);
        yield* f.child.persistence.beforeStart(f.child.owner);
        expect(yield* heldUnits()).toEqual([
          { unit: f.child.allocation.unit },
          { unit: f.independent.allocation.unit },
        ]);
        yield* TestClock.setTime(deadline);
        for (const receipt of [
          f.root.drain,
          { ...f.child.drain, invocation: "b".repeat(32) },
          { ...f.child.drain, cgroup: "/sys/fs/cgroup/foreign" },
          { ...f.child.drain, kernel: "populated 1" },
        ]) {
          yield* deniedDrain(f.child.persistence.afterDrain(receipt));
          expect(yield* heldUnits()).toEqual([
            { unit: f.child.allocation.unit },
            { unit: f.independent.allocation.unit },
          ]);
        }
        yield* f.child.persistence.afterDrain(f.child.drain);
        expect(yield* heldUnits()).toEqual([{ unit: f.independent.allocation.unit }]);
      }),
    ),
);

it.effect(
  "approved descendant setup and verification share the original root resource budget",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* approvedPiResourceFixture;
        const setup = yield* f.setup(f.child, 4, PROJECT_TASK_MEMORY_BYTES / 4);
        const verification = yield* f.verification(f.child, 5, PROJECT_TASK_MEMORY_BYTES / 4);
        yield* f.sql.withTransaction(setup.loan.reserve);
        yield* f.sql.withTransaction(setup.loan.capture(setup.owner));
        yield* setup.captureOwner;
        yield* rejected(f.sql.withTransaction(verification.loan.reserve));
        expect(
          yield* f.sql`SELECT task_id,authority_kind FROM project_task_resource_child WHERE unit=${setup.allocation.unit}`,
        ).toEqual([{ task_id: taskId, authority_kind: "setup" }]);
        yield* rejected(
          f.sql.withTransaction(setup.loan.cleanupDrain({ ...setup.drain, kernel: "populated 1" })),
        );
        yield* rejected(f.sql.withTransaction(verification.loan.reserve));
        yield* f.sql.withTransaction(setup.loan.cleanupDrain(setup.drain));
        expect(yield* f.sql.withTransaction(verification.loan.reserve)).toBe(verification.deadline);
        yield* f.sql.withTransaction(verification.loan.capture(verification.owner));
        yield* verification.captureOwner;
        expect(
          yield* f.sql`SELECT task_id,authority_kind FROM project_task_resource_child WHERE unit=${verification.allocation.unit}`,
        ).toEqual([{ task_id: taskId, authority_kind: "verification" }]);
        expect(
          yield* f.sql`SELECT task_id,deadline_at_ms FROM project_task_resource_budget ORDER BY task_id`,
        ).toEqual([
          { task_id: taskId, deadline_at_ms: resourceTime + 300000 },
          { task_id: f.independentTaskId, deadline_at_ms: resourceTime + 300000 },
        ]);
        yield* TestClock.setTime(resourceTime + 300000);
        yield* rejected(
          f.sql.withTransaction(
            verification.loan.cleanupDrain({ ...verification.drain, invocation: "b".repeat(32) }),
          ),
        );
        yield* f.sql.withTransaction(verification.loan.cleanupDrain(verification.drain));
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE task_id=${taskId} AND drain_json IS NULL`,
        ).toEqual([{ held: f.root.allocation.policy.memoryBytes }]);
      }),
    ),
);

it.effect(
  "descendant verification rejects foreign dispatch identity and an extended root deadline",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* approvedPiResourceFixture;
        const original = {
          dispatchId: f.child.request.dispatchId,
          bindingId: f.child.op.authority.binding.recordId,
          generation: f.child.op.authority.binding.generation,
        };
        for (const [index, provenance] of [
          { ...original, dispatchId: "missing-dispatch" },
          { ...original, dispatchId: f.independent.request.dispatchId },
          { ...original, bindingId: f.root.op.authority.binding.recordId },
          { ...original, generation: original.generation + 1 },
        ].entries()) {
          const verification = yield* f.verification(
            f.child,
            10 + index,
            PROJECT_TASK_MEMORY_BYTES / 8,
            provenance,
          );
          yield* rejected(f.sql.withTransaction(verification.loan.reserve));
        }
        const extended = yield* f.verification(
          f.child,
          14,
          PROJECT_TASK_MEMORY_BYTES / 8,
          {},
          resourceTime + 300001,
        );
        yield* rejected(f.sql.withTransaction(extended.loan.reserve));
        expect(yield* f.sql`SELECT COUNT(*) AS children FROM project_task_resource_child`).toEqual([
          { children: 2 },
        ]);
      }),
    ),
);

for (const kind of [
  "pi",
  "setup",
  "verification",
  "setup-without-input",
  "verification-without-dispatch",
] as const)
  it.effect(`historical descendant ${kind} reservations block allocation until exact cleanup`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* approvedPiResourceFixture;
        const logicalTaskId = f.child.op.authority.binding.taskId;
        const historical =
          kind === "pi"
            ? {
                ...f.child,
                id: f.child.op.operation.operationId,
                deadline: f.child.op.deadlineAtMs,
                loan: f.resources.pi(f.child.op.operation.operationId, f.child.allocation),
                captureOwner: f.sql`UPDATE project_team_pi_process SET status='captured',owner_json=${canonicalProjectWorkPayload(f.child.owner)} WHERE unit=${f.child.allocation.unit}`,
              }
            : kind === "verification" || kind === "verification-without-dispatch"
              ? yield* f.verification(
                  f.child,
                  4,
                  PROJECT_TASK_MEMORY_BYTES / 2,
                  kind === "verification-without-dispatch"
                    ? { dispatchId: "retired-dispatch" }
                    : {},
                )
              : yield* f.setup(f.child, 4, PROJECT_TASK_MEMORY_BYTES / 2, kind === "setup");
        const authorityKind =
          kind === "setup-without-input"
            ? "setup"
            : kind === "verification-without-dispatch"
              ? "verification"
              : kind;
        yield* f.sql`INSERT INTO project_task_resource_budget VALUES('environment',${projectId},${logicalTaskId},${resourceTime + 300000},${PROJECT_TASK_MEMORY_BYTES})`;
        // Restore the old partition without changing any production approval or resource row.
        // Its uncaptured reservation must already prevent forward root allocation.
        yield* f.sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
          VALUES(${historical.allocation.unit},${historical.allocation.nonce},'environment',${projectId},${logicalTaskId},${authorityKind},${historical.id},${canonicalProjectWorkPayload(historical.allocation)},${historical.allocation.policy.memoryBytes},${historical.deadline})`;
        const waiting = yield* f.verification(f.root, 5, PROJECT_TASK_MEMORY_BYTES / 8);
        const blocked = yield* f.sql.withTransaction(waiting.loan.reserve).pipe(Effect.result);
        expect(blocked).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "PiManagedProcessError",
            message: "Original task contains an unaccounted native child",
          },
        });
        yield* rejected(f.sql.withTransaction(historical.loan.reserve));
        yield* historical.captureOwner;
        if (authorityKind === "pi" || authorityKind === "verification")
          yield* f.sql`UPDATE project_task_resource_child SET owner_json=${canonicalProjectWorkPayload(historical.owner)} WHERE unit=${historical.allocation.unit}`;
        // Setup may have retained its native owner just before resource capture was interrupted.
        yield* f.sql.withTransaction(historical.loan.captureCleanup(historical.owner));
        const before =
          yield* f.sql`SELECT * FROM project_task_resource_child WHERE unit=${historical.allocation.unit}`;
        const budgets = yield* f.sql`SELECT * FROM project_task_resource_budget ORDER BY task_id`;
        const resumed = yield* makeProjectTaskResources("environment");
        const cleanup =
          authorityKind === "pi"
            ? resumed.pi(historical.id, historical.allocation)
            : authorityKind === "verification"
              ? resumed.verification(historical.id, historical.allocation)
              : resumed.setup(historical.id, historical.allocation);
        for (const receipt of [
          { ...historical.drain, invocation: "b".repeat(32) },
          { ...historical.drain, cgroup: "/sys/fs/cgroup/foreign" },
          { ...historical.drain, kernel: "populated 1" },
        ]) {
          yield* rejected(f.sql.withTransaction(cleanup.cleanupDrain(receipt)));
          expect(
            yield* f.sql`SELECT * FROM project_task_resource_child WHERE unit=${historical.allocation.unit}`,
          ).toEqual(before);
          yield* rejected(f.sql.withTransaction(waiting.loan.reserve));
        }
        yield* f.sql.withTransaction(cleanup.cleanupDrain(historical.drain));
        yield* f.sql.withTransaction(cleanup.cleanupDrain(historical.drain));
        expect(
          yield* f.sql`SELECT * FROM project_task_resource_child WHERE unit=${historical.allocation.unit}`,
        ).toEqual(
          before.map((row) => ({
            ...row,
            drain_json: canonicalProjectWorkPayload(historical.drain),
          })),
        );
        expect(yield* f.sql`SELECT * FROM project_task_resource_budget ORDER BY task_id`).toEqual(
          budgets,
        );
        yield* f.sql.withTransaction(waiting.loan.reserve);
        yield* rejected(f.sql.withTransaction(cleanup.reserve));
        yield* TestClock.setTime(resourceTime + 300000);
        yield* f.sql.withTransaction(cleanup.cleanupDrain(historical.drain));
        expect(yield* f.sql`SELECT * FROM project_task_resource_budget ORDER BY task_id`).toEqual(
          budgets,
        );
      }),
    ),
  );

for (const kind of ["pi", "setup", "verification", "memory-companion"] as const)
  it.effect(`unaccounted inherited ${kind} custody blocks forward root allocation`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* approvedPiResourceFixture;
        const waiting = yield* f.verification(f.root, 5, PROJECT_TASK_MEMORY_BYTES / 8);
        if (kind === "pi")
          yield* f.sql`UPDATE project_team_pi_process SET status='quarantine',owner_json=${canonicalProjectWorkPayload(f.child.owner)} WHERE unit=${f.child.allocation.unit}`;
        else if (kind === "setup") {
          const setup = yield* f.setup(f.child, 4, PROJECT_TASK_MEMORY_BYTES / 2);
          yield* setup.captureOwner;
        } else if (kind === "verification") {
          const verification = yield* f.verification(f.child, 4, PROJECT_TASK_MEMORY_BYTES / 2);
          yield* verification.captureOwner;
        } else {
          // SQL custody only: this unknown companion grants no memory admission/backend authority.
          const intent = {
            allocation: f.child.allocation,
            owner: {
              operation: {
                environmentId: "environment",
                projectId,
                taskId: f.child.op.authority.binding.taskId,
                rootTaskId: taskId,
                rootDeadlineAtMs: resourceTime + 300000,
              },
            },
          };
          yield* f.sql`INSERT INTO project_memory_companion_invocation(invocation_id,environment_id,project_id,task_id,effect_id,request_id,generation,intent_json,phase,owner_json)
            VALUES('unknown-companion','environment',${projectId},${f.child.op.authority.binding.taskId},'unknown-effect','unknown-request',0,${canonicalProjectWorkPayload(intent)},'uncertain',${canonicalProjectWorkPayload(f.child.owner)})`;
        }
        const blocked = yield* f.sql.withTransaction(waiting.loan.reserve).pipe(Effect.result);
        expect(blocked).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "PiManagedProcessError",
            message: "Original task contains an unaccounted native child",
          },
        });
        // A genuinely independent approved root remains outside this ancestry.
        expect(
          yield* f.sql.withTransaction(
            f.resources.pi(f.independent.op.operation.operationId, f.independent.allocation)
              .reserve,
          ),
        ).toBe(resourceTime + 300000);
        expect(yield* f.sql`SELECT COUNT(*) AS children FROM project_task_resource_child`).toEqual([
          { children: 2 },
        ]);
      }),
    ),
  );

it.effect(
  "unattributed legacy verifier without a resource child blocks until matched cleanup",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* approvedPiResourceFixture;
        const held = yield* f.verification(f.child, 4, PROJECT_TASK_MEMORY_BYTES / 2, {
          dispatchId: "retired-dispatch",
          taskId: ProjectWorkTaskId.make("retired-task"),
        });
        const waiting = yield* f.verification(f.root, 5, PROJECT_TASK_MEMORY_BYTES / 8);
        yield* held.captureOwner;
        expect(
          yield* f.sql`SELECT unit FROM project_task_resource_child WHERE unit=${held.allocation.unit}`,
        ).toEqual([]);
        const before =
          yield* f.sql`SELECT * FROM project_work_verification_execution WHERE attempt_id=${held.id}`;
        yield* rejected(f.sql.withTransaction(waiting.loan.reserve));
        for (const drain of [
          { ...held.drain, invocation: "b".repeat(32) },
          { ...held.drain, cgroup: "/sys/fs/cgroup/foreign" },
          { ...held.drain, kernel: "populated 1" },
        ]) {
          yield* rejected(f.sql.withTransaction(held.loan.cleanupDrain(drain)));
          expect(
            yield* f.sql`SELECT * FROM project_work_verification_execution WHERE attempt_id=${held.id}`,
          ).toEqual(before);
          yield* rejected(f.sql.withTransaction(waiting.loan.reserve));
        }
        yield* f.sql.withTransaction(held.loan.cleanupDrain(held.drain));
        // This controlled custody fixture records the owning journal's terminal cleanup;
        // the resource seam never invents a child reservation or updates a verifier lifecycle.
        yield* f.sql`UPDATE project_work_verification_execution SET phase='terminal',result_json=${canonicalProjectWorkPayload({ reconciliation: held.drain })},result_hash=${resourceHash({ reconciliation: held.drain })},revision=revision+1 WHERE attempt_id=${held.id}`;
        expect(
          yield* f.sql`SELECT unit FROM project_task_resource_child WHERE unit=${held.allocation.unit}`,
        ).toEqual([]);
        expect(yield* f.sql.withTransaction(waiting.loan.reserve)).toBe(waiting.deadline);
      }),
    ),
);
