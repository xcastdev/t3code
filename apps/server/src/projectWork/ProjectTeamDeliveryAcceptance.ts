import {
  CommandId,
  ProjectTeamDeliveryAcceptanceProof,
  type ProjectWorkCommand,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Reviews from "./ProjectTeamReviewFreshness.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as PublicationAuthorization from "./ProjectWorkPublicationAuthorization.ts";
import * as Journal from "./ProjectWorkPublicationJournal.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import { mergeMatches } from "./ProjectWorkManagedMerge.ts";
import type { ProjectWorkPrincipal } from "./ProjectWorkGateway.ts";
const rejected = () => new Journal.PublicationError({ reason: "not-ready" });
import {
  criterionSnapshots,
  assertDeliveryAcceptanceCurrent,
} from "./ProjectTeamDeliveryAcceptanceState.ts";
type AcceptanceCommand = Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
export const AcceptanceInput = Schema.Struct({
  operationId: Schema.String,
  expectedReceiptHash: Schema.String,
});
export type AcceptanceInput = typeof AcceptanceInput.Type;
export class ProjectTeamDeliveryAcceptance extends Context.Service<
  ProjectTeamDeliveryAcceptance,
  {
    readonly execute: (
      input: AcceptanceInput,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<ProjectTeamDeliveryAcceptanceProof, Journal.PublicationError>;
  }
>()("t3/projectWork/ProjectTeamDeliveryAcceptance") {}
const isPublicationError = Schema.is(Journal.PublicationError);
const decodeProof = Schema.decodeUnknownEffect(ProjectTeamDeliveryAcceptanceProof);
const decodeProofJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamDeliveryAcceptanceProof),
);
const boundary = (cause: unknown) =>
  isPublicationError(cause) ? cause : new Journal.PublicationError({ reason: "not-ready", cause });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* Repository.ProjectWorkRepository;
  const environment = yield* Environment.ServerEnvironment;
  const human = yield* Authorization.ProjectTeamAuthorization;
  const reviews = yield* Reviews.ProjectTeamReviewFreshness;
  const authority = yield* PublicationAuthorization.ProjectWorkPublicationAuthorization;
  const journal = yield* Journal.ProjectWorkPublicationJournal;
  const execute = Effect.fn("ProjectTeamDeliveryAcceptance.execute")(function* (
    input: AcceptanceInput,
    principal: ProjectWorkPrincipal,
  ) {
    yield* human.assertHuman(principal);
    const retained = yield* journal.read(input.operationId);
    if (
      Option.isNone(retained) ||
      retained.value.kind !== "merge" ||
      retained.value.stage !== "confirmed" ||
      !retained.value.merge ||
      !mergeMatches(retained.value, retained.value.merge) ||
      Journal.publicationHash(retained.value) !== input.expectedReceiptHash
    )
      return yield* rejected();
    const operation = retained.value,
      target = operation.decision.request.target;
    if (principal.projectId !== undefined && principal.projectId !== target.projectId)
      return yield* rejected();
    yield* reviews.assertPhysical(target.projectId, operation.decision.source.jobId);
    for (const source of operation.decision.integrationSources?.sources ?? [])
      yield* reviews.assertPhysical(target.projectId, source.jobId);
    yield* authority.assertReviewed(operation.decision);
    const state = yield* Repository.readCurrentState(sql, target.projectId);
    const snapshots = yield* Effect.try({
      try: () => criterionSnapshots(state, target.taskId, target.scopeHash),
      catch: boundary,
    });
    const proof = yield* decodeProof({
      version: 1,
      environmentId: yield* environment.getEnvironmentId,
      operationId: operation.operationId,
      receiptSha256: input.expectedReceiptHash,
      decisionSha256: operation.decisionHash,
      gateId: operation.decision.gate.recordId,
      gateSha256: Journal.publicationHash(operation.decision.gate),
      source: operation.decision.source,
      sourceRef: operation.decision.sourceRef,
      ...snapshots,
    });
    yield* Effect.try({
      try: () => assertDeliveryAcceptanceCurrent(state, proof),
      catch: boundary,
    });
    const previous = state.evidence.find(
      (e) => e.evidenceId === `delivery-acceptance:${operation.operationId}`,
    );
    if (previous?.detail !== undefined) {
      const prior = yield* decodeProofJson(previous.detail);
      if (canonicalProjectWorkPayload(prior) !== canonicalProjectWorkPayload(proof))
        return yield* rejected();
      return prior;
    }
    const at = DateTime.formatIso(yield* DateTime.now);
    const command: AcceptanceCommand = {
      type: "project-work.foundation.commit",
      commandId: CommandId.make(`delivery-acceptance:${operation.operationId}`),
      projectId: target.projectId,
      expectedRevision: state.revision,
      records: [],
      committedAt: at,
      attribution: {
        actor: { kind: "system", id: "project-team-delivery-acceptance" },
        source: { kind: "system", id: "project-team-delivery-acceptance" },
        recordedAt: at,
      },
      transition: {
        kind: "delivery.accept",
        expectedTaskRevision: state.tasks.find((t) => t.taskId === target.taskId)!.revision,
        proof,
      },
    };
    yield* repository.executeAuthorized(
      command,
      ({ state: current }) =>
        Effect.gen(function* () {
          yield* human.assertHuman(principal);
          yield* authority.assertReviewed(operation.decision);
          yield* Effect.try({
            try: () => assertDeliveryAcceptanceCurrent(current, proof),
            catch: boundary,
          });
          return command;
        }),
      () => human.assertHuman(principal),
    );
    return proof;
  }, Effect.mapError(boundary));
  return ProjectTeamDeliveryAcceptance.of({ execute });
});
export const layer = Layer.effect(ProjectTeamDeliveryAcceptance, make);
