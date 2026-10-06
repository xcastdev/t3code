import { expect, it } from "@effect/vitest";
import { ProjectTeamGate, ProjectWorkFoundationCommitCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { scoped, at } from "./ProjectTeamAuthorization.testFixtures.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import { decideProjectWorkCommand } from "./ProjectWorkDecider.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";

const decodeGate = Schema.decodeUnknownEffect(ProjectTeamGate);
const attribution = {
  actor: { kind: "human", id: "fixture-human" },
  source: { kind: "web", id: "fixture-browser" },
  recordedAt: at,
} as const;
const decode = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const fixture = Effect.gen(function* () {
  const f = yield* verificationFixture;
  const gate = yield* decodeGate({
    kind: "gate",
    projectId: f.selection.projectId,
    recordId: "verification-gate",
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "approved",
    taskId: f.selection.taskId,
    gate: "verification",
    specRevision: f.selection.specRevision,
    planRevision: f.selection.planRevision,
    contentHash: f.prepared.sha256,
    verificationJobId: f.selection.jobId,
    attribution,
    evidenceIds: [],
  });
  yield* f.repository.execute(
    decode({
      type: "project-work.foundation.commit",
      projectId: f.selection.projectId,
      commandId: "seed-verification-gate",
      expectedRevision: (yield* readCurrentState(f.sql, f.selection.projectId)).revision,
      attribution,
      records: [gate],
      committedAt: at,
    }),
  );
  const state = yield* readCurrentState(f.sql, f.selection.projectId);
  const command = {
    type: "project-work.foundation.commit",
    projectId: state.projectId,
    commandId: "verification-claim",
    expectedRevision: state.revision,
    attribution: {
      actor: { kind: "system", id: "project-team-verification" },
      source: { kind: "system", id: "project-team-verification" },
      recordedAt: at,
    },
    records: [],
    committedAt: at,
    transition: {
      kind: "verification.claim",
      taskId: f.selection.taskId,
      expectedTaskRevision: f.selection.expectedTaskRevision,
      gateId: gate.recordId,
      expectedGateRevision: gate.revision,
      jobId: f.selection.jobId,
      manifestHash: f.prepared.sha256,
      attemptId: "verification-attempt",
    },
  };
  return { ...f, gate, state, command };
});

it.effect("private consumption preserves human approval and changes no task lease", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.repository.execute(decode(f.command));
      const state = yield* readCurrentState(f.sql, f.selection.projectId);
      expect(state.foundationRecords?.find((r) => r.recordId === f.gate.recordId)).toEqual({
        ...f.gate,
        status: "consumed",
        revision: 1,
        consumedByRunId: "verification-attempt",
        consumedByCommandId: "verification-claim",
      });
      expect(state.tasks).toEqual(f.state.tasks);
      expect(state.attempts).toEqual(f.state.attempts);
      expect(state.revision).toBe(f.state.revision + 1);
      expect(
        (yield* f.repository
          .execute(
            decode({ ...f.command, commandId: "second-claim", expectedRevision: state.revision }),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

for (const mutation of [
  "task-revision",
  "gate-revision",
  "job",
  "hash",
  "actor",
  "source",
  "mixed-records",
] as const) {
  it.effect(`denies ${mutation} without consuming approval`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const command = structuredClone(f.command);
        switch (mutation) {
          case "task-revision":
            command.transition.expectedTaskRevision++;
            break;
          case "gate-revision":
            command.transition.expectedGateRevision++;
            break;
          case "job":
            command.transition.jobId = "other-job";
            break;
          case "hash":
            command.transition.manifestHash = "0".repeat(64);
            break;
          case "actor":
            command.attribution.actor.id = "other-producer";
            break;
          case "source":
            command.attribution.source.id = "other-producer";
            break;
          case "mixed-records":
            Object.assign(command, { records: [f.gate] });
            break;
        }
        expect(
          (yield* Effect.try(() => decode(command)).pipe(
            Effect.flatMap((c) => f.repository.execute(c)),
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(f.state);
      }),
    ),
  );
}

it.effect(
  "stale specification, latest plan, duplicate gate and non-human approval cannot be consumed",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const command = decode(f.command);
        const records = f.state.foundationRecords ?? [];
        const gate = records.find((r) => r.recordId === f.gate.recordId);
        const plan = records.find(
          (r) =>
            r.kind === "plan-revision" &&
            r.taskId === f.selection.taskId &&
            r.planRevision === f.selection.planRevision,
        );
        if (gate?.kind !== "gate" || plan?.kind !== "plan-revision")
          return yield* Effect.die("Missing seeded gate or plan");
        const states = [
          {
            ...f.state,
            tasks: f.state.tasks.map((r) =>
              r.taskId === f.selection.taskId ? { ...r, specRevision: r.specRevision + 1 } : r,
            ),
          },
          {
            ...f.state,
            foundationRecords: [
              ...records,
              { ...plan, recordId: "newer-plan", planRevision: plan.planRevision + 1 },
            ],
          },
          { ...f.state, foundationRecords: [...records, gate] },
          {
            ...f.state,
            foundationRecords: [...records, { ...gate, recordId: "duplicate-job-gate" }],
          },
          {
            ...f.state,
            foundationRecords: records.map((r) =>
              r.recordId === gate.recordId
                ? {
                    ...gate,
                    attribution: {
                      ...gate.attribution,
                      actor: { kind: "system" as const, id: "pretend-human" },
                    },
                  }
                : r,
            ),
          },
          {
            ...f.state,
            foundationRecords: records.map((r) =>
              r.recordId === gate.recordId ? { ...gate, status: "invalidated" as const } : r,
            ),
          },
        ];
        for (const state of states)
          expect(() => decideProjectWorkCommand(state, command)).toThrow();
        expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(f.state);
      }),
    ),
);
