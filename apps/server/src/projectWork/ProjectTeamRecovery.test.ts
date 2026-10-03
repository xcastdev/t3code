import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectWorkFoundationCommitCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  at,
  attribution,
  projectId,
  seed,
  scoped,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
  type ProjectTeamDispatchRecoveryPosition,
  type ProjectTeamDispatchStage,
} from "./ProjectTeamDispatchJournal.ts";
import type { ProjectTeamDispatchSnapshot } from "./ProjectTeamDispatch.ts";
import {
  makeProjectTeamRecovery,
  ProjectTeamRecoveryError,
  type ProjectTeamRecoveryDiscovery,
  type ProjectTeamRecoveryPorts,
} from "./ProjectTeamRecovery.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
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

const error = (reason: string) => new ProjectTeamRecoveryError({ reason });
const cause = (reason: string) => Cause.fail(error(reason));
type Claim = { readonly original: ProjectTeamDispatchSnapshot };
type Drain = { readonly claim: Claim };
type Ports = ProjectTeamRecoveryPorts<Claim, Drain, ProjectTeamRecoveryError, Scope.Scope>;

// SQL discovery is real. Native/setup/Git receipts below are controlled Root seams, not V8 proof.
const harness = (initial: ProjectTeamDispatchSnapshot) => {
  let snapshot = initial;
  let owned = false;
  let authorized = true;
  let knowledge: "safe" | "setup-started" | "setup-lost-completion" | "assignment-uncertain" =
    "safe";
  let drained = true;
  const events: string[] = [];
  const claims: Claim[] = [];
  const ports: { -readonly [K in keyof Ports]: Ports[K] } = {
    readPage: () =>
      Effect.succeed([{ dispatchId: initial.fence.dispatchId, snapshot: Exit.succeed(initial) }]),
    recordDiscoveryFailure: (id) =>
      Effect.sync(() => {
        events.push("attention:" + id);
      }),
    withClaim: (discovered, run) =>
      Effect.gen(function* () {
        if (owned) return { _tag: "Busy" as const };
        const claim = yield* Effect.acquireRelease(
          Effect.sync(() => {
            owned = true;
            const value = { original: discovered };
            claims.push(value);
            events.push("claim:" + discovered.fence.dispatchId);
            return value;
          }),
          () =>
            Effect.sync(() => {
              owned = false;
              events.push("release");
            }),
        );
        return yield* run(claim);
      }),
    assess: (claim) =>
      Effect.sync(() => {
        expect(claims).toContain(claim);
        events.push("assess");
        if (
          !authorized ||
          knowledge !== "safe" ||
          snapshot.fence.claimGeneration === 0 ||
          ["stopping", "quarantine"].includes(snapshot.fence.stage)
        ) {
          return { _tag: "Cleanup" as const, cause: cause(authorized ? knowledge : "revoked") };
        }
        return { _tag: "Resume" as const, claim, snapshot };
      }),
    resume: (claim) =>
      Effect.sync(() => {
        expect(claims).toContain(claim);
        events.push("resume:" + snapshot.intent.request.assignmentOperationId);
        return {
          _tag: "Observed" as const,
          fence: { ...snapshot.fence, stage: "assignment-observed" as const },
        };
      }),
    joinCleanup: (claim) =>
      Effect.sync(() => {
        expect(claims).toContain(claim);
        events.push("join");
        return drained
          ? { _tag: "Joined" as const, receipt: { claim } }
          : { _tag: "Uncertain" as const, cause: cause("actual writer may survive") };
      }),
    settle: (claim, receipt) =>
      Effect.sync(() => {
        expect(receipt.claim).toBe(claim);
        events.push("settle");
      }),
    quarantine: () =>
      Effect.sync(() => {
        events.push("quarantine");
      }),
  };
  return {
    ports,
    events,
    claims,
    state: (stage: ProjectTeamDispatchStage, claimGeneration = 1) => {
      snapshot = { ...snapshot, fence: { ...snapshot.fence, stage, claimGeneration } };
    },
    knowledge: (value: typeof knowledge) => {
      knowledge = value;
    },
    revoke: () => {
      authorized = false;
    },
    drain: (value: boolean) => {
      drained = value;
    },
  };
};

for (const stage of [
  "reserved",
  "workspace-ready",
  "setup-complete",
  "session-bound",
  "assignment-intent",
  "assignment-observed",
] as const) {
  it.effect(
    `uses Root's fresh continuation claim for ${stage}, preserving operation identities`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const retained = yield* f.journal.reserve(f.request);
          const h = harness(retained);
          h.state(stage);
          const report = yield* makeProjectTeamRecovery(h.ports).sweep();
          expect(report.items[0]?.result).toEqual(
            Exit.succeed({
              _tag: "Resumed",
              fence: { ...retained.fence, stage: "assignment-observed", claimGeneration: 1 },
            }),
          );
          expect(h.events).toEqual([
            "claim:dispatch-intent",
            "assess",
            "resume:assignment",
            "release",
          ]);
          expect(h.claims[0]?.original.intent.request).toEqual(f.request);
        }),
      ),
  );
}

for (const knowledge of [
  "setup-started",
  "setup-lost-completion",
  "assignment-uncertain",
] as const) {
  it.effect(
    `joins ${knowledge} without calling dispatch.resume or releasing undrained capacity`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const h = harness(yield* f.journal.reserve(f.request));
          h.state(knowledge === "assignment-uncertain" ? "assignment-intent" : "workspace-ready");
          h.knowledge(knowledge);
          h.drain(false);
          const report = yield* makeProjectTeamRecovery(h.ports).sweep();
          expect(
            Exit.isSuccess(report.items[0]!.result) && report.items[0]!.result.value._tag,
          ).toBe("Quarantined");
          expect(h.events).toEqual([
            "claim:dispatch-intent",
            "assess",
            "join",
            "quarantine",
            "release",
          ]);
        }),
      ),
  );
}

for (const stage of ["reserved", "stopping", "quarantine"] as const) {
  it.effect(`retains cleanup ownership at ${stage} and settles only after joined drain`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const h = harness(yield* f.journal.reserve(f.request));
        h.state(stage, stage === "reserved" ? 0 : 1);
        yield* makeProjectTeamRecovery(h.ports).sweep();
        expect(h.events).toEqual(["claim:dispatch-intent", "assess", "join", "settle", "release"]);
      }),
    ),
  );
}

it.effect(
  "refuses a Root continuation with claim generation zero or a different dispatch identity",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const retained = yield* f.journal.reserve(f.request);
        for (const fresh of [
          retained,
          { ...retained, fence: { ...retained.fence, dispatchId: "other", claimGeneration: 1 } },
        ]) {
          const h = harness(retained);
          h.ports.assess = (claim) => Effect.succeed({ _tag: "Resume", claim, snapshot: fresh });
          yield* makeProjectTeamRecovery(h.ports).sweep();
          expect(h.events).toEqual(["claim:dispatch-intent", "join", "settle", "release"]);
        }
      }),
    ),
);

it.effect(
  "a failed assessment joins retained cleanup and preserves all quarantine publication causes",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const h = harness(yield* f.journal.reserve(f.request));
        h.ports.assess = () => Effect.fail(error("physical assessment failed"));
        h.ports.joinCleanup = () => Effect.fail(error("join failed"));
        h.ports.quarantine = () => Effect.fail(error("attention failed"));
        const report = yield* makeProjectTeamRecovery(h.ports).sweep();
        const result = report.items[0]!.result;
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const reasons = result.cause.reasons
            .filter(Cause.isFailReason)
            .map((r) => r.error.reason);
          expect(reasons).toEqual([
            "physical assessment failed",
            "join failed",
            "attention failed",
          ]);
        }
        expect(h.events).toEqual(["claim:dispatch-intent", "release"]);
      }),
    ),
);

it.effect("lost settlement response retains quarantine and the original cause", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const h = harness(yield* f.journal.reserve(f.request));
      h.revoke();
      h.ports.settle = () => Effect.fail(error("settlement response lost"));
      const report = yield* makeProjectTeamRecovery(h.ports).sweep();
      const result = report.items[0]!.result;
      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isSuccess(result) && result.value._tag === "Quarantined") {
        expect(
          result.value.cause.reasons.filter(Cause.isFailReason).map((r) => r.error.reason),
        ).toEqual(["revoked", "settlement response lost"]);
      } else return yield* Effect.die("Quarantine result missing");
      expect(h.events).toEqual([
        "claim:dispatch-intent",
        "assess",
        "join",
        "quarantine",
        "release",
      ]);
    }),
  ),
);

it.effect("competing claim losers never stop the active recovery winner", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const h = harness(yield* f.journal.reserve(f.request));
      h.state("assignment-observed");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const original = h.ports.assess;
      h.ports.assess = (claim) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(original(claim)),
        );
      const winner = yield* makeProjectTeamRecovery(h.ports).sweep().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const loser = yield* makeProjectTeamRecovery(h.ports).sweep();
      expect(loser.items[0]?.result).toEqual(Exit.succeed({ _tag: "Busy" }));
      expect(h.events).toEqual(["claim:dispatch-intent"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(winner);
      expect(h.events).toEqual(["claim:dispatch-intent", "assess", "resume:assignment", "release"]);
    }),
  ),
);

it.effect("repeated interruption cannot detach cleanup or advance over an unfinished item", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const retained = yield* f.journal.reserve(f.request);
      const h = harness(retained);
      h.state("session-bound");
      const resumed = yield* Deferred.make<void>();
      const joining = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      h.ports.readPage = ({ afterDispatchId }) =>
        Effect.succeed(
          afterDispatchId
            ? []
            : ["a", "b"].map((id) => ({
                dispatchId: id,
                snapshot: Exit.succeed({
                  ...retained,
                  fence: { ...retained.fence, dispatchId: id },
                }),
              })),
        );
      h.ports.assess = (claim) =>
        Effect.succeed({
          _tag: "Resume",
          claim,
          snapshot: {
            ...retained,
            fence: {
              ...retained.fence,
              dispatchId: claim.original.fence.dispatchId,
              claimGeneration: 1,
            },
          },
        });
      h.ports.resume = () =>
        Deferred.succeed(resumed, undefined).pipe(Effect.andThen(Effect.never));
      h.ports.joinCleanup = (claim) =>
        Deferred.succeed(joining, undefined).pipe(
          Effect.andThen(Deferred.await(drained)),
          Effect.map(() => ({ _tag: "Joined", receipt: { claim } })),
        );
      const recovery = makeProjectTeamRecovery(h.ports, { pageSize: 2 });
      const fiber = yield* recovery.sweep().pipe(Effect.forkChild);
      yield* Deferred.await(resumed);
      yield* Effect.sync(() => fiber.interruptUnsafe());
      yield* Deferred.await(joining);
      yield* Effect.sync(() => fiber.interruptUnsafe());
      expect(h.events).toEqual(["claim:a"]);
      yield* Deferred.succeed(drained, undefined);
      const interrupted = yield* Fiber.await(fiber);
      expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true);
      expect(h.events).toEqual(["claim:a", "settle", "release"]);
      h.ports.assess = () => Effect.succeed({ _tag: "Cleanup", cause: cause("revoked") });
      h.ports.joinCleanup = (claim) => Effect.succeed({ _tag: "Joined", receipt: { claim } });
      const retry = yield* recovery.sweep();
      expect(retry.items.map((i) => i.dispatchId)).toEqual(["a", "b"]);
    }),
  ),
);

const fileScoped = <A, E, R>(run: (filename: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-recovery-" });
      const filename = directory + "/state.sqlite";
      const services = Layer.mergeAll(
        Authorization.layer,
        ProjectWorkRepositoryLive,
        ProjectWorkQueryLive,
        ProjectWorkProjectionLive,
      ).pipe(
        Layer.provideMerge(makeSqlitePersistenceLive(filename)),
        Layer.provideMerge(NodeServices.layer),
      );
      return yield* run(filename).pipe(Effect.provide(services));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const sqlDiscovery = Effect.fn("recoveryTest.sqlDiscovery")(
  function* (
    f: Effect.Success<typeof fixture>,
    input: { readonly afterDispatchId?: string; readonly limit: number },
  ) {
    const ids = yield* f.sql<{
      dispatch_id: string;
    }>`SELECT dispatch_id FROM project_team_dispatch WHERE environment_id='environment' AND stage <> 'settled' AND dispatch_id > ${input.afterDispatchId ?? ""} ORDER BY dispatch_id LIMIT ${input.limit}`;
    let afterDispatchId = input.afterDispatchId;
    const items: ProjectTeamRecoveryDiscovery<ProjectTeamRecoveryError>[] = [];
    for (const row of ids) {
      const snapshot = yield* f.journal
        .readRecoveryPage({
          ...(afterDispatchId === undefined ? {} : { afterDispatchId }),
          limit: 1,
        })
        .pipe(
          Effect.flatMap((page) =>
            page[0] ? Effect.succeed(page[0]) : Effect.fail(error("Retained row disappeared")),
          ),
          Effect.mapError((failure) =>
            error(
              failure._tag === "ProjectTeamDispatchJournalError" ? failure.reason : String(failure),
            ),
          ),
          Effect.exit,
        );
      items.push({ dispatchId: row.dispatch_id, snapshot });
      afterDispatchId = row.dispatch_id;
    }
    return items;
  },
  Effect.mapError((failure) => error(failure.message)),
);

// Corrupt copied owners exercise attention traversal; only the original retains committed effect proof.
const addRows = Effect.fn("recoveryTest.addRows")(function* (
  f: Effect.Success<typeof fixture>,
  ids: readonly string[],
  malformedId?: string,
) {
  const source = (yield* f.sql`SELECT * FROM project_team_dispatch`)[0]!;
  const bindingRow =
    (yield* f.sql`SELECT * FROM project_team_run_binding WHERE record_id='binding'`)[0]!;
  const retained = (yield* f.journal.readRecoveryPage({ limit: 1 }))[0]!;
  const transition = retained.intent.compiledClaim.transition;
  if (transition?.kind !== "claim") return yield* Effect.die("Claim fixture missing");
  for (const id of ids) {
    const binding = {
      ...transition.binding,
      recordId: id,
      attemptId: id,
      worktree: "/workspace-" + id,
      branch: "refs/heads/" + id,
    };
    const compiledClaim = {
      ...retained.intent.compiledClaim,
      transition: { ...transition, binding },
    };
    const intent = {
      ...retained.intent,
      compiledClaim,
      request: {
        ...retained.intent.request,
        dispatchId: id,
        claim: compiledClaim,
        git: {
          ...retained.intent.request.git,
          runId: id,
          worktreePath: binding.worktree,
          branchRef: binding.branch,
        },
      },
    };
    yield* f.sql`INSERT INTO project_team_run_binding ${f.sql.insert({ ...bindingRow, record_id: id, attempt_id: id, payload_json: yield* encodeJson(binding) })}`;
    yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert({ ...source, dispatch_id: id, binding_id: id, attempt_id: id, worktree: binding.worktree, branch: binding.branch, intent_json: malformedId === id ? "{}" : yield* encodeJson(intent) })}`;
  }
});

it.effect(
  "bounded actual SQLite pages cross corrupt owners, wrap fairly, and retry the original Busy owner",
  () =>
    fileScoped(() =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const retained = yield* f.journal.reserve(f.request);
        const ids = Array.from(
          { length: 129 },
          (_, index) => "item-" + String(index).padStart(3, "0"),
        );
        yield* addRows(f, ids);
        const reopened = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
        });
        const h = harness(retained);
        const pages: (string | undefined)[] = [];
        h.ports.readPage = (input) => {
          pages.push(input.afterDispatchId);
          return sqlDiscovery({ ...f, journal: reopened }, input);
        };
        let claims = 0;
        h.ports.withClaim = (item) =>
          Effect.sync(() => {
            claims++;
            expect(item.fence.dispatchId).toBe(f.request.dispatchId);
            expect(item.intent.limits.maximumTokens).toBe(retained.intent.limits.maximumTokens);
            return { _tag: "Busy" as const };
          });
        const recovery = makeProjectTeamRecovery(h.ports);
        const first = yield* recovery.sweep();
        const second = yield* recovery.sweep();
        const again = yield* recovery.sweep();
        expect(first.items.map((i) => i.dispatchId)).toEqual([
          f.request.dispatchId,
          ...ids.slice(0, 127),
        ]);
        expect("afterDispatchId" in first ? first.afterDispatchId : undefined).toBe(ids[126]);
        expect(second.items.map((i) => i.dispatchId)).toEqual(ids.slice(127));
        expect(second.wrapped).toBe(true);
        expect(again.items.map((i) => i.dispatchId)).toEqual([
          f.request.dispatchId,
          ...ids.slice(0, 127),
        ]);
        expect(pages).toEqual([undefined, ids[126], undefined]);
        expect(claims).toBe(2);
        expect(h.events).toEqual([
          ...ids.map((id) => "attention:" + id),
          ...ids.slice(0, 127).map((id) => "attention:" + id),
        ]);
        expect(Exit.isSuccess(first.items[0]!.result)).toBe(true);
        expect(first.items.slice(1).every((item) => Exit.isFailure(item.result))).toBe(true);
      }),
    ),
);

it.effect(
  "malformed actual SQLite row and failed attention publication do not starve a later valid row",
  () =>
    fileScoped(() =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const retained = yield* f.journal.reserve(f.request);
        yield* addRows(f, ["a", "b", "c"], "b");
        const h = harness(retained);
        h.ports.readPage = (input) => sqlDiscovery(f, input);
        h.ports.recordDiscoveryFailure = (id) =>
          Effect.sync(() => {
            h.events.push("attention:" + id);
          }).pipe(Effect.andThen(Effect.fail(error("publication failed"))));
        h.ports.assess = () => Effect.succeed({ _tag: "Cleanup", cause: cause("revoked") });
        const recovery = makeProjectTeamRecovery(h.ports, { pageSize: 4 });
        const result = yield* recovery.sweep();
        expect(result.items.map((i) => i.dispatchId)).toEqual([
          "a",
          "b",
          "c",
          f.request.dispatchId,
        ]);
        for (const [index, reason] of [
          "Original dispatch effect identity is invalid",
          "Dispatch intent is invalid",
          "Original dispatch effect identity is invalid",
        ].entries()) {
          const failed = result.items[index]!.result;
          if (!Exit.isFailure(failed)) return yield* Effect.die("Corrupt copied owner succeeded");
          expect(
            failed.cause.reasons.filter(Cause.isFailReason).map((r) => r.error.reason),
          ).toEqual([reason, "publication failed"]);
        }
        expect(Exit.isSuccess(result.items[3]!.result)).toBe(true);
        expect(h.events).toEqual([
          "attention:a",
          "attention:b",
          "attention:c",
          "claim:dispatch-intent",
          "join",
          "settle",
          "release",
        ]);
        expect((yield* recovery.sweep()).items).toEqual([]);
        expect((yield* recovery.sweep()).items.map((i) => i.dispatchId)).toEqual([
          "a",
          "b",
          "c",
          f.request.dispatchId,
        ]);
      }),
    ),
);

for (const invalid of ["duplicate", "descending", "overflow", "cursor"]) {
  it.effect(`rejects ${invalid} discovery pages before any claim`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const retained = yield* f.journal.reserve(f.request);
        const h = harness(retained);
        const recovery = makeProjectTeamRecovery(h.ports, { pageSize: 2 });
        const ids =
          invalid === "duplicate"
            ? ["a", "a"]
            : invalid === "descending"
              ? ["b", "a"]
              : invalid === "overflow"
                ? ["a", "b", "c"]
                : ["a", "b"];
        h.ports.readPage = () =>
          Effect.succeed(
            ids.map((dispatchId) => ({
              dispatchId,
              snapshot: Exit.succeed({ ...retained, fence: { ...retained.fence, dispatchId } }),
            })),
          );
        h.ports.withClaim = () => Effect.succeed({ _tag: "Busy" });
        if (invalid === "cursor") yield* recovery.sweep();
        expect(Exit.isFailure(yield* recovery.sweep().pipe(Effect.exit))).toBe(true);
        expect(h.events).toEqual([]);
      }),
    ),
  );
}

it.effect("failed discovery reads retain the cursor and retry the unvisited bounded window", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const retained = yield* f.journal.reserve(f.request);
      const h = harness(retained);
      const seen: (string | undefined)[] = [];
      let fail = true;
      h.ports.readPage = (input) =>
        Effect.suspend(() => {
          seen.push(input.afterDispatchId);
          if (fail) {
            fail = false;
            return Effect.fail(error("page response lost"));
          }
          return Effect.succeed([
            { dispatchId: retained.fence.dispatchId, snapshot: Exit.succeed(retained) },
          ]);
        });
      const recovery = makeProjectTeamRecovery(h.ports, { pageSize: 1 });
      expect(Exit.isFailure(yield* recovery.sweep().pipe(Effect.exit))).toBe(true);
      yield* recovery.sweep();
      expect(seen).toEqual([undefined, undefined]);
    }),
  ),
);

it.effect("current revocation while resume runs joins cleanup before durable settlement", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const h = harness(yield* f.journal.reserve(f.request));
      h.state("session-bound");
      const entered = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      h.ports.resume = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(revoked)),
          Effect.andThen(Effect.fail(error("current gate revoked"))),
        );
      const fiber = yield* makeProjectTeamRecovery(h.ports).sweep().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      h.revoke();
      yield* Deferred.succeed(revoked, undefined);
      const report = yield* Fiber.join(fiber);
      const item = report.items[0]!.result;
      expect(Exit.isSuccess(item) && item.value._tag).toBe("Settled");
      expect(h.events).toEqual(["claim:dispatch-intent", "assess", "join", "settle", "release"]);
    }),
  ),
);

for (const revocation of [
  "binding-removed",
  "writer-released",
  "deadline-expired",
  "project-deleted",
] as const) {
  it.effect(
    `retained SQL discovery after ${revocation} provides cleanup knowledge without continuation authority`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const retained = yield* f.journal.reserve(f.request);
          if (revocation === "binding-removed")
            yield* f.sql`DELETE FROM project_team_run_binding WHERE record_id='binding'`;
          if (revocation === "writer-released")
            yield* f.sql`UPDATE project_team_reservation SET status='released' WHERE record_id=${retained.intent.writableReservationId!}`;
          if (revocation === "deadline-expired")
            yield* TestClock.setTime(retained.intent.limits.deadlineAtMs);
          if (revocation === "project-deleted") {
            yield* f.sql`INSERT INTO project_lifecycle (project_id,state,workspace_root,changed_at) VALUES (${projectId},'tombstoned','/workspace',${at})`;
          }
          expect(
            Exit.isFailure(yield* f.journal.inspect(f.request.dispatchId).pipe(Effect.exit)),
          ).toBe(true);
          const h = harness(retained);
          h.ports.readPage = (input) => sqlDiscovery(f, input);
          h.ports.assess = () =>
            f.journal.inspect(f.request.dispatchId).pipe(
              Effect.map(() => ({
                _tag: "Resume" as const,
                claim: h.claims[0]!,
                snapshot: retained,
              })),
              Effect.catch(() =>
                Effect.succeed({ _tag: "Cleanup" as const, cause: cause(revocation) }),
              ),
            );
          h.drain(false);
          const report = yield* makeProjectTeamRecovery(h.ports).sweep();
          expect(report.items.map((i) => i.dispatchId)).toEqual([f.request.dispatchId]);
          const result = report.items[0]!.result;
          expect(Exit.isSuccess(result) && result.value._tag).toBe("Quarantined");
          expect(h.events).toEqual(["claim:dispatch-intent", "join", "quarantine", "release"]);
          expect((yield* f.sql`SELECT stage FROM project_team_dispatch`)[0]?.stage).toBe(
            "reserved",
          );
        }),
      ),
  );
}

it.effect(
  "a synchronous attention defect preserves malformed discovery cause and continues the bounded page",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const retained = yield* f.journal.reserve(f.request);
        const h = harness(retained);
        h.ports.readPage = () =>
          Effect.succeed([
            { dispatchId: "a", snapshot: Exit.fail(error("malformed row")) },
            {
              dispatchId: "b",
              snapshot: Exit.succeed({
                ...retained,
                fence: { ...retained.fence, dispatchId: "b" },
              }),
            },
          ]);
        h.ports.recordDiscoveryFailure = () => {
          throw error("attention defect");
        };
        const report = yield* makeProjectTeamRecovery(h.ports).sweep();
        const result = report.items[0]!.result;
        if (!Exit.isFailure(result)) return yield* Effect.die("Missing discovery failure");
        expect(result.cause.reasons.filter(Cause.isFailReason).map((r) => r.error.reason)).toEqual([
          "malformed row",
        ]);
        expect(result.cause.reasons.filter(Cause.isDieReason).map((r) => r.defect)).toEqual([
          error("attention defect"),
        ]);
        expect(Exit.isSuccess(report.items[1]!.result)).toBe(true);
        expect(h.events).toEqual(["claim:b", "assess", "join", "settle", "release"]);
      }),
    ),
);

type PositionedFailure =
  | Effect.Error<ReturnType<Effect.Success<typeof fixture>["journal"]["readRecoveryCandidates"]>>
  | ProjectTeamRecoveryError;

const malformedKeyFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
  const source = (yield* f.sql<Record<string, unknown>>`SELECT * FROM project_team_dispatch`)[0];
  const binding = (yield* f.sql<
    Record<string, unknown>
  >`SELECT * FROM project_team_run_binding WHERE record_id='binding'`)[0];
  if (!source || !binding) return yield* Effect.die("Missing retained SQL owner");
  const insert = Effect.fn(function* (dispatchId: string | null | Uint8Array, ordinal: number) {
    const bindingId = `restored-binding-${ordinal}`;
    const attemptId = `restored-attempt-${ordinal}`;
    yield* f.sql`INSERT INTO project_team_run_binding ${f.sql.insert({ ...binding, record_id: bindingId, attempt_id: attemptId })}`;
    yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert({ ...source, dispatch_id: dispatchId, binding_id: bindingId, attempt_id: attemptId, worktree: `/restored-workspace-${ordinal}` })}`;
  });
  return { ...f, claimed, insert };
});

for (const action of ["resume", "cleanup"] as const) {
  it.effect(
    `actual SQL positioned discovery crosses malformed keys before one original ${action}`,
    () =>
      fileScoped(() =>
        Effect.gen(function* () {
          const f = yield* malformedKeyFixture;
          const rawIds = [null, null, "", "a".repeat(257), f.request.dispatchId];
          for (const [ordinal, id] of rawIds.slice(0, -1).entries()) yield* f.insert(id, ordinal);
          if (action === "cleanup")
            yield* f.sql`DELETE FROM project_team_run_binding WHERE record_id='binding'`;
          const h = harness(f.claimed);
          const reads: Parameters<typeof f.journal.readRecoveryCandidates>[0][] = [];
          const diagnostics: {
            dispatchId: string | null;
            position?: ProjectTeamDispatchRecoveryPosition;
            cause: Cause.Cause<PositionedFailure>;
          }[] = [];
          const discoveredFailures: Cause.Cause<PositionedFailure>[] = [];
          const ports: ProjectTeamRecoveryPorts<Claim, Drain, PositionedFailure, Scope.Scope> = {
            ...h.ports,
            readPage: (input) => {
              reads.push(input);
              return f.journal.readRecoveryCandidates(input).pipe(
                Effect.tap((page) =>
                  Effect.sync(() => {
                    for (const candidate of page)
                      if (Exit.isFailure(candidate.snapshot))
                        discoveredFailures.push(candidate.snapshot.cause);
                  }),
                ),
              );
            },
            recordDiscoveryFailure: (dispatchId, discoveryCause, position) =>
              Effect.sync(() => {
                diagnostics.push({
                  dispatchId,
                  ...(position === undefined ? {} : { position }),
                  cause: discoveryCause,
                });
                h.events.push("attention:" + dispatchId);
              }),
            assess: (claim) =>
              f.journal.inspect(f.request.dispatchId).pipe(
                Effect.map((snapshot) => ({ _tag: "Resume" as const, claim, snapshot })),
                Effect.catch((failure) =>
                  Effect.succeed({ _tag: "Cleanup" as const, cause: Cause.fail(failure) }),
                ),
              ),
            joinCleanup: (claim) =>
              Effect.sync(() => {
                expect(h.claims).toContain(claim);
                h.events.push("join");
                return { _tag: "Joined" as const, receipt: { claim } };
              }),
            quarantine: (claim) =>
              Effect.sync(() => {
                expect(h.claims).toContain(claim);
                h.events.push("quarantine");
              }),
          };
          const recovery = makeProjectTeamRecovery(ports, { pageSize: 1 });
          const visited: (string | null)[] = [];
          for (let page = 0; page < rawIds.length; page++) {
            const report = yield* recovery.sweep();
            expect(report.items).toHaveLength(1);
            visited.push(...report.items.map((item) => item.dispatchId));
            expect("afterPosition" in report ? report.afterPosition : undefined).toBeDefined();
            expect(
              "afterDispatchId" in report ? report.afterDispatchId : undefined,
            ).toBeUndefined();
            if (page < rawIds.length - 1)
              expect(Exit.isFailure(report.items[0]!.result)).toBe(true);
          }
          const end = yield* recovery.sweep();
          expect(end.items).toEqual([]);
          expect(end.wrapped).toBe(true);
          expect("afterPosition" in end ? end.afterPosition : undefined).toBeUndefined();
          expect(visited).toEqual(rawIds);
          expect(diagnostics.map((item) => item.dispatchId)).toEqual(rawIds.slice(0, -1));
          expect(diagnostics.map((item) => item.cause)).toEqual(discoveredFailures);
          expect(diagnostics.every((item) => item.position !== undefined)).toBe(true);
          expect(reads).toHaveLength(6);
          expect(reads[0]).toEqual({ limit: 1 });
          expect(
            reads
              .slice(1)
              .every(
                (input) =>
                  input.afterPosition !== undefined &&
                  input.afterDispatchId === undefined &&
                  input.limit === 1,
              ),
          ).toBe(true);
          expect(h.claims).toHaveLength(1);
          expect(h.claims[0]?.original).toEqual(f.claimed);
          expect(h.claims[0]?.original.intent.request.assignmentOperationId).toBe(
            f.request.assignmentOperationId,
          );
          expect(h.events.filter((event) => !event.startsWith("attention:"))).toEqual(
            action === "resume"
              ? ["claim:dispatch-intent", "resume:assignment", "release"]
              : ["claim:dispatch-intent", "join", "settle", "release"],
          );
          expect(yield* f.journal.readRetained(f.request.dispatchId)).toEqual(f.claimed);
          expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
        }),
      ),
  );
}

it.effect(
  "deleted actual SQL cursor records failure and resets only on the next bounded sweep",
  () =>
    fileScoped(() =>
      Effect.gen(function* () {
        const f = yield* malformedKeyFixture;
        yield* f.insert("a-corrupt", 0);
        const h = harness(f.claimed);
        const reads: Parameters<typeof f.journal.readRecoveryCandidates>[0][] = [];
        const recorded: {
          dispatchId: string | null;
          position?: ProjectTeamDispatchRecoveryPosition;
          cause: Cause.Cause<PositionedFailure>;
        }[] = [];
        const ports: ProjectTeamRecoveryPorts<Claim, Drain, PositionedFailure, Scope.Scope> = {
          ...h.ports,
          readPage: (input) => {
            reads.push(input);
            return f.journal.readRecoveryCandidates(input);
          },
          recordDiscoveryFailure: (dispatchId, discoveryCause, position) =>
            Effect.sync(() => {
              recorded.push({
                dispatchId,
                ...(position === undefined ? {} : { position }),
                cause: discoveryCause,
              });
            }),
          joinCleanup: (claim) => Effect.succeed({ _tag: "Joined", receipt: { claim } }),
          quarantine: () => Effect.void,
        };
        const recovery = makeProjectTeamRecovery(ports, { pageSize: 1 });
        const first = yield* recovery.sweep();
        expect(first.items[0]?.dispatchId).toBe("a-corrupt");
        yield* f.sql`DELETE FROM project_team_dispatch WHERE dispatch_id='a-corrupt'`;
        const failed = yield* recovery.sweep().pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect(reads).toHaveLength(2);
        expect(h.claims).toEqual([]);
        expect(recorded).toHaveLength(2);
        if (Exit.isFailure(failed)) expect(recorded[1]?.cause).toEqual(failed.cause);
        expect(recorded[1]?.position).toEqual(
          "afterPosition" in first ? first.afterPosition : undefined,
        );
        const resumed = yield* recovery.sweep();
        expect(reads[2]).toEqual({ limit: 1 });
        expect(resumed.items[0]?.dispatchId).toBe(f.request.dispatchId);
        expect(h.claims).toHaveLength(1);
        expect(h.claims[0]?.original).toEqual(f.claimed);
      }),
    ),
);

const positionFor = (rowId: string): ProjectTeamDispatchRecoveryPosition => ({
  rowId,
  dispatchIdHash: "a".repeat(64),
});

for (const invalid of [
  "duplicate",
  "reused-row",
  "noncanonical",
  "hash",
  "mixed",
  "cursor-reuse",
] as const) {
  it.effect(`positioned pages reject ${invalid} before acquiring any claim`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const retained = yield* f.journal.reserve(f.request);
        const h = harness(retained);
        const first = {
          dispatchId: retained.fence.dispatchId,
          position: positionFor("1"),
          snapshot: Exit.succeed(retained),
        };
        const second = { ...first, position: positionFor("2") };
        const page: ProjectTeamRecoveryDiscovery<ProjectTeamRecoveryError>[] =
          invalid === "duplicate"
            ? [first, first]
            : invalid === "reused-row"
              ? [
                  first,
                  { ...first, position: { ...first.position, dispatchIdHash: "b".repeat(64) } },
                ]
              : invalid === "noncanonical"
                ? [{ ...first, position: positionFor("01") }]
                : invalid === "hash"
                  ? [{ ...first, position: { ...first.position, dispatchIdHash: "invalid" } }]
                  : invalid === "mixed"
                    ? [
                        first,
                        { dispatchId: retained.fence.dispatchId, snapshot: Exit.succeed(retained) },
                      ]
                    : [first, second];
        h.ports.readPage = () => Effect.succeed(page);
        h.ports.withClaim = () => Effect.succeed({ _tag: "Busy" });
        const recovery = makeProjectTeamRecovery(h.ports, { pageSize: 2 });
        if (invalid === "cursor-reuse") yield* recovery.sweep();
        expect(Exit.isFailure(yield* recovery.sweep().pipe(Effect.exit))).toBe(true);
        expect(h.events).toEqual([]);
        expect(h.claims).toEqual([]);
      }),
    ),
  );
}

it.effect(
  "malformed positioned success snapshots remain attention only, including runtime non-string keys",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const h = harness(claimed);
        const page: ProjectTeamRecoveryDiscovery<ProjectTeamRecoveryError>[] = [
          null,
          "",
          "a".repeat(257),
          null,
          f.request.dispatchId,
        ].map((dispatchId, index) => ({
          dispatchId,
          position: positionFor(String(index + 1)),
          snapshot: Exit.succeed(claimed),
        }));
        // A misbehaving private port can violate its declared diagnostic type at runtime.
        if (!page[3]) return yield* Effect.die("Missing malformed runtime fixture");
        Object.defineProperty(page[3], "dispatchId", { value: new Uint8Array([1, 2]) });
        const diagnostics: {
          dispatchId: string | null;
          position?: ProjectTeamDispatchRecoveryPosition;
        }[] = [];
        h.ports.readPage = () => Effect.succeed(page);
        h.ports.recordDiscoveryFailure = (dispatchId, discoveryCause, position) =>
          Effect.sync(() => {
            diagnostics.push({ dispatchId, ...(position === undefined ? {} : { position }) });
            expect(Cause.pretty(discoveryCause)).toContain(
              "Root discovery dispatch identity is invalid",
            );
          });
        const report = yield* makeProjectTeamRecovery(h.ports, { pageSize: 5 }).sweep();
        expect(report.items.map((item) => Exit.isFailure(item.result))).toEqual([
          true,
          true,
          true,
          true,
          false,
        ]);
        expect(diagnostics.map((item) => item.dispatchId)).toEqual([
          null,
          "",
          "a".repeat(257),
          null,
        ]);
        expect(diagnostics.every((item) => item.position !== undefined)).toBe(true);
        expect(h.claims).toHaveLength(1);
        expect(h.claims[0]?.original).toEqual(claimed);
        expect(h.events).toEqual([
          "claim:dispatch-intent",
          "assess",
          "resume:assignment",
          "release",
        ]);
      }),
    ),
);

it.effect("interrupting a positioned SQL page read retains the unfinished continuation", () =>
  fileScoped(() =>
    Effect.gen(function* () {
      const f = yield* malformedKeyFixture;
      yield* f.insert(null, 0);
      const h = harness(f.claimed);
      const entered = yield* Deferred.make<void>();
      const reads: Parameters<typeof f.journal.readRecoveryCandidates>[0][] = [];
      const diagnostics: (string | null)[] = [];
      const ports: ProjectTeamRecoveryPorts<Claim, Drain, PositionedFailure, Scope.Scope> = {
        ...h.ports,
        readPage: (input) => {
          reads.push(input);
          return reads.length === 2
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : f.journal.readRecoveryCandidates(input);
        },
        recordDiscoveryFailure: (dispatchId) =>
          Effect.sync(() => {
            diagnostics.push(dispatchId);
          }),
        joinCleanup: (claim) => Effect.succeed({ _tag: "Joined", receipt: { claim } }),
        quarantine: () => Effect.void,
      };
      const recovery = makeProjectTeamRecovery(ports, { pageSize: 1 });
      const first = yield* recovery.sweep();
      const reading = yield* recovery.sweep().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(reading);
      expect(h.claims).toEqual([]);
      expect(diagnostics).toEqual([null]);
      const resumed = yield* recovery.sweep();
      expect(reads[1]).toEqual({
        afterPosition: "afterPosition" in first ? first.afterPosition : undefined,
        limit: 1,
      });
      expect(reads[2]).toEqual(reads[1]);
      expect(resumed.items[0]?.dispatchId).toBe(f.request.dispatchId);
      expect(h.claims).toHaveLength(1);
    }),
  ),
);

it.effect(
  "actual SQL BLOB diagnostics retain opaque positions after text owners without granting authority",
  () =>
    fileScoped(() =>
      Effect.gen(function* () {
        const f = yield* malformedKeyFixture;
        for (const [ordinal, id] of [
          null,
          null,
          "",
          "a".repeat(257),
          new Uint8Array([255, 0, 13]),
        ].entries())
          yield* f.insert(id, ordinal);
        const h = harness(f.claimed);
        const diagnostics: {
          dispatchId: string | null;
          position?: ProjectTeamDispatchRecoveryPosition;
          cause: Cause.Cause<PositionedFailure>;
        }[] = [];
        const reads: Parameters<typeof f.journal.readRecoveryCandidates>[0][] = [];
        const ports: ProjectTeamRecoveryPorts<Claim, Drain, PositionedFailure, Scope.Scope> = {
          ...h.ports,
          readPage: (input) => {
            reads.push(input);
            return f.journal.readRecoveryCandidates(input);
          },
          recordDiscoveryFailure: (dispatchId, discoveryCause, position) =>
            Effect.sync(() => {
              diagnostics.push({
                dispatchId,
                cause: discoveryCause,
                ...(position === undefined ? {} : { position }),
              });
            }),
          joinCleanup: (claim) => Effect.succeed({ _tag: "Joined", receipt: { claim } }),
          quarantine: () => Effect.void,
        };
        const recovery = makeProjectTeamRecovery(ports, { pageSize: 2 });
        const first = yield* recovery.sweep();
        const second = yield* recovery.sweep();
        const third = yield* recovery.sweep();
        expect(first.items.map((item) => item.dispatchId)).toEqual([null, null]);
        expect(second.items.map((item) => item.dispatchId)).toEqual(["", "a".repeat(257)]);
        expect(third.items.map((item) => item.dispatchId)).toEqual([f.request.dispatchId, null]);
        expect(Exit.isSuccess(third.items[0]!.result)).toBe(true);
        expect(Exit.isFailure(third.items[1]!.result)).toBe(true);
        expect("afterPosition" in third ? third.afterPosition : undefined).toBeDefined();
        expect("afterDispatchId" in third ? third.afterDispatchId : undefined).toBeUndefined();
        expect((yield* recovery.sweep()).wrapped).toBe(true);
        expect(reads).toHaveLength(4);
        expect(
          reads
            .slice(1)
            .every(
              (input) =>
                input.afterPosition !== undefined &&
                input.afterDispatchId === undefined &&
                input.limit === 2,
            ),
        ).toBe(true);
        expect(diagnostics.map((item) => item.dispatchId)).toEqual([
          null,
          null,
          "",
          "a".repeat(257),
          null,
        ]);
        expect(new Set(diagnostics.map((item) => item.position?.rowId)).size).toBe(5);
        expect(h.claims).toHaveLength(1);
        expect(h.claims[0]?.original).toEqual(f.claimed);
        expect(h.events).toEqual([
          "claim:dispatch-intent",
          "assess",
          "resume:assignment",
          "release",
        ]);
        expect(yield* f.journal.readRetained(f.request.dispatchId)).toEqual(f.claimed);
      }),
    ),
);

for (const positioned of [false, true]) {
  for (const publication of ["success", "failure", "defect"] as const) {
    it.effect(
      `${positioned ? "positioned" : "legacy"} joined attention ${publication} retains full causes and repeated interruption without cursor advance`,
      () =>
        scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const h = harness(yield* f.journal.reserve(f.request));
            const entered = yield* Deferred.make<void>();
            const proceed = yield* Deferred.make<void>();
            const decodeReason = Cause.makeFailReason(error("decode failure")).annotate(
              Context.makeUnsafe(new Map([["origin", "decode"]])),
            );
            const decodeCause = Cause.fromReasons([decodeReason, decodeReason]);
            const publicationReason = (
              publication === "defect"
                ? Cause.makeDieReason(error("publication defect"))
                : Cause.makeFailReason(error("publication failure"))
            ).annotate(Context.makeUnsafe(new Map([["origin", "publication"]])));
            const publicationCause = Cause.fromReasons([publicationReason, publicationReason]);
            const reads: Parameters<Ports["readPage"]>[0][] = [];
            let held = true;
            let drained = false;
            let published = 0;
            h.ports.readPage = (input) => {
              reads.push(input);
              const second = positioned
                ? input.afterPosition !== undefined
                : input.afterDispatchId !== undefined;
              return Effect.succeed([
                {
                  dispatchId: second ? "b" : "a",
                  ...(positioned ? { position: positionFor(second ? "2" : "1") } : {}),
                  snapshot: Exit.failCause(second ? decodeCause : cause("initial malformed")),
                },
              ]);
            };
            h.ports.recordDiscoveryFailure = (id, observed) =>
              Effect.gen(function* () {
                published++;
                if (id !== "b") return;
                expect(observed).toEqual(decodeCause);
                if (held) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(proceed);
                }
                drained = true;
                if (publication !== "success") return yield* Effect.failCause(publicationCause);
              });
            const recovery = makeProjectTeamRecovery(h.ports, { pageSize: 1 });
            yield* recovery.sweep();
            const fiber = yield* recovery.sweep().pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* Effect.sync(() => {
              fiber.interruptUnsafe(
                101,
                Context.makeUnsafe(new Map([["interrupt-origin", "first"]])),
              );
              fiber.interruptUnsafe(
                202,
                Context.makeUnsafe(new Map([["interrupt-origin", "second"]])),
              );
            });
            expect(drained).toBe(false);
            expect(h.claims).toEqual([]);
            held = false;
            yield* Deferred.succeed(proceed, undefined);
            const interrupted = yield* Fiber.await(fiber);
            expect(drained).toBe(true);
            expect(published).toBe(2);
            expect(reads).toHaveLength(2);
            if (!Exit.isFailure(interrupted))
              return yield* Effect.die("Canceled attention succeeded");
            expect(Cause.hasInterrupts(interrupted.cause)).toBe(true);
            const decoded = interrupted.cause.reasons
              .filter(Cause.isFailReason)
              .filter((reason) => reason.error.reason === "decode failure");
            expect(decoded).toHaveLength(2);
            expect(decoded.every((reason) => reason.annotations.get("origin") === "decode")).toBe(
              true,
            );
            const publications = interrupted.cause.reasons.filter(
              (reason) => reason.annotations.get("origin") === "publication",
            );
            expect(publications).toHaveLength(publication === "success" ? 0 : 2);
            expect(
              publications.every(
                (reason) => reason._tag === (publication === "defect" ? "Die" : "Fail"),
              ),
            ).toBe(true);
            const interrupts = interrupted.cause.reasons.filter(Cause.isInterruptReason);
            expect(interrupts.map((reason) => reason.fiberId)).toEqual([101, 202]);
            expect(interrupts.map((reason) => reason.annotations.get("interrupt-origin"))).toEqual([
              "first",
              "second",
            ]);
            const retry = yield* recovery.sweep();
            expect(reads[2]).toEqual(reads[1]);
            expect(Exit.isFailure(retry.items[0]!.result)).toBe(true);
            expect(published).toBe(3);
            expect(h.claims).toEqual([]);
            expect(h.events).toEqual([]);
          }),
        ),
    );
  }
}
