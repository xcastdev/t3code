import { expect, it } from "@effect/vitest";
import {
  ProjectWorkFoundationCommitCommand,
  ProviderDriverKind,
  TurnId,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderValidationError } from "../provider/Errors.ts";
import { makeProviderManagedSessions } from "../provider/ProviderManagedSessions.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import type { PiManagedRuntimeInstance } from "../provider/pi/PiManagedRuntime.ts";
import type { PiProductionRuntimeAssets } from "../provider/pi/PiProductionRuntime.ts";
import { layerTest, ServerSettingsService } from "../serverSettings.ts";
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
  inspectProjectTeamSessionAuthority,
  layer as authorizationLayer,
  managedActorId,
  ProjectTeamAuthorization,
  ProjectTeamAuthorizationError,
} from "./ProjectTeamAuthorization.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { makeProjectTeamProviderSessions } from "./ProjectTeamProviderSessions.ts";
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

const managedFixture = Effect.fn("providerSessionsTest.managedFixture")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  const intercepted = yield* seed("implementer", "reserved", {
    roleTools: ["pi.read", "pi.write"],
    toolIds: ["pi.read", "pi.write"],
    issueCredential: false,
    nativeSessionId: null,
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
      commandId: "provider-sessions-limits",
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
  const request = {
    dispatchId: "provider-sessions-dispatch",
    claim,
    git: {
      effectId: "provider-sessions-dispatch",
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
    setupId: "provider-sessions-setup",
    initializeOperationId: "retained-initialize",
    assignmentOperationId: "retained-assignment",
    assignment:
      "  Implement the approved task\n\nKeep [the cited decision](t3://decision/original) and `literal` bytes.\n  ",
  } satisfies ProjectTeamDispatchRequest;
  // These observations exercise durable stage sequencing only, never actual Git/setup/native joins.
  const journal = yield* makeProjectTeamDispatchJournal({
    ...options,
    verifyStage: () => Effect.void,
  });
  const reserved = yield* journal.reserve(request);
  const claimEffect = journal.claimEffect(reserved.fence);
  const advance = Effect.fn("providerSessionsTest.advance")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    stage: (typeof stages)[number],
  ) {
    if (stage === "session-bound") {
      // Actual repository transition with a synthetic identity; no native session was opened.
      const binding = (yield* readCurrentState(sql, projectId)).foundationRecords!.find(
        (record) => record.kind === "run-binding",
      )!;
      yield* change({
        ...binding,
        revision: binding.revision + 1,
        status: "running",
        sessionId: "synthetic-provider-session",
      });
    }
    return yield* journal.advanceStage(snapshot.fence, {
      receiptId: `provider-sessions-${stage}`,
      stage,
      evidence: { fixture: "synthetic-stage-observation" },
    });
  });
  const setup = Effect.gen(function* () {
    const claimed = yield* claimEffect;
    return yield* advance(yield* advance(claimed, "workspace-ready"), "setup-complete");
  });
  const change = Effect.fn("providerSessionsTest.change")(function* (
    record: Parameters<typeof decodeRecord>[0],
  ) {
    const decoded = decodeRecord(record);
    yield* repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: `provider-sessions-authority-change-${decoded.recordId}-${decoded.revision}`,
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution,
        records: [decoded],
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

const ownedScope = Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  return scope;
});

const unused = () => Effect.die("Controlled producer fixture cannot execute Pi operations");
const makeRuntime = () =>
  ({
    inspect: unused(),
    prepareOperation: unused,
    readSession: unused,
    readThread: unused,
    requestStop: unused,
    stopAll: unused(),
    authorizeSkills: unused,
    discoverNativeSkills: unused,
  }) satisfies PiManagedRuntimeInstance;

const barrier = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const wait = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
  return { entered, release, wait };
});

type Boundary = "initialize" | "assignment";

// Actual SQL, registry and private managed-call primitive; the selected mock observes the
// producer boundary only. It proves no full ProviderService, native Pi, Git or setup execution.
const install = Effect.fn("providerSessionsTest.install")(function* (
  hold: Effect.Effect<void> = Effect.void,
) {
  const registry = yield* makeProjectTeamPiRuntime();
  const driverScope = yield* ownedScope;
  const producerScope = yield* ownedScope;
  const runtime = makeRuntime();
  let activeLoans = 0;
  let finishedLoans = 0;
  const assets: PiProductionRuntimeAssets = {
    runtimeFiles: [],
    revalidate: Effect.void,
    borrow: (operation) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          activeLoans++;
        }),
        () => operation,
        () =>
          Effect.sync(() => {
            activeLoans--;
            finishedLoans++;
          }),
      ),
  };
  yield* registry
    .publishAssets(providerInstanceId, assets, runtime)
    .pipe(Effect.provideService(Scope.Scope, driverScope));
  let adapter: object = {};
  let boundaryEntries = 0;
  const initialized: Array<{
    input: ProviderSessionStartInput;
    primaryProjectRoot: string | undefined;
  }> = [];
  const assignments: Array<ProviderSendTurnInput> = [];
  const managed = yield* makeProviderManagedSessions(() => Effect.succeed(adapter));
  const service = yield* ProviderService.pipe(
    Effect.provide(
      Layer.mock(ProviderService)({
        startSession: (thread, input) =>
          Effect.gen(function* () {
            boundaryEntries++;
            yield* hold;
            const call = yield* managed.current("start", thread, input.providerInstanceId, adapter);
            if (call === undefined)
              return yield* Effect.die("Expected privately registered start loan");
            initialized.push({ input, primaryProjectRoot: call.primaryProjectRoot });
            return {
              provider: ProviderDriverKind.make("piAgent"),
              providerInstanceId,
              status: "ready",
              runtimeMode: "approval-required",
              threadId: thread,
              cwd: input.cwd,
              createdAt: at,
              updatedAt: at,
            } satisfies ProviderSession;
          }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            boundaryEntries++;
            yield* hold;
            const call = yield* managed.current(
              "assignment",
              input.threadId,
              providerInstanceId,
              adapter,
            );
            if (call === undefined)
              return yield* Effect.die("Expected privately registered assignment loan");
            expect(call.assignment).toBe(input.input);
            assignments.push(input);
            return { threadId: input.threadId, turnId: TurnId.make("controlled-turn") };
          }),
      }),
    ),
  );
  managed.bind(service);
  const producer = yield* makeProjectTeamProviderSessions(options).pipe(
    Effect.provideService(ProviderService, service),
    Effect.provideService(ProjectTeamPiRuntime, registry),
    Effect.provideService(Scope.Scope, producerScope),
  );
  return {
    producer,
    producerScope,
    driverScope,
    registry,
    initialized,
    assignments,
    replaceAdapter: () =>
      Effect.sync(() => {
        adapter = {};
      }),
    replaceInstance: registry.publishAssets(providerInstanceId, assets, makeRuntime()),
    counts: () => ({ boundaryEntries, activeLoans, finishedLoans }),
  };
});

const observeSql = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    dispatches: yield* sql`SELECT * FROM project_team_dispatch`,
    receipts: yield* sql`SELECT * FROM project_team_dispatch_receipt ORDER BY receipt_id`,
    events: yield* sql`SELECT * FROM project_work_events ORDER BY sequence`,
    effects: yield* sql`SELECT * FROM project_team_effect ORDER BY record_id`,
    operations: yield* sql`SELECT * FROM project_team_pi_operation ORDER BY operation_id`,
    state: yield* readCurrentState(sql, projectId),
    authSessions: yield* sql`SELECT * FROM auth_sessions ORDER BY session_id`,
  };
});
const expectDenied = Effect.fn("providerSessionsTest.expectDenied")(function* <E, R>(
  operation: Effect.Effect<unknown, E, R>,
) {
  const result = yield* operation.pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ProviderValidationError);
});
const stageFor = Effect.fn("providerSessionsTest.stageFor")(function* (
  f: Effect.Success<ReturnType<typeof managedFixture>>,
  boundary: Boundary,
) {
  const ready = yield* f.setup;
  if (boundary === "initialize") return ready;
  return yield* f.advance(yield* f.advance(ready, "session-bound"), "assignment-intent");
});
const invoke = (
  installed: Effect.Success<ReturnType<typeof install>>,
  boundary: Boundary,
  dispatchId: string,
) =>
  boundary === "initialize"
    ? installed.producer.initialize(dispatchId)
    : installed.producer.assign(dispatchId);

it.effect(
  "initializes the original SQL-bound model, instance and assigned cwd while lending the primary root",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        let ready = yield* f.setup;
        const first = yield* install();
        const before = yield* observeSql;
        yield* first.producer.initialize(f.request.dispatchId);
        yield* first.producer.initialize(f.request.dispatchId);
        expect(yield* observeSql).toEqual(before);
        ready = yield* f.advance(ready, "session-bound");
        const second = yield* install();
        const bound = yield* observeSql;
        yield* second.producer.initialize(f.request.dispatchId);
        expect(yield* observeSql).toEqual(bound);
        for (const installed of [first, second]) {
          for (const entry of installed.initialized) {
            expect(entry).toEqual({
              primaryProjectRoot: "/workspace",
              input: {
                threadId,
                providerInstanceId,
                provider: "piAgent",
                modelSelection: { instanceId: providerInstanceId, model: "test" },
                cwd: "/workspace-assigned",
                runtimeMode: "approval-required",
              },
            });
          }
          expect(installed.counts().activeLoans).toBe(0);
        }
        expect(first.initialized).toHaveLength(2);
        expect(second.initialized).toHaveLength(1);
        expect(ready.fence.stage).toBe("session-bound");
      }),
    ),
);

it.effect(
  "sends original assignment bytes at assignment-intent without recording observation or completion",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        const ready = yield* stageFor(f, "assignment");
        const installed = yield* install();
        const before = yield* observeSql;
        const result = yield* installed.producer.assign(f.request.dispatchId);
        expect(result).toEqual({ threadId, turnId: "controlled-turn" });
        expect(installed.assignments).toEqual([
          {
            threadId,
            input: f.request.assignment,
            modelSelection: { instanceId: providerInstanceId, model: "test" },
          },
        ]);
        expect(Buffer.from(installed.assignments[0]!.input!)).toEqual(
          Buffer.from(ready.intent.request.assignment),
        );
        expect(yield* observeSql).toEqual(before);
        expect(installed.counts()).toEqual({
          boundaryEntries: 1,
          activeLoans: 0,
          finishedLoans: 1,
        });
        yield* f.advance(ready, "assignment-observed");
        const observed = yield* observeSql;
        yield* expectDenied(installed.producer.assign(f.request.dispatchId));
        expect(yield* observeSql).toEqual(observed);
        expect(installed.assignments).toHaveLength(1);
      }),
    ),
);

for (const boundary of ["initialize", "assignment"] as const) {
  for (const stage of [
    "reserved",
    "workspace-ready",
    "setup-complete",
    "session-bound",
    "assignment-intent",
    "assignment-observed",
  ] as const) {
    if (boundary === "initialize" && (stage === "setup-complete" || stage === "session-bound"))
      continue;
    if (boundary === "assignment" && stage === "assignment-intent") continue;
    it.effect(`denies ${boundary} from ${stage} before entering its provider boundary`, () =>
      test(
        Effect.gen(function* () {
          const f = yield* managedFixture();
          let ready = yield* f.claimEffect;
          for (const next of stages) {
            if (ready.fence.stage === stage) break;
            ready = yield* f.advance(ready, next);
          }
          const installed = yield* install();
          const before = yield* observeSql;
          yield* expectDenied(invoke(installed, boundary, f.request.dispatchId));
          expect(yield* observeSql).toEqual(before);
          expect(installed.counts().boundaryEntries).toBe(0);
        }),
      ),
    );
  }
  it.effect(
    `denies ${boundary} with a missing dispatch or a forged forward stage without the committed claim`,
    () =>
      test(
        Effect.gen(function* () {
          const f = yield* managedFixture();
          const installed = yield* install();
          yield* f.sql`UPDATE project_team_dispatch SET stage=${boundary === "initialize" ? "setup-complete" : "assignment-intent"}`;
          const before = yield* observeSql;
          yield* expectDenied(invoke(installed, boundary, "missing"));
          yield* expectDenied(invoke(installed, boundary, f.request.dispatchId));
          expect(yield* observeSql).toEqual(before);
          expect(installed.counts().boundaryEntries).toBe(0);
        }),
      ),
  );
}

type Fixture = Effect.Success<ReturnType<typeof managedFixture>>;
type Installed = Effect.Success<ReturnType<typeof install>>;
const changes = [
  "project flag",
  "execution flag",
  "producer closed",
  "expired deadline",
  "expired lease",
  "changed lease",
  "stale credential",
  "changed generation",
  "changed revision",
  "changed claim generation",
  "changed intent",
  "changed stage",
  "adapter replacement",
  "Pi instance replacement",
  "Pi instance closed",
] as const;
const applyChange = Effect.fn("providerSessionsTest.applyChange")(function* (
  change: (typeof changes)[number],
  f: Fixture,
  installed: Installed,
  snapshot: ProjectTeamDispatchSnapshot,
  boundary: Boundary,
) {
  if (change === "project flag" || change === "execution flag") {
    const settings = yield* ServerSettingsService;
    yield* settings.updateSettings({
      [change === "project flag" ? "projectWorkEnabled" : "projectTeamExecutionEnabled"]: false,
    });
  } else if (change === "producer closed") {
    yield* Scope.close(installed.producerScope, Exit.void);
  } else if (change === "expired deadline") {
    yield* TestClock.setTime(snapshot.intent.limits.deadlineAtMs);
  } else if (change === "expired lease") {
    // Restored authority fixture: update the actual reducer checkpoint and matching projection.
    yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.attempts[0].leasedUntil',${at}) WHERE project_id=${projectId}`;
    yield* f.sql`UPDATE project_work_attempts SET leased_until=${at}`;
  } else if (change === "changed lease") {
    // Restored authority fixture, rather than an ordinary lease renewal.
    yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.attempts[0].leaseToken','replacement-lease') WHERE project_id=${projectId}`;
    yield* f.sql`UPDATE project_work_attempts SET lease_token='replacement-lease'`;
  } else if (change === "stale credential") {
    const binding = (yield* readCurrentState(f.sql, projectId)).foundationRecords!.find(
      (r) => r.kind === "run-binding",
    )!;
    yield* f.change({ ...binding, revision: binding.revision + 1, status: "revoked" });
  } else if (change === "changed generation") {
    yield* f.sql`UPDATE project_team_run_binding SET generation=generation+1 WHERE record_id='binding'`;
  } else if (change === "changed revision") {
    yield* f.sql`UPDATE project_team_dispatch SET revision=revision+1`;
  } else if (change === "changed claim generation") {
    yield* f.sql`UPDATE project_team_dispatch SET claim_generation=claim_generation+1`;
  } else if (change === "changed intent") {
    // Restored/corrupt storage fixture only: the normal immutable trigger is tested separately.
    yield* f.sql`DROP TRIGGER project_team_dispatch_immutable`;
    yield* f.sql`UPDATE project_team_dispatch SET intent_json=json_set(intent_json,'$.request.assignment','substituted assignment')`;
  } else if (change === "changed stage") {
    yield* f.advance(snapshot, boundary === "initialize" ? "session-bound" : "assignment-observed");
  } else if (change === "adapter replacement") {
    yield* installed.replaceAdapter();
  } else if (change === "Pi instance replacement") {
    yield* installed.replaceInstance;
  } else {
    yield* Scope.close(installed.driverScope, Exit.void);
  }
});

for (const boundary of ["initialize", "assignment"] as const) {
  for (const change of changes) {
    it.effect(`rechecks ${change} during a held ${boundary} source boundary`, () =>
      test(
        Effect.gen(function* () {
          const f = yield* managedFixture();
          const snapshot = yield* stageFor(f, boundary);
          const paused = yield* barrier;
          const installed = yield* install(paused.wait);
          const pending = yield* invoke(installed, boundary, f.request.dispatchId).pipe(
            Effect.forkScoped,
          );
          yield* Effect.raceFirst(
            Deferred.await(paused.entered),
            Fiber.join(pending).pipe(
              Effect.flatMap(() => Effect.die("Producer did not reach its held boundary")),
            ),
          );
          expect(installed.counts()).toEqual({
            boundaryEntries: 1,
            activeLoans: 1,
            finishedLoans: 0,
          });
          yield* applyChange(change, f, installed, snapshot, boundary);
          const beforeRelease = yield* observeSql;
          yield* Deferred.succeed(paused.release, undefined);
          yield* expectDenied(Fiber.join(pending));
          expect(yield* observeSql).toEqual(beforeRelease);
          expect(installed.initialized).toEqual([]);
          expect(installed.assignments).toEqual([]);
          expect(installed.counts()).toEqual({
            boundaryEntries: 1,
            activeLoans: 0,
            finishedLoans: 1,
          });
        }),
      ),
    );
  }
  for (const change of [
    "project flag",
    "execution flag",
    "producer closed",
    "expired deadline",
    "expired lease",
    "stale credential",
    "changed generation",
  ] as const) {
    it.effect(`denies ${boundary} after ${change} without entering the provider boundary`, () =>
      test(
        Effect.gen(function* () {
          const f = yield* managedFixture();
          const snapshot = yield* stageFor(f, boundary);
          const installed = yield* install();
          yield* applyChange(change, f, installed, snapshot, boundary);
          const before = yield* observeSql;
          yield* expectDenied(invoke(installed, boundary, f.request.dispatchId));
          expect(yield* observeSql).toEqual(before);
          expect(installed.counts().boundaryEntries).toBe(0);
          expect(installed.counts().activeLoans).toBe(0);
        }),
      ),
    );
  }
}

it.effect(
  "ignores mutation of the caller's reservation inputs and preserves original SQL intent",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        const ready = yield* f.setup;
        const installed = yield* install();
        f.request.git.primaryRoot = "/caller-primary";
        f.request.git.worktreePath = "/caller-worktree";
        f.request.assignment = "caller substitution";
        if (f.request.claim.transition?.kind !== "claim")
          return yield* Effect.die("Missing claim fixture");
        f.request.claim.transition.binding.model = "caller-model";
        const before = yield* observeSql;
        yield* installed.producer.initialize(f.request.dispatchId);
        expect(installed.initialized[0]?.primaryProjectRoot).toBe(
          ready.intent.request.git.primaryRoot,
        );
        expect(installed.initialized[0]?.input.cwd).toBe(ready.intent.request.git.worktreePath);
        expect(installed.initialized[0]?.input.modelSelection?.model).toBe("test");
        expect(yield* observeSql).toEqual(before);
        yield* f.advance(yield* f.advance(ready, "session-bound"), "assignment-intent");
        const assignmentBefore = yield* observeSql;
        yield* installed.producer.assign(f.request.dispatchId);
        expect(installed.assignments[0]?.input).toBe(ready.intent.request.assignment);
        expect(yield* observeSql).toEqual(assignmentBefore);
      }),
    ),
);

it.effect("the actual immutable SQL trigger refuses replacement assignment content", () =>
  test(
    Effect.gen(function* () {
      const f = yield* managedFixture();
      yield* stageFor(f, "assignment");
      const installed = yield* install();
      const before = yield* observeSql;
      const changed =
        yield* f.sql`UPDATE project_team_dispatch SET intent_json=json_set(intent_json,'$.request.assignment','replacement')`.pipe(
          Effect.result,
        );
      expect(changed._tag).toBe("Failure");
      expect(yield* observeSql).toEqual(before);
      yield* installed.producer.assign(f.request.dispatchId);
      expect(installed.assignments[0]?.input).toBe(f.request.assignment);
      expect(yield* observeSql).toEqual(before);
    }),
  ),
);

it.effect(
  "reserved session inspection preserves existing credentials and ordinary running-only authorization",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        const ready = yield* f.setup;
        const authorization = yield* ProjectTeamAuthorization;
        yield* f.sql`INSERT INTO auth_sessions (session_id,subject,scopes,method,issued_at,expires_at)
      VALUES ('existing-session',${managedActorId({ providerInstanceId, threadId })},'[]','mcp',${at},'2030-01-01T00:00:00.000Z')`;
        const before = yield* observeSql;
        const identity = { providerInstanceId, threadId };
        const authority = yield* inspectProjectTeamSessionAuthority(authorization, identity);
        expect(authority?.binding.status).toBe("reserved");
        expect(authority?.binding.sessionId).toBeUndefined();
        const transition = ready.intent.compiledClaim.transition;
        if (transition?.kind !== "claim") return yield* Effect.die("Missing original claim");
        expect(authority?.binding.recordId).toBe(transition.binding.recordId);
        if (authority === undefined) return yield* Effect.die("Missing reserved authority");
        const ordinary = yield* authorization
          .resolve({
            actor: { kind: "agent", id: managedActorId(authority.credential) },
            managed: authority.credential,
          })
          .pipe(Effect.result);
        expect(ordinary._tag).toBe("Failure");
        if (ordinary._tag === "Failure")
          expect(ordinary.failure).toBeInstanceOf(ProjectTeamAuthorizationError);
        const installed = yield* install();
        yield* installed.producer.initialize(f.request.dispatchId);
        expect(yield* observeSql).toEqual(before);
        expect(
          yield* f.sql`SELECT revoked_at FROM auth_sessions WHERE session_id='existing-session'`,
        ).toEqual([{ revoked_at: null }]);
      }),
    ),
);

it.effect(
  "private reserved inspection rejects unknown factories and ends with its actual authorization scope",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* managedFixture();
        yield* f.setup;
        const identity = { providerInstanceId, threadId };
        const unknown = yield* ProjectTeamAuthorization.pipe(
          Effect.provide(Layer.mock(ProjectTeamAuthorization)({})),
        );
        const unregistered = yield* inspectProjectTeamSessionAuthority(unknown, identity).pipe(
          Effect.result,
        );
        expect(unregistered._tag).toBe("Failure");
        if (unregistered._tag === "Failure")
          expect(unregistered.failure).toBeInstanceOf(ProjectTeamAuthorizationError);
        const authorityScope = yield* ownedScope;
        const context = yield* Layer.buildWithScope(authorizationLayer, authorityScope);
        const owned = yield* ProjectTeamAuthorization.pipe(Effect.provide(context));
        const before = yield* observeSql;
        expect((yield* inspectProjectTeamSessionAuthority(owned, identity))?.binding.status).toBe(
          "reserved",
        );
        yield* Scope.close(authorityScope, Exit.void);
        const closed = yield* inspectProjectTeamSessionAuthority(owned, identity).pipe(
          Effect.result,
        );
        expect(closed._tag).toBe("Failure");
        if (closed._tag === "Failure")
          expect(closed.failure).toBeInstanceOf(ProjectTeamAuthorizationError);
        expect(yield* observeSql).toEqual(before);
      }),
    ),
);
