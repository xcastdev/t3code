import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as PublicationAuthorization from "./ProjectWorkPublicationAuthorization.ts";
import * as Host from "./ProjectWorkPublicationHost.ts";
import * as Journal from "./ProjectWorkPublicationJournal.ts";
import type { ProjectWorkPrincipal } from "./ProjectWorkGateway.ts";

export class ProjectWorkHumanPublicationRequest extends Context.Service<
  ProjectWorkHumanPublicationRequest,
  {
    readonly execute: (
      input: PublicationAuthorization.PublicationInput,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<Journal.DeliveryOperation, Journal.PublicationError>;
  }
>()("t3/projectWork/ProjectWorkHumanPublicationRequest") {}
export function publicationMatches(
  operation: Journal.DeliveryOperation,
  outcome: import("@t3tools/contracts").ProjectWorkPublicationOutcome,
): boolean {
  const request = operation.decision.request;
  return (
    outcome.kind === "confirmed" &&
    outcome.operationId === operation.operationId &&
    outcome.requestHash === Journal.publicationHash(request) &&
    outcome.marker === request.marker &&
    canonicalProjectWorkPayload(outcome.repository) ===
      canonicalProjectWorkPayload(request.repository) &&
    outcome.pullRequest.headSha === request.target.headSha &&
    outcome.pullRequest.baseSha === request.target.baseSha &&
    outcome.pullRequest.baseRef === request.target.baseRef &&
    outcome.pullRequest.headRef === request.target.headRef &&
    outcome.pullRequest.headRepositoryNodeId === request.target.headRepositoryNodeId
  );
}
const decodeInput = Schema.decodeUnknownEffect(PublicationAuthorization.PublicationInput);
const make = Effect.gen(function* () {
  const human = yield* Authorization.ProjectTeamAuthorization;
  const authority = yield* PublicationAuthorization.ProjectWorkPublicationAuthorization;
  const host = yield* Host.ProjectWorkPublicationHost;
  const journal = yield* Journal.ProjectWorkPublicationJournal;
  const execute = Effect.fn("ProjectWorkHumanPublicationRequest.execute")(function* (
    input: PublicationAuthorization.PublicationInput,
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
    if (principal.projectId !== undefined && principal.projectId !== selected.projectId)
      return yield* new Journal.PublicationError({ reason: "authorization" });
    const retained = yield* journal.read(selected.operationId);
    let operation: Journal.DeliveryOperation;
    if (Option.isSome(retained)) {
      operation = retained.value;
      const request = operation.decision.request;
      if (
        operation.kind !== "create-pr" ||
        request.target.projectId !== selected.projectId ||
        request.target.taskId !== selected.taskId ||
        operation.decision.gate.recordId !== selected.gateId ||
        canonicalProjectWorkPayload(operation.decision.sourceRef) !==
          canonicalProjectWorkPayload(selected.sourceRef) ||
        request.title !== selected.title ||
        request.body !== selected.body ||
        canonicalProjectWorkPayload(operation.principal) !==
          canonicalProjectWorkPayload({ actor: principal.actor, source: principal.source })
      )
        return yield* new Journal.PublicationError({ reason: "conflict" });
    } else {
      const decision = yield* authority.prepare(selected);
      operation = yield* journal.retain({
        operationId: selected.operationId,
        kind: "create-pr",
        decision,
        decisionHash: Journal.publicationHash(decision),
        principal: { actor: principal.actor, source: principal.source },
        stage: "approved",
      });
    }
    if (operation.stage === "confirmed") return operation;
    // A retained claim may have reached the host. Reconciliation never creates another PR.
    if (operation.stage !== "approved") {
      const outcome = yield* host.reconcilePublication(operation);
      const next = {
        ...operation,
        stage: publicationMatches(operation, outcome)
          ? ("confirmed" as const)
          : ("uncertain" as const),
        publication: outcome,
      };
      yield* journal.save(next);
      return next;
    }
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
    const created = yield* host
      .create(
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
    const outcome =
      created._tag === "Success"
        ? created.success
        : yield* host
            .reconcilePublication(operation)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
    const next: Journal.DeliveryOperation = {
      ...operation,
      stage: outcome && publicationMatches(operation, outcome) ? "confirmed" : "uncertain",
      ...(outcome ? { publication: outcome } : {}),
    };
    yield* journal.save(next);
    return next;
  });
  return ProjectWorkHumanPublicationRequest.of({ execute });
});
export const layer = Layer.effect(ProjectWorkHumanPublicationRequest, make);
