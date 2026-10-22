import {
  ProjectWorkPublicationRequest,
  ProjectWorkPublicationOutcome,
  ProjectTeamGate,
  ProjectTeamIntegrationSource,
  ProjectTeamIntegrationSourceRef,
  ProjectTeamIntegrationSources,
  ProjectWorkActor,
  ProjectWorkSource,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Durable publication identity uses synchronous SHA-256 in transaction checks.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class PublicationError extends Schema.TaggedError<PublicationError>()("PublicationError", {
  reason: Schema.Literals([
    "authorization",
    "stale",
    "unsupported",
    "uncertain",
    "storage",
    "conflict",
    "not-ready",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
export const publicationHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
export const PublicationDecision = Schema.Struct({
  request: ProjectWorkPublicationRequest,
  cwd: Schema.String,
  providerId: Schema.String,
  account: Schema.Struct({
    credentialFingerprint: Schema.String,
    accountId: Schema.String,
    viewer: Schema.String,
  }),
  gate: ProjectTeamGate,
  source: ProjectTeamIntegrationSource,
  sourceRef: ProjectTeamIntegrationSourceRef,
  integrationSources: Schema.optionalKey(ProjectTeamIntegrationSources),
});
export type PublicationDecision = typeof PublicationDecision.Type;
export const MergeConfirmation = Schema.Struct({
  providerId: Schema.String,
  host: Schema.String,
  repositoryNodeId: Schema.String,
  repository: Schema.String,
  number: Schema.Number,
  authorizedHeadSha: Schema.String,
  baseSha: Schema.String,
  baseRef: Schema.String,
  mergedCommitSha: Schema.String,
  mergedAt: Schema.String,
});
export type MergeConfirmation = typeof MergeConfirmation.Type;
export const DeliveryOperation = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.Literals(["create-pr", "merge"]),
  decision: PublicationDecision,
  decisionHash: Schema.String,
  principal: Schema.Struct({ actor: ProjectWorkActor, source: ProjectWorkSource }),
  publicationOperationId: Schema.optionalKey(Schema.String),
  stage: Schema.Literals(["approved", "claimed", "uncertain", "confirmed"]),
  publication: Schema.optionalKey(ProjectWorkPublicationOutcome),
  merge: Schema.optionalKey(MergeConfirmation),
});
export type DeliveryOperation = typeof DeliveryOperation.Type;
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(DeliveryOperation));
const encode = Schema.encodeEffect(Schema.fromJsonString(DeliveryOperation));
export class ProjectWorkPublicationJournal extends Context.Service<
  ProjectWorkPublicationJournal,
  {
    readonly read: (
      id: string,
    ) => Effect.Effect<Option.Option<DeliveryOperation>, PublicationError>;
    readonly retain: (
      operation: DeliveryOperation,
    ) => Effect.Effect<DeliveryOperation, PublicationError>;
    readonly claim: (operation: DeliveryOperation) => Effect.Effect<boolean, PublicationError>;
    readonly save: (operation: DeliveryOperation) => Effect.Effect<void, PublicationError>;
  }
>()("t3/projectWork/ProjectWorkPublicationJournal") {}
const isPublicationError = Schema.is(PublicationError);
const storage = (cause: unknown) =>
  isPublicationError(cause) ? cause : new PublicationError({ reason: "storage", cause });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = Effect.fn("ProjectWorkPublicationJournal.read")(function* (id: string) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_delivery_operations WHERE operation_id=${id}`;
    return rows[0]
      ? Option.some(yield* decode(rows[0].payload_json))
      : Option.none<DeliveryOperation>();
  }, Effect.mapError(storage));
  const retain = Effect.fn("ProjectWorkPublicationJournal.retain")(function* (
    operation: DeliveryOperation,
  ) {
    yield* sql`INSERT INTO t3_workflow_v2_delivery_operations(operation_id,project_id,task_id,gate_id,kind,decision_hash,stage,payload_json) VALUES(${operation.operationId},${operation.decision.request.target.projectId},${operation.decision.request.target.taskId},${operation.decision.gate.recordId},${operation.kind},${operation.decisionHash},'approved',${yield* encode(operation)}) ON CONFLICT DO NOTHING`;
    const found = yield* read(operation.operationId);
    if (
      Option.isNone(found) ||
      found.value.decisionHash !== operation.decisionHash ||
      found.value.kind !== operation.kind ||
      canonicalProjectWorkPayload(found.value.principal) !==
        canonicalProjectWorkPayload(operation.principal) ||
      found.value.publicationOperationId !== operation.publicationOperationId
    )
      return yield* new PublicationError({ reason: "conflict" });
    return found.value;
  }, Effect.mapError(storage));
  const claim = Effect.fn("ProjectWorkPublicationJournal.claim")(function* (
    operation: DeliveryOperation,
  ) {
    const claimed = { ...operation, stage: "claimed" as const };
    const rows =
      yield* sql`UPDATE t3_workflow_v2_delivery_operations SET stage='claimed',payload_json=${yield* encode(claimed)} WHERE operation_id=${operation.operationId} AND decision_hash=${operation.decisionHash} AND stage='approved' RETURNING operation_id`;
    return rows.length === 1;
  }, Effect.mapError(storage));
  const save = Effect.fn("ProjectWorkPublicationJournal.save")(function* (
    operation: DeliveryOperation,
  ) {
    if (!["uncertain", "confirmed"].includes(operation.stage))
      return yield* new PublicationError({ reason: "conflict" });
    const rows =
      yield* sql`UPDATE t3_workflow_v2_delivery_operations SET stage=${operation.stage},payload_json=${yield* encode(operation)} WHERE operation_id=${operation.operationId} AND decision_hash=${operation.decisionHash} AND stage IN ('claimed','uncertain') RETURNING operation_id`;
    if (rows.length !== 1) return yield* new PublicationError({ reason: "conflict" });
  }, Effect.mapError(storage));
  return ProjectWorkPublicationJournal.of({ read, retain, claim, save });
});
export const layer = Layer.effect(ProjectWorkPublicationJournal, make);
