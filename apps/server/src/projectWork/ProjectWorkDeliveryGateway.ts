import {
  CommandId,
  ProjectWorkDeliveryRequest,
  ProjectWorkDeliveryRecoveryRead,
  type ProjectId,
  type ProjectWorkTaskId,
  type ProjectWorkDeliveryResult,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Sources from "./ProjectTeamIntegrationSources.ts";
import * as Host from "./ProjectWorkPublicationHost.ts";
import * as Journal from "./ProjectWorkPublicationJournal.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ProjectWorkPrincipal } from "./ProjectWorkGateway.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";
export const publicDeliveryResult = (
  result: Journal.DeliveryOperation,
): ProjectWorkDeliveryResult => ({
  operationId: result.operationId,
  kind: result.kind,
  stage: result.stage,
  ...(result.publication?.kind === "confirmed"
    ? {
        pullRequest: {
          number: result.publication.pullRequest.number,
          url: result.publication.pullRequest.url,
          state: result.publication.pullRequest.state,
        },
      }
    : {}),
  ...(result.merge === undefined ? {} : { mergedCommitSha: result.merge.mergedCommitSha }),
  ...(result.kind === "merge" && result.stage === "confirmed" && result.merge !== undefined
    ? { receiptHash: Journal.publicationHash(result) }
    : {}),
});
const decodeDeliveryRequestJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkDeliveryRequest),
);
const decodeDeliveryOperationJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Journal.DeliveryOperation),
);
const decodeDeliveryRecovery = Schema.decodeUnknownEffect(ProjectWorkDeliveryRecoveryRead);
type DeliveryRecoveryInput = {
  readonly projectId: ProjectId;
  readonly taskId: ProjectWorkTaskId;
  readonly limit: number;
  readonly cursor?: string;
};
export const readDeliveryRecovery = Effect.fn("ProjectWorkDeliveryGateway.readDeliveryRecovery")(
  function* (
    sql: SqlClient.SqlClient,
    environmentId: import("@t3tools/contracts").EnvironmentId,
    input: DeliveryRecoveryInput,
  ) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 32)
      return yield* new Journal.PublicationError({ reason: "authorization" });
    const state = yield* Repository.readCurrentState(sql, input.projectId);
    if (!state.tasks.some((t) => t.taskId === input.taskId))
      return yield* new Journal.PublicationError({ reason: "authorization" });
    const rows = yield* sql<{
      id: string;
      payload_json: string;
      kind: string;
      gate_id: string;
      base_ref: string;
    }>`
        SELECT * FROM (
          SELECT 'preview:' || command_id AS id, request_json AS payload_json, 'preview' AS kind, gate_id, base_ref FROM t3_workflow_v2_delivery_previews WHERE project_id=${input.projectId} AND task_id=${input.taskId}
          UNION ALL SELECT 'operation:' || operation_id AS id,payload_json,'operation' AS kind,gate_id,'' AS base_ref FROM t3_workflow_v2_delivery_operations WHERE project_id=${input.projectId} AND task_id=${input.taskId}
        ) WHERE id > ${input.cursor ?? ""} ORDER BY id LIMIT ${input.limit + 1}`;
    const items: Array<ProjectWorkDeliveryRecoveryRead["items"][number]> = [];
    for (const row of rows.slice(0, input.limit)) {
      if (row.kind === "preview") {
        const request = yield* decodeDeliveryRequestJson(row.payload_json);
        if (request.operation !== "preview")
          return yield* new Journal.PublicationError({ reason: "storage" });
        items.push({
          request,
          result: {
            operationId: request.input.commandId,
            kind: "preview",
            stage: "proposed",
            gateId: row.gate_id,
          },
          sourceRef: request.input.sourceRef,
          baseRef: row.base_ref,
          gateId: row.gate_id,
        });
      } else {
        const operation = yield* decodeDeliveryOperationJson(row.payload_json);
        const d = operation.decision;
        const request: ProjectWorkDeliveryRequest =
          operation.kind === "merge"
            ? {
                operation: "merge",
                input: {
                  operationId: operation.operationId,
                  publicationOperationId: operation.publicationOperationId!,
                  gateId: d.gate.recordId,
                },
              }
            : {
                operation: "publish",
                input: {
                  operationId: operation.operationId,
                  projectId: d.request.target.projectId,
                  taskId: d.request.target.taskId,
                  gateId: d.gate.recordId,
                  sourceRef: d.sourceRef,
                  title: d.request.title,
                  body: d.request.body,
                },
              };
        items.push({
          request,
          result: publicDeliveryResult(operation),
          sourceRef: d.sourceRef,
          baseRef: d.request.target.baseRef,
          gateId: d.gate.recordId,
        });
      }
    }
    return yield* decodeDeliveryRecovery({
      environmentId,
      projectId: input.projectId,
      taskId: input.taskId,
      revision: state.revision,
      items,
      ...(rows.length > input.limit ? { nextCursor: rows[input.limit - 1]!.id } : {}),
    });
  },
  Effect.mapError((cause) => new Journal.PublicationError({ reason: "storage", cause })),
);
type Preview = Extract<ProjectWorkDeliveryRequest, { operation: "preview" }>["input"];
export const retainDeliveryPreview = Effect.fn("ProjectWorkDeliveryGateway.retainDeliveryPreview")(
  function* (sql: SqlClient.SqlClient, input: Preview, gateId: string, baseRef: string) {
    yield* sql`INSERT INTO t3_workflow_v2_delivery_previews(project_id,task_id,command_id,request_json,gate_id,base_ref) VALUES(${input.projectId},${input.taskId},${input.commandId},${canonicalProjectWorkPayload({ operation: "preview", input })},${gateId},${baseRef})`;
  },
);
export class ProjectWorkDeliveryGateway extends Context.Service<
  ProjectWorkDeliveryGateway,
  {
    readonly recover: (
      input: { projectId: ProjectId; taskId: ProjectWorkTaskId; limit: number; cursor?: string },
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<ProjectWorkDeliveryRecoveryRead, Journal.PublicationError>;
    readonly preview: (
      input: Preview,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<ProjectWorkDeliveryResult, Journal.PublicationError>;
    readonly link: (
      operation: Journal.DeliveryOperation,
    ) => Effect.Effect<void, Journal.PublicationError>;
  }
>()("t3/projectWork/ProjectWorkDeliveryGateway") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* Environment.ServerEnvironment;
  const sources = yield* Sources.ProjectTeamIntegrationSources;
  const host = yield* Host.ProjectWorkPublicationHost;
  const journal = yield* Journal.ProjectWorkPublicationJournal;
  const repository = yield* Repository.ProjectWorkRepository;
  const authorization = yield* Authorization.ProjectTeamAuthorization;
  const engine = yield* Orchestrator.OrchestratorV2;
  const link = Effect.fn("ProjectWorkDeliveryGateway.link")(
    function* (operation: Journal.DeliveryOperation) {
      if (operation.stage !== "confirmed" || operation.publication?.kind !== "confirmed") return;
      const state = yield* Repository.readCurrentState(
        sql,
        operation.decision.request.target.projectId,
      );
      const binding = state.foundationRecords?.find(
        (record) =>
          record.kind === "run-binding" && record.recordId === operation.decision.source.bindingId,
      );
      if (
        binding?.kind !== "run-binding" ||
        binding.generation !== operation.decision.source.generation ||
        binding.status !== "settled"
      )
        return yield* new Journal.PublicationError({ reason: "stale" });
      yield* engine.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`project-work-publication-link:${operation.operationId}`),
        threadId: binding.threadId,
        host: operation.publication.repository.host,
        repository: operation.publication.repository.nameWithOwner,
        number: operation.publication.pullRequest.number,
        url: operation.publication.pullRequest.url,
        source: "created",
      });
    },
    Effect.mapError((cause) => new Journal.PublicationError({ reason: "uncertain", cause })),
  );
  const preview = Effect.fn("ProjectWorkDeliveryGateway.preview")(
    function* (input: Preview, principal: ProjectWorkPrincipal) {
      yield* authorization.assertHumanSourceControl(principal);
      const at = DateTime.formatIso(yield* DateTime.now);
      const attribution = { actor: principal.actor, source: principal.source, recordedAt: at };
      const gateId = projectTeamDerivedRecordId(input.commandId, "delivery-gate");
      const command = {
        type: "project-work.foundation.commit" as const,
        commandId: input.commandId,
        projectId: input.projectId,
        expectedRevision: input.expectedRevision,
        attribution,
        committedAt: at,
        records: [],
      };
      const fingerprint = Journal.publicationHash({
        input,
        actor: principal.actor,
        source: principal.source,
      });
      const prior =
        yield* sql`SELECT command_id FROM t3_workflow_v2_work_command_receipts WHERE project_id=${input.projectId} AND command_id=${input.commandId} LIMIT 1`;
      if (prior.length > 0) {
        yield* repository.executeAuthorized(
          command,
          () => Effect.fail(new Journal.PublicationError({ reason: "stale" })),
          () => authorization.assertHumanSourceControl(principal),
          fingerprint,
        );
        return {
          operationId: input.commandId,
          kind: "preview" as const,
          stage: "proposed" as const,
          gateId,
        };
      }
      const state = yield* Repository.readCurrentState(sql, input.projectId);
      if (state.revision !== input.expectedRevision || input.taskId !== input.sourceRef.taskId)
        return yield* new Journal.PublicationError({ reason: "stale" });
      const source = yield* sources.qualify(state, input.sourceRef);
      const captured = yield* host.capture({
        projectId: input.projectId,
        source,
        baseRef: input.baseRef,
      });
      let number: number | undefined;
      if (input.kind === "merge") {
        if (input.publicationOperationId === undefined || input.mergeMethod === undefined)
          return yield* new Journal.PublicationError({ reason: "authorization" });
        const publication = yield* journal.read(input.publicationOperationId);
        if (
          Option.isNone(publication) ||
          publication.value.kind !== "create-pr" ||
          publication.value.stage !== "confirmed" ||
          publication.value.publication?.kind !== "confirmed" ||
          canonicalProjectWorkPayload(publication.value.decision.sourceRef) !==
            canonicalProjectWorkPayload(input.sourceRef) ||
          canonicalProjectWorkPayload(publication.value.decision.request.repository) !==
            canonicalProjectWorkPayload(captured.repository)
        )
          return yield* new Journal.PublicationError({ reason: "stale" });
        number = publication.value.publication.pullRequest.number;
      } else if (input.mergeMethod !== undefined || input.publicationOperationId !== undefined)
        return yield* new Journal.PublicationError({ reason: "authorization" });
      yield* repository.executeAuthorized(
        command,
        ({ state: current }) =>
          Effect.gen(function* () {
            yield* authorization.assertHumanSourceControl(principal);
            const actual = yield* sources.qualify(current, input.sourceRef);
            if (canonicalProjectWorkPayload(source) !== canonicalProjectWorkPayload(actual))
              return yield* new Journal.PublicationError({ reason: "stale" });
            yield* retainDeliveryPreview(sql, input, gateId, captured.baseRef);
            return {
              type: "project-work.foundation.commit" as const,
              commandId: input.commandId,
              projectId: input.projectId,
              expectedRevision: input.expectedRevision,
              attribution,
              committedAt: at,
              records: [
                {
                  kind: "gate" as const,
                  recordId: gateId,
                  projectId: input.projectId,
                  taskId: input.taskId,
                  revision: 0,
                  generation: source.generation,
                  updatedAt: at,
                  status: "proposed" as const,
                  gate: input.kind === "merge" ? ("merge" as const) : ("publication" as const),
                  specRevision: source.specRevision,
                  planRevision: source.planRevision,
                  contentHash: source.scopeHash,
                  attribution,
                  repository: captured.repository.nameWithOwner,
                  headSha: source.headSha,
                  targetBranch: captured.baseRef,
                  ...(number === undefined ? {} : { pullRequestNumber: number }),
                  ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
                  evidenceIds: [],
                },
              ],
            };
          }),
        () => authorization.assertHumanSourceControl(principal),
        fingerprint,
      );
      return {
        operationId: input.commandId,
        kind: "preview" as const,
        stage: "proposed" as const,
        gateId,
      };
    },
    Effect.mapError((cause) => new Journal.PublicationError({ reason: "authorization", cause })),
  );
  const recover = Effect.fn("ProjectWorkDeliveryGateway.recover")(
    function* (input: DeliveryRecoveryInput, principal: ProjectWorkPrincipal) {
      yield* authorization.assertHuman(principal);
      return yield* readDeliveryRecovery(sql, yield* environment.getEnvironmentId, input);
    },
    Effect.mapError((cause) => new Journal.PublicationError({ reason: "authorization", cause })),
  );
  return ProjectWorkDeliveryGateway.of({ preview, link, recover });
});
export const layer = Layer.effect(ProjectWorkDeliveryGateway, make);
