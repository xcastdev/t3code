import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamEffect,
  ProjectTeamMemoryProcessIntent,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  restoreHistoricalBinding,
  providerInstanceId,
  threadId,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { preallocatePiManagedProcess } from "../provider/pi/PiManagedProcess.ts";
import { makeProjectTeamPiOperations } from "./ProjectTeamPiOperations.ts";
import * as Accounting from "./ProjectTeamModelAccounting.ts";
import {
  ProjectMemoryJobOwner,
  makeProjectMemoryModelAccounting,
} from "./memory/ProjectMemoryModelAccounting.ts";
import { projectMemoryHash } from "./memory/ProjectMemoryService.ts";
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

const decodeMemoryIntent = Schema.decodeUnknownEffect(ProjectTeamMemoryProcessIntent);

const decodeEffect = Schema.decodeUnknownEffect(ProjectTeamEffect);

const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);

const decodeMemoryOwner = Schema.decodeUnknownEffect(ProjectMemoryJobOwner);

const mixedUsageFixture = (piOutcome: "reported" | "unknown" | "overshoot" = "reported") =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at) + 1);
    const f = yield* seed("investigator", "reserved", {
      nativeSessionId: null,
      roleTools: [],
      toolIds: [],
      issueCredential: false,
    });
    const fs = yield* FileSystem.FileSystem;
    const worktree = yield* fs.makeTempDirectoryScoped();
    const role = { ...f.role, model: "gpt-6-luna", memoryAccess: "project" as const };
    yield* restoreHistoricalBinding(role);
    const binding = {
      ...f.binding,
      worktree,
      model: "gpt-6-luna",
      configuration: {
        ...f.binding.configuration,
        instructionsHash: NodeCrypto.createHash("sha256").update(role.instructions).digest("hex"),
        maxTokens: 64_000,
        maxDurationMs: 300_000,
      },
    };
    yield* restoreHistoricalBinding(binding);
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
    // Retain an authenticated admission at the repository seam, then use the real
    // memory accounting producer for every reservation and settlement.
    const repository = yield* ProjectWorkRepository;
    const current = yield* readCurrentState(f.sql, projectId);
    const selection = {
      kind: "comment" as const,
      retainedId: "comment",
      retainedRevision: 0,
      sourceRecordId: "source",
      expectedSourceRecordRevision: 0,
      sourceRevision: 0,
      sourceGeneration: 0,
      contentHash: "a".repeat(64),
      effectId: "memory-effect",
      expectedEffectRevision: 0,
      expectedClaimGeneration: 0,
    };
    const intent = yield* decodeMemoryIntent({
      type: "project-team.memory.process",
      commandId: "memory-admission",
      projectId,
      taskId: binding.taskId,
      expectedRevision: current.revision,
      expectedTaskRevision: current.tasks[0]!.revision,
      specRevision: binding.specRevision,
      planRevision: binding.planRevision,
      selection,
    });
    const admittedEffect = yield* decodeEffect({
      kind: "effect",
      recordId: "memory-effect",
      effectId: "memory-effect",
      projectId,
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "pending",
      effectKind: "memory-index",
      taskId: binding.taskId,
      runId: binding.recordId,
      targetId: "source",
      payload: { recordIds: [], expectedRevision: current.revision },
      claimGeneration: 0,
      availableAt: at,
    });
    const attribution = {
      actor: op.principal.actor,
      source: { kind: "mcp" as const, id: op.workerId },
      recordedAt: at,
    };
    const fingerprint =
      "project-team-intent:" +
      projectMemoryHash({
        intent,
        actor: attribution.actor,
        source: attribution.source,
        managed: op.principal.managed,
      });
    const command = yield* decodeCommit({
      type: "project-work.foundation.commit",
      commandId: intent.commandId,
      projectId,
      expectedRevision: current.revision,
      attribution,
      committedAt: at,
      records: [admittedEffect],
    });
    yield* repository.executeAuthorized(
      command,
      () => Effect.succeed(command),
      undefined,
      fingerprint,
    );
    const rows = yield* f.sql<{
      request: string;
    }>`SELECT request_hash AS request FROM project_team_pi_operation WHERE operation_id=${op.operation.operationId}`;
    const owner = yield* decodeMemoryOwner({
      version: 1,
      operation: {
        version: 1,
        environmentId: "environment",
        projectId,
        taskId: binding.taskId,
        bindingId: binding.recordId,
        generation: 0,
        providerInstanceId,
        threadId,
        operationId: op.operation.operationId,
        workerId: op.workerId,
        ordinal: op.ordinal,
        attemptId: binding.attemptId,
        rootBindingId: binding.recordId,
        rootTaskId: binding.taskId,
        rootMaximumTokens: 64_000,
        rootDeadlineAtMs: op.deadlineAtMs,
        attemptMaximumTokens: 64_000,
        attemptDeadlineAtMs: op.deadlineAtMs,
        operationMaximumTokens: op.maximumTokens,
        operationDeadlineAtMs: op.deadlineAtMs,
        leaseDeadlineAtMs: op.deadlineAtMs,
        roleSha256: projectMemoryHash(op.authority.role),
        configurationSha256: projectMemoryHash(op.authority.binding.configuration),
        requestSha256: rows[0]!.request,
        allocation: op.allocation,
      },
      selection,
      request: intent,
      admittedEffect,
      commandId: intent.commandId,
      intentFingerprint: fingerprint,
      actorId: op.principal.actor.id,
      sourceKind: "mcp",
      sourceId: op.workerId,
      admittedAt: at,
    });
    yield* f.sql`INSERT INTO project_team_memory_job
    (effect_id,environment_id,project_id,input_json,status,owner_json)
    VALUES ('memory-effect','environment',${projectId},'{}','pending',${canonicalProjectWorkPayload(owner)})`;
    const memory = yield* makeProjectMemoryModelAccounting({
      environmentId: "environment",
      maximumConcurrentCalls: 4,
      maximumConcurrentModelCalls: 4,
      assertCurrentInTransaction: () => Effect.void,
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
