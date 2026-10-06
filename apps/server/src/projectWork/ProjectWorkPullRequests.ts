import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectTeamEffect,
  ProjectWorkPublicationRequest,
  ProjectWorkPublicationOutcome,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Outbox from "./github/ProjectWorkGitHubOutbox.ts";
import {
  PublicationError,
  validatePublicationRequest,
  type PublicationCredential,
} from "./github/ProjectWorkGitHubOutbox.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
export { PublicationError, type PublicationCredential } from "./github/ProjectWorkGitHubOutbox.ts";
export interface Options {
  readonly authorizePublication?: (
    request: ProjectWorkPublicationRequest,
    phase: "enqueue" | "dispatch",
  ) => Effect.Effect<void, PublicationError>;
  readonly resolveCredential: (
    request: ProjectWorkPublicationRequest,
  ) => Effect.Effect<PublicationCredential, PublicationError>;
}
type Request = typeof ProjectWorkPublicationRequest.Type;
type Outcome = typeof ProjectWorkPublicationOutcome.Type;
type PublicationEffect = typeof ProjectTeamEffect.Type;
interface Receipt {
  readonly operationId: string;
  readonly status: typeof ProjectTeamEffect.Type.status;
  readonly duplicate: boolean;
}
export class ProjectWorkPullRequests extends Context.Service<
  ProjectWorkPullRequests,
  {
    readonly enqueue: (request: Request) => Effect.Effect<Receipt, PublicationError>;
    readonly dispatch: (
      operationId: string,
    ) => Effect.Effect<ProjectWorkPublicationOutcome, PublicationError>;
    readonly reconcile: (operationId: string) => Effect.Effect<Outcome, PublicationError>;
    readonly recoverAll: () => Effect.Effect<
      { recovered: number; confirmed: number; uncertain: number; failed: number },
      PublicationError
    >;
  }
>()("t3/projectWork/ProjectWorkPullRequests") {}
const decodeEffect = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectTeamEffect));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isRequest = Schema.is(ProjectWorkPublicationRequest);
const isOutcome = Schema.is(ProjectWorkPublicationOutcome);
const isPublicationError = Schema.is(PublicationError);
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
const origin = (recordedAt: string) => ({
  actor: { kind: "system" as const, id: "project-work-github-outbox" },
  source: { kind: "system" as const, id: "project-work-github-outbox" },
  recordedAt,
});
export const make = Effect.fn("ProjectWorkPullRequests.make")(function* (options: Options) {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const outbox = yield* Outbox.make();
  const permit = yield* Semaphore.make(1);
  const authorize = (request: Request, phase: "enqueue" | "dispatch") =>
    options.authorizePublication === undefined
      ? Effect.fail(new PublicationError({ reason: "authorization-denied" }))
      : options.authorizePublication(request, phase);
  const enqueue = Effect.fn("ProjectWorkPullRequests.enqueue")(function* (raw: Request) {
    const request = Outbox.capturePublicationRequest(raw);
    if (request === undefined) return yield* new PublicationError({ reason: "invalid-request" });
    const now = DateTime.formatIso(yield* DateTime.now);
    let duplicate = false;
    let status: typeof ProjectTeamEffect.Type.status = "pending";
    yield* repository
      .executeAtomic(
        Effect.gen(function* () {
          yield* authorize(request, "enqueue");
          const state = yield* readCurrentState(sql, request.target.projectId);
          const existing = state.foundationRecords?.find(
            (record) => record.recordId === request.operationId,
          );
          if (existing !== undefined) {
            if (
              existing.kind !== "effect" ||
              existing.effectKind !== "publication" ||
              existing.effectId !== request.operationId ||
              existing.payload.summary !== canonicalProjectWorkPayload(request)
            )
              return yield* new PublicationError({ reason: "invalid-state" });
            duplicate = true;
            status = existing.status;
            return [];
          }
          const task = state.tasks.find((entry) => entry.taskId === request.target.taskId);
          if (task === undefined || task.revision !== request.expectedTaskRevision)
            return yield* new PublicationError({ reason: "invalid-state" });
          const record: typeof ProjectTeamEffect.Type = {
            kind: "effect",
            recordId: request.operationId,
            effectId: request.operationId,
            projectId: request.target.projectId,
            revision: 0,
            generation: 0,
            updatedAt: now,
            status: "pending",
            effectKind: "publication",
            taskId: request.target.taskId,
            targetId: `${request.repository.host}/${request.repository.nameWithOwner}`,
            payload: {
              recordIds: request.authorizationRecordIds,
              expectedRevision: request.expectedTaskRevision,
              summary: canonicalProjectWorkPayload(request),
            },
            claimGeneration: 0,
            availableAt: now,
          };
          const command: ProjectWorkCommand = {
            type: "project-work.foundation.commit",
            commandId: CommandId.make(`publication-enqueue:${request.operationId}`),
            projectId: request.target.projectId,
            expectedRevision: state.revision,
            attribution: {
              actor: { kind: "system", id: "project-work-github-outbox" },
              source: { kind: "system", id: "project-work-github-outbox" },
              recordedAt: now,
            },
            committedAt: now,
            records: [record],
          };
          return [command];
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isPublicationError(cause)
            ? cause
            : new PublicationError({ reason: "persistence", cause }),
        ),
      );
    return { operationId: request.operationId, status, duplicate };
  });
  const load = Effect.fn("ProjectWorkPullRequests.load")(function* (operationId: string) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload_json AS payload FROM project_team_effect WHERE unique_key=${operationId} LIMIT 1`;
    if (rows[0] === undefined) return yield* new PublicationError({ reason: "operation-missing" });
    const effect = yield* decodeEffect(rows[0].payload);
    if (
      effect.effectKind !== "publication" ||
      effect.effectId !== operationId ||
      effect.recordId !== operationId ||
      effect.payload.summary === undefined
    )
      return yield* new PublicationError({ reason: "invalid-state" });
    const request = yield* decodeJson(effect.payload.summary);
    if (
      !isRequest(request) ||
      !validatePublicationRequest(request) ||
      canonicalProjectWorkPayload(request) !== effect.payload.summary ||
      request.operationId !== operationId ||
      request.target.projectId !== effect.projectId ||
      request.target.taskId !== effect.taskId ||
      effect.targetId !== `${request.repository.host}/${request.repository.nameWithOwner}` ||
      effect.payload.expectedRevision !== request.expectedTaskRevision ||
      canonicalProjectWorkPayload(effect.payload.recordIds) !==
        canonicalProjectWorkPayload(request.authorizationRecordIds)
    )
      return yield* new PublicationError({ reason: "invalid-state" });
    const captured = Outbox.capturePublicationRequest(request);
    if (captured === undefined) return yield* new PublicationError({ reason: "invalid-state" });
    return { effect, request: captured };
  });
  const retained = Effect.fn("ProjectWorkPullRequests.retained")(function* (
    effect: PublicationEffect,
    request: Request,
  ) {
    if (effect.status !== "succeeded" || effect.outcome === undefined) return undefined;
    const outcome = yield* decodeJson(effect.outcome);
    if (
      !isOutcome(outcome) ||
      outcome.kind !== "confirmed" ||
      outcome.operationId !== request.operationId ||
      outcome.requestHash !== Outbox.publicationRequestHash(request) ||
      outcome.claimGeneration !== effect.claimGeneration
    )
      return yield* new PublicationError({ reason: "invalid-state" });
    return outcome;
  });
  const reflect = Effect.fn("ProjectWorkPullRequests.reflect")(function* (
    effect: PublicationEffect,
    receipt: Outcome,
  ) {
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        const state = yield* readCurrentState(sql, effect.projectId);
        const current = state.foundationRecords?.find(
          (record) => record.recordId === effect.recordId,
        );
        if (
          current?.kind !== "effect" ||
          current.effectKind !== "publication" ||
          current.claimGeneration !== effect.claimGeneration ||
          current.payload.summary !== effect.payload.summary
        )
          return yield* new PublicationError({ reason: "invalid-state" });
        if (
          (current.status === "claimed" ||
            current.status === "uncertain" ||
            current.status === "succeeded") &&
          current.outcome === canonicalProjectWorkPayload(receipt)
        )
          return [];
        if (current.status === "succeeded") {
          if (current.outcome === canonicalProjectWorkPayload(receipt)) return [];
          return yield* new PublicationError({ reason: "invalid-state" });
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const command: ProjectWorkCommand = {
          type: "project-work.foundation.commit",
          projectId: effect.projectId,
          commandId: CommandId.make(`publication-reflect:${digest(receipt)}`),
          expectedRevision: state.revision,
          attribution: origin(now),
          committedAt: now,
          records: [],
          transition: {
            kind: "publication.reflect",
            effectId: effect.effectId,
            expectedEffectRevision: current.revision,
            claimGeneration: effect.claimGeneration,
            receipt,
          },
        };
        return [command];
      }),
    );
    return receipt;
  });
  const reconcile = Effect.fn("ProjectWorkPullRequests.reconcile")(function* (operationId: string) {
    const { effect, request } = yield* load(operationId);
    const prior = yield* retained(effect, request);
    if (prior !== undefined) return prior;
    if (effect.status !== "claimed" && effect.status !== "uncertain")
      return yield* new PublicationError({ reason: "invalid-state" });
    const remote = yield* options.resolveCredential(request).pipe(
      Effect.flatMap((credential) =>
        outbox.reconcile(request, Object.freeze({ ...credential }), effect.claimGeneration),
      ),
      Effect.result,
    );
    const receipt: Outcome =
      remote._tag === "Success"
        ? remote.success
        : {
            version: 1,
            operationId,
            requestHash: Outbox.publicationRequestHash(request),
            claimGeneration: effect.claimGeneration,
            observedAt: DateTime.formatIso(yield* DateTime.now),
            kind: "uncertain",
            reason: "incomplete-response",
          };
    return yield* reflect(effect, receipt);
  });
  const dispatch = Effect.fn("ProjectWorkPullRequests.dispatch")(function* (operationId: string) {
    const { effect, request } = yield* load(operationId);
    const prior = yield* retained(effect, request);
    if (prior !== undefined) return prior;
    if (effect.status === "claimed" || effect.status === "uncertain")
      return yield* reconcile(operationId);
    if (effect.status !== "pending")
      return yield* new PublicationError({ reason: "invalid-state" });
    yield* authorize(request, "dispatch");
    const credential = Object.freeze({ ...(yield* options.resolveCredential(request)) });
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        yield* authorize(request, "dispatch");
        const state = yield* readCurrentState(sql, request.target.projectId);
        const command: ProjectWorkCommand = {
          type: "project-work.foundation.commit",
          commandId: CommandId.make(
            `publication-claim:${digest(request)}:${effect.claimGeneration}`,
          ),
          projectId: effect.projectId,
          expectedRevision: state.revision,
          attribution: origin(DateTime.formatIso(yield* DateTime.now)),
          committedAt: DateTime.formatIso(yield* DateTime.now),
          records: [],
          transition: {
            kind: "publication.claim",
            effectId: effect.effectId,
            expectedEffectRevision: effect.revision,
            expectedClaimGeneration: effect.claimGeneration,
          },
        };
        return [command];
      }),
    );
    const claimed = yield* load(operationId);
    if (
      claimed.effect.status !== "claimed" ||
      claimed.effect.claimGeneration !== effect.claimGeneration + 1
    )
      return yield* reconcile(operationId);
    const receipt = yield* outbox.create(request, credential, claimed.effect.claimGeneration);
    return yield* reflect(claimed.effect, receipt);
  });
  const protect = <A, E>(effect: Effect.Effect<A, E>) =>
    permit
      .withPermit(effect)
      .pipe(
        Effect.mapError((cause) =>
          isPublicationError(cause)
            ? cause
            : new PublicationError({ reason: "persistence", cause }),
        ),
      );
  const recoverAll = Effect.fn("ProjectWorkPullRequests.recoverAll")(function* () {
    const counts = { recovered: 0, confirmed: 0, uncertain: 0, failed: 0 };
    let cursor = "";
    while (true) {
      const rows = yield* sql<{
        recordId: string;
        payload: string;
      }>`SELECT record_id AS recordId,payload_json AS payload FROM project_team_effect WHERE record_id>${cursor} AND status IN ('claimed','uncertain') ORDER BY record_id LIMIT 128`;
      for (const row of rows) {
        cursor = row.recordId;
        const decoded = yield* decodeEffect(row.payload).pipe(Effect.result);
        if (decoded._tag === "Failure") {
          counts.failed++;
          continue;
        }
        if (decoded.success.effectKind !== "publication") continue;
        const result = yield* protect(reconcile(decoded.success.effectId)).pipe(Effect.result);
        if (result._tag === "Failure") counts.failed++;
        else {
          counts.recovered++;
          counts[result.success.kind === "confirmed" ? "confirmed" : "uncertain"]++;
        }
      }
      if (rows.length < 128) return counts;
    }
  });
  return ProjectWorkPullRequests.of({
    enqueue: (request) => protect(enqueue(request)),
    dispatch: (id) => protect(dispatch(id)),
    reconcile: (id) => protect(reconcile(id)),
    recoverAll: () =>
      recoverAll().pipe(
        Effect.mapError((cause) =>
          isPublicationError(cause)
            ? cause
            : new PublicationError({ reason: "persistence", cause }),
        ),
      ),
  });
});
