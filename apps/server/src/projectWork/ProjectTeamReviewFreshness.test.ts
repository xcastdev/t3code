// @effect-diagnostics nodeBuiltinImport:off - Pinned SDK journal bytes are the host observation under test.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  canonicalProjectWorkPayload,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { preallocatePiManagedProcess } from "../provider/pi/PiManagedProcess.ts";
import { makeProjectTeamReviewFreshness } from "./ProjectTeamReviewFreshness.ts";

const encode = canonicalProjectWorkPayload;
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const at = "2026-10-05T00:00:00.000Z";
const decodeRole = Schema.decodeUnknownEffect(ProjectTeamRoleRevision);
const decodeBinding = Schema.decodeUnknownEffect(ProjectTeamRunBinding);
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const workspace = NodePath.join(root, "workspace");
  const nativeRoot = NodePath.join(root, "native");
  yield* fs.makeDirectory(workspace);
  yield* fs.makeDirectory(nativeRoot);
  yield* fs.makeDirectory(NodePath.join(root, "protected"));
  const sessionDirectoryRoot = NodePath.join(nativeRoot, "sessions");
  const expectedBriefing = "Fresh reviewer briefing only. No implementer conversation. 🐦";
  const manager = yield* Effect.sync(() =>
    SessionManager.create("/workspace", sessionDirectoryRoot),
  );
  manager.appendModelChange("synthetic", "fixture-only");
  manager.appendThinkingLevelChange("off");
  manager.appendSessionInfo("Independent review");
  const leafId = manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: expectedBriefing }],
    timestamp: 1,
  });
  const file = manager.getSessionFile();
  if (!file) return yield* Effect.die("Pinned SDK fixture did not persist");
  const native = {
    sessionId: manager.getSessionId(),
    sessionReference: `sessions/${NodePath.basename(file)}`,
    leafId,
    persisted: true,
  };
  const common = { projectId: "review-project", revision: 0, generation: 1, updatedAt: at };
  const role = yield* decodeRole({
    ...common,
    kind: "role-revision",
    recordId: "review-role",
    status: "available",
    roleId: "reviewer",
    roleRevision: 0,
    role: "reviewer",
    instructions: "Independent reviewer",
    skills: [],
    tools: [],
    model: "synthetic",
    memoryAccess: "none",
    delegationDepth: 0,
  });
  const binding = yield* decodeBinding({
    ...common,
    kind: "run-binding",
    recordId: "review-binding",
    status: "running",
    taskId: "review-task",
    attemptId: "review-attempt",
    memberId: "review-member",
    roleRevisionId: role.recordId,
    providerInstanceId: "review-provider",
    threadId: "review-thread",
    environmentId: "review-environment",
    model: "synthetic",
    worktree: workspace,
    branch: "review",
    leaseGeneration: 1,
    specRevision: 2,
    planRevision: 3,
    configuration: {
      instructionsHash: digest(role.instructions),
      toolIds: [],
      skillIds: [],
      runtimeVersion: "0.99.1",
      maxTokens: 1000,
      maxDurationMs: 10000,
      paidFallback: false,
    },
  });
  const allocation = yield* preallocatePiManagedProcess({
    workspaceRoot: workspace,
    workspaceAccess: "readonly",
    nativeStateRoot: nativeRoot,
    protectedRoots: [NodePath.join(root, "protected")],
    runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
    argv: ["/bin/true"],
    memoryBytes: 33554432,
    runtimeSeconds: 10,
  });
  const operationId = "review-initialize";
  const request = {
    kind: "initialize",
    operationId,
    threadId: binding.threadId,
    resumeCursor: null,
  };
  const intent = {
    request,
    binding,
    role,
    allocation,
    resourceHash: "a".repeat(64),
    rootBudget: { rootTaskId: binding.taskId, maximumTokens: 1000, deadlineAtMs: 100000 },
    operationLimits: { maximumTokens: 1000, deadlineAtMs: 100000 },
  };
  const owner = {
    type: "owner",
    unit: allocation.unit,
    nonce: allocation.nonce,
    invocation: "a".repeat(32),
    cgroup: `/sys/fs/cgroup/${allocation.unit}`,
    pid: 123,
    memoryBytes: allocation.policy.memoryBytes,
    swapBytes: 0,
    oomGroup: 1,
  };
  const drain = {
    unit: owner.unit,
    invocation: owner.invocation,
    cgroup: owner.cgroup,
    ownerPid: owner.pid,
    memoryBytes: owner.memoryBytes,
    swapBytes: 0,
    oomGroup: 1,
    launcherPid: 122,
    childPid: 124,
    childExitCode: 0,
    kernel: "populated 0\nfrozen 0\n",
  };
  const terminal = {
    identity: { workerId: "review-worker", generation: 1 },
    operation: { operationId, operationKind: "initialize" },
    outcome: "success",
    ownerCaptured: true,
    native,
    drain,
    accountingReceipts: [],
  };
  yield* sql`INSERT INTO project_team_pi_operation
    (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
      operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,
      status,intent_json,native_json,terminal_json)
    VALUES (${operationId},${binding.environmentId},${binding.projectId},${binding.recordId},1,
      ${binding.providerInstanceId},${binding.threadId},'review-worker',0,'initialize',${digest(encode(request))},
      ${binding.recordId},${binding.taskId},1000,100000,'settled',${encode(intent)},${encode(native)},${encode(terminal)})`;
  yield* sql`INSERT INTO project_team_pi_process (unit,operation_id,allocation_json,status,owner_json,drain_json)
    VALUES (${allocation.unit},${operationId},${encode(allocation)},'drained',${encode(owner)},${encode(drain)})`;
  const service = yield* makeProjectTeamReviewFreshness({ environmentId: binding.environmentId });
  const input = {
    projectId: binding.projectId,
    taskId: binding.taskId,
    bindingId: binding.recordId,
    generation: binding.generation,
    providerInstanceId: binding.providerInstanceId,
    threadId: binding.threadId,
    operationId,
    specRevision: binding.specRevision,
    planRevision: binding.planRevision,
    sessionDirectoryRoot,
    expectedCwd: "/workspace",
    native,
    expectedBriefing,
    assertCurrent: Effect.void,
  };
  return { sql, manager, file, service, input, intent, terminal, drain, allocation, root };
});
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(SqlitePersistenceMemory, NodeServices.layer)),
  );
const sessionOwner = (f: Effect.Success<typeof fixture>) => ({
  projectId: f.input.projectId,
  taskId: f.input.taskId,
  bindingId: f.input.bindingId,
  generation: f.input.generation,
  providerInstanceId: f.input.providerInstanceId,
  threadId: f.input.threadId,
  sessionId: f.input.native.sessionId,
  specRevision: f.input.specRevision,
  planRevision: f.input.planRevision,
});
const addSuccessor = Effect.fn("freshnessTest.addSuccessor")(function* (
  f: Effect.Success<typeof fixture>,
) {
  yield* f.sql`INSERT INTO project_team_pi_operation
    (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
      operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,
      status,intent_json,native_json,terminal_json)
    SELECT 'review-prompt',environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
      operation_ordinal+1,'prompt',request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,
      'settled',intent_json,native_json,terminal_json FROM project_team_pi_operation WHERE operation_id=${f.input.operationId}`;
});

it.effect("retains the actual fresh initialized SDK journal and immutable ownership", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const receipt = yield* f.service.capture(f.input);
      expect(receipt).toMatchObject({
        operationId: f.input.operationId,
        bindingId: f.input.bindingId,
        specRevision: 2,
        planRevision: 3,
        native: f.input.native,
        briefingSHA256: digest(f.input.expectedBriefing),
      });
      const raw = yield* Effect.promise(() => NodeFSP.readFile(f.file, "utf8"));
      const rows = yield* f.sql<{
        raw: string;
      }>`SELECT native_jsonl AS raw FROM project_team_review_freshness`;
      expect(rows).toEqual([{ raw }]);
    }),
  ),
);

it.effect(
  "reads historical freshness after a prompt but refuses recapture of the superseded initialization",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const receipt = yield* f.service.capture(f.input);
        yield* addSuccessor(f);
        f.manager.appendMessage({
          role: "user",
          content: [{ type: "text", text: "Later review assignment" }],
          timestamp: 2,
        });
        expect(yield* f.service.readRetained(f.input.operationId)).toEqual(receipt);
        expect(yield* f.service.readForSession(sessionOwner(f))).toEqual(receipt);
        expect(yield* f.service.capture(f.input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "invalid-operation" },
        });
      }),
    ),
);

for (const kind of ["custom", "assistant", "compaction", "branch", "metadata", "parent"] as const) {
  it.effect(`rejects ${kind} history without retaining a freshness receipt`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        if (kind === "custom")
          f.manager.appendCustomEntry("prior-state", { secret: "prior context" });
        if (kind === "compaction")
          f.manager.appendCompaction("Prior conversation summary", f.input.native.leafId!, 12);
        if (kind === "branch") {
          const first = f.manager.getEntries()[0];
          if (!first) return yield* Effect.die("Missing SDK metadata");
          f.manager.branch(first.id);
          f.manager.appendSessionInfo("Sibling branch");
        }
        if (kind === "assistant")
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              f.file,
              encode({
                type: "message",
                id: "prior-assistant",
                parentId: f.input.native.leafId,
                timestamp: at,
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Prior implementer answer" }],
                  timestamp: 1,
                },
              }) + "\n",
            ),
          );
        if (kind === "metadata" || kind === "parent") {
          const entries = f.manager
            .getEntries()
            .map((entry, index) =>
              kind === "metadata" && index === 0 ? { ...entry, provider: 42 } : entry,
            );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              f.file,
              [
                encode({
                  ...f.manager.getHeader(),
                  ...(kind === "parent" ? { parentSession: "" } : {}),
                }),
                ...entries.map(encode),
              ].join("\n") + "\n",
            ),
          );
        }
        expect(yield* f.service.capture(f.input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(yield* f.sql`SELECT operation_id FROM project_team_review_freshness`).toEqual([]);
      }),
    ),
  );
}

it.effect("rejects a changed briefing and a second user message", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(
        yield* f.service
          .capture({ ...f.input, expectedBriefing: "Different approved briefing" })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      f.manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Old conversation" }],
        timestamp: 2,
      });
      expect(yield* f.service.capture(f.input).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      expect(yield* f.sql`SELECT operation_id FROM project_team_review_freshness`).toEqual([]);
    }),
  ),
);

it.effect(
  "reuses an identical retained receipt without rereading later native bytes and rejects conflicting retry",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const receipt = yield* f.service.capture(f.input);
        yield* Effect.promise(() => NodeFSP.unlink(f.file));
        expect(yield* f.service.capture(f.input)).toEqual(receipt);
        expect(yield* f.service.readRetained(f.input.operationId)).toEqual(receipt);
        const recreated = yield* makeProjectTeamReviewFreshness({
          environmentId: "review-environment",
        });
        expect(yield* recreated.readForSession(sessionOwner(f))).toEqual(receipt);
        expect(
          yield* f.service
            .capture({ ...f.input, expectedBriefing: "Conflicting retry" })
            .pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: "conflict" },
        });
      }),
    ),
);

it.effect("rejects foreign ownership and changed specification on session lookup", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(
        yield* f.service.capture({ ...f.input, threadId: "foreign-thread" }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      yield* f.service.capture(f.input);
      for (const target of [
        { ...sessionOwner(f), taskId: "foreign-task" },
        { ...sessionOwner(f), specRevision: 3 },
        { ...sessionOwner(f), providerInstanceId: "foreign-provider" },
      ])
        expect(yield* f.service.readForSession(target).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
      expect(yield* f.service.readRetained("missing-initialization")).toBeUndefined();
    }),
  ),
);

it.effect("requires successful matching process drain and original native identity", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE project_team_pi_process SET status='quarantine' WHERE operation_id=${f.input.operationId}`;
      expect(yield* f.service.capture(f.input).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      yield* f.sql`UPDATE project_team_pi_process SET status='drained' WHERE operation_id=${f.input.operationId}`;
      yield* f.service.capture(f.input);
      yield* f.sql`UPDATE project_team_pi_operation SET native_json=${encode({ ...f.input.native, sessionId: "other-session" })} WHERE operation_id=${f.input.operationId}`;
      expect(yield* f.service.readRetained(f.input.operationId).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
    }),
  ),
);

it.effect("rehashes retained raw bytes rather than trusting a stored artifact label", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.service.capture(f.input);
      // Deliberately damage storage after removing its mutation guard to exercise the read validator.
      yield* f.sql`DROP TRIGGER project_team_review_freshness_immutable`;
      yield* f.sql`UPDATE project_team_review_freshness SET native_jsonl=native_jsonl || ' ' WHERE operation_id=${f.input.operationId}`;
      expect(yield* f.service.readRetained(f.input.operationId).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
    }),
  ),
);

it.effect("rejects inherited transactions before invoking the host fence or retaining bytes", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      let checks = 0;
      const input = {
        ...f.input,
        assertCurrent: Effect.sync(() => {
          checks++;
        }),
      };
      const result = yield* f.sql.withTransaction(f.service.capture(input).pipe(Effect.result));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "inherited-transaction" },
      });
      expect(
        yield* f.sql.withTransaction(
          f.service.readRetained(f.input.operationId).pipe(Effect.result),
        ),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "inherited-transaction" },
      });
      expect(
        yield* f.sql.withTransaction(f.service.readForSession(sessionOwner(f)).pipe(Effect.result)),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "inherited-transaction" },
      });
      expect(checks).toBe(0);
      expect(yield* f.sql`SELECT operation_id FROM project_team_review_freshness`).toEqual([]);
    }),
  ),
);

it.effect(
  "runs current-owner checks outside its private SQL transaction and stops on changed ownership",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        let checks = 0;
        const assertCurrent = Effect.gen(function* () {
          expect(Option.isNone(yield* Effect.serviceOption(f.sql.transactionService))).toBe(true);
          yield* f.sql.withTransaction(f.sql`SELECT 1`);
          checks++;
          if (checks === 2) return yield* Effect.fail("private owner detail must not leak");
        });
        const error = yield* f.service.capture({ ...f.input, assertCurrent }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ProjectTeamReviewFreshnessError" });
        expect(encode(error)).not.toContain("private owner detail");
        expect(yield* f.sql`SELECT operation_id FROM project_team_review_freshness`).toEqual([]);
      }),
    ),
);

it.effect("captures immutable identity and briefing before its first authorization await", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const originalBriefing = f.input.expectedBriefing;
      const originalSessionId = f.input.native.sessionId;
      const entered = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const input = {
        ...f.input,
        native: { ...f.input.native },
        assertCurrent: Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(proceed);
        }),
      };
      const running = yield* Effect.forkChild(f.service.capture(input));
      yield* Deferred.await(entered);
      input.expectedBriefing = "Changed after authorization began";
      input.native.sessionId = "changed-after-authorization";
      yield* Deferred.succeed(proceed, undefined);
      const receipt = yield* Fiber.join(running);
      expect(receipt.native.sessionId).toBe(originalSessionId);
      expect(receipt.briefingSHA256).toBe(digest(originalBriefing));
    }),
  ),
);
