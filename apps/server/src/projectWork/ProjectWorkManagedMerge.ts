import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as PublicationAuthorization from "./ProjectWorkPublicationAuthorization.ts";
import * as Host from "./ProjectWorkPublicationHost.ts";
import * as Journal from "./ProjectWorkPublicationJournal.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import type { ProjectWorkPrincipal } from "./ProjectWorkGateway.ts";

export const MergeInput = Schema.Struct({
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  publicationOperationId: Schema.String,
  gateId: Schema.String,
});
export type MergeInput = typeof MergeInput.Type;
export function mergeMatches(
  operation: Journal.DeliveryOperation,
  confirmation: Journal.MergeConfirmation,
): boolean {
  const request = operation.decision.request;
  const publication = operation.publication;
  return (
    publication?.kind === "confirmed" &&
    confirmation.providerId === operation.decision.providerId &&
    confirmation.host === request.repository.host &&
    confirmation.repositoryNodeId === request.repository.nodeId &&
    confirmation.repository === request.repository.nameWithOwner &&
    confirmation.number === publication.pullRequest.number &&
    confirmation.authorizedHeadSha === request.target.headSha &&
    confirmation.baseSha === request.target.baseSha &&
    confirmation.baseRef === request.target.baseRef &&
    confirmation.mergedCommitSha.length > 0 &&
    Number.isFinite(Date.parse(confirmation.mergedAt))
  );
}
export class ProjectWorkManagedMerge extends Context.Service<
  ProjectWorkManagedMerge,
  {
    readonly execute: (
      input: MergeInput,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<Journal.DeliveryOperation, Journal.PublicationError>;
  }
>()("t3/projectWork/ProjectWorkManagedMerge") {}
const decodeInput = Schema.decodeUnknownEffect(MergeInput);
const make = Effect.gen(function* () {
  const human = yield* Authorization.ProjectTeamAuthorization;
  const authority = yield* PublicationAuthorization.ProjectWorkPublicationAuthorization;
  const host = yield* Host.ProjectWorkPublicationHost;
  const journal = yield* Journal.ProjectWorkPublicationJournal;
  const sql = yield* SqlClient.SqlClient;
  const execute = Effect.fn("ProjectWorkManagedMerge.execute")(function* (
    input: MergeInput,
    principal: ProjectWorkPrincipal,
  ) {
    const selected = yield* decodeInput(input).pipe(
      Effect.mapError((cause) => new Journal.PublicationError({ reason: "authorization", cause })),
    );
    yield* human
      .assertHumanSourceControl(principal)
      .pipe(
        Effect.mapError(
          (cause) => new Journal.PublicationError({ reason: "authorization", cause }),
        ),
      );
    const published = yield* journal.read(selected.publicationOperationId);
    if (
      Option.isNone(published) ||
      published.value.kind !== "create-pr" ||
      published.value.stage !== "confirmed" ||
      published.value.publication?.kind !== "confirmed"
    )
      return yield* new Journal.PublicationError({ reason: "not-ready" });
    const publication = published.value;
    const publicationOutcome = publication.publication;
    if (publicationOutcome?.kind !== "confirmed")
      return yield* new Journal.PublicationError({ reason: "not-ready" });
    if (
      principal.projectId !== undefined &&
      principal.projectId !== publication.decision.request.target.projectId
    )
      return yield* new Journal.PublicationError({ reason: "authorization" });
    const retained = yield* journal.read(selected.operationId);
    let operation: Journal.DeliveryOperation;
    if (Option.isSome(retained)) {
      operation = retained.value;
      if (
        operation.kind !== "merge" ||
        operation.publicationOperationId !== selected.publicationOperationId ||
        operation.decision.gate.recordId !== selected.gateId ||
        canonicalProjectWorkPayload(operation.principal) !==
          canonicalProjectWorkPayload({ actor: principal.actor, source: principal.source })
      )
        return yield* new Journal.PublicationError({ reason: "conflict" });
    } else {
      const state = yield* readCurrentState(
        sql,
        publication.decision.request.target.projectId,
      ).pipe(
        Effect.mapError((cause) => new Journal.PublicationError({ reason: "storage", cause })),
      );
      const gate = state.foundationRecords?.find(
        (r) => r.kind === "gate" && r.recordId === selected.gateId,
      );
      const target = publication.decision.request.target;
      if (
        !gate ||
        gate.kind !== "gate" ||
        gate.gate !== "merge" ||
        gate.status !== "approved" ||
        gate.taskId !== target.taskId ||
        gate.specRevision !== target.specRevision ||
        gate.planRevision !== target.planRevision ||
        gate.contentHash !== target.scopeHash ||
        gate.headSha !== target.headSha ||
        gate.targetBranch !== target.baseRef ||
        gate.repository !== publication.decision.request.repository.nameWithOwner ||
        gate.pullRequestNumber !== publicationOutcome.pullRequest.number ||
        gate.mergeMethod === undefined
      )
        return yield* new Journal.PublicationError({ reason: "authorization" });
      const decision = { ...publication.decision, gate };
      operation = yield* journal.retain({
        operationId: selected.operationId,
        kind: "merge",
        decision,
        decisionHash: Journal.publicationHash(decision),
        principal: { actor: principal.actor, source: principal.source },
        publicationOperationId: selected.publicationOperationId,
        stage: "approved",
        publication: publicationOutcome,
      });
    }
    if (operation.stage === "confirmed") return operation;
    if (operation.stage !== "approved") {
      const confirmation = yield* host.reconcileMerge(operation);
      const next: Journal.DeliveryOperation = {
        ...operation,
        stage: confirmation && mergeMatches(operation, confirmation) ? "confirmed" : "uncertain",
        ...(confirmation && mergeMatches(operation, confirmation) ? { merge: confirmation } : {}),
      };
      yield* journal.save(next);
      return next;
    }
    if (!(yield* host.supportsExactMerge(operation)))
      return yield* new Journal.PublicationError({ reason: "unsupported" });
    yield* authority.assertCurrent(operation.decision);
    yield* human
      .assertHumanSourceControl(principal)
      .pipe(
        Effect.mapError(
          (cause) => new Journal.PublicationError({ reason: "authorization", cause }),
        ),
      );
    if (!(yield* journal.claim(operation)))
      return yield* new Journal.PublicationError({ reason: "uncertain" });
    operation = { ...operation, stage: "claimed" };
    const merged = yield* host
      .mergeExact(
        operation,
        authority
          .assertCurrent(operation.decision)
          .pipe(
            Effect.andThen(
              human
                .assertHumanSourceControl(principal)
                .pipe(
                  Effect.mapError(
                    (cause) => new Journal.PublicationError({ reason: "authorization", cause }),
                  ),
                ),
            ),
          ),
      )
      .pipe(Effect.result);
    const confirmation =
      merged._tag === "Success"
        ? merged.success
        : yield* host.reconcileMerge(operation).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const next: Journal.DeliveryOperation = {
      ...operation,
      stage: confirmation && mergeMatches(operation, confirmation) ? "confirmed" : "uncertain",
      ...(confirmation && mergeMatches(operation, confirmation) ? { merge: confirmation } : {}),
    };
    yield* journal.save(next);
    return next;
  });
  return ProjectWorkManagedMerge.of({ execute });
});
export const layer = Layer.effect(ProjectWorkManagedMerge, make);
