import { ProjectTeamEffect } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import {
  seed,
  restoreHistoricalBinding,
  providerInstanceId,
  threadId,
  at,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { preallocatePiManagedProcess } from "../provider/pi/PiManagedProcess.ts";
import { makeProjectTeamPiOperations } from "./ProjectTeamPiOperations.ts";
import { make as makeAccounting } from "./ProjectTeamModelAccounting.ts";

const decodeSetup = Schema.decodeUnknownEffect(ProjectTeamEffect);
const parseJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const model = "inclusionai/ling-3.1-flash:free";
const time = Date.parse(at) + 100;
const fileTest = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const live = Layer.mergeAll(
        Authorization.layer,
        ProjectWorkRepositoryLive,
        ProjectWorkProjectionLive,
        ProjectWorkQueryLive,
      ).pipe(Layer.provideMerge(makeSqlitePersistenceLive(`${directory}/runtime.sqlite`)));
      return yield* body.pipe(Effect.provide(live));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(time);
  const f = yield* seed("investigator", "reserved", {
    nativeSessionId: null,
    roleTools: [],
    toolIds: [],
  });
  const fs = yield* FileSystem.FileSystem;
  const worktree = yield* fs.makeTempDirectoryScoped();
  const protectedRoot = yield* fs.makeTempDirectoryScoped();
  const nativeRoot = yield* fs.makeTempDirectoryScoped();
  const role = { ...f.role, model, instructions: "Investigate the assigned task" };
  yield* restoreHistoricalBinding(role);
  const binding = {
    ...f.binding,
    worktree,
    model,
    configuration: {
      ...f.binding.configuration,
      instructionsHash: NodeCrypto.createHash("sha256").update(role.instructions).digest("hex"),
      maxTokens: 20000,
      maxDurationMs: 300000,
      runtimeVersion: "0.99.1",
    },
  };
  yield* restoreHistoricalBinding(binding);
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
  const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
  const identity = { providerInstanceId, threadId };
  const prepare = (id = "initialize") =>
    operations.prepare(identity, { threadId, kind: "initialize" }, "request", {
      allocation,
      workerId: "worker",
      operationId: id,
    });
  return { ...f, binding, role, allocation, operations, identity, prepare };
});
const rejected = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => expect(result._tag).toBe("Failure")),
  );

it.effect(
  "commits exact launch intent and unique ordinal before activation and denies replay",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const op = yield* f.prepare();
        expect(op.ordinal).toBe(0);
        const process = yield* f.sql<{
          status: string;
          allocation_json: string;
        }>`SELECT * FROM project_team_pi_process`;
        expect(process[0]?.status).toBe("allocated");
        expect(parseJson(process[0]!.allocation_json)).toEqual(f.allocation);
        yield* rejected(f.prepare("duplicate"));
        const persistence = f.operations.persistence(op);
        yield* persistence.claimActivation(f.allocation);
        yield* rejected(persistence.claimActivation(f.allocation));
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
            ?.status,
        ).toBe("starting");
      }),
    ),
);
it.effect(
  "binds actual native identity through event repository and retains uncertain worker fence",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const op = yield* f.prepare();
        yield* f.operations.persistence(op).claimActivation(f.allocation);
        const native = {
          sessionId: "native",
          sessionReference: "sessions/native.jsonl",
          leafId: null,
          persisted: false,
        };
        yield* f.operations.persistNative(op, native);
        const authority = yield* f.operations.current(f.identity);
        expect(authority.binding.status).toBe("running");
        expect(authority.binding.sessionId).toBe("native");
        expect(
          (yield* f.repo.replay(f.binding.projectId)).some(
            (entry) =>
              entry.type === "project-work.foundation.recorded" &&
              entry.record.kind === "run-binding" &&
              entry.record.sessionId === "native",
          ),
        ).toBe(true);
        yield* rejected(f.operations.persistNative(op, { ...native, sessionId: "different" }));
        yield* f.operations.persistTerminal(op, {
          identity: { workerId: op.workerId, generation: 0 },
          operation: op.operation,
          outcome: "quarantine",
          ownerCaptured: false,
          native,
          drain: null,
          accountingReceipts: [],
        });
        yield* rejected(f.prepare("replacement"));
        yield* rejected(f.operations.nativeFor(f.identity));
        const fresh = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        yield* rejected(
          fresh.prepare(f.identity, { threadId, kind: "initialize" }, "request", {
            allocation: f.allocation,
            workerId: "replacement",
            operationId: "restart",
          }),
        );
      }),
    ),
);
it.effect(
  "canceled unactivated intent releases ownership but preserves increasing chronology",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const op = yield* f.prepare();
        yield* f.operations.persistTerminal(op, {
          identity: { workerId: op.workerId, generation: 0 },
          operation: op.operation,
          outcome: "canceled",
          ownerCaptured: false,
          native: null,
          drain: null,
          accountingReceipts: [],
        });
        const nextAllocation = {
          ...f.allocation,
          unit: "t3-pi-managed-next.service",
          nonce: "next",
        };
        const replacement = yield* f.operations.prepare(
          f.identity,
          { threadId, kind: "initialize" },
          "new-request",
          { allocation: nextAllocation, operationId: "next", workerId: "next" },
        );
        expect(replacement.ordinal).toBe(1);
      }),
    ),
);
it.effect("rejects stale approval before ownership allocation", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const gate = (yield* f.operations.current(f.identity, true)).state.foundationRecords!.find(
        (entry) => entry.kind === "gate" && entry.recordId === f.binding.specificationGateId,
      )!;
      if (gate.kind !== "gate") return yield* Effect.die("Fixture gate unavailable");
      yield* restoreHistoricalBinding({
        ...gate,
        status: "invalidated",
        revision: gate.revision + 1,
      });
      yield* rejected(f.prepare());
      expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
    }),
  ),
);
it.effect("rejects nested transactions and foreign SQL clients before success", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* rejected(f.sql.withTransaction(f.prepare()));
      const foreign = makeSqlitePersistenceLive(":memory:");
      yield* rejected(f.prepare().pipe(Effect.provide(foreign)));
      expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
    }),
  ),
);
it.effect(
  "durable accounting reads operation/root budget transactionally and settles after revocation",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const op = yield* f.prepare();
        const persistence = f.operations.persistence(op);
        yield* persistence.claimActivation(f.allocation);
        yield* persistence.beforeStart({
          type: "owner",
          unit: f.allocation.unit,
          nonce: f.allocation.nonce,
          invocation: "a".repeat(32),
          cgroup: `/sys/fs/cgroup/${f.allocation.unit}`,
          pid: 123,
          memoryBytes: 33554432,
          swapBytes: 0,
          oomGroup: 1,
        });
        yield* f.operations.persistNative(op, {
          sessionId: "native",
          sessionReference: "sessions/native.jsonl",
          leafId: null,
          persisted: false,
        });
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const request = {
          workerId: op.workerId,
          operationId: op.operation.operationId,
          generation: 0,
          requestId: 1,
          routeId: "command-code-ling-free",
          provider: "command-code" as const,
          model,
          maxInputTokens: 100,
          maxOutputTokens: 100,
          callCount: 1 as const,
          deadlineAtMs: time + 10000,
        };
        const receipt = yield* accounting.reserve(op.principal, request);
        expect(receipt.status).toBe("reserved");
        expect((yield* accounting.reserve(op.principal, request)).status).toBe("existing");
        const running = (yield* f.operations.current(f.identity)).binding;
        yield* restoreHistoricalBinding({
          ...running,
          revision: running.revision + 1,
          configuration: { ...running.configuration, runtimeVersion: "changed-after-intent" },
        });
        yield* rejected(accounting.reserve(op.principal, { ...request, requestId: 2 }));
        expect((yield* f.sql`SELECT * FROM project_team_model_request`).length).toBe(1);
        yield* restoreHistoricalBinding({
          ...running,
          status: "revoked",
          revision: running.revision + 2,
        });
        yield* rejected(accounting.reserve(op.principal, { ...request, requestId: 2 }));
        const settlement = yield* accounting.settle({
          ...request,
          reservationId: receipt.reservationId,
          outcome: "unknown",
          chargedInputTokens: 100,
          chargedOutputTokens: 100,
        });
        expect(settlement.accountingReceiptId.length).toBeGreaterThan(0);
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_team_model_request`)[0]
            ?.status,
        ).toBe("unknown");
      }),
    ),
);

it.effect("rejects an expired frozen run budget before intent", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* TestClock.setTime(Date.parse(at) + 300001);
      yield* rejected(f.prepare());
      expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
    }),
  ),
);
it.effect("keeps unfinished setup uncertain before allocation", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const setup = yield* decodeSetup({
        recordId: "setup-effect",
        projectId: f.binding.projectId,
        revision: 0,
        generation: 0,
        updatedAt: at,
        kind: "effect",
        status: "uncertain",
        effectId: "setup-effect",
        effectKind: "setup",
        runId: f.binding.recordId,
        targetId: f.binding.recordId,
        payload: { recordIds: [f.binding.recordId], expectedRevision: 0 },
        claimGeneration: 0,
        availableAt: at,
      });
      yield* restoreHistoricalBinding(setup);
      yield* rejected(f.prepare());
      expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
    }),
  ),
);
