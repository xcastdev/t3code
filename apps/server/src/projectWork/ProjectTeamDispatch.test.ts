import { expect, it } from "@effect/vitest";
import { ProjectWorkFoundationCommitCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  at,
  attribution,
  projectId,
  seed,
  scoped,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import {
  makeProjectTeamDispatch,
  ProjectTeamDispatchError,
  type ProjectTeamDispatchPorts,
  type ProjectTeamDispatchReceipt,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatch.ts";

const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);

const fixture = Effect.gen(function* () {
  const repository = yield* ProjectWorkRepository;
  const sql = yield* SqlClient.SqlClient;
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  // The real fixture commits approvals and the execution grant; intercept only its final claim.
  const result = yield* seed("implementer", "reserved", {
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
          return Effect.fail(
            new ProjectWorkPolicyError("invalid-state", "Fixture retains the uncommitted claim"),
          );
        }
        return repository.execute(command);
      },
    }),
    Effect.result,
  );
  expect(result._tag).toBe("Failure");
  if (!pending || pending.transition?.kind !== "claim")
    return yield* Effect.die("Fixture did not capture its claim");
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "configure-limits",
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
    dispatchId: "dispatch-intent",
    claim,
    git: {
      effectId: "dispatch-intent",
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
    setupId: "setup",
    initializeOperationId: "initialize",
    assignmentOperationId: "assignment",
    assignment: "Implement the approved task",
  };
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  return { sql, repository, request, journal };
});

// Admission and claim use actual SQLite. The remaining Root ports are controlled receipts,
// not managed Git/setup/native-runtime evidence for the combined V8 gate.
const harness = Effect.gen(function* () {
  const f = yield* fixture;
  let snapshot = yield* f.journal.reserve(f.request);
  const owner = {};
  const recovery = {};
  type Setup = { readonly setupId: string };
  type Session = { readonly operationId: string; readonly cwd: string };
  type Assignment = { readonly operationId: string };
  type Receipt = ProjectTeamDispatchReceipt<Setup, Session, Assignment>;
  let receipt: Receipt | undefined;
  let retainedAssignment: Assignment | undefined;
  let active = false;
  let authorized = true;
  const events: string[] = [];
  const failure = new ProjectTeamDispatchError({ reason: "Root fence revoked" });
  const cleanupFailure = new ProjectTeamDispatchError({ reason: "Root cleanup uncertain" });
  const workspace = {
    assignment: f.request.git,
    primary: { path: "/workspace", dev: "1", ino: "1" },
    worktree: { path: "/workspace-assigned", dev: "1", ino: "2" },
    common: { path: "/workspace/.git", dev: "1", ino: "3" },
    gitDirectory: { path: "/workspace/.git/worktrees/assigned", dev: "1", ino: "4" },
    initialHeadOid: "a".repeat(40),
    pointerAndConfigurationHash: "b".repeat(64),
  };
  type Ports = ProjectTeamDispatchPorts<
    object,
    object,
    Setup,
    Session,
    Assignment,
    ProjectTeamDispatchError
  >;
  const ports: { -readonly [K in keyof Ports]: Ports[K] } = {
    withExecutor: (id, run) =>
      Effect.gen(function* () {
        if (active) return { _tag: "Busy" as const };
        active = true;
        return yield* Effect.suspend(() => run(owner)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active = false;
            }),
          ),
        );
      }),
    withRecoveryExecutor: (claim, run) =>
      Effect.gen(function* () {
        if (claim !== recovery) return yield* failure;
        if (active) return { _tag: "Busy" as const };
        active = true;
        return yield* Effect.suspend(() => run(owner, snapshot)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active = false;
            }),
          ),
        );
      }),
    inspect: () => Effect.succeed(snapshot),
    claimEffect: (_, expected) =>
      f.journal.claimEffect(expected).pipe(
        Effect.map((claimed) => {
          snapshot = claimed;
          events.push("claim");
          return snapshot;
        }),
        Effect.mapError(() => failure),
      ),
    assertCurrent: (candidate, fence) =>
      Effect.suspend(() =>
        candidate === owner &&
        authorized &&
        fence.dispatchId === snapshot.fence.dispatchId &&
        fence.revision === snapshot.fence.revision &&
        fence.claimGeneration === snapshot.fence.claimGeneration &&
        fence.stage === snapshot.fence.stage
          ? Effect.succeed(snapshot)
          : Effect.fail(failure),
      ),
    readReceipt: () =>
      Effect.sync(() => {
        events.push("read-receipt");
        return receipt;
      }),
    appendStage: (_, expected, next) =>
      Effect.sync(() => {
        expect(expected.fence).toEqual(snapshot.fence);
        receipt = next;
        snapshot = {
          ...snapshot,
          fence: { ...snapshot.fence, stage: next.stage, revision: snapshot.fence.revision + 1 },
        };
        events.push(next.stage);
        return snapshot;
      }),
    withWorkspace: (_, _snapshot, use) =>
      Effect.sync(() => {
        events.push("workspace");
        return { workspace };
      }).pipe(Effect.flatMap(use)),
    setup: () =>
      Effect.sync(() => {
        events.push("setup");
        return { setupId: f.request.setupId };
      }),
    initialize: (_, current, physical, setup) =>
      Effect.sync(() => {
        expect(current.fence.stage).toBe("setup-complete");
        expect(setup.setupId).toBe(f.request.setupId);
        expect(physical).toBe(workspace);
        events.push("initialize");
        return { operationId: f.request.initializeOperationId, cwd: physical.worktree.path };
      }),
    sendAssignment: (_, current, session) =>
      Effect.sync(() => {
        expect(current.fence.stage).toBe("assignment-intent");
        expect(session.cwd).toBe(f.request.git.worktreePath);
        events.push("send");
        retainedAssignment = { operationId: f.request.assignmentOperationId };
        return { _tag: "Observed" as const, receipt: retainedAssignment };
      }),
    readAssignmentObservation: () =>
      Effect.sync(() => {
        events.push("read-assignment");
        return retainedAssignment;
      }),
    recordUncertain: () =>
      Effect.sync(() => {
        events.push("uncertain");
      }),
    stopAndJoin: () =>
      Effect.sync(() => {
        events.push("joined");
      }),
  };
  return {
    ...f,
    ports,
    recovery,
    events,
    failure,
    cleanupFailure,
    getSnapshot: () => snapshot,
    setSnapshot: (value: ProjectTeamDispatchSnapshot) => {
      snapshot = value;
    },
    getReceipt: () => receipt,
    setReceipt: (value: Receipt | undefined) => {
      receipt = value;
    },
    revoke: () => {
      authorized = false;
    },
    clearAssignment: () => {
      retainedAssignment = undefined;
    },
    make: () => makeProjectTeamDispatch(ports),
  };
});

it.effect(
  "orders durable claim, completed setup, session and assignment intent before sending",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        const result = yield* h.make().dispatch(h.request.dispatchId);
        expect(result._tag).toBe("Observed");
        expect(h.events).toEqual([
          "claim",
          "workspace",
          "workspace-ready",
          "setup",
          "setup-complete",
          "initialize",
          "session-bound",
          "assignment-intent",
          "send",
          "assignment-observed",
        ]);
        expect(h.getSnapshot().fence).toEqual({
          dispatchId: h.request.dispatchId,
          revision: 6,
          claimGeneration: 1,
          stage: "assignment-observed",
        });
        const retry = yield* h.make().dispatch(h.request.dispatchId);
        expect(retry._tag).toBe("RecoveryRequired");
        expect(h.events.filter((e) => e === "send")).toHaveLength(1);
        expect(h.events).not.toContain("joined");
      }),
    ),
);

it.effect(
  "holds the combination loan through durable workspace persistence and retains its receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        let held = false;
        const loan = h.ports.withWorkspace;
        const append = h.ports.appendStage;
        const integration = {
          version: 1 as const,
          selectionSha256: "a".repeat(64),
          baseSha: "b".repeat(40),
          combinedHeadSha: "c".repeat(40),
          combinedTree: "d".repeat(40),
          sourceHeads: ["e".repeat(40)],
        };
        h.ports.withWorkspace = (owner, snapshot, use) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              held = true;
            }),
            () => loan(owner, snapshot, (evidence) => use({ ...evidence, integration })),
            () =>
              Effect.sync(() => {
                held = false;
                h.events.push("loan-released");
              }),
          );
        h.ports.appendStage = (owner, snapshot, receipt) => {
          if (receipt.stage === "workspace-ready") expect(held).toBe(true);
          else expect(held).toBe(false);
          expect(receipt.integration).toEqual(integration);
          return append(owner, snapshot, receipt);
        };
        expect((yield* h.make().dispatch(h.request.dispatchId))._tag).toBe("Observed");
        expect(h.events.indexOf("loan-released")).toBe(h.events.indexOf("workspace-ready") + 1);
        expect(h.getReceipt()?.integration).toEqual(integration);
      }),
    ),
);

it.effect("releases the combination loan before cleanup when workspace persistence fails", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      let held = false;
      const loan = h.ports.withWorkspace;
      const join = h.ports.stopAndJoin;
      h.ports.withWorkspace = (owner, snapshot, use) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            held = true;
          }),
          () => loan(owner, snapshot, use),
          () =>
            Effect.sync(() => {
              held = false;
              h.events.push("loan-released");
            }),
        );
      h.ports.appendStage = () =>
        Effect.fail(new ProjectTeamDispatchError({ reason: "Storage refused workspace" }));
      h.ports.stopAndJoin = (...args) => {
        expect(held).toBe(false);
        return join(...args);
      };
      expect((yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(h.events).toEqual(["claim", "workspace", "loan-released", "joined"]);
    }),
  ),
);

it.effect("awaits setup; a concurrent ordinary caller leaves the winner alone", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const started = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<{ setupId: string }>();
      h.ports.setup = () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(completed)));
      const adapter = h.make();
      const winner = yield* adapter.dispatch(h.request.dispatchId).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(h.events).not.toContain("initialize");
      expect((yield* adapter.dispatch(h.request.dispatchId))._tag).toBe("Busy");
      expect(h.events).not.toContain("joined");
      yield* Deferred.succeed(completed, { setupId: h.request.setupId });
      expect((yield* Fiber.join(winner))._tag).toBe("Observed");
      expect(h.events.filter((e) => e === "claim")).toHaveLength(1);
    }),
  ),
);

it.effect("initial authority denial launches and stops nothing", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      h.revoke();
      expect((yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(h.events).toEqual([]);
    }),
  ),
);

for (const boundary of ["workspace", "setup", "initialize", "sendAssignment"] as const) {
  it.effect(`revocation during ${boundary} prevents later stages and joins ownership`, () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        if (boundary === "workspace") {
          const call = h.ports.withWorkspace;
          h.ports.withWorkspace = (owner, snapshot, use) =>
            call(owner, snapshot, (evidence) =>
              Effect.sync(h.revoke).pipe(Effect.andThen(use(evidence))),
            );
        }
        if (boundary === "setup") {
          const call = h.ports.setup;
          h.ports.setup = (...args) => call(...args).pipe(Effect.tap(() => Effect.sync(h.revoke)));
        }
        if (boundary === "initialize") {
          const call = h.ports.initialize;
          h.ports.initialize = (...args) =>
            call(...args).pipe(Effect.tap(() => Effect.sync(h.revoke)));
        }
        if (boundary === "sendAssignment") {
          const call = h.ports.sendAssignment;
          h.ports.sendAssignment = (...args) =>
            call(...args).pipe(Effect.tap(() => Effect.sync(h.revoke)));
        }
        const result = yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        expect(h.getSnapshot().fence.stage).toBe(
          {
            workspace: "reserved",
            setup: "workspace-ready",
            initialize: "setup-complete",
            sendAssignment: "assignment-intent",
          }[boundary],
        );
        expect(h.events.at(-1)).toBe("joined");
        expect(h.events).not.toContain("assignment-observed");
      }),
    ),
  );
}

it.effect("lost workspace commit response recovers only the exact Root receipt", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const append = h.ports.appendStage;
      h.ports.appendStage = (...args) =>
        append(...args).pipe(Effect.andThen(Effect.fail(h.failure)));
      expect((yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(h.getSnapshot().fence.stage).toBe("workspace-ready");
      h.ports.appendStage = append;
      expect((yield* h.make().dispatch(h.request.dispatchId))._tag).toBe("RecoveryRequired");
      expect((yield* h.make().resume(h.recovery))._tag).toBe("Observed");
      expect(h.events.filter((e) => e === "workspace")).toHaveLength(1);
      expect(h.events.filter((e) => e === "claim")).toHaveLength(1);
    }),
  ),
);

for (const stage of ["workspace-ready", "setup-complete", "session-bound"] as const) {
  it.effect(`missing ${stage} receipt stops recovery instead of guessing or repeating`, () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        const append = h.ports.appendStage;
        h.ports.appendStage = (...args) =>
          append(...args).pipe(
            Effect.flatMap((value) =>
              args[2].stage === stage ? Effect.fail(h.failure) : Effect.succeed(value),
            ),
          );
        yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit);
        h.ports.appendStage = append;
        h.setReceipt(undefined);
        const before = [...h.events];
        expect((yield* h.make().resume(h.recovery).pipe(Effect.exit))._tag).toBe("Failure");
        expect(h.events.slice(before.length)).toEqual(["read-receipt", "joined"]);
        expect(h.getSnapshot().fence.stage).toBe(stage);
      }),
    ),
  );
}

it.effect("uncertain assignment is retained and never blindly resent", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      h.ports.sendAssignment = () =>
        Effect.sync(() => {
          h.events.push("send-uncertain");
          return { _tag: "Uncertain" as const, cause: Cause.fail(h.failure) };
        });
      expect((yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(h.events.slice(-3)).toEqual(["send-uncertain", "uncertain", "joined"]);
      expect(h.getSnapshot().fence.stage).toBe("assignment-intent");
      const before = [...h.events];
      expect((yield* h.make().resume(h.recovery).pipe(Effect.exit))._tag).toBe("Failure");
      expect(h.events.slice(before.length)).toEqual([
        "read-receipt",
        "read-assignment",
        "uncertain",
        "joined",
      ]);
      expect(h.events.filter((e) => e === "send-uncertain")).toHaveLength(1);
    }),
  ),
);

it.effect("lost send response is recovered through native observation without a second send", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const send = h.ports.sendAssignment;
      h.ports.sendAssignment = (...args) =>
        send(...args).pipe(Effect.andThen(Effect.fail(h.failure)));
      expect((yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      h.ports.sendAssignment = send;
      expect((yield* h.make().resume(h.recovery))._tag).toBe("Observed");
      expect(h.events.filter((e) => e === "send")).toHaveLength(1);
      expect(h.events).toContain("read-assignment");
    }),
  ),
);

it.effect("retains original, uncertainty recording and cleanup failure causes", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      h.ports.sendAssignment = () => Effect.fail(h.failure);
      const recordFailure = new ProjectTeamDispatchError({ reason: "Uncertainty receipt failed" });
      h.ports.recordUncertain = () => Effect.fail(recordFailure);
      h.ports.stopAndJoin = () => Effect.fail(h.cleanupFailure);
      const exit = yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
        expect(errors).toEqual([h.failure, recordFailure, h.cleanupFailure]);
      }
    }),
  ),
);

for (const boundary of ["workspace", "setup", "initialize", "sendAssignment"] as const) {
  it.effect(`interruption during ${boundary} joins cleanup before returning`, () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        const entered = yield* Deferred.make<void>();
        const cleanupEntered = yield* Deferred.make<void>();
        const cleanupComplete = yield* Deferred.make<void>();
        const wait = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
        if (boundary === "workspace") h.ports.withWorkspace = () => wait;
        if (boundary === "setup") h.ports.setup = () => wait;
        if (boundary === "initialize") h.ports.initialize = () => wait;
        if (boundary === "sendAssignment") h.ports.sendAssignment = () => wait;
        h.ports.stopAndJoin = () =>
          Deferred.succeed(cleanupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(cleanupComplete)),
            Effect.andThen(Effect.sync(() => h.events.push("joined"))),
            Effect.asVoid,
          );
        const dispatch = yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const interrupt = yield* Fiber.interrupt(dispatch).pipe(Effect.forkChild);
        yield* Deferred.await(cleanupEntered);
        expect(h.events).not.toContain("joined");
        yield* Deferred.succeed(cleanupComplete, undefined);
        yield* Fiber.join(interrupt);
        const exit = yield* Fiber.await(dispatch);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(h.events.at(-1)).toBe("joined");
        expect(h.events).not.toContain("assignment-observed");
        expect(h.events.includes("uncertain")).toBe(boundary === "sendAssignment");
      }),
    ),
  );
}

it.effect("unregistered recovery object grants no work or cleanup ownership", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      expect((yield* h.make().resume({}).pipe(Effect.exit))._tag).toBe("Failure");
      expect(h.events).toEqual([]);
    }),
  ),
);

it.effect("actual expired SQLite claim cannot start workspace effects", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      yield* TestClock.setTime(Date.parse(at) + 2001);
      expect((yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(h.events).toEqual([]);
    }),
  ),
);

it.effect("a changed fence returned by Root fails before acquiring resources", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      h.ports.assertCurrent = () =>
        Effect.succeed({
          ...h.getSnapshot(),
          fence: { ...h.getSnapshot().fence, claimGeneration: 1 },
        });
      expect((yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(h.events).toEqual([]);
    }),
  ),
);

it.effect("failed setup never initializes or sends an assignment", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      h.ports.setup = () => Effect.fail(h.failure);
      expect((yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(h.getSnapshot().fence.stage).toBe("workspace-ready");
      expect(h.events).toEqual(["claim", "workspace", "workspace-ready", "joined"]);
    }),
  ),
);

for (const recovery of [false, true]) {
  it.effect(
    `observation append failure retains uncertainty (${recovery ? "recovery" : "first send"})`,
    () =>
      scoped(
        Effect.gen(function* () {
          const h = yield* harness;
          if (recovery) {
            const send = h.ports.sendAssignment;
            h.ports.sendAssignment = (...args) =>
              send(...args).pipe(Effect.andThen(Effect.fail(h.failure)));
            yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit);
            h.ports.sendAssignment = send;
          }
          const append = h.ports.appendStage;
          h.ports.appendStage = (...args) =>
            args[2].stage === "assignment-observed" ? Effect.fail(h.failure) : append(...args);
          const before = h.events.length;
          const exit = yield* (
            recovery ? h.make().resume(h.recovery) : h.make().dispatch(h.request.dispatchId)
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(h.getSnapshot().fence.stage).toBe("assignment-intent");
          expect(h.events.slice(before)).toContain("joined");
          // Exact native observation has been seen; its durable dispatch receipt did not commit.
          expect(h.events.slice(before)).toContain("uncertain");
        }),
      ),
  );
}

it.effect("current revocation after Observed but before persistence retains uncertainty", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const send = h.ports.sendAssignment;
      h.ports.sendAssignment = (...args) =>
        send(...args).pipe(Effect.tap(() => Effect.sync(h.revoke)));
      const exit = yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(h.getSnapshot().fence.stage).toBe("assignment-intent");
      expect(h.events).toContain("send");
      expect(h.events).toContain("joined");
      expect(h.events).toContain("uncertain");
    }),
  ),
);

it.effect("lost observed-stage append response enters latest-owner uncertainty recording", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const append = h.ports.appendStage;
      h.ports.appendStage = (...args) =>
        append(...args).pipe(
          Effect.flatMap((value) =>
            args[2].stage === "assignment-observed"
              ? Effect.fail(h.failure)
              : Effect.succeed(value),
          ),
        );
      const exit = yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(h.getSnapshot().fence.stage).toBe("assignment-observed");
      expect(h.events).toContain("joined");
      // The helper has no committed response; only Root may determine the latest receipt.
      expect(h.events).toContain("uncertain");
    }),
  ),
);

it.effect(
  "recovery denies forwarding but joins retained owner when initial current check is revoked",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        const append = h.ports.appendStage;
        h.ports.appendStage = (...args) =>
          append(...args).pipe(Effect.andThen(Effect.fail(h.failure)));
        yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit);
        h.ports.appendStage = append;
        h.revoke();
        const before = h.events.length;
        expect((yield* h.make().resume(h.recovery).pipe(Effect.exit))._tag).toBe("Failure");
        expect(h.events.slice(before)).toEqual(["joined"]);
      }),
    ),
);

it.effect("concurrent recovery loser never cleans up ordinary winner", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<{ setupId: string }>();
      h.ports.setup = () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish)));
      const winner = yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect((yield* h.make().resume(h.recovery))._tag).toBe("Busy");
      expect(h.events).not.toContain("joined");
      yield* Deferred.succeed(finish, { setupId: h.request.setupId });
      expect((yield* Fiber.join(winner))._tag).toBe("Observed");
      expect(h.events.filter((e) => e === "send")).toHaveLength(1);
    }),
  ),
);

it.effect(
  "already durable observation needs no uncertainty record on later receipt-read failure",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        expect((yield* h.make().dispatch(h.request.dispatchId))._tag).toBe("Observed");
        h.ports.readReceipt = () => Effect.fail(h.failure);
        const before = h.events.length;
        expect((yield* h.make().resume(h.recovery).pipe(Effect.exit))._tag).toBe("Failure");
        expect(h.getSnapshot().fence.stage).toBe("assignment-observed");
        expect(h.events.slice(before)).toEqual(["joined"]);
      }),
    ),
);

it.effect("revocation after recovery receipt read blocks setup and joins retained cleanup", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const append = h.ports.appendStage;
      h.ports.appendStage = (...args) =>
        append(...args).pipe(Effect.andThen(Effect.fail(h.failure)));
      yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit);
      h.ports.appendStage = append;
      const read = h.ports.readReceipt;
      h.ports.readReceipt = (...args) =>
        read(...args).pipe(Effect.tap(() => Effect.sync(h.revoke)));
      const before = h.events.length;
      expect((yield* h.make().resume(h.recovery).pipe(Effect.exit))._tag).toBe("Failure");
      expect(h.events.slice(before)).toEqual(["read-receipt", "joined"]);
    }),
  ),
);

it.effect("interruption of recovery's initial current check joins retained cleanup", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const append = h.ports.appendStage;
      h.ports.appendStage = (...args) =>
        append(...args).pipe(Effect.andThen(Effect.fail(h.failure)));
      yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit);
      h.ports.appendStage = append;
      const entered = yield* Deferred.make<void>();
      h.ports.assertCurrent = () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const before = h.events.length;
      const recovery = yield* h.make().resume(h.recovery).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(recovery);
      expect((yield* Fiber.await(recovery))._tag).toBe("Failure");
      expect(h.events.slice(before)).toEqual(["joined"]);
    }),
  ),
);

it.effect("changed recovery fence must still join the registered retained owner", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const append = h.ports.appendStage;
      h.ports.appendStage = (...args) =>
        append(...args).pipe(Effect.andThen(Effect.fail(h.failure)));
      yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit);
      h.ports.appendStage = append;
      h.ports.assertCurrent = () =>
        Effect.succeed({
          ...h.getSnapshot(),
          fence: { ...h.getSnapshot().fence, revision: h.getSnapshot().fence.revision + 1 },
        });
      const before = h.events.length;
      expect((yield* h.make().resume(h.recovery).pipe(Effect.exit))._tag).toBe("Failure");
      expect(h.events.slice(before)).toEqual(["joined"]);
    }),
  ),
);

it.effect(
  "confirmed durable observation needs no uncertainty when the following current check is revoked",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        const append = h.ports.appendStage;
        h.ports.appendStage = (...args) =>
          append(...args).pipe(
            Effect.tap(() =>
              args[2].stage === "assignment-observed" ? Effect.sync(h.revoke) : Effect.void,
            ),
          );
        expect((yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        expect(h.getSnapshot().fence.stage).toBe("assignment-observed");
        expect(h.events.at(-1)).toBe("joined");
        expect(h.events).not.toContain("uncertain");
      }),
    ),
);

it.effect("invalid observation append response retains uncertainty for Root reconciliation", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const append = h.ports.appendStage;
      h.ports.appendStage = (...args) =>
        append(...args).pipe(
          Effect.map((snapshot) =>
            args[2].stage === "assignment-observed"
              ? {
                  ...snapshot,
                  fence: { ...snapshot.fence, claimGeneration: snapshot.fence.claimGeneration + 1 },
                }
              : snapshot,
          ),
        );
      expect((yield* h.make().dispatch(h.request.dispatchId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(h.getSnapshot().fence.stage).toBe("assignment-observed");
      expect(h.events.slice(-2)).toEqual(["uncertain", "joined"]);
    }),
  ),
);

it.effect("registered recovery cleanup still joins when the snapshot has no effect claim", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      expect((yield* h.make().resume(h.recovery).pipe(Effect.exit))._tag).toBe("Failure");
      expect(h.getSnapshot().fence.claimGeneration).toBe(0);
      expect(h.events).toEqual(["joined"]);
    }),
  ),
);
