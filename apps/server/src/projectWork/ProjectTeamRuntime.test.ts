import { expect, it } from "@effect/vitest";
import {
  ProjectWorkFoundationCommitCommand,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { layerTest, ServerSettingsService } from "../serverSettings.ts";
import {
  PiManagedRuntimeError,
  type PiManagedOperationRequest,
} from "../provider/pi/PiManagedRuntime.ts";
import type { PiProductionRuntimeHooks } from "../provider/pi/PiProductionRuntime.ts";
import {
  at,
  attribution,
  decodeRecord,
  projectId,
  providerInstanceId,
  scoped,
  seed,
  threadId,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { makeProjectTeamRuntime } from "./ProjectTeamRuntime.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";

const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const options = { environmentId: "environment", maximumEnvironmentModelCalls: 4 };
const stages = [
  "workspace-ready",
  "setup-complete",
  "session-bound",
  "assignment-intent",
  "assignment-observed",
] as const;
type Resolver = NonNullable<PiProductionRuntimeHooks["resolveOperationId"]>;

// Capture the installed private callback only; this fixture does not publish assets or run Pi.
const install = Effect.fn("runtimeTest.install")(function* (supplied = options) {
  let resolver: Resolver | undefined;
  const runtime = yield* makeProjectTeamRuntime(supplied).pipe(
    Effect.provide(
      Layer.mock(ProjectTeamPiRuntime)({
        installOperationResolver: (resolve) =>
          Effect.sync(() => {
            resolver = resolve;
          }),
      }),
    ),
  );
  if (resolver === undefined) return yield* Effect.die("Resolver was not installed");
  return { ...runtime, resolve: resolver };
});

const managedFixture = Effect.fn("runtimeTest.managedFixture")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  const intercepted = yield* seed("implementer", "reserved", {
    roleTools: ["pi.read", "pi.write"],
    toolIds: ["pi.read", "pi.write"],
    issueCredential: false,
  }).pipe(
    Effect.provideService(ProjectWorkRepository, {
      ...repository,
      execute: (command) => {
        if (
          command.type === "project-work.foundation.commit" &&
          command.transition?.kind === "claim"
        ) {
          pending = command;
          return Effect.fail(new ProjectWorkPolicyError("invalid-state", "Retain claim fixture"));
        }
        return repository.execute(command);
      },
    }),
    Effect.result,
  );
  expect(intercepted._tag).toBe("Failure");
  if (pending?.transition?.kind !== "claim")
    return yield* Effect.die("Fixture did not retain its private claim");
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "runtime-limits",
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
          environmentModelCalls: 4,
          projectWritableWorkers: 1,
          modelCalls: 2,
          delegationDepth: 2,
          repairAllowance: 2,
          model: "test",
          tokenLimit: 2000,
          durationLimitMs: 2000,
        },
      ],
    }),
  );
  yield* TestClock.setTime(Date.parse(at) + 1);
  const claim = {
    ...pending,
    expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
    transition: {
      ...pending.transition,
      binding: {
        ...pending.transition.binding,
        branch: "refs/heads/assigned",
        worktree: "/workspace-assigned",
      },
    },
  };
  const request: ProjectTeamDispatchRequest = {
    dispatchId: "runtime-dispatch",
    claim,
    git: {
      effectId: "runtime-dispatch",
      runId: "binding",
      generation: 0,
      primaryRoot: "/workspace",
      commonGitDirectory: "/workspace/.git",
      worktreePath: "/workspace-assigned",
      branchRef: "refs/heads/assigned",
      baseRef: "refs/heads/main",
      baseOid: "a".repeat(40),
      ownershipToken: "owner",
      policyHash: "b".repeat(64),
    },
    setupId: "runtime-setup",
    initializeOperationId: "retained-initialize",
    assignmentOperationId: "retained-assignment",
    assignment: "Implement the approved task",
  };
  // These observations exercise durable stage sequencing only, never actual Git/setup/native joins.
  const journal = yield* makeProjectTeamDispatchJournal({
    ...options,
    verifyStage: () => Effect.void,
  });
  const reserved = yield* journal.reserve(request);
  const claimEffect = journal.claimEffect(reserved.fence);
  const advance = Effect.fn("runtimeTest.advance")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    stage: (typeof stages)[number],
  ) {
    return yield* journal.advanceStage(snapshot.fence, {
      receiptId: `runtime-${stage}`,
      stage,
      evidence: { fixture: "synthetic-stage-observation" },
    });
  });
  const setup = Effect.gen(function* () {
    const claimed = yield* claimEffect;
    return yield* advance(yield* advance(claimed, "workspace-ready"), "setup-complete");
  });
  const change = Effect.fn("runtimeTest.change")(function* (
    record: Parameters<typeof decodeRecord>[0],
  ) {
    yield* repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "runtime-authority-change",
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution,
        records: [decodeRecord(record)],
        committedAt: at,
      }),
    );
  });
  return { sql, repository, request, journal, reserved, claimEffect, advance, setup, change };
});

const test = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  scoped(
    program.pipe(
      Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
      Effect.scoped,
    ),
  );
const initialize: PiManagedOperationRequest = {
  kind: "initialize",
  threadId,
  cwd: "/workspace-assigned",
  runtimeMode: "approval-required",
  modelSelection: { instanceId: providerInstanceId, model: "test" },
};
const expectDenied = Effect.fn("runtimeTest.expectDenied")(function* (
  operation: ReturnType<Resolver>,
) {
  const result = yield* operation.pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure).toBeInstanceOf(PiManagedRuntimeError);
    expect(result.failure.code).toBe("denied");
  }
});

it.effect(
  "resolves only retained operation IDs across stages, retries and producer replacement",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        let snapshot = yield* f.setup;
        const first = yield* install();
        const state = yield* readCurrentState(f.sql, projectId);
        const before = yield* f.sql`SELECT * FROM project_team_dispatch`;
        for (let retry = 0; retry < 2; retry++)
          expect(yield* first.resolve(providerInstanceId, initialize)).toBe("retained-initialize");
        const second = yield* install();
        expect(yield* second.resolve(providerInstanceId, initialize)).toBe("retained-initialize");
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual(before);
        expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(state.revision);
        snapshot = yield* f.advance(snapshot, "session-bound");
        expect(yield* second.resolve(providerInstanceId, initialize)).toBe("retained-initialize");
        snapshot = yield* f.advance(snapshot, "assignment-intent");
        const prompt: PiManagedOperationRequest = {
          ...initialize,
          kind: "prompt",
          prompt: f.request.assignment,
        };
        expect(yield* second.resolve(providerInstanceId, prompt)).toBe("retained-assignment");
        yield* f.advance(snapshot, "assignment-observed");
        expect(yield* second.resolve(providerInstanceId, prompt)).toBe("retained-assignment");
        yield* expectDenied(second.resolve(providerInstanceId, initialize));
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
);

it.effect(
  "ordinary Pi threads retain undefined identity with either feature disabled and after stop",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        const runtime = yield* install();
        const settings = yield* ServerSettingsService;
        const request: PiManagedOperationRequest = {
          kind: "initialize",
          threadId: ThreadId.make("ordinary"),
        };
        expect(yield* runtime.resolve(providerInstanceId, request)).toBeUndefined();
        yield* settings.updateSettings({ projectWorkEnabled: false });
        expect(yield* runtime.resolve(providerInstanceId, request)).toBeUndefined();
        yield* settings.updateSettings({
          projectWorkEnabled: true,
          projectTeamExecutionEnabled: false,
        });
        expect(yield* runtime.resolve(providerInstanceId, request)).toBeUndefined();
        yield* runtime.stop;
        expect(yield* runtime.resolve(providerInstanceId, request)).toBeUndefined();
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
);

for (const state of ["unclaimed", "reserved", "workspace-ready"] as const)
  it.effect(`denies initialization at ${state} without creating a replacement identity`, () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        if (state === "unclaimed") {
          // A restored forward-stage header cannot replace the original effect claim.
          yield* f.sql`UPDATE project_team_dispatch SET stage='setup-complete'`;
        } else {
          const claimed = yield* f.claimEffect;
          if (state === "workspace-ready") yield* f.advance(claimed, state);
        }
        const runtime = yield* install();
        yield* expectDenied(runtime.resolve(providerInstanceId, initialize));
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
  );

const mismatches: ReadonlyArray<readonly [string, PiManagedOperationRequest]> = [
  ["cwd", { ...initialize, cwd: "/other" }],
  ["model", { ...initialize, modelSelection: { instanceId: providerInstanceId, model: "other" } }],
  [
    "model instance",
    {
      ...initialize,
      modelSelection: { instanceId: ProviderInstanceId.make("other"), model: "test" },
    },
  ],
  ["runtime mode", { ...initialize, runtimeMode: "full-access" }],
  ["compaction", { kind: "compact", threadId }],
  ["premature prompt", { kind: "prompt", threadId, prompt: "Implement the approved task" }],
];
for (const [label, request] of mismatches)
  it.effect(`denies ${label} against the original assignment`, () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        yield* f.setup;
        const runtime = yield* install();
        yield* expectDenied(runtime.resolve(providerInstanceId, request));
        expect(yield* runtime.resolve(providerInstanceId, initialize)).toBe("retained-initialize");
      }),
    ),
  );

it.effect(
  "rejects changed assignment content at the prompt stage and ignores caller replacement IDs",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        const ready = yield* f.advance(yield* f.setup, "session-bound");
        yield* f.advance(ready, "assignment-intent");
        const runtime = yield* install();
        yield* expectDenied(
          runtime.resolve(providerInstanceId, { kind: "prompt", threadId, prompt: "Changed" }),
        );
        expect(
          yield* runtime.resolve(providerInstanceId, {
            kind: "prompt",
            threadId,
            prompt: f.request.assignment,
            operationId: "caller-replacement",
          }),
        ).toBe("retained-assignment");
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
);

it.effect(
  "captures environment and maximum model-call options before the caller mutates them",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        yield* f.setup;
        const supplied = { ...options };
        const runtime = yield* install(supplied);
        supplied.environmentId = "replacement";
        supplied.maximumEnvironmentModelCalls = 0;
        expect(yield* runtime.resolve(providerInstanceId, initialize)).toBe("retained-initialize");
      }),
    ),
);

for (const flag of ["projectWorkEnabled", "projectTeamExecutionEnabled"] as const)
  it.effect(`denies managed identity while ${flag} is disabled and allows explicit reenable`, () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        yield* f.setup;
        const runtime = yield* install();
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ [flag]: false });
        yield* expectDenied(runtime.resolve(providerInstanceId, initialize));
        yield* settings.updateSettings({ [flag]: true });
        expect(yield* runtime.resolve(providerInstanceId, initialize)).toBe("retained-initialize");
        yield* runtime.stop;
        yield* expectDenied(runtime.resolve(providerInstanceId, initialize));
      }),
    ),
  );

for (const authority of ["revoked", "paused member", "retired role", "generation"] as const)
  it.effect(`denies actual current ${authority} authority after successful lookup`, () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        yield* f.setup;
        const runtime = yield* install();
        expect(yield* runtime.resolve(providerInstanceId, initialize)).toBe("retained-initialize");
        const records = (yield* readCurrentState(f.sql, projectId)).foundationRecords!;
        const kind =
          authority === "paused member"
            ? "member"
            : authority === "retired role"
              ? "role-revision"
              : "run-binding";
        const original = records.find((record) => record.kind === kind)!;
        if (authority === "generation")
          yield* f.sql`UPDATE project_team_run_binding SET generation=1 WHERE record_id='binding'`;
        else
          yield* f.change({
            ...original,
            revision: original.revision + 1,
            status:
              authority === "paused member"
                ? "paused"
                : authority === "retired role"
                  ? "retired"
                  : "revoked",
          });
        yield* expectDenied(runtime.resolve(providerInstanceId, initialize));
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
  );

for (const corruption of ["missing", "duplicate"] as const)
  it.effect(`denies ${corruption} durable dispatch instead of allocating a replacement`, () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        yield* f.setup;
        const runtime = yield* install();
        if (corruption === "missing") {
          // Model missing restored physical dispatch storage while preserving domain authority.
          yield* f.sql`CREATE TABLE restored_empty_dispatch AS SELECT * FROM project_team_dispatch WHERE 0`;
          yield* f.sql`ALTER TABLE project_team_dispatch RENAME TO original_dispatch`;
          yield* f.sql`ALTER TABLE restored_empty_dispatch RENAME TO project_team_dispatch`;
        } else {
          // Simulate restored corrupt storage without the UNIQUE binding constraint, using real SQL.
          yield* f.sql`CREATE TABLE restored_duplicate_dispatch AS SELECT * FROM project_team_dispatch`;
          yield* f.sql`ALTER TABLE project_team_dispatch RENAME TO original_dispatch`;
          yield* f.sql`ALTER TABLE restored_duplicate_dispatch RENAME TO project_team_dispatch`;
          yield* f.sql`INSERT INTO project_team_dispatch SELECT * FROM original_dispatch`;
          expect(yield* f.sql`SELECT count(*) AS count FROM project_team_dispatch`).toEqual([
            { count: 2 },
          ]);
        }
        yield* expectDenied(runtime.resolve(providerInstanceId, initialize));
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
  );

it.effect("the durable immutable trigger rejects a substituted original operation ID", () =>
  test(
    Effect.gen(function* () {
      const f = yield* managedFixture();
      yield* f.setup;
      const runtime = yield* install();
      const before = yield* f.sql`SELECT intent_json FROM project_team_dispatch`;
      const changed =
        yield* f.sql`UPDATE project_team_dispatch SET intent_json=json_set(intent_json,'$.request.initializeOperationId','substituted-original')`.pipe(
          Effect.result,
        );
      expect(changed._tag).toBe("Failure");
      expect(yield* f.sql`SELECT intent_json FROM project_team_dispatch`).toEqual(before);
      expect(yield* runtime.resolve(providerInstanceId, initialize)).toBe("retained-initialize");
    }),
  ),
);

for (const change of ["stage", "revision", "claim generation", "final expiry"] as const)
  it.effect(`rejects ${change} movement after the first actual journal inspection`, () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        const ready = yield* f.setup;
        let observations = 0;
        const afterInspection = Effect.gen(function* () {
          observations++;
          if (change === "final expiry") {
            if (observations === 2) yield* TestClock.setTime(ready.intent.limits.deadlineAtMs);
            return;
          }
          if (observations !== 1) return;
          if (change === "stage") yield* f.advance(ready, "session-bound");
          else if (change === "revision")
            yield* f.sql`UPDATE project_team_dispatch SET revision=revision+1`;
          else yield* f.sql`UPDATE project_team_dispatch SET claim_generation=claim_generation+1`;
        });
        const observedSql = new Proxy(f.sql, {
          get(target, key, receiver) {
            if (key !== "withTransaction") return Reflect.get(target, key, receiver);
            return <A, E, R>(operation: Effect.Effect<A, E, R>) =>
              target.withTransaction(operation).pipe(Effect.tap(() => afterInspection));
          },
        });
        const runtime = yield* install().pipe(
          Effect.provideService(SqlClient.SqlClient, observedSql),
        );
        yield* expectDenied(runtime.resolve(providerInstanceId, initialize));
        // Corrupt claim generation now fails inside the second journal transaction.
        expect(observations).toBe(change === "claim generation" ? 1 : 2);
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
  );

for (const change of ["execution flag", "revocation", "expiry"] as const)
  it.effect(`rechecks ${change} changed during the final settings read`, () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        const ready = yield* f.setup;
        const settings = yield* ServerSettingsService;
        let observations = 0;
        const observedSettings: ServerSettingsService["Service"] = {
          ...settings,
          getSettings: Effect.gen(function* () {
            yield* Effect.gen(function* () {
              observations++;
              if (observations === 2) {
                if (change === "execution flag")
                  yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
                else if (change === "expiry")
                  yield* TestClock.setTime(ready.intent.limits.deadlineAtMs);
                else {
                  const record = (yield* readCurrentState(
                    f.sql,
                    projectId,
                  )).foundationRecords!.find((record) => record.kind === "run-binding")!;
                  yield* f.change({ ...record, revision: record.revision + 1, status: "revoked" });
                }
              }
            }).pipe(Effect.orDie);
            return yield* settings.getSettings;
          }),
        };
        const runtime = yield* install().pipe(
          Effect.provideService(ServerSettingsService, observedSettings),
        );
        yield* expectDenied(runtime.resolve(providerInstanceId, initialize));
        expect(observations).toBe(2);
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
  );

for (const corruption of [
  "positive unclaimed header",
  "missing claim receipt",
  "missing claim event",
  "disagreeing effect projection",
  "terminal consistent claim",
] as const)
  it.effect(`denies ${corruption} using original claim evidence`, () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        if (corruption === "positive unclaimed header") {
          yield* f.sql`UPDATE project_team_dispatch SET stage='setup-complete',revision=2,claim_generation=1`;
        } else {
          yield* f.setup;
          const claimId = projectTeamDerivedRecordId(
            f.reserved.intent.compiledClaim.commandId,
            "claim-dispatch",
          );
          if (corruption === "missing claim receipt") {
            expect(
              (yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE command_id=${claimId}`)
                .length,
            ).toBe(1);
            yield* f.sql`DELETE FROM project_work_command_receipts WHERE command_id=${claimId}`;
          } else if (corruption === "missing claim event") {
            expect(
              (yield* f.sql`SELECT event_id FROM project_work_events WHERE command_id=${claimId}`)
                .length,
            ).toBe(1);
            yield* f.sql`DELETE FROM project_work_events WHERE command_id=${claimId}`;
          } else if (corruption === "disagreeing effect projection") {
            yield* f.sql`UPDATE project_team_effect SET status='completed' WHERE unique_key=${f.request.dispatchId}`;
          } else {
            const effect = (yield* readCurrentState(f.sql, projectId)).foundationRecords!.find(
              (record) => record.kind === "effect" && record.effectId === f.request.dispatchId,
            )!;
            yield* f.change({ ...effect, revision: effect.revision + 1, status: "canceled" });
            // Consistent terminal proof remains available for cleanup; it grants no forward lookup.
            expect(
              (yield* f.journal.readRetained(f.request.dispatchId)).fence.claimGeneration,
            ).toBe(1);
          }
        }
        const runtime = yield* install();
        yield* expectDenied(runtime.resolve(providerInstanceId, initialize));
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
  );

for (const proof of ["receipt", "event"] as const)
  it.effect(`revalidates original claim ${proof} after final settings read`, () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        yield* f.setup;
        const claimId = projectTeamDerivedRecordId(
          f.reserved.intent.compiledClaim.commandId,
          "claim-dispatch",
        );
        const settings = yield* ServerSettingsService;
        let reads = 0;
        const observedSettings: ServerSettingsService["Service"] = {
          ...settings,
          getSettings: Effect.gen(function* () {
            yield* Effect.gen(function* () {
              if (++reads === 2) {
                if (proof === "receipt")
                  yield* f.sql`DELETE FROM project_work_command_receipts WHERE command_id=${claimId}`;
                else yield* f.sql`DELETE FROM project_work_events WHERE command_id=${claimId}`;
              }
            }).pipe(Effect.orDie);
            return yield* settings.getSettings;
          }),
        };
        const runtime = yield* install().pipe(
          Effect.provideService(ServerSettingsService, observedSettings),
        );
        yield* expectDenied(runtime.resolve(providerInstanceId, initialize));
        expect(reads).toBe(2);
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
  );
