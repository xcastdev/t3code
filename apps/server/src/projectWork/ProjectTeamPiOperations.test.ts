import { canonicalProjectWorkPayload, ProjectTeamEffect } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
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
import { PiManagedRuntimeError } from "../provider/pi/PiManagedRuntime.ts";
import type { PiSessionTerminal } from "../provider/pi/PiSessionRuntime.ts";

const decodeSetup = Schema.decodeUnknownEffect(ProjectTeamEffect);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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

const nativeReference = {
  sessionId: "native",
  sessionReference: "sessions/native.jsonl",
  leafId: "leaf",
  persisted: true,
};
const settledRead = Effect.gen(function* () {
  const f = yield* fixture;
  const op = yield* f.operations.prepare(f.identity, { threadId, kind: "initialize" }, "read", {
    allocation: f.allocation,
    workerId: "worker",
    operationId: "read",
    resourceHash: "a".repeat(64),
  });
  yield* f.operations.persistNative(op, nativeReference);
  // This settled SQL fixture exercises read identity, not operating-system drain.
  yield* f.sql`UPDATE project_team_pi_operation SET status='settled'`;
  const expected = yield* f.operations.nativeFor(f.identity);
  return { ...f, op, expected };
});
const typedDenial = <A, R>(effect: Effect.Effect<A, PiManagedRuntimeError, R>, code?: string) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(PiManagedRuntimeError);
        if (code) expect(result.failure.code).toBe(code);
      }
    }),
  );

for (const mode of [
  "unchanged",
  "legacy-unchanged",
  "operation-id",
  "leaf",
  "path",
  "persisted",
  "resource-hash",
  "new-head",
  "binding-session",
  "generation",
  "malformed-native",
  "excess-native",
  "malformed-intent",
  "malformed-expected",
  "excess-expected",
  "malformed-expected-hash",
  "prepared",
  "starting",
  "running",
  "quarantine",
] as const) {
  it.effect(`admits only the exact durable native read: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* settledRead;
        let expected = f.expected;
        switch (mode) {
          case "legacy-unchanged":
            yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_remove(intent_json, '$.resourceHash')`;
            expected = { ...expected, resourceHash: null };
            break;
          case "operation-id":
            expected = { ...expected, operationId: "different" };
            break;
          case "leaf":
          case "path":
          case "persisted": {
            const native = {
              ...nativeReference,
              ...(mode === "leaf"
                ? { leafId: "new-leaf" }
                : mode === "path"
                  ? { sessionReference: "sessions/new.jsonl" }
                  : { persisted: false }),
            };
            yield* f.sql`UPDATE project_team_pi_operation SET native_json=${encodeJson(native)}`;
            break;
          }
          case "resource-hash":
            yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json, '$.resourceHash', ${"b".repeat(64)})`;
            break;
          case "new-head":
            yield* f.sql`INSERT INTO project_team_pi_operation SELECT 'new-head',environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,1,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json,native_json,terminal_json FROM project_team_pi_operation`;
            break;
          case "binding-session":
          case "generation": {
            const binding = (yield* f.operations.current(f.identity)).binding;
            yield* restoreHistoricalBinding({
              ...binding,
              revision: binding.revision + 1,
              ...(mode === "binding-session"
                ? { sessionId: "replacement" }
                : { generation: binding.generation + 1 }),
            });
            break;
          }
          case "malformed-native":
            yield* f.sql`UPDATE project_team_pi_operation SET native_json='{'`;
            break;
          case "excess-native":
            yield* f.sql`UPDATE project_team_pi_operation SET native_json=${encodeJson({ ...nativeReference, extra: true })}`;
            break;
          case "malformed-intent":
            yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json, '$.resourceHash', 'malformed')`;
            break;
          case "malformed-expected":
            expected = {
              ...expected,
              native: { ...expected.native, sessionReference: "../outside.jsonl" },
            };
            break;
          case "malformed-expected-hash":
            expected = { ...expected, resourceHash: "invalid" };
            break;
          case "excess-expected": {
            const native = { ...expected.native, extra: true };
            expected = { ...expected, native };
            break;
          }
          case "prepared":
          case "starting":
          case "running":
          case "quarantine":
            yield* f.sql`UPDATE project_team_pi_operation SET status=${mode}`;
            break;
        }
        let calls = 0;
        const admission = f.operations.admitCurrent(
          f.identity,
          (authority) => {
            calls++;
            return authority.binding.sessionId;
          },
          expected,
        );
        if (mode === "unchanged" || mode === "legacy-unchanged") {
          expect(yield* admission).toBe(nativeReference.sessionId);
          expect(calls).toBe(1);
        } else {
          yield* typedDenial(admission);
          expect(calls).toBe(0);
          if (
            mode === "malformed-native" ||
            mode === "excess-native" ||
            mode === "malformed-intent"
          )
            yield* typedDenial(f.operations.nativeFor(f.identity), "uncertain");
        }
      }),
    ),
  );
}

it.effect("admits a native read before a queued durable stop and denies its successor", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* settledRead;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const stopStarted = yield* Deferred.make<void>();
      let holdRead = true;
      const observedSql = new Proxy(f.sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          if (
            !holdRead ||
            !statement.compile()[0].includes("ORDER BY operation_ordinal DESC LIMIT 1")
          )
            return statement;
          return statement.pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                holdRead = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }),
            ),
          );
        },
      });
      const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" }).pipe(
        Effect.provideService(SqlClient.SqlClient, observedSql),
      );
      let calls = 0;
      const admission = () =>
        operations
          .admitCurrent(
            f.identity,
            () => {
              calls++;
              return "read";
            },
            f.expected,
          )
          .pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
      const pending = yield* admission().pipe(Effect.forkChild);
      yield* Effect.raceFirst(
        Deferred.await(entered),
        Fiber.join(pending).pipe(
          Effect.flatMap(() => Effect.die("Native read did not reach its final SQL receipt")),
        ),
      );
      let committed = false;
      const stop = yield* Deferred.succeed(stopStarted, undefined).pipe(
        Effect.andThen(
          restoreHistoricalBinding({
            ...f.expected.authority.binding,
            revision: f.expected.authority.binding.revision + 1,
            status: "stopping",
          }),
        ),
        Effect.tap(
          Effect.sync(() => {
            committed = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(stopStarted);
      expect(committed).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toBe("read");
      yield* Fiber.join(stop);
      expect(committed).toBe(true);
      expect(calls).toBe(1);
      yield* typedDenial(admission());
      expect(calls).toBe(1);
    }),
  ),
);

for (const mode of ["unchanged", "stop-first", "expired", "expires-in-callback"] as const) {
  it.effect(`orders durable native read against the captured transaction and clock: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* settledRead;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const queued = yield* Deferred.make<void>();
        const clock = yield* Clock.Clock;
        let clockOffset: number | undefined;
        const operations = yield* makeProjectTeamPiOperations({
          environmentId: "environment",
        }).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillisUnsafe: () => clockOffset ?? clock.currentTimeMillisUnsafe(),
          }),
        );
        let calls = 0;
        const hold = yield* f.sql
          .withTransaction(
            Effect.gen(function* () {
              if (mode === "stop-first") {
                yield* restoreHistoricalBinding({
                  ...f.expected.authority.binding,
                  revision: f.expected.authority.binding.revision + 1,
                  status: "stopping",
                });
              }
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const pending = yield* Deferred.succeed(queued, undefined).pipe(
          Effect.andThen(
            operations.admitCurrent(
              f.identity,
              () => {
                calls++;
                if (mode === "expires-in-callback") {
                  // Clock services expose the same unsafe clock used by the synchronous admission fence.
                  clockOffset = f.op.deadlineAtMs + 1000;
                }
                return "read";
              },
              f.expected,
            ),
          ),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(queued);
        if (mode === "expired") yield* TestClock.setTime(f.op.deadlineAtMs + 1000);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(hold);
        const result = yield* Fiber.join(pending);
        expect(result._tag).toBe(mode === "unchanged" ? "Success" : "Failure");
        expect(calls).toBe(mode === "unchanged" || mode === "expires-in-callback" ? 1 : 0);
      }),
    ),
  );
}

const terminalFixtureFor = (stable = false) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const request = {
      threadId,
      kind: "initialize" as const,
      ...(stable ? { operationId: "stable-initialize" } : {}),
    };
    const requestHash = stable
      ? NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(request)).digest("hex")
      : "request";
    const resourceHash = "a".repeat(64);
    const op = stable
      ? yield* f.operations.prepare(f.identity, request, requestHash, {
          allocation: f.allocation,
          workerId: "worker",
          operationId: request.operationId!,
          resourceHash,
        })
      : yield* f.prepare();
    // Captured owner and drain metadata are synthetic SQL fixtures, not native process proof.
    const owner = {
      type: "owner" as const,
      unit: f.allocation.unit,
      nonce: f.allocation.nonce,
      invocation: "a".repeat(32),
      cgroup: `/sys/fs/cgroup/${f.allocation.unit}`,
      pid: 123,
      memoryBytes: f.allocation.policy.memoryBytes,
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
      launcherPid: 124,
      childPid: 125,
      childExitCode: 0,
      kernel: "populated 0\nfrozen 0",
    };
    const activate = Effect.gen(function* () {
      yield* f.operations.persistence(op).claimActivation(f.allocation);
      yield* f.operations.persistence(op).beforeStart(owner);
      yield* f.operations.persistNative(op, nativeReference);
    });
    const terminal = (
      outcome: PiSessionTerminal["outcome"],
      drained = false,
    ): PiSessionTerminal => ({
      identity: { workerId: op.workerId, generation: 0 },
      operation: op.operation,
      outcome,
      ownerCaptured: drained,
      native: drained ? nativeReference : null,
      drain: drained ? drain : null,
      accountingReceipts: [],
    });
    return { ...f, op, owner, drain, activate, terminal, request, requestHash, resourceHash };
  });

const terminalFixture = terminalFixtureFor();

for (const mode of [
  "allocated-canceled",
  "allocated-failed",
  "allocated-quarantine",
  "allocated-success",
  "claimed-canceled",
  "captured-failed",
  "captured-canceled",
  "drained-failed",
  "drained-canceled",
  "drained-success",
  "drained-quarantine",
  "wrong-drain",
] as const) {
  it.effect(`returns the committed SQL drain disposition: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixture;
        const allocated = mode.startsWith("allocated");
        if (mode === "claimed-canceled")
          yield* f.operations.persistence(f.op).claimActivation(f.allocation);
        else if (!allocated) yield* f.activate;
        const outcome = mode.endsWith("success")
          ? "success"
          : mode.endsWith("quarantine")
            ? "quarantine"
            : mode.endsWith("canceled")
              ? "canceled"
              : "failed";
        const terminal = f.terminal(outcome, mode.startsWith("drained") || mode === "wrong-drain");
        const effect = f.operations.persistTerminal(
          f.op,
          mode === "wrong-drain"
            ? { ...terminal, drain: { ...f.drain, invocation: "b".repeat(32) } }
            : terminal,
        );
        if (mode === "allocated-success" || mode === "wrong-drain") {
          yield* typedDenial(effect, "uncertain");
          expect(
            (yield* f.sql<{
              status: string;
              terminal_json: string | null;
            }>`SELECT status,terminal_json FROM project_team_pi_operation`)[0],
          ).toEqual({ status: allocated ? "prepared" : "running", terminal_json: null });
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]
              ?.status,
          ).toBe(allocated ? "allocated" : "captured");
        } else {
          const expected =
            mode.endsWith("quarantine") || mode.startsWith("claimed") || mode.startsWith("captured")
              ? "uncertain"
              : "drained";
          expect(yield* effect).toBe(expected);
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
              ?.status,
          ).toBe(expected === "uncertain" ? "quarantine" : "settled");
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]
              ?.status,
          ).toBe(expected === "uncertain" ? "quarantine" : "drained");
          yield* typedDenial(f.operations.persistTerminal(f.op, terminal), "conflict");
        }
      }),
    ),
  );
}

for (const mode of [
  "pending",
  "reported",
  "failed",
  "unknown",
  "success-missing",
  "success-reported",
  "success-pending",
  "wrong-receipt",
] as const) {
  it.effect(`retains or drains native state after durable model accounting: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixture;
        yield* f.activate;
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const request = {
          workerId: f.op.workerId,
          operationId: f.op.operation.operationId,
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
        const reservation = yield* accounting.reserve(f.op.principal, request);
        const receipts: PiSessionTerminal["accountingReceipts"][number][] = [];
        if (mode !== "pending" && mode !== "success-pending") {
          const reported = mode !== "failed" && mode !== "unknown";
          const receipt = yield* accounting.settle({
            ...request,
            reservationId: reservation.reservationId,
            outcome: reported ? "reported" : mode,
            chargedInputTokens: reported ? 10 : 100,
            chargedOutputTokens: reported ? 20 : 100,
            ...(reported
              ? {
                  reportedModel: model,
                  reportedUsage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                }
              : {}),
          });
          if (reported && mode !== "success-missing")
            receipts.push({
              requestId: request.requestId,
              routeId: request.routeId,
              provider: request.provider,
              model: request.model,
              reportedModel: model,
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
              reservationId: reservation.reservationId,
              accountingReceiptId:
                mode === "wrong-receipt" ? "different" : receipt.accountingReceiptId,
            });
        }
        const terminal = {
          ...f.terminal(mode.startsWith("success") ? "success" : "failed", true),
          accountingReceipts: receipts,
        };
        const effect = f.operations.persistTerminal(f.op, terminal);
        if (mode === "success-missing" || mode === "success-pending" || mode === "wrong-receipt") {
          yield* typedDenial(effect, "uncertain");
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
              ?.status,
          ).toBe("running");
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]
              ?.status,
          ).toBe("captured");
        } else {
          const disposition = mode === "pending" ? "uncertain" : "drained";
          expect(yield* effect).toBe(disposition);
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
              ?.status,
          ).toBe(disposition === "uncertain" ? "quarantine" : "settled");
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]
              ?.status,
          ).toBe(disposition === "uncertain" ? "quarantine" : "drained");
        }
      }),
    ),
  );
}

it.effect(
  "retains selected resource identity in durable intent and reconstructs it after restart",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const resourceHash = "a".repeat(64);
        const op = yield* f.operations.prepare(
          f.identity,
          { threadId, kind: "initialize" },
          "skills",
          {
            allocation: f.allocation,
            workerId: "worker",
            operationId: "skills",
            resourceHash,
          },
        );
        const rows = yield* f.sql<{
          intent_json: string;
        }>`SELECT intent_json FROM project_team_pi_operation`;
        expect(parseJson(rows[0]!.intent_json)).toHaveProperty("resourceHash", resourceHash);
        const native = {
          sessionId: "native",
          sessionReference: "sessions/native.jsonl",
          leafId: null,
          persisted: false,
        };
        yield* f.operations.persistNative(op, native);
        // Synthetic settled SQL fixture proves reconstruction only, not operating-system drain.
        yield* f.sql`UPDATE project_team_pi_operation SET status='settled'`;
        const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        expect((yield* restarted.nativeFor(f.identity)).resourceHash).toBe(resourceHash);
        yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json, '$.resourceHash', 'malformed')`;
        yield* rejected(restarted.nativeFor(f.identity));
      }),
    ),
);

it.effect(
  "rejects malformed resource identities before committing operation or process ownership",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const resourceHash of ["", "a".repeat(63), "z".repeat(64)]) {
          yield* rejected(
            f.operations.prepare(f.identity, { threadId, kind: "initialize" }, "skills", {
              allocation: f.allocation,
              workerId: "worker",
              operationId: "skills",
              resourceHash,
            }),
          );
        }
        expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
        expect((yield* f.sql`SELECT * FROM project_team_pi_process`).length).toBe(0);
      }),
    ),
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
        const committed = yield* f.operations.persistNative(op, native);
        const authority = yield* f.operations.current(f.identity);
        expect(committed).toEqual(authority);
        expect(authority.binding.revision).toBe(op.authority.binding.revision + 1);
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

for (const mode of ["control", "before-prepare", "before-final-commit", "after-commit"] as const) {
  it.effect(`native binding commit fence ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const real = yield* Authorization.ProjectTeamAuthorization;
        const projection = yield* ProjectWorkProjection;
        const restore = (record: Parameters<typeof restoreHistoricalBinding>[0]) =>
          restoreHistoricalBinding(record).pipe(
            Effect.provideService(ProjectWorkProjection, projection),
            Effect.provideService(SqlClient.SqlClient, f.sql),
            Effect.orDie,
          );
        let armed = false,
          reads = 0,
          changed = false,
          inTransaction = false;
        const wrapped = Authorization.ProjectTeamAuthorization.of({
          ...real,
          issueCredential: (...args) =>
            Effect.gen(function* () {
              const authority = yield* real.issueCredential(...args);
              if (armed) {
                reads++;
                const inside = Option.isSome(yield* Effect.serviceOption(f.sql.transactionService));
                if (
                  !changed &&
                  authority &&
                  ((mode === "before-prepare" && reads === 1 && inside) ||
                    (mode === "before-final-commit" && reads === 2 && inside) ||
                    (mode === "after-commit" && reads === 3 && !inside))
                ) {
                  inTransaction = inside;
                  yield* restore({
                    ...authority.binding,
                    revision: authority.binding.revision + 1,
                    sessionId: "foreign-native-replacement",
                  });
                  changed = true;
                  return yield* real.issueCredential(...args);
                }
              }
              return authority;
            }),
        });
        const ops = yield* makeProjectTeamPiOperations({ environmentId: "environment" }).pipe(
          Effect.provideService(Authorization.ProjectTeamAuthorization, wrapped),
        );
        const op = yield* ops.prepare(
          f.identity,
          { threadId: f.identity.threadId, kind: "initialize" },
          "request",
          { allocation: f.allocation, workerId: "worker", operationId: "native-fence" },
        );
        const native = {
          sessionId: "original-native",
          sessionReference: "sessions/original-native.jsonl",
          leafId: null,
          persisted: false,
        };
        armed = true;
        const outcome = yield* ops.persistNative(op, native).pipe(Effect.result);
        armed = false;
        const current = yield* real.issueCredential(f.identity);
        const rows = yield* f.sql<{
          native_json: string | null;
          status: string;
        }>`SELECT native_json,status FROM project_team_pi_operation WHERE operation_id='native-fence'`;
        const journal = yield* f.repo.replay(f.binding.projectId);
        const fs = yield* FileSystem.FileSystem;
        if (process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE)
          yield* fs.writeFileString(
            process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE + "/native-commit-" + mode + ".json",
            encodeJson({
              mode,
              outcome,
              reads,
              changed,
              inTransaction,
              binding: current?.binding,
              rows,
              events: journal.filter(
                (e) =>
                  e.type === "project-work.foundation.recorded" && e.record.kind === "run-binding",
              ),
            }),
          );
        expect(changed).toBe(mode !== "control");
        expect(inTransaction).toBe(mode === "before-prepare" || mode === "before-final-commit");
        if (mode === "before-prepare" || mode === "before-final-commit") {
          expect(rows[0]?.native_json).toBeNull();
          expect(current?.binding.status).toBe("reserved");
          expect(current?.binding.sessionId).toBeUndefined();
        } else {
          expect(parseJson(rows[0]!.native_json!)).toEqual(native);
          expect(current?.binding.sessionId).toBe(
            mode === "control" ? native.sessionId : "foreign-native-replacement",
          );
        }
        expect(outcome._tag).toBe(mode === "control" ? "Success" : "Failure");
      }),
    ),
  );
}

for (const mode of [
  "completed",
  "prepared",
  "starting",
  "running",
  "quarantine",
  "failed",
  "request",
  "hash",
  "kind",
  "resource",
  "binding",
  "generation",
  "scalar",
  "allocation",
  "owner",
  "drain",
  "native",
  "terminal",
  "deadline",
  "retired",
] as const) {
  it.effect(`stable Pi identity never repeats external work: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixtureFor(true);
        if (mode !== "prepared") yield* f.activate;
        if (!["prepared", "starting", "running", "quarantine"].includes(mode))
          yield* f.operations.persistTerminal(
            f.op,
            f.terminal(mode === "failed" ? "failed" : "success", true),
          );
        if (["starting", "quarantine"].includes(mode))
          yield* f.sql`UPDATE project_team_pi_operation SET status=${mode}`;
        let request: typeof f.request & { readonly cwd?: string } = f.request;
        let hash = f.requestHash;
        let resource = f.resourceHash;
        if (mode === "request") request = { ...request, cwd: "changed" };
        if (mode === "hash") hash = "b".repeat(64);
        if (mode === "kind")
          yield* f.sql`UPDATE project_team_pi_operation SET operation_kind='compact'`;
        if (mode === "resource") resource = "b".repeat(64);
        if (mode === "scalar")
          yield* f.sql`UPDATE project_team_pi_operation SET project_id='other'`;
        if (mode === "allocation")
          yield* f.sql`UPDATE project_team_pi_process SET allocation_json=json_set(allocation_json,'$.nonce','other')`;
        if (mode === "owner")
          yield* f.sql`UPDATE project_team_pi_process SET owner_json=json_set(owner_json,'$.nonce','other')`;
        if (mode === "drain")
          yield* f.sql`UPDATE project_team_pi_process SET drain_json=json_set(drain_json,'$.childExitCode',1)`;
        if (mode === "native")
          yield* f.sql`UPDATE project_team_pi_operation SET native_json=json_set(native_json,'$.leafId','other')`;
        if (mode === "terminal")
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json='{'`;
        if (["binding", "generation", "retired"].includes(mode)) {
          const binding = (yield* f.operations.current(f.identity)).binding;
          yield* restoreHistoricalBinding({
            ...binding,
            revision: binding.revision + 1,
            ...(mode === "binding"
              ? { branch: "other" }
              : mode === "generation"
                ? { generation: 1 }
                : { status: "settled" as const }),
          });
        }
        if (mode === "deadline") yield* TestClock.setTime(f.op.deadlineAtMs);
        const effect = f.operations.lookup(f.identity, request, hash, resource);
        if (mode === "completed") {
          const receipt = yield* effect;
          expect(receipt?.terminal).toEqual(f.terminal("success", true));
          expect(receipt?.operation).toEqual(f.op.operation);
          // Reconstructing the private service models response loss and a server restart.
          const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
          expect((yield* restarted.lookup(f.identity, request, hash, resource))?.terminal).toEqual(
            receipt?.terminal,
          );
        } else yield* typedDenial(effect);
        expect((yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).length).toBe(1);
        expect((yield* f.sql`SELECT unit FROM project_team_pi_process`).length).toBe(1);
        expect((yield* f.sql`SELECT reservation_id FROM project_team_model_request`).length).toBe(
          0,
        );
      }),
    ),
  );
}

for (const mode of [
  "reported",
  "lost-receipt",
  "changed-settlement",
  "changed-reservation",
  "changed-charge",
  "changed-root",
  "pending",
  "budget",
] as const) {
  it.effect(`stable Pi replay preserves original accounting: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixtureFor(true);
        yield* f.activate;
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const reservation = {
          workerId: f.op.workerId,
          operationId: f.op.operation.operationId,
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
        const reserved = yield* accounting.reserve(f.op.principal, reservation);
        const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
        const settled = yield* accounting.settle({
          ...reservation,
          reservationId: reserved.reservationId,
          outcome: "reported",
          chargedInputTokens: 10,
          chargedOutputTokens: 20,
          reportedModel: model,
          reportedUsage: usage,
        });
        const terminal = {
          ...f.terminal("success", true),
          accountingReceipts: [
            {
              requestId: 1,
              routeId: reservation.routeId,
              provider: reservation.provider,
              model,
              reportedModel: model,
              usage,
              reservationId: reserved.reservationId,
              accountingReceiptId: settled.accountingReceiptId,
            },
          ],
        };
        yield* f.operations.persistTerminal(f.op, terminal);
        if (mode === "lost-receipt")
          yield* f.sql`UPDATE project_team_model_request SET accounting_receipt_id=NULL`;
        if (mode === "changed-settlement")
          yield* f.sql`UPDATE project_team_model_request SET settlement_json=json_set(settlement_json,'$.reportedUsage.total_tokens',99)`;
        if (mode === "changed-reservation")
          yield* f.sql`UPDATE project_team_model_request SET reservation_json=json_set(reservation_json,'$.requestId',2)`;
        if (mode === "changed-charge")
          yield* f.sql`UPDATE project_team_model_request SET charged_input_tokens=99`;
        if (mode === "changed-root")
          yield* f.sql`UPDATE project_team_model_request SET run_id='other'`;
        if (mode === "pending") yield* f.sql`UPDATE project_team_model_request SET status='held'`;
        if (mode === "budget")
          yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=maximum_tokens+1`;
        const replay = f.operations.lookup(f.identity, f.request, f.requestHash, f.resourceHash);
        if (mode === "reported") {
          expect((yield* replay)?.terminal).toEqual(terminal);
          expect((yield* replay)?.terminal).toEqual(terminal);
        } else yield* typedDenial(replay, "uncertain");
        expect((yield* f.sql`SELECT reservation_id FROM project_team_model_request`).length).toBe(
          1,
        );
      }),
    ),
  );
}
it.effect("a stable lookup miss cannot admit two competing preparations", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = { threadId, kind: "initialize" as const, operationId: "competing-root-id" };
      const hash = NodeCrypto.createHash("sha256")
        .update(canonicalProjectWorkPayload(request))
        .digest("hex");
      const resourceHash = "a".repeat(64);
      expect(yield* f.operations.lookup(f.identity, request, hash, resourceHash)).toBeUndefined();
      const prepare = (workerId: string) =>
        f.operations
          .prepare(f.identity, request, hash, {
            allocation: f.allocation,
            operationId: request.operationId,
            workerId,
            resourceHash,
          })
          .pipe(Effect.result);
      const results = yield* Effect.all([prepare("first"), prepare("second")], {
        concurrency: "unbounded",
      });
      expect(results.filter((entry) => entry._tag === "Success")).toHaveLength(1);
      expect(results.filter((entry) => entry._tag === "Failure")).toHaveLength(1);
      yield* typedDenial(f.operations.lookup(f.identity, request, hash, resourceHash), "conflict");
      expect((yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).length).toBe(1);
      expect((yield* f.sql`SELECT unit FROM project_team_pi_process`).length).toBe(1);
    }),
  ),
);
