import { makeMemoryProcessingDestination } from "./MemoryProcessingDestination.ts";
import {
  ProjectId,
  ProjectMemorySource,
  ProjectWorkEvidenceId,
  projectWorkPayloadFingerprint,
  type ProjectTeamMemoryConfigureIntent,
  type ProjectWorkWriteResult,
  type ProjectTeamMemoryProcessIntent,
} from "@t3tools/contracts";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as DateTime from "effect/DateTime";
import * as Repository from "../ProjectWorkRepository.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Projects from "../../orchestration-v2/ProjectStore.ts";
import * as Events from "../../persistence/OrchestrationEventStore.ts";
import * as Bus from "../ProjectWorkEventBus.ts";
import { readCurrentState } from "../ProjectWorkRepository.ts";
import * as TeamAuthorization from "../ProjectTeamAuthorization.ts";
import type { ProjectWorkPrincipal } from "../ProjectWorkGateway.ts";
import * as Configuration from "./ProjectMemoryConfiguration.ts";
import * as Processing from "./ProjectMemoryProcessing.ts";
import * as Authority from "./ProjectMemoryService.ts";
import { ProjectMemoryError, ownerId, sourceTuple, memoryHash } from "./ProjectMemoryRepository.ts";

const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemorySource));
const isMemoryError = Schema.is(ProjectMemoryError);
const unavailable = (cause: unknown) =>
  isMemoryError(cause) ? cause : new ProjectMemoryError({ reason: "unavailable", cause });
export class ProjectMemoryRuntime extends Context.Service<
  ProjectMemoryRuntime,
  {
    readonly process: (
      input: ProjectTeamMemoryProcessIntent,
    ) => Effect.Effect<void, ProjectMemoryError>;
    readonly configure: (
      input: ProjectTeamMemoryConfigureIntent,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<ProjectWorkWriteResult, ProjectMemoryError>;
    readonly subscribe: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
    readonly recover: () => Effect.Effect<void, ProjectMemoryError>;
  }
>()("t3/projectWork/memory/ProjectMemoryRuntime") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const configuration = yield* Configuration.ProjectMemoryConfiguration;
  const repository = yield* Repository.ProjectWorkRepository;
  const auth = yield* TeamAuthorization.ProjectTeamAuthorization;
  const destinationFor = yield* makeMemoryProcessingDestination;
  const hints = yield* PubSub.sliding<void>(1);
  const environment = yield* Environment.ServerEnvironment;
  const projects = yield* Projects.ProjectStoreV2;
  const authority = yield* Authority.ProjectMemoryService;
  const processing = yield* Processing.ProjectMemoryProcessing;
  const schedule = Effect.fn("ProjectMemoryRuntime.schedule")(function* (
    source: ProjectMemorySource,
    taskId: string,
  ) {
    const owner = source.owner;
    if (owner.kind !== "project") return yield* new ProjectMemoryError({ reason: "forbidden" });
    const environmentId = yield* environment.getEnvironmentId;
    const state = yield* readCurrentState(sql, owner.projectId);
    const records = state.foundationRecords ?? [];
    const membership = records.find(
      (record) =>
        record.kind === "task-membership" && record.taskId === taskId && record.status === "active",
    );
    const constraints =
      membership?.kind === "task-membership" ? membership.rootConstraints : undefined;
    const limits = records.filter(
      (record) =>
        record.kind === "limits" &&
        record.status === "configured" &&
        (constraints?.limitsRecordId === undefined ||
          (record.recordId === constraints.limitsRecordId &&
            record.revision === constraints.limitsRevision)),
    );
    if (
      limits.length !== 1 ||
      limits[0]?.kind !== "limits" ||
      limits[0].providerInstanceId === undefined
    )
      return yield* new ProjectMemoryError({ reason: "invalid" });
    const selected = limits[0];
    const project = yield* projects.get(owner.projectId);
    if (Option.isNone(project)) return yield* new ProjectMemoryError({ reason: "stale" });
    const tuple = sourceTuple(
      { environmentId, owner, ownerRevision: source.ownerRevision },
      source,
    );
    const configured = yield* configuration.read(tuple);
    const destination = yield* destinationFor(tuple, configured.configuration);
    yield* processing.enqueueExtraction({
      tuple,
      cwd: project.value.workspaceRoot,
      modelSelection: { instanceId: selected.providerInstanceId!, model: selected.model },
      configurationRevision: configured.revision,
      ...(configured.configuration.extractionRoute
        ? { extractionRoute: configured.configuration.extractionRoute }
        : {}),
      ...(destination ? { destination } : {}),
    });
  }, Effect.mapError(unavailable));
  const process = Effect.fn("ProjectMemoryRuntime.process")(function* (
    input: ProjectTeamMemoryProcessIntent,
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    const owner = input.selection.owner;
    if (owner.kind !== "project" || owner.projectId !== input.projectId)
      return yield* new ProjectMemoryError({ reason: "forbidden" });
    const sourceRow = (yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_memory_sources WHERE environment_id=${environmentId} AND owner_kind=${owner.kind} AND owner_id=${ownerId(owner)} AND owner_revision=${input.selection.ownerRevision} AND source_revision=${input.selection.sourceRevision} AND generation=${input.selection.sourceGeneration} AND content_hash=${input.selection.contentHash} AND json_extract(payload_json,'$.recordId')=${input.selection.sourceRecordId} AND task_id=${input.taskId} AND status='current' LIMIT 1`)[0];
    if (!sourceRow) return yield* new ProjectMemoryError({ reason: "stale" });
    const source = yield* decodeSource(sourceRow.payload_json);
    yield* schedule(source, input.taskId);
    yield* PubSub.publish(hints, undefined);
  }, Effect.mapError(unavailable));
  const recover = Effect.fn("ProjectMemoryRuntime.recover")(function* () {
    const environmentId = yield* environment.getEnvironmentId;
    let afterOwner = "";
    while (true) {
      const rows = yield* sql<{
        owner_id: string;
        owner_revision: number;
      }>`SELECT source.owner_id,MAX(source.owner_revision) AS owner_revision FROM t3_workflow_v2_memory_sources source LEFT JOIN projection_projects project ON project.project_id=source.owner_id WHERE source.environment_id=${environmentId} AND source.owner_kind='project' AND source.status='current' AND (project.project_id IS NULL OR project.deleted_at IS NOT NULL) AND source.owner_id>${afterOwner} GROUP BY source.owner_id ORDER BY source.owner_id LIMIT 128`;
      if (rows.length === 0) break;
      for (const row of rows)
        yield* authority.deleteOwner({
          environmentId,
          owner: { kind: "project", projectId: ProjectId.make(row.owner_id) },
          ownerRevision: row.owner_revision,
        });
      afterOwner = rows[rows.length - 1]!.owner_id;
    }
    let afterSource = 0;
    while (true) {
      const sources = yield* sql<{
        cursor: number;
        payload_json: string;
        task_id: string;
      }>`SELECT source.rowid AS cursor,source.payload_json,source.task_id FROM t3_workflow_v2_memory_sources source LEFT JOIN t3_workflow_v2_memory_processing job ON job.environment_id=source.environment_id AND job.owner_kind=source.owner_kind AND job.owner_id=source.owner_id AND job.owner_revision=source.owner_revision AND job.source_id=source.source_id AND job.source_revision=source.source_revision AND job.generation=source.generation AND job.content_hash=source.content_hash WHERE source.environment_id=${environmentId} AND source.owner_kind='project' AND source.status='current' AND source.rowid>${afterSource} AND job.operation_key IS NULL ORDER BY source.rowid LIMIT 128`;
      if (sources.length === 0) break;
      for (const row of sources) {
        const source = yield* decodeSource(row.payload_json);
        yield* schedule(source, row.task_id).pipe(Effect.ignore);
      }
      afterSource = sources[sources.length - 1]!.cursor;
    }
    let after = "";
    while (true) {
      const page = yield* processing.reconcile(after);
      if (page.length === 0) break;
      after = page[page.length - 1]!;
    }
    after = "";
    while (true) {
      const page = yield* processing.cleanup(after);
      if (page.length === 0) break;
      after = page[page.length - 1]!;
    }
  }, Effect.mapError(unavailable));
  const configure = Effect.fn("ProjectMemoryRuntime.configure")(function* (
    input: ProjectTeamMemoryConfigureIntent,
    principal: ProjectWorkPrincipal,
  ) {
    yield* auth.assertHuman(principal);
    const at = DateTime.formatIso(yield* DateTime.now);
    const attribution = { actor: principal.actor, source: principal.source, recordedAt: at };
    const result = yield* repository.executeReserved(
      {
        type: "project-work.evidence.add",
        commandId: input.commandId,
        projectId: input.projectId,
        expectedRevision: input.expectedRevision,
        attribution,
        addedAt: at,
        evidence: {
          evidenceId: ProjectWorkEvidenceId.make(
            `memory-configuration:${memoryHash(input.commandId)}`,
          ),
          kind: "observation",
          summary: "Memory processing configuration updated",
          detail: `Configuration revision ${input.expectedConfigurationRevision + 1}`,
          recordedAt: at,
          revision: 0,
          attribution,
        },
      },
      (receipt) =>
        Effect.gen(function* () {
          yield* auth.assertHuman(principal);
          if (
            input.owner.kind !== "project" ||
            input.owner.projectId !== input.projectId ||
            (principal.projectId !== undefined && principal.projectId !== input.projectId)
          )
            return yield* new ProjectMemoryError({ reason: "forbidden" });
          const project = yield* projects.get(input.projectId);
          if (Option.isNone(project)) return yield* new ProjectMemoryError({ reason: "stale" });
          const scope = {
            environmentId: yield* environment.getEnvironmentId,
            owner: input.owner,
            ownerRevision: input.ownerRevision,
          };
          if (receipt.duplicate) {
            yield* configuration.read(scope);
            return;
          }
          yield* configuration.set(
            {
              environmentId: yield* environment.getEnvironmentId,
              owner: input.owner,
              ownerRevision: input.ownerRevision,
            },
            input.expectedConfigurationRevision,
            input.configuration,
          );
        }),
      projectWorkPayloadFingerprint({ input, actor: principal.actor, source: principal.source }),
    );
    return result.writeResult;
  }, Effect.mapError(unavailable));
  return ProjectMemoryRuntime.of({
    process,
    configure,
    recover,
    subscribe: PubSub.subscribe(hints).pipe(Effect.map(Stream.fromSubscription)),
  });
});
export const layer = Layer.effect(ProjectMemoryRuntime, make);
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* ProjectMemoryRuntime;
    const bus = yield* Bus.ProjectWorkEventBus;
    const events = yield* Events.OrchestrationEventStore;
    const wake = yield* bus.subscribe;
    const requests = yield* runtime.subscribe;
    yield* Stream.runForEach(requests, () => runtime.recover().pipe(Effect.ignore)).pipe(
      Effect.forkScoped,
    );
    const afterSequence = yield* events.latestApplicationSequence;
    yield* Stream.runForEach(wake, () => runtime.recover().pipe(Effect.ignore)).pipe(
      Effect.forkScoped,
    );
    yield* events.streamApplicationEvents({ afterSequence }).pipe(
      Stream.filter(
        (event) =>
          "aggregateKind" in event &&
          event.aggregateKind === "project" &&
          event.type === "project.deleted",
      ),
      Stream.runForEach(() => runtime.recover().pipe(Effect.ignore)),
      Effect.forkScoped,
    );
    yield* runtime.recover().pipe(Effect.ignore, Effect.forkScoped);
  }),
);
