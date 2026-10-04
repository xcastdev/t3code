import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import {
  seed,
  restoreHistoricalBinding,
  providerInstanceId,
  threadId,
  at,
  projectId,
  attribution,
  scoped,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { preallocatePiManagedProcess } from "../provider/pi/PiManagedProcess.ts";
import { makeProjectTeamPiOperations } from "./ProjectTeamPiOperations.ts";
import { make as makeAccounting } from "./ProjectTeamModelAccounting.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProjectTeamSessionReceipts } from "./ProjectTeamSessionReceipts.ts";
import type { PiNativeReference } from "../provider/pi/PiWorkerProtocol.ts";
import type { PiSessionTerminal } from "../provider/pi/PiSessionRuntime.ts";

const model = "inclusionai/ling-3.1-flash:free";
const time = Date.parse(at) + 100;
const isoTime = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
const native: PiNativeReference = {
  sessionId: "native",
  sessionReference: "sessions/native.jsonl",
  leafId: null,
  persisted: true,
};
const fixture = Effect.gen(function* () {
  const repository = yield* ProjectWorkRepository;
  const sql = yield* SqlClient.SqlClient;
  let claim: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  yield* seed("investigator", "reserved", {
    nativeSessionId: null,
    roleTools: [],
    toolIds: [],
    issueCredential: false,
  }).pipe(
    Effect.provideService(ProjectWorkRepository, {
      ...repository,
      execute: (command) => {
        if (
          command.type === "project-work.foundation.commit" &&
          command.transition?.kind === "claim"
        ) {
          claim = command;
          return Effect.fail(
            new ProjectWorkPolicyError("invalid-state", "Retain journal fixture claim"),
          );
        }
        return repository.execute(command);
      },
    }),
    Effect.result,
  );
  if (!claim || claim.transition?.kind !== "claim")
    return yield* Effect.die("Missing journal fixture claim");
  const state = yield* readCurrentState(sql, projectId);
  const role = state.foundationRecords?.find((r) => r.kind === "role-revision");
  if (role?.kind !== "role-revision") return yield* Effect.die("Missing journal role");
  yield* restoreHistoricalBinding({ ...role, model });
  const fs = yield* FileSystem.FileSystem;
  const worktree = yield* fs.makeTempDirectoryScoped();
  const nativeRoot = yield* fs.makeTempDirectoryScoped();
  const protectedRoot = yield* fs.makeTempDirectoryScoped();
  const binding = {
    ...claim.transition.binding,
    worktree,
    branch: "refs/heads/assigned",
    model,
    configuration: {
      ...claim.transition.binding.configuration,
      maxTokens: 20000,
      maxDurationMs: 300000,
      runtimeVersion: "0.99.1",
      instructionsHash: NodeCrypto.createHash("sha256").update(role.instructions).digest("hex"),
    },
  };
  const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "journal-limits",
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      attribution,
      committedAt: at,
      records: [
        {
          kind: "limits",
          projectId,
          recordId: "limits",
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "configured",
          model,
          tokenLimit: 20000,
          durationLimitMs: 300000,
          environmentModelCalls: 2,
          modelCalls: 2,
          projectWritableWorkers: 1,
          delegationDepth: 2,
          repairAllowance: 2,
        },
      ],
    }),
  );
  const request = {
    dispatchId: "journal-dispatch",
    claim: {
      ...claim,
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      transition: {
        ...claim.transition,
        binding,
        claim: { ...claim.transition.claim, leasedUntil: isoTime(time + 10000) },
      },
    },
    git: {
      effectId: "journal-dispatch",
      runId: binding.recordId,
      generation: binding.generation,
      primaryRoot: "/workspace",
      commonGitDirectory: "/workspace/.git",
      worktreePath: worktree,
      branchRef: binding.branch,
      baseRef: "refs/heads/main",
      baseOid: "a".repeat(40),
      ownershipToken: "owner",
      policyHash: "b".repeat(64),
    },
    setupId: "journal-setup",
    initializeOperationId: "journal-initialize",
    assignmentOperationId: "journal-assignment",
    assignment: "Investigate the approved task",
  };
  yield* TestClock.setTime(time);
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 2,
  });
  const admitted = yield* journal.reserve(request);
  const snapshot = yield* journal.claimEffect(admitted.fence);
  const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
  const allocation = yield* preallocatePiManagedProcess({
    workspaceRoot: worktree,
    workspaceAccess: "readonly",
    nativeStateRoot: nativeRoot,
    protectedRoots: [protectedRoot],
    runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
    argv: ["/bin/true"],
    memoryBytes: 33554432,
    runtimeSeconds: 10,
  });
  const identity = { providerInstanceId, threadId };
  return {
    sql,
    journal,
    snapshot,
    operations,
    allocation,
    identity,
    repository,
    request,
    binding,
    role: { ...role, model },
  };
});

const producer = Effect.gen(function* () {
  const f = yield* fixture;
  const resourceHash = "a".repeat(64);
  const initializeRequest = {
    threadId,
    kind: "initialize" as const,
    operationId: f.request.initializeOperationId,
  };
  const init = yield* f.operations.prepare(f.identity, initializeRequest, hash(initializeRequest), {
    allocation: f.allocation,
    workerId: "init-worker",
    operationId: initializeRequest.operationId,
    resourceHash,
  });
  // SQL producer callbacks consume controlled owner/drain records. They do not start native workers.
  const activated = new Set<string>();
  const activate = Effect.fn("receiptTest.activate")(function* (
    op: typeof init,
    ref: typeof native,
  ) {
    const owner = {
      type: "owner" as const,
      unit: op.allocation.unit,
      nonce: op.allocation.nonce,
      invocation: "a".repeat(32),
      cgroup: `/sys/fs/cgroup/${op.allocation.unit}`,
      pid: 123,
      memoryBytes: op.allocation.policy.memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
    };
    yield* f.operations.persistence(op).claimActivation(op.allocation);
    yield* f.operations.persistence(op).beforeStart(owner);
    yield* f.operations.persistNative(op, ref);
    activated.add(op.operation.operationId);
  });
  const complete = Effect.fn("receiptTest.complete")(function* (
    op: typeof init,
    ref: typeof native,
    outcome: PiSessionTerminal["outcome"] = "success",
    accounting: PiSessionTerminal["accountingReceipts"] = [],
  ) {
    const owner = {
      type: "owner" as const,
      unit: op.allocation.unit,
      nonce: op.allocation.nonce,
      invocation: "a".repeat(32),
      cgroup: `/sys/fs/cgroup/${op.allocation.unit}`,
      pid: 123,
      memoryBytes: op.allocation.policy.memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
    };
    if (!activated.has(op.operation.operationId)) yield* activate(op, ref);
    const terminal: PiSessionTerminal = {
      identity: { workerId: op.workerId, generation: op.authority.binding.generation },
      operation: op.operation,
      outcome,
      ownerCaptured: true,
      native: ref,
      drain: {
        unit: owner.unit,
        invocation: owner.invocation,
        cgroup: owner.cgroup,
        ownerPid: owner.pid,
        memoryBytes: owner.memoryBytes,
        swapBytes: 0,
        oomGroup: 1,
        launcherPid: 124,
        childPid: 125,
        childExitCode: 0,
        kernel: "populated 0\nfrozen 0",
      },
      accountingReceipts: accounting,
    };
    yield* f.operations.persistTerminal(op, terminal);
    return terminal;
  });
  const readers = yield* makeProjectTeamSessionReceipts({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 2,
  });
  const initialize = complete(init, native);
  const prompt = Effect.gen(function* () {
    const allocation = yield* preallocatePiManagedProcess({
      workspaceRoot: f.binding.worktree,
      workspaceAccess: "readonly",
      nativeStateRoot: f.allocation.launch.nativeState!.path,
      protectedRoots: f.allocation.launch.protectedRoots,
      runtimeFiles: f.allocation.launch.runtimeFiles.map((file) => ({
        source: file.source,
        target: file.target,
      })),
      argv: f.allocation.launch.argv,
      memoryBytes: 33554432,
      runtimeSeconds: 10,
    });
    const request = {
      threadId,
      kind: "prompt" as const,
      operationId: f.request.assignmentOperationId,
      prompt: f.request.assignment,
      resumeCursor: native,
    };
    const op = yield* f.operations.prepare(f.identity, request, hash(request), {
      allocation,
      workerId: "prompt-worker",
      operationId: request.operationId,
      resourceHash,
    });
    return { op, request, complete: complete(op, { ...native, leafId: "final-leaf" }) };
  });
  return { ...f, init, readers, initialize, prompt, complete, activate };
});
const denial = Effect.fn("receiptTest.denial")(function* <A, R>(
  effect: Effect.Effect<
    A,
    { readonly _tag: "ProjectTeamSessionReceiptError"; readonly code: string },
    R
  >,
  code?: string,
) {
  const result = yield* effect.pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure._tag).toBe("ProjectTeamSessionReceiptError");
    if (code) expect(result.failure.code).toBe(code);
  }
});

it.effect("returns absence only before original operation exists", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const readers = yield* makeProjectTeamSessionReceipts({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 2,
      });
      expect(yield* readers.readInitialization(f.snapshot)).toBeUndefined();
      expect(yield* readers.readAssignment(f.snapshot)).toBeUndefined();
    }),
  ),
);
it.effect("replays exact completed originals after reader recreation and revoked authority", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* producer;
      const terminal = yield* f.initialize;
      const init = yield* f.readers.readInitialization(f.snapshot);
      expect(init?.terminal).toEqual(terminal);
      const prompt = yield* f.prompt;
      const promptTerminal = yield* prompt.complete;
      const receipt = yield* f.readers.readAssignment(f.snapshot);
      expect(receipt?.terminal).toEqual(promptTerminal);
      expect(receipt?.operation.operationId).toBe(f.request.assignmentOperationId);
      expect(receipt?.native.leafId).toBe("final-leaf");
      // Later native state and authority do not replace the original immutable receipts.
      const current = yield* f.operations.current(f.identity);
      yield* restoreHistoricalBinding({
        ...current.binding,
        status: "revoked",
        revision: current.binding.revision + 1,
        sessionId: "later-projection",
      });
      yield* TestClock.setTime(time + 1000000);
      const recreated = yield* makeProjectTeamSessionReceipts({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 2,
      });
      expect(yield* recreated.readInitialization(f.snapshot)).toEqual(init);
      expect(yield* recreated.readAssignment(f.snapshot)).toEqual(receipt);
      expect((yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).length).toBe(2);
      expect((yield* f.sql`SELECT unit FROM project_team_pi_process`).length).toBe(2);
    }),
  ),
);
for (const status of ["prepared", "starting", "running", "quarantine"] as const)
  it.effect(`retains ${status} original as uncertainty without redispatch`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* producer;
        yield* f.sql`UPDATE project_team_pi_operation SET status=${status} WHERE operation_id=${f.init.operation.operationId}`;
        yield* denial(f.readers.readInitialization(f.snapshot), "uncertain");
      }),
    ),
  );
for (const outcome of ["failed", "canceled", "quarantine"] as const)
  it.effect(`retains ${outcome} terminal without success`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* producer;
        yield* f.complete(f.init, native, outcome);
        yield* denial(f.readers.readInitialization(f.snapshot), "uncertain");
      }),
    ),
  );
for (const mode of [
  "environment",
  "project",
  "binding",
  "generation",
  "provider",
  "thread",
  "kind",
  "hash",
  "request",
  "role",
  "resource",
  "allocation",
  "owner",
  "drain",
  "native",
  "terminal-worker",
  "terminal-operation",
  "unknown",
  "truncated",
  "missing-process",
  "duplicate-process",
  "oversized",
  "claim",
  "snapshot",
  "budget",
  "duplicate-operation",
  "displaced-operation",
] as const)
  it.effect(`rejects original evidence disagreement: ${mode}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* producer;
        yield* f.initialize;
        const id = f.init.operation.operationId;
        if (mode === "environment")
          yield* f.sql`UPDATE project_team_pi_operation SET environment_id='other' WHERE operation_id=${id}`;
        if (mode === "project")
          yield* f.sql`UPDATE project_team_pi_operation SET project_id='other' WHERE operation_id=${id}`;
        if (mode === "binding")
          yield* f.sql`UPDATE project_team_pi_operation SET binding_id='other' WHERE operation_id=${id}`;
        if (mode === "generation")
          yield* f.sql`UPDATE project_team_pi_operation SET generation=1 WHERE operation_id=${id}`;
        if (mode === "provider")
          yield* f.sql`UPDATE project_team_pi_operation SET provider_instance_id='other' WHERE operation_id=${id}`;
        if (mode === "thread")
          yield* f.sql`UPDATE project_team_pi_operation SET thread_id='other' WHERE operation_id=${id}`;
        if (mode === "kind")
          yield* f.sql`UPDATE project_team_pi_operation SET operation_kind='compact' WHERE operation_id=${id}`;
        if (mode === "hash")
          yield* f.sql`UPDATE project_team_pi_operation SET request_hash=${"b".repeat(64)} WHERE operation_id=${id}`;
        if (mode === "request")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.request.operationId','other') WHERE operation_id=${id}`;
        if (mode === "role")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.role.memoryAccess','shared') WHERE operation_id=${id}`;
        if (mode === "resource")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_remove(intent_json,'$.resourceHash') WHERE operation_id=${id}`;
        if (mode === "allocation")
          yield* f.sql`UPDATE project_team_pi_process SET allocation_json=json_set(allocation_json,'$.launch.workspace.ino',99) WHERE operation_id=${id}`;
        if (mode === "owner")
          yield* f.sql`UPDATE project_team_pi_process SET owner_json=json_set(owner_json,'$.pid',99) WHERE operation_id=${id}`;
        if (mode === "drain")
          yield* f.sql`UPDATE project_team_pi_process SET drain_json=json_set(drain_json,'$.kernel','populated 0\npopulated 1') WHERE operation_id=${id}`;
        if (mode === "native")
          yield* f.sql`UPDATE project_team_pi_operation SET native_json=json_set(native_json,'$.leafId','other') WHERE operation_id=${id}`;
        if (mode === "terminal-worker")
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=json_set(terminal_json,'$.identity.workerId','other') WHERE operation_id=${id}`;
        if (mode === "terminal-operation")
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=json_set(terminal_json,'$.operation.operationId','other') WHERE operation_id=${id}`;
        if (mode === "unknown")
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=json_set(terminal_json,'$.unknown',1) WHERE operation_id=${id}`;
        if (mode === "truncated")
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json='{' WHERE operation_id=${id}`;
        if (mode === "missing-process")
          yield* f.sql`DELETE FROM project_team_pi_process WHERE operation_id=${id}`;
        if (mode === "duplicate-process")
          yield* f.sql`INSERT INTO project_team_pi_process SELECT 'other',operation_id,allocation_json,status,owner_json,drain_json FROM project_team_pi_process WHERE operation_id=${id}`;
        if (mode === "oversized") {
          yield* f.sql`PRAGMA ignore_check_constraints=ON`;
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${" ".repeat(262145)} WHERE operation_id=${id}`;
        }
        if (mode === "claim")
          yield* f.sql`DELETE FROM project_work_command_receipts WHERE command_id=${projectTeamDerivedRecordId(f.snapshot.intent.compiledClaim.commandId, "claim-dispatch")}`;
        if (mode === "budget")
          yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=21000`;
        if (mode === "displaced-operation") {
          yield* f.sql`PRAGMA foreign_keys=OFF`;
          yield* f.sql`UPDATE project_team_pi_operation SET operation_id='displaced' WHERE operation_id=${id}`;
        }
        if (mode === "duplicate-operation") {
          yield* f.sql`ALTER TABLE project_team_pi_operation RENAME TO original_pi_operation`;
          yield* f.sql`CREATE TABLE project_team_pi_operation AS SELECT * FROM original_pi_operation`;
          yield* f.sql`INSERT INTO project_team_pi_operation SELECT * FROM original_pi_operation`;
        }
        const snapshot =
          mode === "snapshot"
            ? {
                ...f.snapshot,
                intent: {
                  ...f.snapshot.intent,
                  request: { ...f.snapshot.intent.request, initializeOperationId: "other" },
                },
              }
            : f.snapshot;
        yield* denial(f.readers.readInitialization(snapshot));
      }),
    ),
  );
for (const mode of [
  "bytes",
  "source",
  "session",
  "reference",
  "state",
  "missing-init",
  "running",
  "failed",
] as const)
  it.effect(`requires completed original assignment correlation: ${mode}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* producer;
        yield* f.initialize;
        const p = yield* f.prompt;
        if (mode === "failed")
          yield* f.complete(p.op, { ...native, leafId: "final-leaf" }, "failed");
        else if (mode !== "running") yield* p.complete;
        const id = p.op.operation.operationId;
        if (mode === "bytes") {
          const request = { ...p.request, prompt: p.request.prompt + " changed" };
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.request.prompt',${request.prompt}),request_hash=${hash(request)} WHERE operation_id=${id}`;
        }
        if (mode === "source")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.resourceHash',${"b".repeat(64)}) WHERE operation_id=${id}`;
        if (mode === "session" || mode === "reference") {
          const ref = {
            ...native,
            leafId: "final-leaf",
            ...(mode === "session"
              ? { sessionId: "other" }
              : { sessionReference: "sessions/other.jsonl" }),
          };
          yield* f.sql`UPDATE project_team_pi_operation SET native_json=${encodeJson(ref)},terminal_json=json_set(terminal_json,'$.native',json(${encodeJson(ref)})) WHERE operation_id=${id}`;
        }
        if (mode === "state") {
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.allocation.launch.nativeState.ino',99) WHERE operation_id=${id}`;
          yield* f.sql`UPDATE project_team_pi_process SET allocation_json=json_set(allocation_json,'$.launch.nativeState.ino',99) WHERE operation_id=${id}`;
        }
        if (mode === "missing-init") {
          yield* f.sql`DELETE FROM project_team_pi_process WHERE operation_id=${f.init.operation.operationId}`;
          yield* f.sql`DELETE FROM project_team_pi_operation WHERE operation_id=${f.init.operation.operationId}`;
        }
        yield* denial(f.readers.readAssignment(f.snapshot));
      }),
    ),
  );
it.effect("denies a foreign SQL client while permitting the captured transaction", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* producer;
      yield* f.initialize;
      expect(yield* f.sql.withTransaction(f.readers.readInitialization(f.snapshot))).toBeDefined();
      const foreign = yield* SqlClient.SqlClient.pipe(Effect.provide(SqlitePersistenceMemory));
      yield* denial(
        f.readers
          .readInitialization(f.snapshot)
          .pipe(Effect.provideService(SqlClient.SqlClient, foreign)),
        "denied",
      );
    }),
  ),
);

for (const mode of [
  "reported",
  "pending",
  "usage",
  "reservation",
  "settlement",
  "owner",
  "transport",
  "capacity",
] as const)
  it.effect(`verifies original accounting correlation: ${mode}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* producer;
        yield* f.initialize;
        const p = yield* f.prompt;
        yield* f.activate(p.op, { ...native, leafId: "final-leaf" });
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const fields = {
          workerId: p.op.workerId,
          operationId: p.op.operation.operationId,
          generation: 0,
          requestId: 1,
          routeId: "command-code-ling-free",
          provider: "command-code" as const,
          model,
          maxInputTokens: 1000,
          maxOutputTokens: 100,
          callCount: 1 as const,
          deadlineAtMs: p.op.deadlineAtMs,
        };
        const reservation = yield* accounting.reserve(p.op.principal, fields);
        const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
        const settlement = yield* accounting.settle({
          ...fields,
          reservationId: reservation.reservationId,
          outcome: "reported",
          transportDrained: true,
          chargedInputTokens: 10,
          chargedOutputTokens: 2,
          reportedModel: model,
          reportedUsage: usage,
        });
        const receipt = {
          requestId: 1,
          reservationId: reservation.reservationId,
          accountingReceiptId: settlement.accountingReceiptId,
          routeId: fields.routeId,
          provider: fields.provider,
          model,
          reportedModel: model,
          usage,
        };
        yield* f.complete(p.op, { ...native, leafId: "final-leaf" }, "success", [receipt]);
        if (mode === "transport")
          yield* f.sql`UPDATE project_team_model_request SET settlement_json=json_set(settlement_json,'$.transportDrained',0)`;
        if (mode === "capacity")
          yield* f.sql`UPDATE project_team_model_request SET capacity_state='quarantine'`;
        if (mode === "pending") yield* f.sql`UPDATE project_team_model_request SET status='held'`;
        if (mode === "usage")
          yield* f.sql`UPDATE project_team_model_request SET charged_input_tokens=11`;
        if (mode === "reservation")
          yield* f.sql`UPDATE project_team_model_request SET reservation_json=json_set(reservation_json,'$.operationId','other')`;
        if (mode === "settlement")
          yield* f.sql`UPDATE project_team_model_request SET settlement_json=json_set(settlement_json,'$.reportedUsage.total_tokens',99)`;
        if (mode === "owner") yield* f.sql`UPDATE project_team_model_request SET worker_id='other'`;
        if (mode === "reported")
          expect(
            (yield* f.readers.readAssignment(f.snapshot))?.terminal.accountingReceipts,
          ).toEqual([receipt]);
        else yield* denial(f.readers.readAssignment(f.snapshot));
      }),
    ),
  );

for (const mode of [
  "unmodified",
  "exact-cap",
  "released-reservations",
  "over-cap",
  "duplicate-receipt",
  "unsafe-charge",
] as const)
  it.effect(`verifies accounting across sequential released requests: ${mode}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* producer;
        yield* f.initialize;
        const p = yield* f.prompt;
        yield* f.activate(p.op, { ...native, leafId: "final-leaf" });
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const receipts: PiSessionTerminal["accountingReceipts"][number][] = [];
        for (const requestId of [1, 2]) {
          const fields = {
            workerId: p.op.workerId,
            operationId: p.op.operation.operationId,
            generation: p.op.authority.binding.generation,
            requestId,
            routeId: "command-code-ling-free",
            provider: "command-code" as const,
            model,
            maxInputTokens: 1000,
            maxOutputTokens: 100,
            callCount: 1 as const,
            deadlineAtMs: p.op.deadlineAtMs,
          };
          const reservation = yield* accounting.reserve(p.op.principal, fields);
          const usage =
            mode === "released-reservations"
              ? { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
              : { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
          const settlement = yield* accounting.settle({
            ...fields,
            reservationId: reservation.reservationId,
            outcome: "reported",
            transportDrained: true,
            chargedInputTokens: usage.prompt_tokens,
            chargedOutputTokens: usage.completion_tokens,
            reportedModel: model,
            reportedUsage: usage,
          });
          receipts.push({
            requestId,
            reservationId: reservation.reservationId,
            accountingReceiptId: settlement.accountingReceiptId,
            routeId: fields.routeId,
            provider: fields.provider,
            model,
            reportedModel: model,
            usage,
          });
        }
        yield* f.complete(p.op, { ...native, leafId: "final-leaf" }, "success", receipts);
        expect(new Set(receipts.map((r) => r.accountingReceiptId)).size).toBe(2);
        expect((yield* f.readers.readAssignment(f.snapshot))?.terminal.accountingReceipts).toEqual(
          receipts,
        );
        const id = p.op.operation.operationId;
        if (mode === "exact-cap" || mode === "over-cap" || mode === "released-reservations") {
          const maximumTokens = mode === "exact-cap" ? 2200 : 1100;
          yield* f.sql`UPDATE project_team_pi_operation SET maximum_tokens=${maximumTokens},intent_json=json_set(intent_json,'$.operationLimits.maximumTokens',${maximumTokens}) WHERE operation_id=${id}`;
        }
        if (mode === "duplicate-receipt") {
          const reused = receipts[0]!.accountingReceiptId;
          yield* f.sql`UPDATE project_team_model_request SET accounting_receipt_id=${reused} WHERE operation_id=${id} AND request_id=2`;
          receipts[1] = { ...receipts[1]!, accountingReceiptId: reused };
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=json_set(terminal_json,'$.accountingReceipts',json(${encodeJson(receipts)})) WHERE operation_id=${id}`;
        }
        // Corrupt SQL at the safe-integer boundary; no actual producer can report this charge.
        if (mode === "unsafe-charge")
          yield* f.sql`UPDATE project_team_model_request SET charged_input_tokens=${Number.MAX_SAFE_INTEGER + 1} WHERE operation_id=${id} AND request_id=2`;
        if (mode === "over-cap" || mode === "duplicate-receipt" || mode === "unsafe-charge")
          yield* denial(f.readers.readAssignment(f.snapshot));
        else
          expect(
            (yield* f.readers.readAssignment(f.snapshot))?.terminal.accountingReceipts,
          ).toEqual(receipts);
      }),
    ),
  );
