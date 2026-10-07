import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectTeamDeliveryAcceptanceProof,
  canonicalProjectWorkPayload,
  ProjectWorkAttribution,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  makeProjectWorkManagedMergeJournal,
  mergeHash,
  type ManagedMergeError,
} from "./ProjectWorkManagedMergeJournal.ts";
import {
  ProjectWorkPublicationAuthorization,
  makeProjectWorkPublicationAuthorization,
} from "./ProjectWorkPublicationAuthorization.ts";
import { projectWorkCommandFingerprint } from "./ProjectWorkPolicy.ts";
import {
  DELIVERY_ACCEPTANCE_PRODUCER,
  assertDeliveryAcceptanceCurrent,
  deliveryCriterionSnapshots,
  deliveryDependencyIds,
  prepareDeliveryAcceptanceEvidence,
  readDeliveryAcceptance,
} from "./ProjectTeamDeliveryAcceptanceState.ts";

const strict = { onExcessProperty: "error" } as const;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const OperationId = Schema.String.check(Schema.isPattern(/^managed-merge:[a-f0-9]{64}$/u));
const Options = Schema.Struct({ environmentId: EnvironmentId });
const Input = Schema.Struct({ operationId: OperationId, expectedReceiptSha256: Digest });
const DependencyInput = Schema.Struct({ projectId: ProjectId, taskId: ProjectWorkTaskId });
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeInput = Schema.decodeUnknownSync(Input, strict);
const decodeOperationId = Schema.decodeUnknownSync(OperationId, strict);
const decodeDependencies = Schema.decodeUnknownSync(DependencyInput, strict);
const decodeProof = Schema.decodeUnknownEffect(ProjectTeamDeliveryAcceptanceProof, strict);
const decodeAttribution = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkAttribution),
  strict,
);
const canonical = canonicalProjectWorkPayload;
export class ProjectTeamDeliveryAcceptanceError extends Schema.TaggedError<ProjectTeamDeliveryAcceptanceError>()(
  "ProjectTeamDeliveryAcceptanceError",
  {
    code: Schema.Literals(["invalid", "not-ready", "unavailable"]),
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
const error = (
  reason: string,
  code: ProjectTeamDeliveryAcceptanceError["code"] = "unavailable",
  cause?: unknown,
) =>
  new ProjectTeamDeliveryAcceptanceError({
    code,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
const isError = Schema.is(ProjectTeamDeliveryAcceptanceError);
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isError(cause)
        ? cause
        : error("Delivery history or storage is unavailable", "unavailable", cause),
    ),
  );
function capture<A>(decode: (input: unknown) => A, input: unknown) {
  try {
    const copy: unknown = structuredClone(input);
    const value = decode(copy);
    return canonical(value) === canonical(copy) ? value : undefined;
  } catch {
    return undefined;
  }
}
export type DeliveryAcceptanceOutcome =
  | { readonly _tag: "Accepted"; readonly operationId: string }
  | { readonly _tag: "NotReady"; readonly reason: string };

export interface ProjectTeamDeliveryAcceptanceService {
  readonly accept: (
    input: typeof Input.Type,
  ) => Effect.Effect<DeliveryAcceptanceOutcome, ProjectTeamDeliveryAcceptanceError>;
  readonly recover: (
    operationId: string,
  ) => Effect.Effect<DeliveryAcceptanceOutcome, ProjectTeamDeliveryAcceptanceError>;
  readonly pending: (
    afterOperationId?: string,
  ) => Effect.Effect<
    readonly { readonly operationId: string }[],
    ProjectTeamDeliveryAcceptanceError
  >;
  readonly assertTaskDependenciesInTransaction: (
    input: typeof DependencyInput.Type,
  ) => Effect.Effect<void, ProjectTeamDeliveryAcceptanceError>;
  readonly assertTaskDependencies: (
    input: typeof DependencyInput.Type,
  ) => Effect.Effect<void, ProjectTeamDeliveryAcceptanceError>;
}

export const makeProjectTeamDeliveryAcceptance = (input: {
  readonly environmentId: string;
}): Effect.Effect<
  ProjectTeamDeliveryAcceptanceService,
  ProjectTeamDeliveryAcceptanceError | ManagedMergeError,
  SqlClient.SqlClient | ProjectWorkRepository
> => {
  const options = capture(decodeOptions, input);
  return Effect.gen(function* () {
    if (!options) return yield* error("Invalid delivery environment", "invalid");
    const { environmentId } = options;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const publication = yield* Effect.serviceOption(ProjectWorkPublicationAuthorization);
    const journal = yield* makeProjectWorkManagedMergeJournal({ environmentId });
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ProjectWorkRepository, repository),
      );
    const affinity = Effect.gen(function* () {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient),
        owner = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        (Option.isSome(client) && client.value !== sql) ||
        (Option.isSome(owner) && owner.value !== repository)
      )
        return yield* error("Delivery requires its captured SQL and repository", "invalid");
    });
    const loan = Effect.gen(function* () {
      yield* affinity;
      const client = yield* Effect.serviceOption(SqlClient.SqlClient),
        owner = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(client) ||
        Option.isNone(owner) ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* error("Delivery requires the original caller transaction", "invalid");
    });
    // Construct only at the forward boundary: reviewed history itself captures a dispatch journal.
    const reviewed = Effect.gen(function* () {
      if (Option.isSome(publication)) return publication.value;
      if (Option.isNone(settings)) return yield* error("Delivery settings are unavailable");
      return yield* makeProjectWorkPublicationAuthorization({ environmentId }).pipe(
        Effect.provideService(ServerSettingsService, settings.value),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ProjectWorkRepository, repository),
      );
    });
    const audit = Effect.fn("DeliveryAcceptance.audit")(function* (
      state: Effect.Success<ReturnType<typeof readCurrentState>>,
      retained: NonNullable<ReturnType<typeof readDeliveryAcceptance>>,
    ) {
      yield* loan;
      const { evidence, detail } = retained;
      const proof = detail.proof;
      const row = yield* journal.readInTransaction(proof.operationId);
      if (
        !row?.receipt ||
        row.status !== "confirmed" ||
        proof.environmentId !== environmentId ||
        mergeHash(row.receipt) !== proof.receiptSha256 ||
        mergeHash(row.decision) !== proof.decisionSha256 ||
        row.decision.publication.target.projectId !== state.projectId ||
        row.decision.publication.target.taskId !== proof.source.taskId ||
        mergeHash(row.decision.gate) !== proof.gateSha256 ||
        row.decision.gate.recordId !== proof.gateId
      )
        return yield* error("Accepted delivery receipt changed");
      const command: Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }> = {
        type: "project-work.foundation.commit",
        commandId: detail.commandId,
        projectId: row.decision.publication.target.projectId,
        expectedRevision: detail.expectedRevision,
        records: [],
        attribution: {
          actor: { kind: "system", id: DELIVERY_ACCEPTANCE_PRODUCER },
          source: { kind: "system", id: DELIVERY_ACCEPTANCE_PRODUCER },
          recordedAt: evidence.recordedAt,
        },
        committedAt: evidence.recordedAt,
        transition: {
          kind: "delivery.accept",
          expectedTaskRevision: detail.expectedTaskRevision,
          proof,
        },
      };
      if (
        detail.commandFingerprint !== projectWorkCommandFingerprint(command) ||
        canonical(prepareDeliveryAcceptanceEvidence(command)) !== canonical(evidence)
      )
        return yield* error("Acceptance association changed");
      yield* journal.auditCommandInTransaction(command);
      const physical =
        yield* sql`SELECT task_id,kind,summary,scope_hash,recorded_at,revision,criterion_id,uri,output_artifact_ids_json,
        CASE WHEN length(CAST(detail AS BLOB))<=32000 THEN detail END AS detail,
        CASE WHEN length(CAST(attribution_json AS BLOB))<=16384 THEN attribution_json END AS attribution
        FROM project_work_evidence WHERE project_id=${state.projectId} AND evidence_id=${evidence.evidenceId} LIMIT 2`;
      const entry = physical[0];
      if (
        physical.length !== 1 ||
        !entry ||
        entry.task_id !== evidence.taskId ||
        entry.kind !== evidence.kind ||
        entry.summary !== evidence.summary ||
        entry.scope_hash !== evidence.scopeHash ||
        entry.recorded_at !== evidence.recordedAt ||
        entry.revision !== evidence.revision ||
        entry.detail !== evidence.detail ||
        typeof entry.attribution !== "string" ||
        entry.criterion_id !== null ||
        entry.uri !== null ||
        entry.output_artifact_ids_json !== null
      )
        return yield* error("Physical acceptance projection changed");
      if (
        canonical(yield* decodeAttribution(entry.attribution)) !== canonical(evidence.attribution)
      )
        return yield* error("Physical acceptance attribution changed");
      return row;
    });
    const current = Effect.fn("DeliveryAcceptance.current")(function* (
      state: Effect.Success<ReturnType<typeof readCurrentState>>,
      retained: NonNullable<ReturnType<typeof readDeliveryAcceptance>>,
    ) {
      const row = yield* audit(state, retained);
      yield* Effect.try({
        try: () => assertDeliveryAcceptanceCurrent(state, retained.detail.proof),
        catch: (cause) => error("Accepted delivery is no longer current", "not-ready", cause),
      });
      const service = yield* reviewed;
      const qualified = yield* service.readCurrentReviewedInTransaction(row.decision.publication);
      if (
        canonical(qualified.source) !== canonical(retained.detail.proof.source) ||
        canonical(qualified.detail.sourceRef) !== canonical(retained.detail.proof.sourceRef)
      )
        return yield* error("Original reviewed source changed", "not-ready");
      const physical =
        yield* sql`SELECT state,completed_at FROM project_work_tasks WHERE project_id=${state.projectId} AND task_id=${retained.detail.proof.source.taskId} LIMIT 2`;
      if (
        physical.length !== 1 ||
        physical[0]?.state !== "completed" ||
        physical[0]?.completed_at !== retained.evidence.recordedAt
      )
        return yield* error("Physical completed task projection changed");
    });
    const accept = (input: typeof Input.Type) => {
      const captured = capture(decodeInput, input);
      return boundary(
        Effect.gen(function* () {
          if (!captured) return yield* error("Invalid delivery receipt selection", "invalid");
          yield* affinity;
          let accepted: DeliveryAcceptanceOutcome = {
            _tag: "NotReady",
            reason: "Delivery is not qualified",
          };
          let original: NonNullable<ReturnType<typeof readDeliveryAcceptance>> | undefined;
          yield* repository.executeAtomic(
            provide(
              Effect.gen(function* () {
                yield* loan;
                const row = yield* journal.readInTransaction(captured.operationId);
                if (
                  !row?.receipt ||
                  row.status !== "confirmed" ||
                  mergeHash(row.receipt) !== captured.expectedReceiptSha256
                )
                  return yield* error("No matching authoritative confirmed delivery", "not-ready");
                const request = row.decision.publication;
                const state = yield* readCurrentState(sql, request.target.projectId);
                original = readDeliveryAcceptance(
                  state,
                  request.target.taskId,
                  captured.operationId,
                );
                if (original?.detail.proof.operationId === captured.operationId) {
                  yield* audit(state, original);
                  accepted = { _tag: "Accepted", operationId: captured.operationId };
                  return [];
                }
                const task = state.tasks.find((t) => t.taskId === request.target.taskId);
                if (!task || ["completed", "canceled", "failed"].includes(task.state)) return [];
                const service = yield* reviewed;
                const qualified = yield* service.readCurrentReviewedInTransaction(request);
                const snapshots = yield* Effect.try({
                  try: () => deliveryCriterionSnapshots(state, qualified.source),
                  catch: (cause) =>
                    error("Required criteria are not qualified", "not-ready", cause),
                });
                const proof = yield* decodeProof({
                  version: 1,
                  environmentId,
                  operationId: captured.operationId,
                  receiptSha256: captured.expectedReceiptSha256,
                  decisionSha256: mergeHash(row.decision),
                  gateId: row.decision.gate.recordId,
                  gateSha256: mergeHash(row.decision.gate),
                  source: qualified.source,
                  sourceRef: qualified.detail.sourceRef,
                  ...snapshots,
                });
                yield* Effect.try({
                  try: () => assertDeliveryAcceptanceCurrent(state, proof),
                  catch: (cause) =>
                    error("Delivered work still has conflicting authority", "not-ready", cause),
                });
                const at = DateTime.formatIso(yield* DateTime.now);
                const command: ProjectWorkCommand = {
                  type: "project-work.foundation.commit",
                  commandId: CommandId.make(
                    `delivery-acceptance:${mergeHash({ environmentId, operationId: captured.operationId, receiptSha256: captured.expectedReceiptSha256 })}`,
                  ),
                  projectId: request.target.projectId,
                  expectedRevision: state.revision,
                  records: [],
                  committedAt: at,
                  attribution: {
                    actor: { kind: "system", id: DELIVERY_ACCEPTANCE_PRODUCER },
                    source: { kind: "system", id: DELIVERY_ACCEPTANCE_PRODUCER },
                    recordedAt: at,
                  },
                  transition: {
                    kind: "delivery.accept",
                    expectedTaskRevision: task.revision,
                    proof,
                  },
                };
                accepted = { _tag: "Accepted", operationId: captured.operationId };
                return [command];
              }),
            ),
            provide(
              Effect.gen(function* () {
                if (accepted._tag !== "Accepted") return;
                const row = yield* journal.readInTransaction(captured.operationId);
                if (!row?.receipt) return yield* error("Delivery disappeared before commit");
                const state = yield* readCurrentState(
                  sql,
                  row.decision.publication.target.projectId,
                );
                const retained = readDeliveryAcceptance(
                  state,
                  row.decision.publication.target.taskId,
                  captured.operationId,
                );
                if (!retained || retained.detail.proof.operationId !== captured.operationId)
                  return yield* error("Acceptance was not retained");
                if (original) yield* audit(state, retained);
                else yield* current(state, retained);
              }),
            ),
          );
          return accepted;
        }),
      ).pipe(
        Effect.catchIf(
          (e) => e.code === "not-ready",
          (e) => Effect.succeed({ _tag: "NotReady" as const, reason: e.reason }),
        ),
      );
    };
    const assertTaskDependenciesInTransaction = (input: typeof DependencyInput.Type) => {
      const selected = capture(decodeDependencies, input);
      return boundary(
        Effect.gen(function* () {
          if (!selected) return yield* error("Invalid dependent task", "invalid");
          yield* loan;
          const state = yield* readCurrentState(sql, selected.projectId);
          const dependencies = yield* Effect.try({
            try: () => deliveryDependencyIds(state, selected.taskId),
            catch: (cause) => error("Dependency lineage is invalid", "not-ready", cause),
          });
          for (const id of dependencies) {
            const task = state.tasks.find((t) => t.taskId === id),
              retained = readDeliveryAcceptance(state, id);
            if (
              task?.state !== "completed" ||
              !retained ||
              task.completedAt !== retained.evidence.recordedAt
            )
              return yield* error("Managed dependency has no accepted delivery", "not-ready");
            yield* current(state, retained);
          }
        }),
      );
    };
    const assertTaskDependencies = (input: typeof DependencyInput.Type) => {
      const action = assertTaskDependenciesInTransaction(input);
      return boundary(
        Effect.gen(function* () {
          yield* affinity;
          if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) yield* action;
          else yield* sql.withTransaction(provide(action));
        }),
      );
    };
    const pending = (afterOperationId?: string) =>
      boundary(
        Effect.gen(function* () {
          yield* affinity;
          return yield* provide(
            sql.withTransaction(
              Effect.gen(function* () {
                return yield* journal.confirmedUnacceptedInTransaction(afterOperationId);
              }),
            ),
          );
        }),
      );
    const recover = (input: string) => {
      const operationId = capture(decodeOperationId, input);
      return boundary(
        Effect.gen(function* () {
          if (!operationId) return yield* error("Invalid delivery operation", "invalid");
          yield* affinity;
          const row = yield* provide(sql.withTransaction(journal.readInTransaction(operationId)));
          if (!row?.receipt) return yield* error("Delivery has no confirmed receipt", "not-ready");
          return yield* accept({ operationId, expectedReceiptSha256: mergeHash(row.receipt) });
        }),
      );
    };
    return {
      accept,
      pending,
      recover,
      assertTaskDependenciesInTransaction,
      assertTaskDependencies,
    };
  });
};
export class ProjectTeamDeliveryAcceptance extends Context.Service<
  ProjectTeamDeliveryAcceptance,
  Effect.Success<ReturnType<typeof makeProjectTeamDeliveryAcceptance>>
>()("t3/projectWork/ProjectTeamDeliveryAcceptance") {}
