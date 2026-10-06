import { expect, it } from "@effect/vitest";
import { ProjectTeamGate, ProjectWorkFoundationCommitCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { scoped, at } from "./ProjectTeamAuthorization.testFixtures.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkVerificationExecutionError } from "./ProjectWorkVerificationExecutionJournal.ts";
import { makeProjectWorkVerificationExecutionGrant } from "./ProjectWorkVerificationExecutionGrant.ts";

const decodeGate = Schema.decodeUnknownEffect(ProjectTeamGate);
const decodeFoundation = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const human = {
  actor: { kind: "human", id: "maintainer" },
  source: { kind: "web", id: "browser" },
  recordedAt: at,
} as const;
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
    attribution: human,
    evidenceIds: [],
  });
  yield* f.repository.execute(
    yield* decodeFoundation({
      type: "project-work.foundation.commit",
      projectId: f.selection.projectId,
      commandId: "seed-verification-gate",
      expectedRevision: (yield* readCurrentState(f.sql, f.selection.projectId)).revision,
      attribution: human,
      records: [gate],
      committedAt: at,
    }),
  );
  const state = yield* readCurrentState(f.sql, f.selection.projectId);
  return { ...f, gate, state };
});

it.effect("uses retained human approval without a surviving browser request", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const grant = yield* makeProjectWorkVerificationExecutionGrant({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        assertEnabled: Effect.void,
      });
      const selection = { receipt: f.prepared, gate: f.gate };
      yield* f.sql.withTransaction(grant.assertCurrent(selection, f.state, "approved", "attempt"));
      const commands = yield* grant.consumeApproval(selection, "attempt", f.state);
      expect(commands).toHaveLength(1);
      for (const command of commands) yield* f.repository.execute(command);
      const state = yield* readCurrentState(f.sql, f.selection.projectId);
      yield* f.sql.withTransaction(grant.assertCurrent(selection, state, "consumed", "attempt"));
      expect(
        (yield* f.sql
          .withTransaction(grant.assertCurrent(selection, state, "consumed", "other-attempt"))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect("disabled execution and changed original approval deny without consuming it", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const grant = yield* makeProjectWorkVerificationExecutionGrant({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        assertEnabled: Effect.void,
      });
      const selection = { receipt: f.prepared, gate: f.gate };
      const changed = {
        ...f.state,
        foundationRecords: (f.state.foundationRecords ?? []).map((r) =>
          r.recordId === f.gate.recordId
            ? {
                ...f.gate,
                attribution: {
                  ...human,
                  actor: { kind: "human" as const, id: "replacement-human" },
                },
              }
            : r,
        ),
      };
      expect(
        (yield* f.sql
          .withTransaction(grant.assertCurrent(selection, changed, "approved", "attempt"))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const disabled = yield* makeProjectWorkVerificationExecutionGrant({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        assertEnabled: Effect.fail(
          new ProjectWorkVerificationExecutionError({ reason: "Execution disabled" }),
        ),
      });
      expect(
        (yield* f.sql
          .withTransaction(disabled.assertCurrent(selection, f.state, "approved", "attempt"))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(f.state);
    }),
  ),
);
