import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectWorkFoundationCommitCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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

// Copy retained journal history to stress discovery. These rows never admit independent workers.
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
  yield* f.sql`UPDATE project_team_dispatch SET stage='settled' WHERE dispatch_id=${f.request.dispatchId}`;
});

it.effect(
  "bounded actual SQLite pages wrap fairly, retry busy rows, and preserve their original limits",
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
        h.ports.withClaim = (item) =>
          Effect.sync(() => {
            expect(item.intent.limits.maximumTokens).toBe(retained.intent.limits.maximumTokens);
            return { _tag: "Busy" as const };
          });
        const recovery = makeProjectTeamRecovery(h.ports);
        const first = yield* recovery.sweep();
        const second = yield* recovery.sweep();
        const again = yield* recovery.sweep();
        expect(first.items.map((i) => i.dispatchId)).toEqual(ids.slice(0, 128));
        expect(first.afterDispatchId).toBe(ids[127]);
        expect(second.items.map((i) => i.dispatchId)).toEqual(ids.slice(128));
        expect(second.wrapped).toBe(true);
        expect(again.items.map((i) => i.dispatchId)).toEqual(ids.slice(0, 128));
        expect(pages).toEqual([undefined, ids[127], undefined]);
        expect(h.events).toEqual([]);
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
        const recovery = makeProjectTeamRecovery(h.ports, { pageSize: 3 });
        const result = yield* recovery.sweep();
        expect(result.items.map((i) => i.dispatchId)).toEqual(["a", "b", "c"]);
        expect(Exit.isSuccess(result.items[0]!.result)).toBe(true);
        const failed = result.items[1]!.result;
        if (!Exit.isFailure(failed)) return yield* Effect.die("Malformed discovery succeeded");
        expect(failed.cause.reasons.filter(Cause.isFailReason).map((r) => r.error.reason)).toEqual([
          "Dispatch intent is invalid",
          "publication failed",
        ]);
        expect(Exit.isSuccess(result.items[2]!.result)).toBe(true);
        expect(h.events).toEqual([
          "claim:a",
          "join",
          "settle",
          "release",
          "attention:b",
          "claim:c",
          "join",
          "settle",
          "release",
        ]);
        expect((yield* recovery.sweep()).items).toEqual([]);
        expect((yield* recovery.sweep()).items.map((i) => i.dispatchId)).toEqual(["a", "b", "c"]);
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
