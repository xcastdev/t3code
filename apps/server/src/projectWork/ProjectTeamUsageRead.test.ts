import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  ProjectWorkComment,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamMemoryProcessIntent,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  attribution,
  providerInstanceId,
  threadId,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamAuthorization } from "./ProjectTeamAuthorization.ts";
import * as ContentGuard from "./ProjectWorkContentGuard.ts";
import { makeProjectMemoryProcessing } from "./memory/ProjectMemoryProcessing.ts";
import { ProjectMemoryPorts } from "./memory/ProjectMemoryPorts.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { preallocatePiManagedProcess } from "../provider/pi/PiManagedProcess.ts";
import { makeProjectTeamPiOperations } from "./ProjectTeamPiOperations.ts";
import * as Accounting from "./ProjectTeamModelAccounting.ts";
import {
  ProjectMemoryJobOwner,
  ProjectMemoryOperation,
  makeProjectMemoryModelAccounting,
} from "./memory/ProjectMemoryModelAccounting.ts";
import {
  makeProjectMemoryService,
  ProjectMemoryServiceError,
  projectMemoryHash,
} from "./memory/ProjectMemoryService.ts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { at, projectId, scoped, seed } from "./ProjectTeamAuthorization.testFixtures.ts";
import { readProjectTeamBindingAccountingInTransaction } from "./ProjectTeamUsageRead.ts";

it.effect(
  "distinguishes a budget-only orphan from an unadmitted assignment and rejects a foreign host",
  () =>
    scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at) + 1);
        const f = yield* seed("implementer", "reserved", { issueCredential: false });
        const read = (environmentId: string) =>
          f.sql
            .withTransaction(
              readProjectTeamBindingAccountingInTransaction(f.sql, projectId, [f.binding]),
            )
            .pipe(
              Effect.provideService(ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentId)),
              }),
            );
        expect(yield* f.sql`SELECT 1 FROM project_team_dispatch`).toEqual([]);
        expect(yield* f.sql`SELECT 1 FROM project_team_pi_operation`).toEqual([]);
        const binding = yield* f.sql`SELECT * FROM project_team_run_binding`;
        expect(yield* read("environment")).toMatchObject([
          {
            availability: "not-admitted",
            bindingId: f.binding.recordId,
          },
        ]);
        expect(yield* read("foreign-environment")).toMatchObject([
          {
            availability: "unavailable",
            reason: "owner-invalid",
          },
        ]);
        yield* f.sql`INSERT INTO project_team_model_budget
      VALUES ('environment',${projectId},${f.binding.taskId},1000,${Date.parse(at) + 10000})`;
        const budget = yield* f.sql`SELECT * FROM project_team_model_budget`;
        expect(yield* read("environment")).toMatchObject([
          {
            availability: "unavailable",
            reason: "budget-invalid",
            bindingId: f.binding.recordId,
          },
        ]);
        expect(yield* f.sql`SELECT * FROM project_team_run_binding`).toEqual(binding);
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(budget);
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
      }),
    ),
);

const decodeComment = Schema.decodeUnknownEffect(ProjectWorkComment);

const decodeMemoryIntent = Schema.decodeUnknownEffect(ProjectTeamMemoryProcessIntent);

const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);

const decodeMemoryOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemoryJobOwner));

const mixedUsageFixture = (piOutcome: "reported" | "unknown" | "overshoot" = "reported") =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at) + 1);
    const repository = yield* ProjectWorkRepository;
    const sql = yield* SqlClient.SqlClient;
    const f = { sql };
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    yield* seed("investigator", "reserved", {
      nativeSessionId: null,
      roleTools: ["project-work.write"],
      toolIds: ["project-work.write"],
      issueCredential: false,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (command) => {
          if (command.type === "project-work.foundation.commit" && command.commandId === "setup")
            return repository.execute({
              ...command,
              records: command.records.map((record) =>
                record.kind === "role-revision"
                  ? { ...record, model: "gpt-6-luna", memoryAccess: "project" }
                  : record,
              ),
            });
          if (
            command.type === "project-work.foundation.commit" &&
            command.transition?.kind === "claim"
          ) {
            pending = command;
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Retain claim for dispatch admission"),
            );
          }
          return repository.execute(command);
        },
      }),
      Effect.result,
    );
    if (!pending || pending.transition?.kind !== "claim")
      return yield* Effect.die("Missing original usage claim");
    const fs = yield* FileSystem.FileSystem;
    const worktree = yield* fs.makeTempDirectoryScoped();
    yield* repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "usage-limits",
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
            model: "gpt-6-luna",
            tokenLimit: 64_000,
            durationLimitMs: 300_000,
            environmentModelCalls: 4,
            modelCalls: 4,
            projectWritableWorkers: 1,
            delegationDepth: 2,
            repairAllowance: 2,
          },
        ],
      }),
    );
    const claimBinding = {
      ...pending.transition.binding,
      worktree,
      branch: "refs/heads/assigned",
      model: "gpt-6-luna",
      configuration: {
        ...pending.transition.binding.configuration,
        instructionsHash: NodeCrypto.createHash("sha256").update("Task").digest("hex"),
        maxTokens: 64_000,
        maxDurationMs: 300_000,
      },
    };
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const reserved = yield* journal.reserve({
      dispatchId: "usage-dispatch",
      claim: {
        ...pending,
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        transition: { ...pending.transition, binding: claimBinding },
      },
      git: {
        effectId: "usage-dispatch",
        runId: claimBinding.recordId,
        generation: 0,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: worktree,
        branchRef: claimBinding.branch,
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: "owner",
        policyHash: "b".repeat(64),
      },
      setupId: "usage-setup",
      initializeOperationId: "initialize",
      assignmentOperationId: "prompt",
      assignment: "Read retained memory for the approved task",
    });
    const snapshot = yield* journal.claimEffect(reserved.fence);
    const claim = snapshot.intent.compiledClaim.transition;
    if (claim?.kind !== "claim") return yield* Effect.die("Missing admitted usage claim");
    const binding = claim.binding;
    const allocation = yield* preallocatePiManagedProcess({
      workspaceRoot: worktree,
      workspaceAccess: "readonly",
      nativeStateRoot: yield* fs.makeTempDirectoryScoped(),
      protectedRoots: [yield* fs.makeTempDirectoryScoped()],
      runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
      argv: ["/bin/true"],
      memoryBytes: 33_554_432,
      runtimeSeconds: 10,
    });
    const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
    const identity = { providerInstanceId, threadId };
    const auth = yield* ProjectTeamAuthorization;
    const native = {
      sessionId: "usage-native",
      sessionReference: "sessions/usage-native.jsonl",
      leafId: "leaf",
      persisted: true,
    };
    const prepare = (
      id: string,
      request:
        | { threadId: typeof threadId; kind: "initialize" }
        | { threadId: typeof threadId; kind: "prompt"; prompt: string },
    ) =>
      Effect.gen(function* () {
        const nonce = NodeCrypto.randomUUID();
        const op = yield* operations.prepare(identity, request, projectMemoryHash(request), {
          allocation: { ...allocation, nonce, unit: `t3-pi-managed-${nonce}.service` },
          workerId: id,
          operationId: id,
        });
        const owner = {
          type: "owner" as const,
          unit: op.allocation.unit,
          nonce: op.allocation.nonce,
          invocation: "a".repeat(32),
          cgroup: `/sys/fs/cgroup/${op.allocation.unit}`,
          pid: 123,
          memoryBytes: op.allocation.policy.memoryBytes,
          swapBytes: 0 as const,
          oomGroup: 1 as const,
        };
        yield* operations.persistence(op).claimActivation(op.allocation);
        yield* operations.persistence(op).beforeStart(owner);
        yield* operations.persistNative(op, native);
        return { op, owner };
      });
    const initialized = yield* prepare("initialize", { threadId, kind: "initialize" });
    yield* operations.persistTerminal(initialized.op, {
      identity: { workerId: initialized.op.workerId, generation: 0 },
      operation: initialized.op.operation,
      outcome: "success",
      ownerCaptured: true,
      native,
      accountingReceipts: [],
      drain: {
        unit: initialized.owner.unit,
        invocation: initialized.owner.invocation,
        cgroup: initialized.owner.cgroup,
        ownerPid: 123,
        memoryBytes: initialized.owner.memoryBytes,
        swapBytes: 0,
        oomGroup: 1,
        launcherPid: 124,
        childPid: 125,
        childExitCode: 0,
        kernel: "removed",
      },
    });
    const { op } = yield* prepare("prompt", { threadId, kind: "prompt", prompt: "Read memory" });
    const accounting = yield* Accounting.make({
      environmentId: "environment",
      maximumConcurrentCalls: 4,
      maximumConcurrentModelCalls: 4,
      routeId: "openai-subscription-luna",
      model: "gpt-6-luna",
      acceptedReportedModels: ["gpt-6-luna"],
      resolveOperation: operations.resolveOperation,
      subscriptionTest: {
        projectId,
        rootTaskId: binding.taskId,
        model: "gpt-6-luna",
        maximumTokens: 64_000,
        maximumDurationMs: 300_000,
      },
    });
    const piRequest = (requestId: number, maximum = 1000) => ({
      workerId: op.workerId,
      generation: 0,
      operationId: op.operation.operationId,
      requestId,
      routeId: "openai-subscription-luna",
      provider: "openai-codex" as const,
      model: "gpt-6-luna",
      maxInputTokens: maximum - 100,
      maxOutputTokens: 100,
      callCount: 1 as const,
      deadlineAtMs: op.deadlineAtMs,
      accountingMode: "openai-subscription-monitored" as const,
      unknownMaximumTokens: 64_000 as const,
    });
    const request = piRequest(1);
    const reservation = yield* accounting.reserve(op.principal, request);
    const guard = yield* ContentGuard.ProjectWorkContentGuard.pipe(
      Effect.provide(ContentGuard.layer),
    );
    yield* repository.execute({
      type: "project-work.comment.add",
      projectId,
      commandId: CommandId.make("usage-comment"),
      comment: yield* decodeComment({
        commentId: "usage-comment",
        projectId,
        taskId: binding.taskId,
        body: "Retain exact original usage and memory ownership.",
        revision: 0,
        createdAt: at,
        attribution,
      }),
      addedAt: at,
      attribution,
    });
    const service = makeProjectMemoryService({
      sql,
      repository,
      authorization: auth,
      contentGuard: guard,
      environmentId: "environment",
    });
    yield* service.captureRetained(projectId, { kind: "comment", retainedId: "usage-comment" });
    const processing = yield* makeProjectMemoryProcessing;
    const authority = yield* auth.resolve(op.principal);
    if (!authority) return yield* Effect.die("Missing executing memory authority");
    const page = yield* sql.withTransaction(
      processing.readSourcesInTransaction(
        {
          operation: "memory-sources",
          projectId,
          taskId: binding.taskId,
        },
        authority,
      ),
    );
    const selection = page.items.find(
      (item) => item.selection.retainedId === "usage-comment",
    )?.selection;
    if (!selection) return yield* Effect.die("Missing captured memory selection");
    const intent = yield* decodeMemoryIntent({
      type: "project-team.memory.process",
      commandId: "memory-admission",
      projectId,
      taskId: binding.taskId,
      expectedRevision: authority.state.revision,
      expectedTaskRevision: authority.state.tasks.find((task) => task.taskId === binding.taskId)!
        .revision,
      specRevision: binding.specRevision,
      planRevision: binding.planRevision,
      selection,
    });
    const memoryIdentity = {
      environmentId: "environment",
      projectId,
      taskId: binding.taskId,
      bindingId: binding.recordId,
      generation: binding.generation,
      providerInstanceId,
      threadId,
      operationId: op.operation.operationId,
      workerId: op.workerId,
      ordinal: op.ordinal,
    };
    const readMemoryOwner = operations
      .readMemoryOperationOwnerInTransaction(memoryIdentity, op.principal)
      .pipe(
        Effect.mapError(
          (error) => new ProjectMemoryServiceError({ reason: error.detail ?? error.code }),
        ),
      );
    const memoryAttribution = {
      actor: op.principal.actor,
      source: { kind: "mcp" as const, id: op.workerId },
      recordedAt: at,
    };
    const fingerprint =
      "project-team-intent:" +
      projectMemoryHash({
        intent,
        actor: memoryAttribution.actor,
        source: memoryAttribution.source,
        managed: op.principal.managed,
      });
    const command = yield* decodeCommit({
      type: "project-work.foundation.commit",
      commandId: intent.commandId,
      projectId,
      expectedRevision: intent.expectedRevision,
      attribution: memoryAttribution,
      committedAt: at,
      records: [
        authority.state.foundationRecords!.find(
          (record) => record.kind === "effect" && record.effectId === selection.effectId,
        )!,
      ],
    });
    yield* repository
      .executeAuthorized(
        command,
        () =>
          processing.compileInTransaction(
            intent,
            op.principal,
            memoryAttribution,
            auth.resolve,
            false,
          ),
        undefined,
        fingerprint,
      )
      .pipe(
        Effect.provideService(ProjectMemoryOperation, {
          identity: memoryIdentity,
          assertForward: sql.withTransaction(readMemoryOwner).pipe(
            Effect.asVoid,
            Effect.mapError((error) =>
              error._tag === "ProjectMemoryServiceError"
                ? error
                : new ProjectMemoryServiceError({ reason: String(error) }),
            ),
          ),
          readCurrentInTransaction: () => readMemoryOwner,
        }),
        Effect.provideService(ProjectMemoryPorts, { assertConfigured: () => Effect.void }),
      );
    const savedOwners = yield* sql<{
      owner: string;
    }>`SELECT owner_json AS owner FROM project_team_memory_job WHERE effect_id=${selection.effectId}`;
    const owner = yield* decodeMemoryOwner(savedOwners[0]!.owner);
    const memory = yield* makeProjectMemoryModelAccounting({
      environmentId: "environment",
      maximumConcurrentCalls: 4,
      maximumConcurrentModelCalls: 4,
      assertCurrentInTransaction: () => readMemoryOwner.pipe(Effect.asVoid),
      assertTransportDrainedInTransaction: () => Effect.void,
    });
    const reserveMemory = (requestId: number, maximum: number) =>
      memory.reserve(owner, {
        phase: "extract",
        routeId: "memory-command-code",
        requestId,
        maxInputTokens: maximum - 10,
        maxOutputTokens: 10,
        deadlineAtMs: op.deadlineAtMs,
      });
    const reported = yield* reserveMemory(1, 100);
    yield* memory.settle({
      ...reported.reservation,
      reservationId: reported.reservationId,
      outcome: "reported",
      chargedInputTokens: 30,
      chargedOutputTokens: 10,
      transportDrained: true,
      reportedModel: reported.reservation.model,
      reportedInputTokens: 30,
      reportedOutputTokens: 10,
    });
    const unknown = yield* reserveMemory(2, 200);
    yield* memory.settle({
      ...unknown.reservation,
      reservationId: unknown.reservationId,
      outcome: "unknown",
      chargedInputTokens: 190,
      chargedOutputTokens: 10,
      transportDrained: false,
    });
    yield* reserveMemory(3, 300);
    yield* accounting.settle({
      ...request,
      reservationId: reservation.reservationId,
      outcome: piOutcome === "unknown" ? "unknown" : "reported",
      transportDrained: piOutcome !== "unknown",
      chargedInputTokens: piOutcome === "reported" ? 300 : 900,
      chargedOutputTokens: piOutcome === "reported" ? 60 : 64_000,
      ...(piOutcome === "unknown"
        ? {}
        : {
            reportedModel: "gpt-6-luna",
            reportedUsage:
              piOutcome === "reported"
                ? { prompt_tokens: 300, completion_tokens: 60, total_tokens: 360 }
                : { prompt_tokens: 900, completion_tokens: 64_000, total_tokens: 64_900 },
          }),
    });

    const read = () =>
      f.sql
        .withTransaction(readProjectTeamBindingAccountingInTransaction(f.sql, projectId, [binding]))
        .pipe(
          Effect.provideService(ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
          }),
        );
    return { ...f, binding, op, accounting, piRequest, read };
  });

it.effect(
  "reads monitored Pi and hard memory charges without spending nominal threshold headroom",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* mixedUsageFixture();
        const writes = yield* f.sql`SELECT total_changes() AS writes`;
        expect(yield* f.read()).toMatchObject([
          {
            availability: "available",
            root: {
              maximumTokens: 64_000,
              chargedTokens: 600,
              reservedTokens: 300,
              unknownChargedTokens: 200,
              remainingTokens: 63_400,
              policy: { observedChargedTokens: 600, nominalHeldTokens: 300 },
            },
          },
        ]);
        expect(yield* f.sql`SELECT total_changes() AS writes`).toEqual(writes);
        yield* f.accounting.reserve(f.op.principal, f.piRequest(2));
        expect(yield* f.read()).toMatchObject([
          {
            availability: "available",
            root: {
              chargedTokens: 600,
              reservedTokens: 1300,
              remainingTokens: 63_400,
              policy: { observedChargedTokens: 600, nominalHeldTokens: 1300 },
            },
          },
        ]);
      }),
    ),
);

for (const corruption of [
  "missing grant",
  "foreign grant",
  "changed grant",
  "monitored memory",
  "hard Pi",
  "owner proof",
  "settlement proof",
  "unknown stop",
] as const)
  it.effect(`rejects mixed history with ${corruption}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* mixedUsageFixture();
        expect(yield* f.read()).toMatchObject([{ availability: "available" }]);
        switch (corruption) {
          case "missing grant":
            yield* f.sql`DROP TRIGGER project_team_pi_subscription_grant_no_delete`;
            yield* f.sql`DELETE FROM project_team_pi_subscription_grant`;
            break;
          case "foreign grant":
            yield* f.sql`DROP TRIGGER project_team_pi_subscription_grant_immutable`;
            yield* f.sql`UPDATE project_team_pi_subscription_grant SET environment_id='foreign'`;
            break;
          case "changed grant":
            yield* f.sql`DROP TRIGGER project_team_pi_subscription_grant_immutable`;
            yield* f.sql`UPDATE project_team_pi_subscription_grant SET deadline_at_ms=deadline_at_ms+1`;
            break;
          case "monitored memory":
            yield* f.sql`DROP TRIGGER project_team_model_accounting_mode_immutable`;
            yield* f.sql`PRAGMA ignore_check_constraints=ON`;
            yield* f.sql`UPDATE project_team_model_request SET accounting_mode='openai-subscription-monitored',unknown_maximum_tokens=64000 WHERE request_lane='memory'`;
            yield* f.sql`PRAGMA ignore_check_constraints=OFF`;
            break;
          case "hard Pi":
            // Forge both physical and JSON route/mode together; the original
            // operation still grants only the subscription Pi route.
            yield* f.sql`DROP TRIGGER project_team_model_accounting_mode_immutable`;
            yield* f.sql`UPDATE project_team_model_request SET accounting_mode='hard',unknown_maximum_tokens=NULL,
            provider='command-code',model='inclusionai/ling-3.1-flash:free',route_id='command-code-ling-free',
            reservation_json=json_remove(json_set(reservation_json,'$.provider','command-code','$.model','inclusionai/ling-3.1-flash:free','$.routeId','command-code-ling-free'),'$.accountingMode','$.unknownMaximumTokens'),
            settlement_json=json_remove(json_set(settlement_json,'$.provider','command-code','$.model','inclusionai/ling-3.1-flash:free','$.reportedModel','inclusionai/ling-3.1-flash:free','$.routeId','command-code-ling-free'),'$.accountingMode','$.unknownMaximumTokens')
            WHERE request_lane='pi'`;
            break;
          case "owner proof":
            yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.rootBudget.maximumTokens',63999) WHERE operation_id='prompt'`;
            break;
          case "settlement proof":
            yield* f.sql`UPDATE project_team_model_request SET settlement_json=json_set(settlement_json,'$.chargedInputTokens',29) WHERE request_lane='memory' AND status='reported'`;
            break;
          case "unknown stop":
            yield* f.sql`UPDATE project_team_pi_subscription_grant SET stopped_at_ms=${Date.parse(at) + 1},stop_reason='unknown-usage'`;
            break;
        }
        const writes = yield* f.sql`SELECT total_changes() AS writes`;
        expect(yield* f.read()).toMatchObject([{ availability: "unavailable" }]);
        expect(yield* f.sql`SELECT total_changes() AS writes`).toEqual(writes);
      }),
    ),
  );

for (const outcome of ["unknown", "overshoot"] as const)
  it.effect(`retains full monitored ${outcome} charges alongside hard memory`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* mixedUsageFixture(outcome);
        const writes = yield* f.sql`SELECT total_changes() AS writes`;
        expect(yield* f.read()).toMatchObject([
          {
            availability: "available",
            root: {
              maximumTokens: 64_000,
              chargedTokens: 65_140,
              reservedTokens: 300,
              unknownChargedTokens: outcome === "unknown" ? 65_100 : 200,
              remainingTokens: 0,
              quarantinedCalls: outcome === "unknown" ? 2 : 1,
              policy: {
                observedChargedTokens: 65_140,
                nominalHeldTokens: 300,
                stoppedReason: outcome === "unknown" ? "unknown-usage" : "threshold-reached",
              },
            },
          },
        ]);
        expect(yield* f.sql`SELECT total_changes() AS writes`).toEqual(writes);
      }),
    ),
  );

it.effect("rejects cumulative hard memory overdraw under a monitored root", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* mixedUsageFixture();
      // Each reservation remains within its original 64k operation ceiling.
      // Their hard total exceeds it, despite the root's monitored Pi policy.
      yield* f.sql`UPDATE project_team_model_request SET maximum_input_tokens=63990,
      reservation_json=json_set(reservation_json,'$.maxInputTokens',63990)
      WHERE request_lane='memory' AND status='held'`;
      expect(yield* f.read()).toMatchObject([
        { availability: "unavailable", reason: "limit-exceeded" },
      ]);
    }),
  ),
);
