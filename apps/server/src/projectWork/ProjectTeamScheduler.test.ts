import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkAttemptId,
  ProjectWorkCriterionId,
  ProjectWorkRelationshipId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import { makeProjectTeamRecovery, ProjectTeamRecoveryExecution } from "./ProjectTeamRecovery.ts";
import type { ProjectTeamDispatchSnapshot } from "./ProjectTeamDispatch.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  at,
  attribution,
  projectId,
  taskId,
  scoped,
  seed,
  createManagedAssignment,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { makeProjectTeamSchedulingView } from "./ProjectTeamSchedulingView.ts";
import { PROJECT_WORK_CHECKPOINT_VERSION } from "./ProjectTeamsPersistence.ts";
import {
  makeProjectTeamScheduler,
  type ProjectTeamSchedulerPorts,
} from "./ProjectTeamScheduler.ts";

const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  yield* seed("implementer", "reserved", {
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
          return Effect.fail(new ProjectWorkPolicyError("invalid-state", "Retain fixture claim"));
        }
        return repository.execute(command);
      },
    }),
    Effect.result,
  );
  if (!pending || pending.transition?.kind !== "claim")
    return yield* Effect.die("Missing uncommitted claim");
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "scheduler-limits",
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
          environmentModelCalls: 2,
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
  const request: ProjectTeamDispatchRequest = {
    dispatchId: "scheduler-dispatch",
    claim: { ...pending, expectedRevision: (yield* readCurrentState(sql, projectId)).revision },
    git: {
      effectId: "scheduler-dispatch",
      runId: "binding",
      generation: 0,
      primaryRoot: "/workspace",
      commonGitDirectory: "/workspace/.git",
      worktreePath: "/workspace",
      branchRef: "task",
      baseRef: "main",
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
    maximumEnvironmentModelCalls: 2,
  });
  const ports = {
    readProjectPage: () => Effect.succeed([{ projectId, priority: 0 }]),
    readProjectState: () =>
      readCurrentState(sql, projectId).pipe(
        Effect.map((state) => ({ state, candidates: [{ taskId, priority: 0 }] })),
      ),
    prepareRequest: () => Effect.succeed({ _tag: "Prepared" as const, request }),
    reserve: journal.reserve,
    notifyCommittedDispatch: (committed: Effect.Success<ReturnType<typeof journal.reserve>>) =>
      Effect.gen(function* () {
        expect((yield* journal.inspect(committed.fence.dispatchId)).fence).toEqual(committed.fence);
        expect((yield* readCurrentState(sql, projectId)).attempts).toHaveLength(1);
      }),
  };
  const scheduler = yield* makeProjectTeamScheduler({ environmentId: "environment", ports });
  return { sql, repository, request, journal, scheduler, ports };
});

it.effect("commits the authorized attempt and pending intent before notification", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.scheduler.sweep();
      expect(result.committed).toHaveLength(1);
      expect(result.committed[0]?.fence).toMatchObject({
        dispatchId: "scheduler-dispatch",
        revision: 0,
        claimGeneration: 0,
        stage: "reserved",
      });
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([
        { dispatch_id: "scheduler-dispatch" },
      ]);
    }),
  ),
);

it.effect("isolates malformed project priority while a healthy SQL claim commits", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const bad = ProjectId.make("a-malformed");
      yield* f.sql`INSERT INTO projection_projects
        (project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${bad},'Malformed policy','/workspace','[]',${at},${at})`;
      const healthy = yield* readCurrentState(f.sql, projectId);
      const limits = healthy.foundationRecords!.find((record) => record.kind === "limits");
      if (limits?.kind !== "limits") return yield* Effect.die("Missing fixture limits");
      yield* f.repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId: bad,
          commandId: "malformed-project-limits",
          expectedRevision: 0,
          attribution,
          committedAt: at,
          records: [
            { ...limits, projectId: bad, recordId: "malformed-limits", projectPriority: 1 },
          ],
        }),
      );
      const current = yield* readCurrentState(f.sql, bad);
      const broken = yield* encodeJson({
        ...current,
        checkpointVersion: PROJECT_WORK_CHECKPOINT_VERSION,
        foundationRecords: current.foundationRecords!.map((record) =>
          record.kind === "limits" ? { ...record, projectPriority: 0.5 } : record,
        ),
      });
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json = ${broken} WHERE project_id = ${bad}`;
      const view = yield* makeProjectTeamSchedulingView();
      const scheduler = yield* makeProjectTeamScheduler({
        environmentId: "environment",
        ports: { ...f.ports, ...view },
      });
      const results = yield* Effect.forEach([0, 1, 2], () => scheduler.sweep());
      expect(
        results.flatMap((result) => result.committed.map((entry) => entry.fence.dispatchId)),
      ).toEqual(["scheduler-dispatch"]);
      for (const result of results)
        expect(result.blocked).toContainEqual({
          projectId: bad,
          phase: "read",
          reason: "project-read-failed",
          error: expect.objectContaining({ _tag: "ProjectWorkPolicyError", code: "invalid-state" }),
        });
      expect((yield* readCurrentState(f.sql, bad)).attempts).toEqual([]);
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([
        { dispatch_id: "scheduler-dispatch" },
      ]);
    }),
  ),
);

type Fixture = Effect.Success<typeof fixture>;
type PortError =
  | Effect.Error<ReturnType<Fixture["journal"]["reserve"]>>
  | "lost-wake"
  | "unavailable";
const schedulerWith = (f: Fixture, ports: Partial<ProjectTeamSchedulerPorts<PortError>>) =>
  makeProjectTeamScheduler({ environmentId: "environment", ports: { ...f.ports, ...ports } });
const snapshotPorts = (f: Fixture, state: ProjectWorkReducerState) => ({
  readProjectState: () => Effect.succeed({ state, candidates: [{ taskId, priority: 0 }] }),
  prepareRequest: () =>
    Effect.succeed({
      _tag: "Prepared" as const,
      request: { ...f.request, claim: { ...f.request.claim, expectedRevision: state.revision } },
    }),
});

it.effect(
  "rejects project keyset order that agrees with UTF-16 but differs from SQLite binary",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const scheduler = yield* schedulerWith(f, {
          readProjectPage: () =>
            Effect.succeed([
              { projectId: ProjectId.make("unicode-\u{10000}"), priority: 0 },
              { projectId: ProjectId.make("unicode-\uE000"), priority: 0 },
            ]),
        });
        const result = yield* scheduler.sweep().pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({ reason: "Invalid project keyset page" });
      }),
    ),
);

it.effect("rejects task keyset order that agrees with UTF-16 but differs from SQLite binary", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const state = yield* readCurrentState(f.sql, projectId);
      const astral = ProjectWorkTaskId.make("unicode-\u{10000}");
      const highBmp = ProjectWorkTaskId.make("unicode-\uE000");
      const scheduler = yield* schedulerWith(f, {
        readProjectState: () =>
          Effect.succeed({
            state: {
              ...state,
              tasks: [astral, highBmp].map((id) => ({ ...state.tasks[0]!, taskId: id })),
            },
            candidates: [
              { taskId: astral, priority: 0 },
              { taskId: highBmp, priority: 0 },
            ],
          }),
      });
      expect((yield* scheduler.sweep()).blocked).toEqual([
        { projectId, phase: "read", reason: "invalid-task-keyset-page" },
      ]);
    }),
  ),
);

it.effect(
  "a lost notification leaves the original committed dispatch recoverable and never reserves a replacement",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const scheduler = yield* schedulerWith(f, {
          notifyCommittedDispatch: () => Effect.fail("lost-wake" as const),
        });
        const first = yield* scheduler.sweep();
        expect(first.committed).toHaveLength(1);
        expect(first.notificationFailures).toEqual(first.committed);
        expect(first.blocked).toMatchObject([
          { phase: "notify", reason: "notification-failed", error: "lost-wake" },
        ]);
        const second = yield* scheduler.sweep();
        expect(second.committed).toEqual([]);
        expect(second.notificationFailures).toEqual([]);
        const recovered = yield* f.journal.readRecoveryPage({ limit: 32 });
        expect(recovered).toHaveLength(1);
        expect(recovered[0]?.intent.request.dispatchId).toBe("scheduler-dispatch");
        expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
      }),
    ),
);

it.effect(
  "concurrent sweeps admit exactly one durable attempt and return its retained request",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const results = yield* Effect.all([f.scheduler.sweep(), f.scheduler.sweep()], {
          concurrency: 2,
        });
        expect(results.flatMap((r) => r.committed)).toHaveLength(1);
        expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([
          { dispatch_id: "scheduler-dispatch" },
        ]);
        expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
      }),
    ),
);

const ineligible: ReadonlyArray<{
  name: string;
  change: (state: ProjectWorkReducerState) => ProjectWorkReducerState;
}> = [
  {
    name: "draft capture",
    change: (s) => ({ ...s, tasks: s.tasks.map((t) => ({ ...t, state: "draft" })) }),
  },
  {
    name: "human task",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "task-membership" ? { ...r, executionKind: "human" } : r,
      ),
    }),
  },
  {
    name: "legacy task",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "task-membership" ? { ...r, executionKind: "legacy" } : r,
      ),
    }),
  },
  {
    name: "paused assignment",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "task-membership" ? { ...r, controlState: "paused" } : r,
      ),
    }),
  },
  {
    name: "removed assignment",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "task-membership" ? { ...r, status: "removed" } : r,
      ),
    }),
  },
  {
    name: "missing explicit start",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) => {
        if (r.kind !== "task-membership") return r;
        const { assignment: _, ...m } = r;
        return m;
      }),
    }),
  },
  {
    name: "invalidated execution grant",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "gate" && r.gate === "execution" ? { ...r, status: "invalidated" } : r,
      ),
    }),
  },
  {
    name: "paused member",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "member" ? { ...r, status: "paused" } : r,
      ),
    }),
  },
  {
    name: "retired role",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "role-revision" ? { ...r, status: "retired" } : r,
      ),
    }),
  },
  {
    name: "changed specification",
    change: (s) => ({
      ...s,
      tasks: s.tasks.map((t) => ({ ...t, specRevision: t.specRevision + 1 })),
    }),
  },
  {
    name: "changed plan",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "plan-revision" ? { ...r, content: "Expanded scope" } : r,
      ),
    }),
  },
  {
    name: "invalidated specification approval",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "gate" && r.gate === "specification" ? { ...r, status: "invalidated" } : r,
      ),
    }),
  },
  {
    name: "invalidated plan approval",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "gate" && r.gate === "plan" ? { ...r, status: "invalidated" } : r,
      ),
    }),
  },
  {
    name: "requested different successor",
    change: (s) => ({
      ...s,
      foundationRecords: (s.foundationRecords ?? []).map((r) =>
        r.kind === "task-membership" ? { ...r, requestedSuccessorMemberId: "different-member" } : r,
      ),
    }),
  },
  {
    name: "unresolved dependency",
    change: (s) => ({
      ...s,
      relationships: [
        {
          relationshipId: ProjectWorkRelationshipId.make("pending-dependency"),
          projectId,
          kind: "depends-on",
          fromTaskId: taskId,
          toTaskId: ProjectWorkTaskId.make("missing"),
          createdAt: at,
          revision: 0,
        },
      ],
    }),
  },
];
for (const control of ineligible)
  it.effect(`does not dispatch ${control.name}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const state = control.change(yield* readCurrentState(f.sql, projectId));
        const scheduler = yield* schedulerWith(f, snapshotPorts(f, state));
        const result = yield* scheduler.sweep();
        expect(result.committed).toEqual([]);
        expect(result.blocked).toHaveLength(1);
        expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
        expect((yield* readCurrentState(f.sql, projectId)).attempts).toEqual([]);
      }),
    ),
  );

it.effect("a pause committed after selection is denied by the actual atomic journal", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const scheduler = yield* schedulerWith(f, {
        reserve: (request) =>
          Effect.gen(function* () {
            const state = yield* readCurrentState(f.sql, projectId);
            const member = state.foundationRecords?.find((r) => r.kind === "member");
            if (member?.kind !== "member") return yield* Effect.die("Missing member");
            yield* f.repository.execute(
              yield* decodeCommit({
                type: "project-work.foundation.commit",
                projectId,
                commandId: "pause-before-reserve",
                expectedRevision: state.revision,
                attribution,
                committedAt: at,
                records: [{ ...member, revision: member.revision + 1, status: "paused" }],
              }),
            );
            return yield* f.journal.reserve(request);
          }),
      });
      const result = yield* scheduler.sweep();
      expect(result.committed).toEqual([]);
      expect(result.blocked).toMatchObject([{ phase: "reserve", reason: "reservation-denied" }]);
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toEqual([]);
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
    }),
  ),
);

it.effect("disabled model limits are an explicit reservation denial", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const state = yield* readCurrentState(f.sql, projectId);
      const limits = state.foundationRecords?.find((r) => r.kind === "limits");
      if (limits?.kind !== "limits") return yield* Effect.die("Missing limits");
      yield* f.repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "disable-limits",
          expectedRevision: state.revision,
          attribution,
          committedAt: at,
          records: [{ ...limits, revision: limits.revision + 1, status: "disabled" }],
        }),
      );
      const latest = yield* readCurrentState(f.sql, projectId);
      const scheduler = yield* schedulerWith(f, snapshotPorts(f, latest));
      expect((yield* scheduler.sweep()).blocked).toMatchObject([
        { phase: "reserve", reason: "reservation-denied" },
      ]);
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
    }),
  ),
);

it.effect("wrong environment and stale prepared revisions cannot reach reservation", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const transition = f.request.claim.transition;
      if (transition?.kind !== "claim") return yield* Effect.die("Missing claim");
      for (const request of [
        { ...f.request, claim: { ...f.request.claim, expectedRevision: 0 } },
        {
          ...f.request,
          claim: {
            ...f.request.claim,
            transition: {
              ...transition,
              binding: {
                ...transition.binding,
                environmentId: EnvironmentId.make("other-environment"),
              },
            },
          },
        },
      ]) {
        const scheduler = yield* schedulerWith(f, {
          prepareRequest: () => Effect.succeed({ _tag: "Prepared", request }),
        });
        expect((yield* scheduler.sweep()).blocked).toMatchObject([
          { phase: "prepare", reason: "prepared-identity-mismatch" },
        ]);
      }
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
    }),
  ),
);

it.effect("keyset sweeps reach all 75 projects despite blocked high-priority projects", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const original = yield* readCurrentState(f.sql, projectId);
      const ids = Array.from({ length: 75 }, (_, i) =>
        ProjectId.make(`project-${String(i).padStart(3, "0")}`),
      );
      const visited: string[] = [];
      const scheduler = yield* schedulerWith(f, {
        readProjectPage: ({ afterProjectId, limit }) =>
          Effect.succeed(
            ids
              .filter((id) => afterProjectId === undefined || id > afterProjectId)
              .slice(0, limit)
              .map((id, i) => ({ projectId: id, priority: i })),
          ),
        readProjectState: ({ projectId: id }) =>
          Effect.succeed({
            state: {
              ...original,
              projectId: id,
              tasks: original.tasks.map((t) => ({ ...t, projectId: id })),
              foundationRecords: (original.foundationRecords ?? []).map((r) => ({
                ...r,
                projectId: id,
              })),
            },
            candidates: [{ taskId, priority: 0 }],
          }),
        prepareRequest: ({ state }) =>
          Effect.sync(() => {
            visited.push(state.projectId);
            return { _tag: "Blocked" as const, reason: "configured-capacity-unavailable" };
          }),
      });
      const results = yield* Effect.all([scheduler.sweep(), scheduler.sweep(), scheduler.sweep()], {
        concurrency: 1,
      });
      expect(new Set(visited).size).toBe(75);
      expect(results.map((r) => r.projectsScanned)).toEqual([32, 32, 11]);
      expect(results.flatMap((r) => r.committed)).toEqual([]);
      expect(results[2]?.hasMore).toBe(false);
      yield* scheduler.sweep();
      expect(visited).toHaveLength(107);
    }),
  ),
);

it.effect(
  "task keysets reach 150 tasks, using priority inside each page without corrupting cursors",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const original = yield* readCurrentState(f.sql, projectId);
        const task = original.tasks[0]!;
        const membership = original.foundationRecords?.find((r) => r.kind === "task-membership");
        const grant = original.foundationRecords?.find(
          (r) => r.kind === "gate" && r.gate === "execution",
        );
        if (membership?.kind !== "task-membership" || grant?.kind !== "gate")
          return yield* Effect.die("Missing managed assignment");
        const ids = Array.from({ length: 150 }, (_, i) =>
          ProjectWorkTaskId.make(`task-${String(i).padStart(3, "0")}`),
        );
        const state = {
          ...original,
          tasks: ids.map((id) => ({
            ...task,
            taskId: id,
            specification: {
              ...task.specification!,
              criterionIds: [ProjectWorkCriterionId.make(`criterion:${id}`)],
            },
          })),
          criteria: ids.map((id) => ({
            ...original.criteria[0]!,
            taskId: id,
            criterionId: ProjectWorkCriterionId.make(`criterion:${id}`),
          })),
          foundationRecords: ids.flatMap((id) => [
            {
              ...membership,
              taskId: id,
              recordId: `membership:${id}`,
              assignment: { ...membership.assignment!, authorizationGateId: `grant:${id}` },
            },
            { ...grant, taskId: id, recordId: `grant:${id}` },
          ]),
        };
        const visited: string[] = [];
        const scheduler = yield* schedulerWith(f, {
          readProjectState: ({ afterTaskId, limit }) =>
            Effect.succeed({
              state,
              candidates: ids
                .filter((id) => afterTaskId === undefined || id > afterTaskId)
                .slice(0, limit)
                .map((id, i) => ({ taskId: id, priority: i })),
            }),
          prepareRequest: ({ taskId: id }) =>
            Effect.sync(() => {
              visited.push(id);
              return { _tag: "Blocked" as const, reason: "needs-configured-member" };
            }),
        });
        for (let i = 0; i < 3; i++) yield* scheduler.sweep();
        expect(new Set(visited).size).toBe(150);
        expect(visited[0]).toBe("task-063");
        expect(visited[64]).toBe("task-127");
        expect(visited[128]).toBe("task-149");
      }),
    ),
);

it.effect(
  "strict project and task keyset pages reject duplicates, overflow and mismatched identity",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const state = yield* readCurrentState(f.sql, projectId);
        for (const page of [
          [
            { projectId, priority: 0 },
            { projectId, priority: 1 },
          ],
          [{ projectId, priority: Number.NaN }],
          Array.from({ length: 33 }, (_, i) => ({
            projectId: ProjectId.make(`project-${i}`),
            priority: i,
          })),
        ]) {
          const scheduler = yield* schedulerWith(f, {
            readProjectPage: () => Effect.succeed(page),
          });
          const result = yield* scheduler.sweep().pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject({ reason: "Invalid project keyset page" });
        }
        for (const page of [
          {
            state,
            candidates: [
              { taskId, priority: 0 },
              { taskId, priority: 1 },
            ],
          },
          { state, candidates: [{ taskId, priority: Number.POSITIVE_INFINITY }] },
          {
            state: { ...state, projectId: "other-project" },
            candidates: [{ taskId, priority: 0 }],
          },
          { state, candidates: [{ taskId: ProjectWorkTaskId.make("unknown"), priority: 0 }] },
        ]) {
          const scheduler = yield* schedulerWith(f, {
            readProjectState: () => Effect.succeed(page),
          });
          expect((yield* scheduler.sweep()).blocked).toMatchObject([
            { phase: "read", reason: "invalid-task-keyset-page" },
          ]);
        }
        expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
      }),
    ),
);

it.effect("invalid sweep limits fail before reading or dispatching", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const options of [
        { projects: 33 },
        { tasksPerProject: 65 },
        { maximumReservations: 33 },
        { projects: 0 },
        { tasksPerProject: 1.5 },
        { maximumReservations: Number.NaN },
      ]) {
        const result = yield* f.scheduler.sweep(options).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({ reason: "Invalid sweep bounds" });
      }
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
    }),
  ),
);

it.effect("a temporarily unreadable project does not block the next eligible project", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const blockedProject = ProjectId.make("a-blocked");
      const scheduler = yield* schedulerWith(f, {
        readProjectPage: () =>
          Effect.succeed([
            { projectId: blockedProject, priority: 1 },
            { projectId, priority: 0 },
          ]),
        readProjectState: (input) =>
          input.projectId === blockedProject
            ? Effect.fail("unavailable" as const)
            : f.ports.readProjectState(),
      });
      const result = yield* scheduler.sweep();
      expect(result.committed).toHaveLength(1);
      expect(result.blocked).toMatchObject([
        { projectId: "a-blocked", phase: "read", error: "unavailable" },
      ]);
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
    }),
  ),
);

it.effect("a journal transaction failure never sends a wake or retains a partial assignment", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`CREATE TRIGGER reject_scheduler_dispatch BEFORE INSERT ON project_team_dispatch BEGIN SELECT RAISE(ABORT,'reject scheduler transaction'); END`;
      const result = yield* f.scheduler.sweep();
      expect(result.committed).toEqual([]);
      expect(result.notificationFailures).toEqual([]);
      expect(result.blocked).toMatchObject([{ phase: "reserve", reason: "reservation-denied" }]);
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toEqual([]);
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
      expect(yield* f.sql`SELECT root_task_id FROM project_team_model_budget`).toEqual([]);
    }),
  ),
);

it.effect("a reservation cap preserves the remaining task window and current writer capacity", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = f.request.claim.transition;
      const role = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
        (r) => r.kind === "role-revision",
      );
      if (first?.kind !== "claim" || role?.kind !== "role-revision")
        return yield* Effect.die("Missing frozen role");
      const otherId = ProjectWorkTaskId.make("zzz-other-task");
      let secondClaim: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
      yield* createManagedAssignment({
        taskId: otherId,
        recordId: "other-binding",
        attemptId: "other-attempt",
        commandId: "other-dispatch",
        providerInstanceId: ProviderInstanceId.make("pi"),
        threadId: ThreadId.make("other-thread"),
        role,
        status: "reserved",
        configuration: first.binding.configuration,
      }).pipe(
        Effect.provideService(ProjectWorkRepository, {
          ...f.repository,
          execute: (command) => {
            if (
              command.type === "project-work.foundation.commit" &&
              command.transition?.kind === "claim"
            ) {
              secondClaim = command;
              return Effect.fail(
                new ProjectWorkPolicyError("invalid-state", "Retain second approved claim"),
              );
            }
            return f.repository.execute(command);
          },
        }),
        Effect.result,
      );
      if (!secondClaim || secondClaim.transition?.kind !== "claim")
        return yield* Effect.die("Missing second claim");
      const otherRequest: ProjectTeamDispatchRequest = {
        ...f.request,
        dispatchId: "other-dispatch",
        claim: secondClaim,
        git: {
          ...f.request.git,
          effectId: "other-dispatch",
          runId: "other-binding",
          ownershipToken: "other-owner",
        },
        setupId: "other-setup",
        initializeOperationId: "other-initialize",
        assignmentOperationId: "other-assignment",
      };
      const selected: string[] = [];
      const scheduler = yield* schedulerWith(f, {
        readProjectState: () =>
          readCurrentState(f.sql, projectId).pipe(
            Effect.map((state) => ({
              state,
              candidates: [
                { taskId, priority: 0 },
                { taskId: otherId, priority: 10 },
              ],
            })),
          ),
        prepareRequest: ({ state, taskId: id }) =>
          Effect.sync(() => {
            selected.push(id);
            const request = id === otherId ? otherRequest : f.request;
            return {
              _tag: "Prepared" as const,
              request: {
                ...request,
                claim: { ...request.claim, expectedRevision: state.revision },
              },
            };
          }),
      });
      const high = yield* scheduler.sweep({ maximumReservations: 1 });
      expect(high.committed.map((r) => r.fence.dispatchId)).toEqual(["other-dispatch"]);
      const low = yield* scheduler.sweep({ maximumReservations: 1 });
      expect(selected).toEqual(["zzz-other-task", "authorization-task"]);
      expect(low.committed).toEqual([]);
      expect(low.blocked).toMatchObject([
        { taskId: "authorization-task", phase: "reserve", reason: "reservation-denied" },
      ]);
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([
        { dispatch_id: "other-dispatch" },
      ]);
    }),
  ),
);

it.effect(
  "explicit investigation dispatches a bounded read-only child without authorizing the parent",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const before = yield* readCurrentState(f.sql, projectId);
        const human = {
          actor: { kind: "human", id: "human" },
          source: { kind: "web", id: "browser" },
          recordedAt: at,
        };
        yield* f.repository.execute(
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "start-research",
            expectedRevision: before.revision,
            attribution: human,
            committedAt: at,
            records: [],
            guided: {
              intent: {
                type: "project-team.investigation.start",
                projectId,
                taskId,
                commandId: "start-research",
                expectedRevision: before.revision,
                expectedTaskRevision: before.tasks[0]!.revision,
                objective: "Investigate the bounded report",
                outputDescriptions: ["Sourced findings"],
              },
            },
          }),
        );
        let state = yield* readCurrentState(f.sql, projectId);
        const membership = state.foundationRecords?.find(
          (r) => r.kind === "task-membership" && r.deliverableKind === "research",
        );
        const role = state.foundationRecords?.find(
          (r) => r.kind === "role-revision" && r.role === "investigator",
        );
        if (membership?.kind !== "task-membership" || role?.kind !== "role-revision")
          return yield* Effect.die("Missing research assignment");
        yield* f.repository.execute(
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "configure-investigator",
            expectedRevision: state.revision,
            attribution,
            committedAt: at,
            records: [
              {
                ...role,
                recordId: "research-role",
                roleRevision: role.roleRevision + 1,
                model: "test",
                delegationDepth: 2,
                revision: 0,
              },
              {
                kind: "member",
                projectId,
                recordId: "read-member",
                revision: 0,
                generation: 0,
                updatedAt: at,
                status: "active",
                name: "Investigator",
                coordinator: false,
                roleRevisionId: "research-role",
              },
            ],
          }),
        );
        state = yield* readCurrentState(f.sql, projectId);
        const first = f.request.claim.transition;
        const grant = state.foundationRecords?.find(
          (r) => r.kind === "gate" && r.recordId === membership.assignment?.authorizationGateId,
        );
        if (first?.kind !== "claim" || grant?.kind !== "gate")
          return yield* Effect.die("Missing explicit research grant");
        const { specificationGateId: _, planGateId: __, ...baseBinding } = first.binding;
        const researchId = membership.taskId;
        const binding = {
          ...baseBinding,
          recordId: "research-binding",
          memberId: "read-member",
          taskId: researchId,
          attemptId: ProjectWorkAttemptId.make("research-attempt"),
          roleRevisionId: "research-role",
          threadId: ThreadId.make("research-thread"),
          planRevision: 0,
          authorizationGateId: grant.recordId,
          scopeHash: projectTeamScopeHash(state, researchId),
          configuration: { ...first.binding.configuration, toolIds: ["read"] },
        };
        const request: ProjectTeamDispatchRequest = {
          ...f.request,
          dispatchId: "research-dispatch",
          claim: {
            ...f.request.claim,
            commandId: CommandId.make("research-dispatch"),
            expectedRevision: state.revision,
            transition: {
              ...first,
              taskId: researchId,
              expectedTaskRevision: state.tasks.find((t) => t.taskId === researchId)!.revision,
              authorizationGateId: grant.recordId,
              expectedGateRevision: grant.revision,
              binding,
              claim: {
                ...first.claim,
                commandId: CommandId.make("research-dispatch"),
                taskId: researchId,
                attemptId: binding.attemptId,
              },
            },
          },
          git: { ...f.request.git, effectId: "research-dispatch", runId: "research-binding" },
          setupId: "research-setup",
          initializeOperationId: "research-initialize",
          assignmentOperationId: "research-assignment",
        };
        const scheduler = yield* schedulerWith(f, {
          readProjectState: () =>
            readCurrentState(f.sql, projectId).pipe(
              Effect.map((state) => ({ state, candidates: [{ taskId: researchId, priority: 0 }] })),
            ),
          prepareRequest: () => Effect.succeed({ _tag: "Prepared", request }),
        });
        const result = yield* scheduler.sweep();
        expect(result.blocked).toEqual([]);
        expect(result.committed).toHaveLength(1);
        expect(result.committed[0]?.intent.limits.writable).toBe(false);
        expect(result.committed[0]?.intent.limits.delegationDepth).toBe(1);
        expect(result.committed[0]?.intent.request.claim.transition).toMatchObject({
          binding: { configuration: { paidFallback: false, toolIds: ["read"] } },
        });
        const after = yield* readCurrentState(f.sql, projectId);
        expect(after.attempts.map((a) => a.taskId)).toEqual([researchId]);
        expect(after.tasks.find((t) => t.taskId === taskId)?.activeAttemptId).toBeUndefined();
        expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([]);
      }),
    ),
);

it.effect(
  "removing a project retires its pending selection window without changing durable history",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const draftId = ProjectWorkTaskId.make("zzz-draft");
        yield* f.repository.execute({
          type: "project-work.task.create",
          projectId,
          taskId: draftId,
          commandId: CommandId.make("capture-draft"),
          title: "Captured reminder",
          createdAt: at,
        });
        let visible = true;
        const scheduler = yield* schedulerWith(f, {
          readProjectPage: () => Effect.succeed(visible ? [{ projectId, priority: 0 }] : []),
          readProjectState: () =>
            readCurrentState(f.sql, projectId).pipe(
              Effect.map((state) => ({
                state,
                candidates: [
                  { taskId, priority: 1 },
                  { taskId: draftId, priority: 0 },
                ],
              })),
            ),
          prepareRequest: ({ state }) =>
            Effect.succeed({
              _tag: "Prepared",
              request: {
                ...f.request,
                claim: { ...f.request.claim, expectedRevision: state.revision },
              },
            }),
        });
        const admitted = yield* scheduler.sweep({ maximumReservations: 1 });
        expect(admitted.committed).toHaveLength(1);
        expect(admitted.hasMore).toBe(true);
        visible = false;
        const removed = yield* scheduler.sweep();
        expect(removed.hasMore).toBe(false);
        expect(removed.projectsScanned).toBe(0);
        expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
        expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([
          { dispatch_id: "scheduler-dispatch" },
        ]);
      }),
    ),
);

const twoTasksForMember = (sameMember = false) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const original = f.request.claim.transition;
    const state = yield* readCurrentState(f.sql, projectId);
    const role = state.foundationRecords?.find((r) => r.kind === "role-revision");
    const limits = state.foundationRecords?.find((r) => r.kind === "limits");
    const member = state.foundationRecords?.find((r) => r.kind === "member");
    if (
      original?.kind !== "claim" ||
      role?.kind !== "role-revision" ||
      limits?.kind !== "limits" ||
      member?.kind !== "member"
    )
      return yield* Effect.die("Fixture lacks frozen role, limits or claim");
    yield* f.repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "two-writer-policy",
        expectedRevision: state.revision,
        attribution,
        committedAt: at,
        records: [
          { ...limits, revision: limits.revision + 1, projectWritableWorkers: 2 },
          ...(sameMember
            ? []
            : [{ ...member, recordId: "continuation-other-member", revision: 0 }]),
        ],
      }),
    );
    const otherId = ProjectWorkTaskId.make("zzz-continuation-other");
    let retained: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    yield* createManagedAssignment({
      taskId: otherId,
      recordId: "continuation-other-binding",
      attemptId: "continuation-other-attempt",
      commandId: "continuation-other-dispatch",
      providerInstanceId: ProviderInstanceId.make("pi"),
      threadId: ThreadId.make("continuation-other-thread"),
      memberId: sameMember ? original.binding.memberId : "continuation-other-member",
      role,
      status: "reserved",
      configuration: original.binding.configuration,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...f.repository,
        execute: (command) => {
          if (
            command.type === "project-work.foundation.commit" &&
            command.transition?.kind === "claim"
          ) {
            retained = command;
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Retain approved continuation claim"),
            );
          }
          return f.repository.execute(command);
        },
      }),
      Effect.result,
    );
    if (!retained || retained.transition?.kind !== "claim")
      return yield* Effect.die("Missing retained second claim");
    const otherRequest: ProjectTeamDispatchRequest = {
      ...f.request,
      dispatchId: "continuation-other-dispatch",
      claim: {
        ...retained,
        transition: {
          ...retained.transition,
          binding: {
            ...retained.transition.binding,
            worktree: "/workspace/continuation-other",
            branch: "continuation-other-branch",
          },
        },
      },
      git: {
        ...f.request.git,
        effectId: "continuation-other-dispatch",
        runId: "continuation-other-binding",
        worktreePath: "/workspace/continuation-other",
        branchRef: "continuation-other-branch",
        ownershipToken: "continuation-other-owner",
      },
      setupId: "continuation-other-setup",
      initializeOperationId: "continuation-other-initialize",
      assignmentOperationId: "continuation-other-assignment",
    };
    const prepared: Array<string> = [];
    return {
      ...f,
      otherId,
      otherRequest,
      prepared,
      prepare: ({
        state,
        taskId: id,
      }: {
        state: ProjectWorkReducerState;
        taskId: ProjectWorkTaskId;
      }) =>
        Effect.sync(() => {
          prepared.push(id);
          const request = id === otherId ? otherRequest : f.request;
          return {
            _tag: "Prepared" as const,
            request: { ...request, claim: { ...request.claim, expectedRevision: state.revision } },
          };
        }),
    };
  });

const twoTasks = twoTasksForMember();

const continuationPorts = (f: Effect.Success<typeof twoTasks>) => ({
  readProjectState: ({ afterTaskId, limit }: { afterTaskId?: ProjectWorkTaskId; limit: number }) =>
    readCurrentState(f.sql, projectId).pipe(
      Effect.map((state) => ({
        state,
        candidates: [
          { taskId, priority: 1 },
          { taskId: f.otherId, priority: 0 },
        ]
          .filter((candidate) => afterTaskId === undefined || candidate.taskId > afterTaskId)
          .slice(0, limit),
      })),
    ),
  prepareRequest: f.prepare,
  notifyCommittedDispatch: () => Effect.void,
});

it.effect("interruption after durable reserve preserves the unvisited selection window", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* twoTasks;
      const entered = yield* Deferred.make<void>();
      const scheduler = yield* schedulerWith(f, {
        ...continuationPorts(f),
        notifyCommittedDispatch: (result) =>
          result.fence.dispatchId === f.request.dispatchId
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const running = yield* scheduler
        .sweep({ tasksPerProject: 2, maximumReservations: 1 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
      expect(
        (yield* f.journal.readRecoveryPage({ limit: 32 })).map(
          (result) => result.intent.request.dispatchId,
        ),
      ).toEqual([f.request.dispatchId]);
      yield* Fiber.interrupt(running);
      const next = yield* scheduler.sweep({ tasksPerProject: 2, maximumReservations: 1 });
      expect(next.blocked).toEqual([]);
      expect(next.committed.map((result) => result.fence.dispatchId)).toEqual([
        f.otherRequest.dispatchId,
      ]);
      expect(f.prepared).toEqual([taskId, f.otherId]);
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(2);
      expect(
        (yield* f.journal.readRecoveryPage({ limit: 32 }))
          .map((result) => result.intent.request.dispatchId)
          .sort(),
      ).toEqual([f.request.dispatchId, f.otherRequest.dispatchId].sort());
    }),
  ),
);

it.effect("normal capped continuation reserves both original identities once", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* twoTasks;
      const scheduler = yield* schedulerWith(f, continuationPorts(f));
      expect(
        (yield* scheduler.sweep({ tasksPerProject: 2, maximumReservations: 1 })).committed.map(
          (result) => result.fence.dispatchId,
        ),
      ).toEqual([f.request.dispatchId]);
      expect(
        (yield* scheduler.sweep({ tasksPerProject: 2, maximumReservations: 1 })).committed.map(
          (result) => result.fence.dispatchId,
        ),
      ).toEqual([f.otherRequest.dispatchId]);
      expect(f.prepared).toEqual([taskId, f.otherId]);
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(2);
    }),
  ),
);

it.effect("a fresh candidate page excludes a retained task before preparation or reserve", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* twoTasks;
      let includeOther = true;
      const scheduler = yield* schedulerWith(f, {
        ...continuationPorts(f),
        readProjectState: ({ afterTaskId, limit }) =>
          readCurrentState(f.sql, projectId).pipe(
            Effect.map((state) => ({
              state,
              candidates: [
                { taskId, priority: 1 },
                ...(includeOther ? [{ taskId: f.otherId, priority: 0 }] : []),
              ]
                .filter((candidate) => afterTaskId === undefined || candidate.taskId > afterTaskId)
                .slice(0, limit),
            })),
          ),
      });
      expect(
        (yield* scheduler.sweep({ tasksPerProject: 2, maximumReservations: 1 })).committed,
      ).toHaveLength(1);
      includeOther = false;
      const next = yield* scheduler.sweep({ tasksPerProject: 2, maximumReservations: 1 });
      expect({
        prepared: f.prepared,
        committed: next.committed.length,
        hasMore: next.hasMore,
      }).toEqual({ prepared: [taskId], committed: 0, hasMore: false });
      expect(
        (yield* readCurrentState(f.sql, projectId)).tasks.find((task) => task.taskId === f.otherId)
          ?.state,
      ).toBe("ready");
      expect(
        (yield* f.journal.readRecoveryPage({ limit: 32 })).map(
          (result) => result.intent.request.dispatchId,
        ),
      ).toEqual([f.request.dispatchId]);
    }),
  ),
);

const threeTasksForMember = (sameMember = false) =>
  Effect.gen(function* () {
    const f = yield* twoTasksForMember(sameMember);
    const before = yield* readCurrentState(f.sql, projectId);
    const role = before.foundationRecords?.find((r) => r.kind === "role-revision");
    const member = before.foundationRecords?.find((r) => r.kind === "member");
    const first = f.request.claim.transition;
    if (role?.kind !== "role-revision" || member?.kind !== "member" || first?.kind !== "claim")
      return yield* Effect.die("Missing third-task prerequisites");
    yield* f.repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "third-member",
        expectedRevision: before.revision,
        attribution,
        committedAt: at,
        records: [{ ...member, recordId: "continuation-third-member", revision: 0 }],
      }),
    );
    const thirdId = ProjectWorkTaskId.make("zzz-continuation-third");
    let retained: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    yield* createManagedAssignment({
      taskId: thirdId,
      recordId: "continuation-third-binding",
      attemptId: "continuation-third-attempt",
      commandId: "continuation-third-dispatch",
      providerInstanceId: ProviderInstanceId.make("pi"),
      threadId: ThreadId.make("continuation-third-thread"),
      memberId: sameMember ? first.binding.memberId : "continuation-third-member",
      role,
      status: "reserved",
      configuration: first.binding.configuration,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...f.repository,
        execute: (command) => {
          if (
            command.type === "project-work.foundation.commit" &&
            command.transition?.kind === "claim"
          ) {
            retained = command;
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Retain third approved claim"),
            );
          }
          return f.repository.execute(command);
        },
      }),
      Effect.result,
    );
    if (!retained || retained.transition?.kind !== "claim")
      return yield* Effect.die("Missing third claim");
    const thirdRequest: ProjectTeamDispatchRequest = {
      ...f.request,
      dispatchId: "continuation-third-dispatch",
      claim: {
        ...retained,
        transition: {
          ...retained.transition,
          binding: {
            ...retained.transition.binding,
            worktree: "/workspace/continuation-third",
            branch: "continuation-third-branch",
          },
        },
      },
      git: {
        ...f.request.git,
        effectId: "continuation-third-dispatch",
        runId: "continuation-third-binding",
        worktreePath: "/workspace/continuation-third",
        branchRef: "continuation-third-branch",
        ownershipToken: "continuation-third-owner",
      },
      setupId: "continuation-third-setup",
      initializeOperationId: "continuation-third-initialize",
      assignmentOperationId: "continuation-third-assignment",
    };

    return { ...f, thirdId, thirdRequest };
  });

const threeTasks = threeTasksForMember();

for (const reprioritize of [false, true]) {
  it.effect(
    reprioritize
      ? "retained candidates follow fresh priorities"
      : "initial priorities select the same eligible third task",
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* threeTasks;
          let changed = !reprioritize;
          const scheduler = yield* schedulerWith(f, {
            ...continuationPorts(f),
            readProjectState: ({ afterTaskId, limit }) =>
              readCurrentState(f.sql, projectId).pipe(
                Effect.map((state) => ({
                  state,
                  candidates: [
                    { taskId, priority: 100 },
                    { taskId: f.otherId, priority: changed ? 0 : 10 },
                    { taskId: f.thirdId, priority: changed ? 50 : 0 },
                  ]
                    .filter(
                      (candidate) => afterTaskId === undefined || candidate.taskId > afterTaskId,
                    )
                    .slice(0, limit),
                })),
              ),
            prepareRequest: ({ state, taskId: id }) =>
              id === f.thirdId
                ? Effect.succeed({
                    _tag: "Prepared" as const,
                    request: {
                      ...f.thirdRequest,
                      claim: { ...f.thirdRequest.claim, expectedRevision: state.revision },
                    },
                  })
                : f.prepare({ state, taskId: id }),
          });
          expect(
            (yield* scheduler.sweep({ tasksPerProject: 3, maximumReservations: 1 })).committed.map(
              (result) => result.fence.dispatchId,
            ),
          ).toEqual([f.request.dispatchId]);
          changed = true;
          const next = yield* scheduler.sweep({ tasksPerProject: 3, maximumReservations: 1 });
          expect(next.blocked).toEqual([]);
          expect(next.committed.map((result) => result.fence.dispatchId)).toEqual([
            f.thirdRequest.dispatchId,
          ]);
          expect(
            (yield* readCurrentState(f.sql, projectId)).tasks.find(
              (task) => task.taskId === f.otherId,
            )?.state,
          ).toBe("ready");
          expect(
            (yield* f.journal.readRecoveryPage({ limit: 32 }))
              .map((result) => result.intent.request.dispatchId)
              .sort(),
          ).toEqual([f.request.dispatchId, f.thirdRequest.dispatchId].sort());
        }),
      ),
  );
}

for (const phase of ["prepare", "reserve", "committed-response"] as const) {
  it.effect(
    `interruption during ${phase} keeps pending IDs and the original durable identity`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* twoTasks;
          const entered = yield* Deferred.make<void>();
          let interruptOnce = true;
          const stop = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          const scheduler = yield* schedulerWith(f, {
            ...continuationPorts(f),
            prepareRequest: (input) => {
              if (phase === "prepare" && interruptOnce) {
                interruptOnce = false;
                return stop;
              }
              return f.prepare(input);
            },
            reserve: (request) => {
              if (phase !== "prepare" && interruptOnce) {
                interruptOnce = false;
                return phase === "reserve"
                  ? stop
                  : f.journal.reserve(request).pipe(Effect.andThen(stop));
              }
              return f.journal.reserve(request);
            },
          });
          const running = yield* scheduler
            .sweep({ tasksPerProject: 2, maximumReservations: 1 })
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(
            phase === "committed-response" ? 1 : 0,
          );
          yield* Fiber.interrupt(running);
          const next = yield* scheduler.sweep({ tasksPerProject: 2, maximumReservations: 1 });
          expect(next.committed.map((result) => result.fence.dispatchId)).toEqual([
            phase === "committed-response" ? f.otherRequest.dispatchId : f.request.dispatchId,
          ]);
          if (phase !== "committed-response") {
            expect(
              (yield* scheduler.sweep({
                tasksPerProject: 2,
                maximumReservations: 1,
              })).committed.map((result) => result.fence.dispatchId),
            ).toEqual([f.otherRequest.dispatchId]);
          }
          expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(2);
          expect(
            (yield* f.journal.readRecoveryPage({ limit: 32 }))
              .map((result) => result.intent.request.dispatchId)
              .sort(),
          ).toEqual([f.request.dispatchId, f.otherRequest.dispatchId].sort());
        }),
      ),
  );
}

it.effect(
  "a retained ID displaced from the fresh bounded page is reached by its refreshed keyset cursor",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* threeTasks;
        let includeOther = false;
        const scheduler = yield* schedulerWith(f, {
          ...continuationPorts(f),
          readProjectState: ({ afterTaskId, limit }) =>
            readCurrentState(f.sql, projectId).pipe(
              Effect.map((state) => ({
                state,
                candidates: [
                  { taskId, priority: 100 },
                  ...(includeOther ? [{ taskId: f.otherId, priority: 10 }] : []),
                  { taskId: f.thirdId, priority: 0 },
                ]
                  .filter(
                    (candidate) => afterTaskId === undefined || candidate.taskId > afterTaskId,
                  )
                  .slice(0, limit),
              })),
            ),
          prepareRequest: ({ state, taskId: id }) =>
            id === f.thirdId
              ? Effect.succeed({
                  _tag: "Prepared" as const,
                  request: {
                    ...f.thirdRequest,
                    claim: { ...f.thirdRequest.claim, expectedRevision: state.revision },
                  },
                })
              : id === f.otherId
                ? Effect.succeed({ _tag: "Blocked" as const, reason: "temporarily-unavailable" })
                : f.prepare({ state, taskId: id }),
        });
        expect(
          (yield* scheduler.sweep({ tasksPerProject: 2, maximumReservations: 1 })).committed.map(
            (result) => result.fence.dispatchId,
          ),
        ).toEqual([f.request.dispatchId]);
        includeOther = true;
        const displaced = yield* scheduler.sweep({ tasksPerProject: 2, maximumReservations: 1 });
        expect(displaced.committed).toEqual([]);
        expect(displaced.hasMore).toBe(true);
        expect(
          (yield* scheduler.sweep({ tasksPerProject: 2, maximumReservations: 1 })).committed.map(
            (result) => result.fence.dispatchId,
          ),
        ).toEqual([f.thirdRequest.dispatchId]);
        expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(2);
      }),
    ),
);

for (const replacement of [false, true]) {
  it.effect(
    replacement
      ? "a fresh eligible replacement on a short page reaches actual reserve"
      : "the same task reserves from a retained short page",
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* threeTasks;
          let changed = false;
          const prepared: Array<ProjectWorkTaskId> = [];
          const scheduler = yield* schedulerWith(f, {
            ...continuationPorts(f),
            readProjectState: ({ afterTaskId, limit }) =>
              readCurrentState(f.sql, projectId).pipe(
                Effect.map((state) => ({
                  state,
                  candidates: (changed
                    ? [{ taskId: f.thirdId, priority: 50 }]
                    : [
                        { taskId, priority: 100 },
                        { taskId: replacement ? f.otherId : f.thirdId, priority: 0 },
                      ]
                  )
                    .filter(
                      (candidate) => afterTaskId === undefined || candidate.taskId > afterTaskId,
                    )
                    .slice(0, limit),
                })),
              ),
            prepareRequest: ({ state, taskId: id }) =>
              Effect.sync(() => {
                prepared.push(id);
                const request =
                  id === f.thirdId ? f.thirdRequest : id === f.otherId ? f.otherRequest : f.request;
                return {
                  _tag: "Prepared" as const,
                  request: {
                    ...request,
                    claim: { ...request.claim, expectedRevision: state.revision },
                  },
                };
              }),
          });
          const first = yield* scheduler.sweep({ tasksPerProject: 3, maximumReservations: 1 });
          expect(first.blocked).toEqual([]);
          expect(first.committed.map((result) => result.fence.dispatchId)).toEqual([
            f.request.dispatchId,
          ]);
          expect(first.hasMore).toBe(true);
          changed = true;
          const next = yield* scheduler.sweep({ tasksPerProject: 3, maximumReservations: 1 });
          expect(next.blocked).toEqual([]);
          expect(next.committed.map((result) => result.fence.dispatchId)).toEqual([
            f.thirdRequest.dispatchId,
          ]);
          expect(next.tasksScanned).toBe(1);
          expect(next.hasMore).toBe(false);
          expect(prepared).toEqual([taskId, f.thirdId]);
          const state = yield* readCurrentState(f.sql, projectId);
          expect(state.attempts).toHaveLength(2);
          expect(state.tasks.find((task) => task.taskId === f.thirdId)).toMatchObject({
            state: "in-progress",
            activeAttemptId: "continuation-third-attempt",
          });
          expect(state.tasks.find((task) => task.taskId === f.otherId)?.state).toBe("ready");
          expect(
            (yield* f.journal.readRecoveryPage({ limit: 32 }))
              .map((result) => result.intent.request.dispatchId)
              .sort(),
          ).toEqual([f.request.dispatchId, f.thirdRequest.dispatchId].sort());
        }),
      ),
  );
}

it.effect(
  "visited high-priority candidates do not starve a lower task when the scan budget shrinks",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* threeTasks;
        const prepared: Array<ProjectWorkTaskId> = [];
        const scheduler = yield* schedulerWith(f, {
          ...continuationPorts(f),
          readProjectState: ({ afterTaskId, limit }) =>
            readCurrentState(f.sql, projectId).pipe(
              Effect.map((state) => ({
                state,
                candidates: [
                  { taskId, priority: 100 },
                  { taskId: f.otherId, priority: 10 },
                  { taskId: f.thirdId, priority: 0 },
                ]
                  .filter(
                    (candidate) => afterTaskId === undefined || candidate.taskId > afterTaskId,
                  )
                  .slice(0, limit),
              })),
            ),
          prepareRequest: ({ state, taskId: id }) => {
            prepared.push(id);
            return id === f.otherId
              ? Effect.succeed({ _tag: "Blocked" as const, reason: "temporarily-unavailable" })
              : Effect.succeed({
                  _tag: "Prepared" as const,
                  request: {
                    ...(id === f.thirdId ? f.thirdRequest : f.request),
                    claim: {
                      ...(id === f.thirdId ? f.thirdRequest.claim : f.request.claim),
                      expectedRevision: state.revision,
                    },
                  },
                });
          },
        });
        expect(
          (yield* scheduler.sweep({ tasksPerProject: 3, maximumReservations: 1 })).committed.map(
            (result) => result.fence.dispatchId,
          ),
        ).toEqual([f.request.dispatchId]);
        const blocked = yield* scheduler.sweep({ tasksPerProject: 1, maximumReservations: 1 });
        expect(blocked.tasksScanned).toBe(1);
        expect(blocked.committed).toEqual([]);
        expect(blocked.blocked).toMatchObject([
          { taskId: f.otherId, phase: "prepare", reason: "temporarily-unavailable" },
        ]);
        expect(blocked.hasMore).toBe(true);
        const next = yield* scheduler.sweep({ tasksPerProject: 1, maximumReservations: 1 });
        expect(next.tasksScanned).toBe(1);
        expect(next.committed.map((result) => result.fence.dispatchId)).toEqual([
          f.thirdRequest.dispatchId,
        ]);
        expect(prepared).toEqual([taskId, f.otherId, f.thirdId]);
        expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(2);
      }),
    ),
);

for (const phase of ["prepare", "reserve"] as const) {
  it.effect(`capacity denial during ${phase} retries the same candidate on the next wake`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* twoTasks;
        let denied = true;
        const scheduler = yield* schedulerWith(f, {
          ...continuationPorts(f),
          prepareRequest: (input) =>
            denied && phase === "prepare"
              ? Effect.succeed({
                  _tag: "Blocked" as const,
                  reason: "configured-capacity-unavailable",
                })
              : f.prepare(input),
          reserve: (request) =>
            denied && phase === "reserve"
              ? Effect.fail(new ProjectWorkPolicyError("invalid-state", "Capacity unavailable"))
              : f.journal.reserve(request),
        });
        const first = yield* scheduler.sweep({ tasksPerProject: 1 });
        expect(first.committed).toHaveLength(0);
        denied = false;
        const retry = yield* scheduler.sweep({ tasksPerProject: 1 });
        expect(retry.committed.map((item) => item.fence.dispatchId)).toEqual([
          f.request.dispatchId,
        ]);
        expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
      }),
    ),
  );
}

it.effect(
  "same-member SQL siblings roll into a freed slot while another continuation stays held, and stop joins",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* threeTasksForMember(true);
        const requests = [f.request, f.otherRequest, f.thirdRequest];
        const scheduler = yield* schedulerWith(f, {
          ...continuationPorts(f),
          readProjectState: ({ afterTaskId, limit }) =>
            readCurrentState(f.sql, projectId).pipe(
              Effect.map((state) => ({
                state,
                candidates: [taskId, f.otherId, f.thirdId]
                  .filter((id) => afterTaskId === undefined || id > afterTaskId)
                  .slice(0, limit)
                  .map((taskId) => ({ taskId, priority: 0 })),
              })),
            ),
          prepareRequest: ({ state, taskId }) => {
            const request = requests.find(
              (request) =>
                request.claim.transition?.kind === "claim" &&
                request.claim.transition.taskId === taskId,
            )!;
            return Effect.succeed({
              _tag: "Prepared" as const,
              request: {
                ...request,
                claim: { ...request.claim, expectedRevision: state.revision },
              },
            });
          },
        });
        const scope = yield* Scope.make();
        const entered = yield* Queue.unbounded<string>();
        const completed = yield* Queue.unbounded<void>();
        const stopping = yield* Queue.unbounded<string>();
        const allowJoin = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(allowJoin, undefined).pipe(
            Effect.andThen(Scope.close(scope, Exit.void)),
          ),
        );
        const releases = new Map<string, Deferred.Deferred<void>>();
        const owned = new Set<string>();
        const resumes: string[] = [];
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 2,
          // Controlled host drain seam only; all claims, reservations and settlements use actual SQL.
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
        });
        type Claim = { snapshot: ProjectTeamDispatchSnapshot };
        const settle = (claim: Claim) =>
          journal
            .settleAfterJoined(claim.snapshot.fence, {
              receiptId: `${claim.snapshot.fence.dispatchId}-joined`,
              stage: "settled",
              evidence: {},
            })
            .pipe(Effect.asVoid);
        const recovery = makeProjectTeamRecovery<
          Claim,
          Claim,
          | Effect.Error<ReturnType<typeof journal.claimEffect>>
          | Effect.Error<ReturnType<typeof journal.settleAfterJoined>>
        >(
          {
            readPage: (input) => journal.readRecoveryCandidates(input),
            recordDiscoveryFailure: () => Effect.void,
            withClaim: (snapshot, run) =>
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  expect(owned.has(snapshot.fence.dispatchId)).toBe(false);
                  owned.add(snapshot.fence.dispatchId);
                  return { snapshot };
                }),
                run,
                () =>
                  Effect.sync(() => {
                    owned.delete(snapshot.fence.dispatchId);
                  }),
              ),
            assess: (claim) =>
              Effect.gen(function* () {
                claim.snapshot = yield* journal.claimEffect(claim.snapshot.fence);
                return { _tag: "Resume" as const, claim, snapshot: claim.snapshot };
              }),
            resume: (claim) =>
              Effect.gen(function* () {
                const id = claim.snapshot.fence.dispatchId;
                const release = yield* Deferred.make<void>();
                releases.set(id, release);
                resumes.push(id);
                yield* Queue.offer(entered, id);
                yield* Deferred.await(release);
                yield* settle(claim);
                return { _tag: "Observed" as const, fence: claim.snapshot.fence };
              }),
            joinCleanup: (claim) =>
              Effect.gen(function* () {
                yield* Queue.offer(stopping, claim.snapshot.fence.dispatchId);
                yield* Deferred.await(allowJoin);
                return { _tag: "Joined" as const, receipt: claim };
              }),
            settle: (claim) => settle(claim),
            quarantine: () => Effect.die("Controlled host should join"),
          },
          { pageSize: 2 },
        );
        const recover = recovery.sweep().pipe(
          Effect.provideService(ProjectTeamRecoveryExecution, {
            scope,
            completed: Queue.offer(completed, undefined).pipe(Effect.asVoid),
          }),
        );
        const first = yield* scheduler.sweep();
        expect(first.committed).toHaveLength(1);
        yield* recover;
        const firstId = yield* Queue.take(entered);
        const sibling = yield* scheduler.sweep();
        expect(sibling.committed).toHaveLength(1);
        yield* recover;
        const secondId = yield* Queue.take(entered);
        const bindings = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.filter(
          (r) => r.kind === "run-binding",
        );
        expect(bindings).toHaveLength(2);
        expect(
          new Set(bindings?.map((r) => (r.kind === "run-binding" ? r.memberId : ""))).size,
        ).toBe(1);
        expect(
          yield* f.sql`SELECT * FROM project_team_reservation WHERE status='held'`,
        ).toHaveLength(2);
        // Repeated discovery and direct duplicate admission cannot create another task/attempt owner.
        yield* recover;
        expect(resumes).toHaveLength(2);
        expect(
          (yield* journal
            .reserve({ ...f.request, dispatchId: "duplicate-task-dispatch" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const denied = yield* scheduler.sweep();
        expect(denied.committed).toHaveLength(0);
        expect(denied.hasMore).toBe(false);
        yield* Deferred.succeed(releases.get(firstId)!, undefined);
        yield* Queue.take(completed);
        expect(owned.has(secondId)).toBe(true);
        expect(
          yield* f.sql`SELECT * FROM project_team_reservation WHERE status='held'`,
        ).toHaveLength(1);
        const replacement = yield* scheduler.sweep();
        expect(replacement.committed).toHaveLength(1);
        // Positioned discovery advances past held owners; wrapping is bounded and wake-driven.
        yield* recover;
        yield* recover;
        const thirdId = yield* Queue.take(entered);
        expect(thirdId).not.toBe(secondId);
        expect(owned.has(secondId)).toBe(true);
        expect(resumes).toHaveLength(3);
        const stop = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        yield* Queue.take(stopping);
        expect(stop.pollUnsafe()).toBeUndefined();
        expect(
          yield* f.sql`SELECT * FROM project_team_reservation WHERE status='held'`,
        ).toHaveLength(2);
        yield* Deferred.succeed(allowJoin, undefined);
        yield* Fiber.join(stop);
        expect(owned.size).toBe(0);
        expect(
          yield* f.sql`SELECT * FROM project_team_reservation WHERE status='held'`,
        ).toHaveLength(0);
      }),
    ),
);
