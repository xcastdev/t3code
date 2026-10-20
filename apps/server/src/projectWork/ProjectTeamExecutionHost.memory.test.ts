import { expect, it } from "@effect/vitest";
import { vi, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import { ProjectId, ProjectWorkTaskId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { makeProjectTeamExecutionHost } from "./ProjectTeamExecutionHost.ts";
import { scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectMemoryPorts } from "./memory/ProjectMemoryPorts.ts";
import { ProjectMemoryServiceError } from "./memory/ProjectMemoryService.ts";
import type { ProjectMemoryOperationIdentity } from "./memory/ProjectMemoryModelAccounting.ts";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ManagedProcess from "../provider/pi/PiManagedProcess.ts";

const controlled = vi.hoisted(() => ({
  events: [] as string[],
  physical: "joined" as "joined" | "owned" | "mismatch",
  setup: true,
}));

// Keep the actual Host and recovery supervisor. These boundaries stand in for physical
// ownership and its retained journal; no process, Git writer or model transport is started.
vi.mock("./ProjectTeamDispatchJournal.ts", async (original) => {
  const actual = await original<typeof import("./ProjectTeamDispatchJournal.ts")>();
  const Effect = await import("effect/Effect");
  const Exit = await import("effect/Exit");
  const binding = {
    projectId: "memory-project",
    taskId: "memory-task",
    recordId: "memory-binding",
    generation: 3,
    providerInstanceId: "pi",
    threadId: "memory-thread",
    worktree: "/workspace",
  };
  const snapshot = {
    fence: { dispatchId: "memory-dispatch", stage: "quarantine", revision: 4, claimGeneration: 2 },
    intent: {
      compiledClaim: { transition: { kind: "claim", binding } },
      request: { setupId: "memory-setup" },
      limits: { deadlineAtMs: 1 },
    },
  };
  return {
    ...actual,
    makeProjectTeamDispatchJournal: () =>
      Effect.succeed({
        readRetained: () => Effect.succeed(snapshot),
        readRecoveryCandidates: () =>
          Effect.succeed([{ dispatchId: "memory-dispatch", snapshot: Exit.succeed(snapshot) }]),
        inspect: () =>
          Effect.fail(
            new actual.ProjectTeamDispatchJournalError({ reason: "Expired original authority" }),
          ),
        settleAfterJoined: () =>
          Effect.sync(() => {
            controlled.events.push("settle");
            return snapshot;
          }),
      }),
  };
});
vi.mock("../project/ProjectManagedSetupJournal.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    makeProjectManagedSetupJournal: () =>
      Effect.succeed({
        readOwnership: () => Effect.sync(() => (controlled.setup ? { retained: {} } : null)),
      }),
  };
});
vi.mock("./ProjectTeamWorkspace.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    makeProjectTeamWorkspace: () =>
      Effect.succeed({
        reconcile: () =>
          Effect.sync(() => {
            controlled.events.push("setup-joined");
            return {};
          }),
      }),
  };
});
vi.mock("./ProjectTeamReviewCurrentTarget.ts", async (original) => {
  const actual = await original<typeof import("./ProjectTeamReviewCurrentTarget.ts")>();
  const Effect = await import("effect/Effect");
  return {
    ...actual,
    makeProjectTeamReviewCurrentTarget: () =>
      Effect.succeed({
        withOriginalTarget: (
          _snapshot: unknown,
          _joined: unknown,
          effect: Effect.Effect<unknown>,
        ) => effect,
      }),
  };
});
vi.mock("./ProjectTaskResources.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    makeProjectTaskResources: () =>
      Effect.succeed({
        pi: () => ({
          cleanupDrain: () =>
            Effect.sync(() => {
              controlled.events.push("process-joined");
            }),
        }),
      }),
  };
});

afterEach(() => vi.restoreAllMocks());
const identity = (operationId: string, ordinal: number): ProjectMemoryOperationIdentity => ({
  environmentId: "environment",
  projectId: ProjectId.make("memory-project"),
  taskId: ProjectWorkTaskId.make("memory-task"),
  bindingId: "memory-binding",
  generation: 3,
  providerInstanceId: ProviderInstanceId.make("pi"),
  threadId: ThreadId.make("memory-thread"),
  operationId,
  workerId: `${operationId}-worker`,
  ordinal,
});

const fixture = Effect.fn("memoryHostTest.fixture")(function* () {
  controlled.events = [];
  controlled.physical = "joined";
  controlled.setup = true;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped();
  const nativeStateRoot = yield* fs.makeTempDirectoryScoped();
  const protectedRoot = yield* fs.makeTempDirectoryScoped();
  const allocation = yield* ManagedProcess.preallocatePiManagedProcess({
    workspaceRoot,
    workspaceAccess: "readonly",
    nativeStateRoot,
    protectedRoots: [protectedRoot],
    runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
    argv: ["/bin/true"],
    memoryBytes: 33554432,
    runtimeSeconds: 10,
  });
  const rows = ["initialize", "prompt", "compact", "prompt"].map((kind, ordinal) => ({
    operation_id: `operation-${ordinal}`,
    operation_kind: kind,
    status: "running",
    environment_id: "environment",
    project_id: "memory-project",
    binding_id: "memory-binding",
    generation: 3,
    provider_instance_id: "pi",
    thread_id: "memory-thread",
    worker_id: `operation-${ordinal}-worker`,
    operation_ordinal: ordinal,
  }));
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
  const observingSql = new Proxy(sql, {
    apply(target, _receiver, args) {
      const statement = target(args[0], ...args.slice(1));
      const query = statement.compile()[0];
      if (query.includes("SELECT operation_id,status,operation_kind")) return Effect.succeed(rows);
      if (query.includes("SELECT allocation_json,owner_json,status"))
        return Effect.succeed([
          {
            allocation_json: JSON.stringify(allocation),
            owner_json: JSON.stringify(owner),
            status: "owned",
          },
        ]);
      return statement;
    },
  });
  vi.spyOn(ManagedProcess, "reconcilePiManagedProcess").mockImplementation(() =>
    Effect.gen(function* () {
      controlled.events.push("reconcile");
      if (controlled.physical === "mismatch")
        return yield* Effect.fail(
          new ManagedProcess.PiManagedProcessError({
            phase: "quarantine",
            message: "Owner mismatch",
          }),
        );
      return {
        state: controlled.physical === "owned" ? ("owned" as const) : ("drained" as const),
        unit: allocation.unit,
        invocation: owner.invocation,
        cgroup: owner.cgroup,
        kernel: "removed",
      };
    }),
  );
  const services = Layer.mergeAll(
    Layer.mock(ProviderService)({}),
    Layer.mock(ServerSettingsService)({}),
    Layer.mock(OrchestrationEngineService)({}),
    Layer.mock(ProjectionSnapshotQuery)({}),
    Layer.mock(GitWorkflowService)({}),
    Layer.effect(ProjectTeamPiRuntime, makeProjectTeamPiRuntime()),
    Layer.mock(ChildProcessSpawner)({}),
    Layer.succeed(HostProcessPlatform, "linux"),
    Layer.succeed(HostProcessUserId, 1000),
  );
  const repository = yield* ProjectWorkRepository;
  const construct = makeProjectTeamExecutionHost({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    protectedRoots: ["/protected"],
    launchPolicy: { memoryBytes: 33554432, runtimeSeconds: 10 },
    assertEnabled: Effect.void,
  }).pipe(
    Effect.provide(services),
    Effect.provideService(SqlClient.SqlClient, observingSql),
    Effect.provideService(ProjectWorkRepository, {
      ...repository,
      executeAtomic: () => Effect.succeed([]),
    }),
  );
  return { construct, rows, sql: observingSql };
});

it.effect(
  "captures memory recovery at construction and joins exact prompt operations before settlement on repeated cleanup",
  () =>
    scoped(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const calls: ProjectMemoryOperationIdentity[] = [];
          const recovered = new Set<string>();
          const host = yield* f.construct.pipe(
            Effect.provideService(ProjectMemoryPorts, {
              assertConfigured: () => Effect.void,
              recoverJoinedOperation: (operation) =>
                Effect.sync(() => {
                  expect(
                    controlled.events.filter((event) => event === "process-joined"),
                  ).toHaveLength((calls.length < 2 ? 1 : 2) * 4);
                  calls.push(operation);
                  recovered.add(operation.operationId);
                  controlled.events.push(`memory:${operation.operationId}`);
                }),
            }),
          );
          // Public recovery deliberately runs outside the providing context, with a hostile replacement.
          for (let attempt = 0; attempt < 2; attempt++) {
            const outcome = yield* host.recover().pipe(
              Effect.provideService(SqlClient.SqlClient, f.sql),
              Effect.provideService(ProjectMemoryPorts, {
                assertConfigured: () => Effect.void,
                recoverJoinedOperation: () => Effect.die("Recovery looked up the caller's port"),
              }),
            );
            const result = outcome.items[0]?.result;
            expect(result && Exit.isSuccess(result) ? result.value._tag : result).toBe("Settled");
          }
          expect(calls).toEqual([
            identity("operation-1", 1),
            identity("operation-3", 3),
            identity("operation-1", 1),
            identity("operation-3", 3),
          ]);
          expect([...recovered]).toEqual(["operation-1", "operation-3"]);
          expect(
            controlled.events.filter((event) => event.startsWith("memory:") || event === "settle"),
          ).toEqual([
            "memory:operation-1",
            "memory:operation-3",
            "settle",
            "memory:operation-1",
            "memory:operation-3",
            "settle",
          ]);
        }),
      ),
    ),
);

for (const denial of [
  "recovery-error",
  "mismatched-identity",
  "owned",
  "mismatch",
  "missing-setup",
] as const)
  it.effect(`retains uncertainty for ${denial} without settlement`, () =>
    scoped(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          let calls = 0;
          if (denial === "mismatched-identity") f.rows[1]!.worker_id = "foreign-worker";
          const host = yield* f.construct.pipe(
            Effect.provideService(ProjectMemoryPorts, {
              assertConfigured: () => Effect.void,
              recoverJoinedOperation: (operation) =>
                Effect.gen(function* () {
                  calls++;
                  expect(operation).toEqual({
                    ...identity("operation-1", 1),
                    ...(denial === "mismatched-identity" ? { workerId: "foreign-worker" } : {}),
                  });
                  return yield* new ProjectMemoryServiceError({
                    reason:
                      denial === "mismatched-identity"
                        ? "Retained worker identity differs"
                        : "Retained terminal has no callback join",
                  });
                }),
            }),
          );
          if (denial === "owned" || denial === "mismatch") controlled.physical = denial;
          if (denial === "missing-setup") controlled.setup = false;
          const outcome = yield* host
            .recover()
            .pipe(Effect.provideService(SqlClient.SqlClient, f.sql));
          const result = outcome.items[0]?.result;
          expect(result && Exit.isSuccess(result) ? result.value._tag : result).toBe("Quarantined");
          expect(calls).toBe(
            denial === "recovery-error" || denial === "mismatched-identity" ? 1 : 0,
          );
          expect(controlled.events).not.toContain("settle");
        }),
      ),
    ),
  );

it.effect(
  "public recovery waits for memory callback recovery before returning joined settlement",
  () =>
    scoped(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const host = yield* f.construct.pipe(
            Effect.provideService(ProjectMemoryPorts, {
              assertConfigured: () => Effect.void,
              recoverJoinedOperation: () =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            }),
          );
          const recovering = yield* host
            .recover()
            .pipe(Effect.provideService(SqlClient.SqlClient, f.sql), Effect.forkChild);
          yield* Deferred.await(entered);
          expect(controlled.events).not.toContain("settle");
          yield* Deferred.succeed(release, undefined);
          const outcome = yield* Fiber.join(recovering);
          const result = outcome.items[0]?.result;
          expect(result && Exit.isSuccess(result) ? result.value._tag : result).toBe("Settled");
        }),
      ),
    ),
);

it.effect("an absent construction port never falls back to a later caller's port", () =>
  scoped(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const host = yield* f.construct;
        const outcome = yield* host.recover().pipe(
          Effect.provideService(SqlClient.SqlClient, f.sql),
          Effect.provideService(ProjectMemoryPorts, {
            assertConfigured: () => Effect.void,
            recoverJoinedOperation: () => Effect.die("Late port must not be used"),
          }),
        );
        const result = outcome.items[0]?.result;
        expect(result && Exit.isSuccess(result) ? result.value._tag : result).toBe("Settled");
      }),
    ),
  ),
);
