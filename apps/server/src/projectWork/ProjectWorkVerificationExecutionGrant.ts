import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assertProjectAcceptsMutations } from "../project/ProjectMutationFence.ts";
import { makeProjectWorkVerificationGate } from "./ProjectWorkVerificationGate.ts";
import { ProjectWorkVerificationPreparationSelection } from "./ProjectWorkVerificationPreparation.ts";
import {
  ProjectWorkVerificationExecutionError,
  type VerificationExecutionIntent,
} from "./ProjectWorkVerificationExecutionJournal.ts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";

type Selection = Pick<VerificationExecutionIntent, "receipt" | "gate">;
const decodeSelection = Schema.decodeUnknownEffect(ProjectWorkVerificationPreparationSelection);
const decodeCommand = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const isExecutionError = Schema.is(ProjectWorkVerificationExecutionError);
const denied = (reason: string) => new ProjectWorkVerificationExecutionError({ reason });
const same = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
const consumeId = (attemptId: string) => CommandId.make("verification-claim:" + attemptId);

/** A committed human decision survives browser disconnect. SQL, current settings,
 * target validity and exact one-shot consumption remain mandatory at execution.
 */
export const makeProjectWorkVerificationExecutionGrant = Effect.fn(
  "VerificationExecutionGrant.make",
)(
  function* (options: {
    readonly environmentId: string;
    readonly maximumEnvironmentModelCalls: number;
    readonly assertEnabled: Effect.Effect<void, ProjectWorkVerificationExecutionError>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const validation = yield* makeProjectWorkVerificationGate({
      environmentId: options.environmentId,
      maximumEnvironmentModelCalls: options.maximumEnvironmentModelCalls,
    });
    const assertCurrent = Effect.fn("VerificationExecutionGrant.assertCurrent")(function* (
      selection: Selection,
      state: ProjectWorkReducerState,
      phase: "approved" | "consumed",
      attemptId: string,
    ) {
      if ((yield* SqlClient.SqlClient) !== sql)
        return yield* denied("Verification grant SQL owner changed");
      yield* options.assertEnabled;
      const { manifest } = selection.receipt;
      yield* assertProjectAcceptsMutations(sql, manifest.projectId).pipe(
        Effect.mapError(() => denied("Verification project does not accept mutations")),
      );
      const task = state.tasks.find((r) => r.taskId === manifest.taskId);
      const binding = state.foundationRecords?.find((r) => r.recordId === manifest.bindingId);
      if (!task || binding?.kind !== "run-binding")
        return yield* denied("Verification original target unavailable");
      const selected = yield* decodeSelection({
        jobId: manifest.jobId,
        projectId: manifest.projectId,
        taskId: manifest.taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: task.revision,
        specRevision: manifest.specRevision,
        planRevision: manifest.planRevision,
        bindingId: manifest.bindingId,
        expectedBindingRevision: binding.revision,
        generation: manifest.generation,
        criterionIds: manifest.criteria.map((r) => r.criterionId),
        command: manifest.command,
      }).pipe(Effect.mapError(() => denied("Verification selection invalid")));
      yield* validation
        .assertCurrent(state, selection.receipt, selected, true)
        .pipe(Effect.mapError(() => denied("Verification original target changed")));
      const original = selection.gate;
      const matches = (state.foundationRecords ?? []).filter(
        (r) =>
          r.kind === "gate" &&
          (r.recordId === original.recordId ||
            (r.gate === "verification" &&
              r.verificationJobId === manifest.jobId &&
              (r.status === "approved" || r.status === "consumed"))),
      );
      const current = matches[0];
      if (
        original.status !== "approved" ||
        original.attribution.actor.kind !== "human" ||
        original.gate !== "verification" ||
        original.projectId !== manifest.projectId ||
        original.taskId !== manifest.taskId ||
        original.verificationJobId !== manifest.jobId ||
        original.contentHash !== selection.receipt.sha256 ||
        original.specRevision !== manifest.specRevision ||
        original.planRevision !== manifest.planRevision ||
        original.revision >= Number.MAX_SAFE_INTEGER ||
        matches.length !== 1 ||
        current?.kind !== "gate"
      )
        return yield* denied("Verification human approval is missing or ambiguous");
      const expected =
        phase === "approved"
          ? original
          : {
              ...original,
              status: "consumed",
              revision: original.revision + 1,
              updatedAt: current.updatedAt,
              consumedByRunId: attemptId,
              consumedByCommandId: consumeId(attemptId),
            };
      if (!same(current, expected))
        return yield* denied("Verification human approval changed or belongs to another attempt");
    });
    const consumeApproval = Effect.fn("VerificationExecutionGrant.consumeApproval")(function* (
      selection: Selection,
      attemptId: string,
      state: ProjectWorkReducerState,
    ) {
      yield* assertCurrent(selection, state, "approved", attemptId);
      const task = state.tasks.find((r) => r.taskId === selection.receipt.manifest.taskId);
      if (!task) return yield* denied("Verification task unavailable");
      const at = DateTime.formatIso(yield* DateTime.now);
      const command = yield* decodeCommand({
        type: "project-work.foundation.commit",
        projectId: state.projectId,
        commandId: consumeId(attemptId),
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
          taskId: task.taskId,
          expectedTaskRevision: task.revision,
          gateId: selection.gate.recordId,
          expectedGateRevision: selection.gate.revision,
          jobId: selection.receipt.manifest.jobId,
          manifestHash: selection.receipt.sha256,
          attemptId,
        },
      }).pipe(Effect.mapError(() => denied("Verification consumption command invalid")));
      return [command];
    });
    return { assertCurrent, consumeApproval };
  },
  Effect.mapError((error) =>
    isExecutionError(error) ? error : denied("Verification grant validator unavailable"),
  ),
);
