import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  ProjectMemoryExtraction,
  ProjectMemoryObservation,
  ProjectMemorySource,
  ProjectWorkFoundationCommitCommand,
  canonicalProjectWorkPayload,
  type ProjectTeamRecord,
  type ProjectWorkAttribution,
  type ProjectWorkCommand,
  type ProjectWorkTaskId,
  ProjectWorkComment,
  ProjectWorkEvidence,
  ProjectWorkDecision,
  ProjectTeamEffect,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProjectWorkContentGuardShape } from "../ProjectWorkContentGuard.ts";
import type { ProjectWorkReducerState } from "../ProjectWorkDecider.ts";
import { readCurrentState, type ProjectWorkRepositoryShape } from "../ProjectWorkRepository.ts";
import type {
  ProjectTeamAuthorization,
  ProjectTeamPrincipal,
} from "../ProjectTeamAuthorization.ts";
import type { ProjectMemoryVerifiedOutcome } from "./ProjectMemoryIndexReactor.ts";
import { MemoryIndexManifest, MemoryVector } from "./MemoryBackend.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
export const ProjectMemoryRetainedSelector = Schema.Struct({
  kind: Schema.Literals(["comment", "evidence", "decision"]),
  retainedId: Id,
});
export const ProjectMemoryExtractedFacts = Schema.Array(
  Schema.Struct({
    key: Id,
    body: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(8_000)),
    quote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  }),
).check(
  Schema.isMaxLength(32),
  Schema.makeFilter(
    (facts) =>
      new Set(facts.map((fact) => fact.key)).size === facts.length &&
      facts.reduce(
        (bytes, fact) => bytes + Buffer.byteLength(fact.body) + Buffer.byteLength(fact.quote),
        0,
      ) <= 32_000,
    { message: "Extraction exceeds source budget or contains duplicate keys" },
  ),
);
export const PROJECT_MEMORY_MODELS = {
  extraction: "inclusionai/ling-3.1-flash:free",
  embedding: "nvidia/nemotron-3-embed-1b:free",
  dimensions: 2048,
  providerFallback: false,
} as const;
export class ProjectMemoryServiceError extends Schema.TaggedError<ProjectMemoryServiceError>()(
  "ProjectMemoryServiceError",
  { reason: Schema.String },
) {}
const isMemoryServiceError = Schema.is(ProjectMemoryServiceError);
const deny = (reason: string) => new ProjectMemoryServiceError({ reason });
const validate = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => deny("Invalid memory input or retained output")),
  );
export const projectMemoryHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
export const projectMemoryId = (kind: string, value: unknown) =>
  `${kind}:${projectMemoryHash(value)}`;
type Selector = typeof ProjectMemoryRetainedSelector.Type;
type Extraction = typeof ProjectMemoryExtraction.Type;
type Observation = typeof ProjectMemoryObservation.Type;
type Source = typeof ProjectMemorySource.Type;
type Manifest = typeof MemoryIndexManifest.Type;
export type ProjectMemoryEffect = Extract<ProjectTeamRecord, { kind: "effect" }>;

export const ProjectMemoryJobInput = Schema.Struct({
  environmentId: Id,
  projectId: Id,
  effect: ProjectTeamEffect,
  source: ProjectMemorySource,
  extraction: Schema.optionalKey(ProjectMemoryExtraction),
});

/** Commit this physical job together with its authoritative intent, before the
 * source/project can be purged. It carries cleanup evidence, never fresh authority.
 */
export const retainProjectMemoryJob = Effect.fn("retainProjectMemoryJob")(function* (
  sql: SqlClient.SqlClient,
  input: typeof ProjectMemoryJobInput.Type,
) {
  const transaction = yield* Effect.serviceOption(sql.transactionService);
  if (transaction._tag === "None")
    return yield* deny("Memory jobs require the captured SQL transaction");
  const decoded = yield* validate(ProjectMemoryJobInput, input);
  const payload = canonicalProjectWorkPayload(decoded);
  if (Buffer.byteLength(payload) > 262_144) return yield* deny("Memory job input exceeds budget");
  yield* sql`INSERT INTO project_team_memory_job (effect_id,environment_id,project_id,input_json,claim_generation,status,receipt_json)
    VALUES (${decoded.effect.effectId},${decoded.environmentId},${decoded.projectId},${payload},0,'pending',NULL)
    ON CONFLICT(effect_id) DO NOTHING`;
  const rows = yield* sql<{
    payload: string;
  }>`SELECT input_json AS payload FROM project_team_memory_job
    WHERE effect_id=${decoded.effect.effectId} AND environment_id=${decoded.environmentId} AND project_id=${decoded.projectId}
    AND length(CAST(input_json AS BLOB))<=262144`;
  if (rows.length !== 1 || rows[0]!.payload !== payload)
    return yield* deny("Memory job immutable winner does not match");
});

/** Root supplies the configured, admission/accounting-backed ports. Each invocation
 * must reserve the request maximum from the same task/root budget before transport,
 * retain unknown charges, enforce deadlines, disable fallback and settle actual usage.
 * No default transport is installed: capture remains usable while ingestion is disabled.
 */
export interface ProjectMemoryModelPorts {
  readonly extract: (input: {
    readonly requestId: string;
    readonly source: Source;
    readonly taskId?: ProjectWorkTaskId;
  }) => Effect.Effect<unknown, ProjectMemoryServiceError>;
  readonly embed: (input: {
    readonly requestId: string;
    readonly source: Source;
    readonly taskId?: ProjectWorkTaskId;
    readonly bodies: ReadonlyArray<string>;
  }) => Effect.Effect<unknown, ProjectMemoryServiceError>;
}

/** Root-owned durable storage. save runs in the repository's captured SQL transaction,
 * inserts once, compares exact immutable bytes on replay and survives process restart.
 * load must bound/validate physical bytes before decoding; project purge must retain
 * cleanup knowledge until a typed backend cleanup receipt is committed.
 */
export interface ProjectMemoryManifestStore {
  readonly save: (manifest: Manifest) => Effect.Effect<void, ProjectMemoryServiceError>;
  readonly load: (
    extractionId: string,
  ) => Effect.Effect<unknown | undefined, ProjectMemoryServiceError>;
}
export interface ProjectMemoryServiceDependencies {
  readonly sql: SqlClient.SqlClient;
  readonly repository: ProjectWorkRepositoryShape;
  readonly contentGuard: ProjectWorkContentGuardShape;
  readonly authorization: ProjectTeamAuthorization["Service"];
  readonly environmentId: string;
  /** Production capture rechecks its current project/settings gate inside the owning transaction. */
  readonly authorizeCapture?: (
    projectId: string,
  ) => Effect.Effect<void, ProjectMemoryServiceError | ServerSettingsError | SqlError>;
  readonly manifests?: ProjectMemoryManifestStore;
  readonly models?: ProjectMemoryModelPorts;
}
const RetainedSourceBody = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("comment"), record: ProjectWorkComment }),
  Schema.Struct({ kind: Schema.Literal("evidence"), record: ProjectWorkEvidence }),
  Schema.Struct({ kind: Schema.Literal("decision"), record: ProjectWorkDecision }),
]);
const decodeCachedContent = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const selectorForSource = Effect.fn("ProjectMemoryService.selectorForSource")(function* (
  source: Source,
) {
  const body = yield* validate(Schema.fromJsonString(RetainedSourceBody), source.content);
  if (body.kind === "comment") return { kind: body.kind, retainedId: body.record.commentId };
  if (body.kind === "evidence") return { kind: body.kind, retainedId: body.record.evidenceId };
  return { kind: body.kind, retainedId: body.record.decisionId };
});
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const systemAttribution = (at: string): ProjectWorkAttribution => ({
  actor: { kind: "system", id: "project-memory" },
  source: { kind: "system", id: "project-memory" },
  recordedAt: at,
});
const records = (state: ProjectWorkReducerState) => state.foundationRecords ?? [];
const sourceFor = (state: ProjectWorkReducerState, id: string) =>
  records(state).find(
    (record): record is Source => record.kind === "memory-source" && record.recordId === id,
  );
const extractionFor = (state: ProjectWorkReducerState, id: string) =>
  records(state).find(
    (record): record is Extraction => record.kind === "memory-extraction" && record.recordId === id,
  );

const retained = (state: ProjectWorkReducerState, selector: Selector) => {
  if (selector.kind === "comment") {
    const record = state.comments?.find((entry) => entry.commentId === selector.retainedId);
    return record === undefined
      ? undefined
      : { record, taskId: record.taskId, sourceKind: "finding" as const };
  }
  if (selector.kind === "evidence") {
    const record = state.evidence.find((entry) => entry.evidenceId === selector.retainedId);
    return record === undefined
      ? undefined
      : { record, taskId: record.taskId, sourceKind: "result" as const };
  }
  const record = state.decisions?.find(
    (entry) => entry.decisionId === selector.retainedId && entry.state === "accepted",
  );
  return record === undefined
    ? undefined
    : { record, taskId: undefined, sourceKind: "decision" as const };
};
/** Concrete physical prepared-vector store; the migration is owned by Root. */
export const makeProjectMemoryManifestStore = (
  sql: SqlClient.SqlClient,
): ProjectMemoryManifestStore => {
  const load = Effect.fn("ProjectMemoryManifestStore.load")(function* (extractionId: string) {
    const rows = yield* sql<{
      extractionId: string;
      environmentId: string;
      projectId: string;
      sourceId: string;
      sourceRevision: number;
      sourceGeneration: number;
      bytes: number;
    }>`
      SELECT extraction_id AS extractionId, environment_id AS environmentId, project_id AS projectId,
      source_id AS sourceId, source_revision AS sourceRevision, source_generation AS sourceGeneration,
      length(CAST(manifest_json AS BLOB)) AS bytes FROM project_team_memory_manifest WHERE extraction_id=${extractionId}`;
    if (rows.length === 0) return undefined;
    const row = rows[0]!;
    if (rows.length !== 1 || row.bytes > 4_194_304)
      return yield* deny("Memory manifest storage exceeds budget");
    const payloads = yield* sql<{
      payload: string;
    }>`SELECT manifest_json AS payload FROM project_team_memory_manifest
      WHERE extraction_id=${extractionId} AND length(CAST(manifest_json AS BLOB))<=4194304`;
    if (payloads.length !== 1) return yield* deny("Memory manifest storage changed");
    const manifest = yield* validate(
      Schema.fromJsonString(MemoryIndexManifest),
      payloads[0]!.payload,
    );
    if (
      manifest.extractionId !== row.extractionId ||
      manifest.environmentId !== row.environmentId ||
      manifest.projectId !== row.projectId ||
      manifest.sourceRecordId !== row.sourceId ||
      manifest.sourceRevision !== row.sourceRevision ||
      manifest.sourceGeneration !== row.sourceGeneration ||
      manifest.observations.length > 32 ||
      Buffer.byteLength(payloads[0]!.payload) !== row.bytes
    )
      return yield* deny("Memory manifest physical identity is corrupt");
    return manifest;
  });
  return {
    load: (extractionId) =>
      load(extractionId).pipe(
        Effect.mapError((error) =>
          isMemoryServiceError(error) ? error : deny("Memory manifest SQL read failed"),
        ),
      ),
    save: Effect.fn("ProjectMemoryManifestStore.save")(
      function* (input) {
        const transaction = yield* Effect.serviceOption(sql.transactionService);
        if (transaction._tag === "None")
          return yield* deny("Memory manifest requires the captured SQL transaction");
        const manifest = yield* validate(MemoryIndexManifest, input);
        const payload = canonicalProjectWorkPayload(manifest);
        if (manifest.observations.length > 32 || Buffer.byteLength(payload) > 4_194_304)
          return yield* deny("Memory manifest exceeds budget");
        yield* sql`INSERT INTO project_team_memory_manifest
        (extraction_id,environment_id,project_id,source_id,source_revision,source_generation,manifest_json)
        VALUES (${manifest.extractionId},${manifest.environmentId},${manifest.projectId},${manifest.sourceRecordId},${manifest.sourceRevision},${manifest.sourceGeneration},${payload})
        ON CONFLICT(extraction_id) DO NOTHING`;
        const retained = yield* load(manifest.extractionId);
        if (canonicalProjectWorkPayload(retained) !== payload)
          return yield* deny("Memory manifest immutable winner does not match");
      },
      Effect.mapError((error) =>
        isMemoryServiceError(error) ? error : deny("Memory manifest SQL save failed"),
      ),
    ),
  };
};

export const makeProjectMemoryService = (dependencies: ProjectMemoryServiceDependencies) => {
  const { sql, repository, contentGuard, authorization } = dependencies;
  const authorizeCapture = dependencies.authorizeCapture ?? (() => Effect.void);
  const manifests = dependencies.manifests ?? makeProjectMemoryManifestStore(sql);
  const requireProject = Effect.fn("ProjectMemoryService.requireProject")(function* (
    projectId: string,
  ) {
    const rows = yield* sql`SELECT p.project_id FROM projection_projects p
      LEFT JOIN project_lifecycle l ON l.project_id=p.project_id
      WHERE p.project_id=${projectId} AND p.deleted_at IS NULL
      AND (l.state IS NULL OR l.state='active') AND l.tombstone_json IS NULL`;
    if (rows.length !== 1) return yield* deny("Memory project is unavailable");
  });
  const commit = Effect.fn("ProjectMemoryService.commit")(function* (
    state: ProjectWorkReducerState,
    changed: ReadonlyArray<ProjectTeamRecord>,
    at: string,
  ) {
    for (const effect of changed) {
      if (
        effect.kind !== "effect" ||
        effect.revision !== 0 ||
        (effect.effectKind !== "memory-index" && effect.effectKind !== "memory-delete")
      )
        continue;
      const source = [...changed, ...records(state)].find(
        (record): record is Source =>
          record.kind === "memory-source" && record.recordId === effect.targetId,
      );
      const extraction = [...changed, ...records(state)].find(
        (record): record is Extraction =>
          record.kind === "memory-extraction" && record.recordId === effect.payload.recordIds[1],
      );
      if (source === undefined) return yield* deny("Memory intent lacks retained source");
      yield* retainProjectMemoryJob(sql, {
        environmentId: dependencies.environmentId,
        projectId: state.projectId,
        effect,
        source,
        ...(extraction === undefined ? {} : { extraction }),
      });
    }
    const commands: Array<ProjectWorkCommand> = [];
    for (let offset = 0; offset < changed.length; offset += 64) {
      commands.push(
        yield* validate(ProjectWorkFoundationCommitCommand, {
          type: "project-work.foundation.commit",
          commandId: CommandId.make(
            projectMemoryId("memory-command", [state.projectId, state.revision, offset, changed]),
          ),
          projectId: ProjectId.make(state.projectId),
          expectedRevision: state.revision + offset,
          records: changed.slice(offset, offset + 64),
          attribution: systemAttribution(at),
          committedAt: at,
        }),
      );
    }
    return commands;
  });
  const intent = (
    source: Source,
    kind: "memory-index" | "memory-delete",
    at: string,
    extraction?: Extraction,
    taskId?: ProjectWorkTaskId,
  ): ProjectMemoryEffect => {
    const id = projectMemoryId(kind, [source.recordId, source.sourceRevision, source.generation]);
    return {
      kind: "effect",
      recordId: id,
      effectId: id,
      projectId: source.projectId,
      revision: 0,
      generation: source.generation,
      updatedAt: at,
      status: "pending",
      effectKind: kind,
      ...(taskId === undefined ? {} : { taskId }),
      targetId: source.recordId,
      payload: {
        recordIds:
          extraction === undefined ? [source.recordId] : [source.recordId, extraction.recordId],
        expectedRevision: source.sourceRevision,
      },
      claimGeneration: 0,
      availableAt: at,
    };
  };
  /** Root-owned retained-event hook. Agent requests use capture instead. */
  const captureRetained = Effect.fn("ProjectMemoryService.captureRetained")(function* (
    projectId: string,
    raw: unknown,
    principal?: ProjectTeamPrincipal,
  ) {
    const selector = yield* validate(ProjectMemoryRetainedSelector, raw);
    let captured: Source | undefined;
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        yield* authorizeCapture(projectId);
        yield* requireProject(projectId);
        const state = yield* readCurrentState(sql, projectId);
        const current = retained(state, selector);
        if (current === undefined || current.record.attribution === undefined)
          return yield* deny(
            "Memory requires a retained attributed finding, result or accepted decision",
          );
        if (
          selector.kind !== "decision" &&
          (current.taskId === undefined ||
            !state.tasks.some((task) => task.taskId === current.taskId))
        )
          return yield* deny("Finding or result has no retained task");
        if (principal !== undefined) {
          const authority = yield* authorization.resolve(principal);
          if (
            authority === undefined ||
            authority.binding.projectId !== projectId ||
            authority.role.memoryAccess === "none" ||
            (current.taskId !== undefined && current.taskId !== authority.binding.taskId)
          )
            return yield* deny("Current managed memory scope does not include this source");
        }
        const retainedBody = yield* validate(RetainedSourceBody, {
          kind: selector.kind,
          record: current.record,
        });
        yield* contentGuard.assertSafe(current.record);
        const content = canonicalProjectWorkPayload({
          kind: selector.kind,
          record: current.record,
        });
        if (content.length > 32_000 || Buffer.byteLength(content) > 32_000)
          return yield* deny("Memory source exceeds retained content budget");
        let logicalRetainedId = selector.retainedId;
        // Accepted decision replacements are corrections of the same logical source.
        // Follow only the decider's retained supersession relation, never model output.
        if (retainedBody.kind === "decision") {
          let decision = retainedBody.record;
          const visited = new Set<string>([decision.decisionId]);
          while (decision.supersedesDecisionId !== undefined) {
            const previous = state.decisions?.find(
              (entry) => entry.decisionId === decision.supersedesDecisionId,
            );
            if (
              previous === undefined ||
              previous.state !== "superseded" ||
              visited.has(previous.decisionId) ||
              visited.size >= 256
            )
              return yield* deny("Retained decision correction chain is invalid or exceeds budget");
            decision = yield* validate(ProjectWorkDecision, previous);
            visited.add(decision.decisionId);
            logicalRetainedId = decision.decisionId;
          }
        }
        const logicalId = canonicalProjectWorkPayload([selector.kind, logicalRetainedId]);
        const versions = records(state).filter(
          (entry): entry is Source =>
            entry.kind === "memory-source" && entry.sourceId === logicalId,
        );
        if (versions.some((entry) => entry.status === "retracted"))
          return yield* deny("Retracted source cannot be captured again");
        if (
          versions.length > 256 ||
          versions.some((entry) => entry.status === "conflicted") ||
          versions.filter((entry) => entry.status === "current").length > 1
        )
          return yield* deny("Memory source history is conflicted or exceeds budget");
        const old = versions.find((entry) => entry.status === "current");
        const contentHash = projectMemoryHash(content);
        if (
          old !== undefined &&
          old.contentHash === contentHash &&
          old.sourceRevision === current.record.revision
        ) {
          captured = old;
          return [];
        }
        if (old !== undefined && current.record.revision < old.sourceRevision)
          return yield* deny("Retained source revision moved backwards");
        const at = yield* now;
        captured = yield* validate(ProjectMemorySource, {
          kind: "memory-source",
          recordId: projectMemoryId("memory-source", [
            projectId,
            logicalId,
            current.record.revision,
            contentHash,
            old?.recordId,
          ]),
          projectId,
          revision: 0,
          generation: old === undefined ? 0 : old.generation + 1,
          updatedAt: at,
          status: "current",
          sourceKind: current.sourceKind,
          sourceId: logicalId,
          sourceRevision: current.record.revision,
          content,
          contentHash,
          attribution: current.record.attribution,
          ...(old === undefined ? {} : { supersedes: old.recordId }),
          sharedWithProjectIds: old?.sharedWithProjectIds ?? [],
        });
        const extraction = yield* validate(ProjectMemoryExtraction, {
          kind: "memory-extraction",
          recordId: projectMemoryId("memory-extraction", [captured.recordId, captured.generation]),
          projectId,
          revision: 0,
          generation: captured.generation,
          updatedAt: at,
          status: "pending",
          engine: "mem0",
          engineVersion: "2.2.1",
          sourceId: captured.recordId,
          sourceRevision: captured.sourceRevision,
          sourceGeneration: captured.generation,
          extractionModel: PROJECT_MEMORY_MODELS.extraction,
          embeddingModel: PROJECT_MEMORY_MODELS.embedding,
          embeddingDimensions: 2048,
          expectedObservationIds: [],
          completedObservationIds: [],
        });
        const changed: Array<ProjectTeamRecord> =
          old === undefined
            ? []
            : [
                { ...old, status: "superseded", revision: old.revision + 1, updatedAt: at },
                intent(old, "memory-delete", at),
              ];
        changed.push(
          captured,
          extraction,
          intent(captured, "memory-index", at, extraction, current.taskId),
        );
        return yield* commit(state, changed, at);
      }),
      Effect.gen(function* () {
        // Final validation runs after auxiliary and command writes in the same SQL
        // transaction, including duplicate captures that prepare no commands.
        yield* requireProject(projectId);
        const state = yield* readCurrentState(sql, projectId);
        const current = retained(state, selector);
        if (
          current === undefined ||
          captured === undefined ||
          current.record.attribution === undefined ||
          current.record.revision !== captured.sourceRevision ||
          projectMemoryHash(
            canonicalProjectWorkPayload({ kind: selector.kind, record: current.record }),
          ) !== captured.contentHash ||
          (selector.kind !== "decision" &&
            (current.taskId === undefined ||
              !state.tasks.some((task) => task.taskId === current.taskId)))
        )
          return yield* deny("Retained source changed before capture committed");
        if (principal !== undefined) {
          const authority = yield* authorization.resolve(principal);
          if (
            authority === undefined ||
            authority.binding.projectId !== projectId ||
            authority.role.memoryAccess === "none" ||
            (current.taskId !== undefined && current.taskId !== authority.binding.taskId)
          )
            return yield* deny("Current managed memory scope does not include this source");
        }
        yield* authorizeCapture(projectId);
      }),
    );
    if (captured === undefined) return yield* deny("Source capture did not commit");
    return captured;
  });
  const capture = Effect.fn("ProjectMemoryService.capture")(function* (
    principal: ProjectTeamPrincipal,
    selector: unknown,
  ) {
    const authority = yield* authorization.resolve(principal);
    if (authority === undefined)
      return yield* deny("Memory capture requires an authenticated managed binding");
    return yield* captureRetained(authority.binding.projectId, selector, principal);
  });
  /** Root's authorized human/lifecycle action, independent of active run authority. */
  const retract = Effect.fn("ProjectMemoryService.retract")(function* (
    projectId: string,
    sourceId: string,
  ) {
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        const state = yield* readCurrentState(sql, projectId);
        const source = sourceFor(state, sourceId);
        if (source === undefined) return yield* deny("Memory source is missing");
        const versions = records(state).filter(
          (record): record is Source =>
            record.kind === "memory-source" && record.sourceId === source.sourceId,
        );
        if (versions.length > 256)
          return yield* deny("Memory source history exceeds retraction budget");
        const at = yield* now;
        const changed: Array<ProjectTeamRecord> = [];
        for (const version of versions) {
          if (version.status === "retracted") continue;
          const decoded = decodeCachedContent(version.content);
          const redacted = yield* contentGuard.redact(
            Option.getOrElse(decoded, () => version.content),
          );
          const content =
            redacted.redactions.length === 0
              ? version.content
              : Option.isSome(decoded)
                ? canonicalProjectWorkPayload(redacted.value)
                : yield* validate(Schema.String, redacted.value);
          const tombstone: Source = {
            ...version,
            content,
            contentHash:
              content === version.content ? version.contentHash : projectMemoryHash(content),
            status: "retracted",
            revision: version.revision + 1,
            generation: version.generation + 1,
            updatedAt: at,
            tombstonedAt: at,
            sharedWithProjectIds: [],
          };
          changed.push(tombstone, intent(tombstone, "memory-delete", at));
        }
        return yield* commit(state, changed, at);
      }),
    );
  });
  /** Root's authorized explicit sharing action; never a model-authored grant. */
  const replaceShares = Effect.fn("ProjectMemoryService.replaceShares")(function* (
    projectId: string,
    sourceId: string,
    rawShares: unknown,
  ) {
    const shares = yield* validate(
      Schema.Array(Schema.toType(ProjectId)).check(Schema.isMaxLength(32)),
      rawShares,
    );
    if (new Set(shares).size !== shares.length || shares.includes(ProjectId.make(projectId)))
      return yield* deny("Invalid explicit memory shares");
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        yield* requireProject(projectId);
        const state = yield* readCurrentState(sql, projectId);
        const source = sourceFor(state, sourceId);
        if (source === undefined || source.status !== "current")
          return yield* deny("Sharing requires a current memory source");
        if (
          canonicalProjectWorkPayload(source.sharedWithProjectIds) ===
          canonicalProjectWorkPayload(shares)
        )
          return [];
        for (const target of shares) yield* requireProject(target);
        const at = yield* now;
        const next: Source = {
          ...source,
          recordId: projectMemoryId("memory-share-source", [source.recordId, shares]),
          revision: 0,
          generation: source.generation + 1,
          updatedAt: at,
          supersedes: source.recordId,
          sharedWithProjectIds: shares,
        };
        const extraction = yield* validate(ProjectMemoryExtraction, {
          kind: "memory-extraction",
          recordId: projectMemoryId("memory-extraction", [next.recordId, next.generation]),
          projectId,
          revision: 0,
          generation: next.generation,
          updatedAt: at,
          status: "pending",
          engine: "mem0",
          engineVersion: "2.2.1",
          sourceId: next.recordId,
          sourceRevision: next.sourceRevision,
          sourceGeneration: next.generation,
          extractionModel: PROJECT_MEMORY_MODELS.extraction,
          embeddingModel: PROJECT_MEMORY_MODELS.embedding,
          embeddingDimensions: 2048,
          expectedObservationIds: [],
          completedObservationIds: [],
        });
        const origin = retained(state, yield* selectorForSource(source));
        const older = records(state).filter(
          (record): record is Source =>
            record.kind === "memory-source" &&
            record.sourceId === source.sourceId &&
            record.status !== "retracted",
        );
        if (older.length > 256) return yield* deny("Memory source history exceeds sharing budget");
        const changed: Array<ProjectTeamRecord> = [];
        for (const version of older) {
          changed.push({
            ...version,
            status: "superseded",
            revision: version.revision + 1,
            updatedAt: at,
            sharedWithProjectIds: [],
          });
          if (version.status === "current") changed.push(intent(version, "memory-delete", at));
        }
        changed.push(
          next,
          extraction,
          intent(next, "memory-index", at, extraction, origin?.taskId),
        );
        return yield* commit(state, changed, at);
      }),
    );
  });
  const readWork = Effect.fn("ProjectMemoryService.readWork")(function* (
    projectId: string,
    effectId: string,
  ) {
    const state = yield* readCurrentState(sql, projectId);
    const effect = records(state).find(
      (entry): entry is ProjectMemoryEffect =>
        entry.kind === "effect" && entry.effectId === effectId,
    );
    if (
      effect === undefined ||
      (effect.effectKind !== "memory-index" && effect.effectKind !== "memory-delete")
    )
      return yield* deny("Memory effect is missing");
    const source = sourceFor(state, effect.targetId);
    if (source === undefined) return yield* deny("Memory effect source is missing");
    const extraction = extractionFor(state, effect.payload.recordIds[1] ?? "");
    const observations =
      extraction === undefined
        ? []
        : records(state).filter(
            (entry): entry is Observation =>
              entry.kind === "memory-observation" && entry.extractionId === extraction.recordId,
          );
    yield* validate(ProjectTeamEffect, effect);
    yield* validate(ProjectMemorySource, source);
    if (extraction !== undefined) yield* validate(ProjectMemoryExtraction, extraction);
    if (
      observations.length > 32 ||
      (extraction !== undefined &&
        (observations.length !== extraction.expectedObservationIds.length ||
          new Set(observations.map((observation) => observation.recordId)).size !==
            observations.length ||
          extraction.expectedObservationIds.some(
            (id) => !observations.some((observation) => observation.recordId === id),
          )))
    )
      return yield* deny("Retained extraction observation set is corrupt or incomplete");
    for (const observation of observations) yield* validate(ProjectMemoryObservation, observation);
    return { state, effect, source, extraction, observations };
  });
  const currentIndex = Effect.fn("ProjectMemoryService.currentIndex")(function* (
    projectId: string,
    effectId: string,
    ownerGeneration: number,
    reflectedOutcome?: ProjectMemoryVerifiedOutcome,
  ) {
    yield* requireProject(projectId);
    const work = yield* readWork(projectId, effectId);
    const selector = yield* selectorForSource(work.source);
    const current = retained(work.state, selector);
    if (
      current === undefined ||
      current.record.revision !== work.source.sourceRevision ||
      projectMemoryHash(
        canonicalProjectWorkPayload({ kind: selector.kind, record: current.record }),
      ) !== work.source.contentHash
    )
      return yield* deny("Retained memory source has changed");
    if (
      (work.effect.status !== "claimed" &&
        !(
          reflectedOutcome !== undefined &&
          work.effect.status === "succeeded" &&
          work.effect.outcome === canonicalProjectWorkPayload(reflectedOutcome) &&
          reflectedOutcome.effectId === effectId &&
          reflectedOutcome.claimGeneration === ownerGeneration &&
          reflectedOutcome.sourceId === work.source.recordId &&
          reflectedOutcome.sourceRevision === work.source.sourceRevision &&
          reflectedOutcome.sourceGeneration === work.source.generation &&
          ((reflectedOutcome.kind === "no-facts" &&
            work.extraction?.status === "no-facts" &&
            reflectedOutcome.observationIds.length === 0) ||
            (reflectedOutcome.kind === "index-complete" &&
              work.extraction?.status === "indexed" &&
              canonicalProjectWorkPayload([...work.extraction.completedObservationIds].sort()) ===
                canonicalProjectWorkPayload([...reflectedOutcome.observationIds].sort())))
        )) ||
      work.effect.claimGeneration !== ownerGeneration ||
      work.source.status !== "current" ||
      work.extraction === undefined ||
      work.extraction.sourceGeneration !== work.source.generation ||
      work.extraction.sourceRevision !== work.source.sourceRevision ||
      work.effect.generation !== work.source.generation
    )
      return yield* deny("Memory work owner or source is stale");
    yield* contentGuard.assertSafe(current.record);
    yield* contentGuard.assertSafe(work.source);
    yield* contentGuard.assertSafe(work.observations);
    return work;
  });
  const claim = Effect.fn("ProjectMemoryService.claim")(function* (
    projectId: string,
    effectId: string,
  ) {
    let owner: number | undefined;
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        const work = yield* readWork(projectId, effectId);
        if (work.effect.status !== "pending") return [];
        if (work.effect.effectKind === "memory-index") yield* requireProject(projectId);
        const rows = yield* sql<{ input: string; status: string; generation: number }>`
          SELECT input_json AS input, status, claim_generation AS generation FROM project_team_memory_job
          WHERE effect_id=${effectId} AND environment_id=${dependencies.environmentId} AND project_id=${projectId}
          AND length(CAST(input_json AS BLOB))<=262144`;
        if (rows.length !== 1 || rows[0]!.status !== "pending" || rows[0]!.generation !== 0)
          return yield* deny("Memory claim requires its original pending physical job");
        const input = yield* validate(Schema.fromJsonString(ProjectMemoryJobInput), rows[0]!.input);
        if (
          canonicalProjectWorkPayload(input.effect) !== canonicalProjectWorkPayload(work.effect) ||
          input.source.recordId !== work.source.recordId ||
          input.source.generation !== work.source.generation ||
          input.source.sourceRevision !== work.source.sourceRevision
        )
          return yield* deny("Memory claim source/effect tuple changed");
        owner = work.effect.claimGeneration + 1;
        yield* sql`UPDATE project_team_memory_job SET status='claimed',claim_generation=${owner}
          WHERE effect_id=${effectId} AND claim_generation=0 AND status='pending' AND receipt_json IS NULL`;
        const at = yield* now;
        return yield* commit(
          work.state,
          [
            {
              ...work.effect,
              status: "claimed",
              revision: work.effect.revision + 1,
              claimGeneration: owner,
              updatedAt: at,
            },
          ],
          at,
        );
      }),
    );
    return owner;
  });
  const extract = Effect.fn("ProjectMemoryService.extract")(function* (
    projectId: string,
    effectId: string,
    ownerGeneration: number,
  ) {
    const work = yield* currentIndex(projectId, effectId, ownerGeneration);
    if (work.extraction!.status !== "pending") return;
    if (dependencies.models === undefined) return yield* deny("Memory model ports are disabled");
    yield* contentGuard.assertSafe(work.source);
    const facts = yield* validate(
      ProjectMemoryExtractedFacts,
      yield* dependencies.models.extract({
        requestId: projectMemoryId("memory-extract", [work.extraction!.recordId]),
        source: work.source,
        ...(work.effect.taskId === undefined ? {} : { taskId: work.effect.taskId }),
      }),
    );
    yield* contentGuard.assertSafe(facts);
    const body = yield* validate(Schema.fromJsonString(RetainedSourceBody), work.source.content);
    const sourceTexts =
      body.kind === "evidence"
        ? [body.record.summary, ...(body.record.detail === undefined ? [] : [body.record.detail])]
        : body.kind === "decision"
          ? [body.record.title, body.record.body]
          : [body.record.body];
    if (facts.some((fact) => !sourceTexts.some((text) => text.includes(fact.quote))))
      return yield* deny("Extraction quote is not in the retained source");
    const observationIds = facts.map((fact) =>
      projectMemoryId("memory-observation", [work.extraction!.recordId, fact.key]),
    );
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        const fresh = yield* currentIndex(projectId, effectId, ownerGeneration);
        yield* contentGuard.assertSafe(fresh.source);
        yield* contentGuard.assertSafe(facts);
        if (fresh.extraction!.status !== "pending")
          return yield* deny("Extraction has already been retained");
        const at = yield* now;
        const extraction: Extraction = {
          ...fresh.extraction!,
          revision: fresh.extraction!.revision + 1,
          updatedAt: at,
          status: facts.length === 0 ? "no-facts" : "extracted",
          expectedObservationIds: observationIds,
          extractionHash: projectMemoryHash(facts),
        };
        const changed: Array<ProjectTeamRecord> = [extraction];
        for (const [index, fact] of facts.entries())
          changed.push(
            yield* validate(ProjectMemoryObservation, {
              kind: "memory-observation",
              recordId: observationIds[index],
              projectId,
              revision: 0,
              generation: fresh.source.generation,
              updatedAt: at,
              status: "current",
              sourceId: fresh.source.recordId,
              sourceRevision: fresh.source.sourceRevision,
              sourceGeneration: fresh.source.generation,
              extractionId: extraction.recordId,
              observationKey: fact.key,
              body: fact.body,
              provenance: fresh.source.attribution,
            }),
          );
        return yield* commit(fresh.state, changed, at);
      }),
    );
  });
  const prepareManifest = Effect.fn("ProjectMemoryService.prepareManifest")(function* (
    projectId: string,
    effectId: string,
    ownerGeneration: number,
    recovering = false,
  ) {
    const work = yield* currentIndex(projectId, effectId, ownerGeneration);
    const extraction = work.extraction!;
    if (extraction.status === "no-facts") return undefined;
    if (extraction.status !== "extracted")
      return yield* deny("Extraction is not ready for indexing");
    const ordered = extraction.expectedObservationIds.map((id) =>
      work.observations.find((observation) => observation.recordId === id),
    );
    if (
      ordered.length === 0 ||
      ordered.length > 32 ||
      ordered.some(
        (observation) =>
          observation === undefined ||
          observation.status !== "current" ||
          observation.sourceRevision !== work.source.sourceRevision ||
          observation.sourceGeneration !== work.source.generation,
      )
    )
      return yield* deny("Retained extraction manifest is incomplete");
    const observations = ordered.filter(
      (observation): observation is Observation => observation !== undefined,
    );
    const stored = yield* manifests.load(extraction.recordId);
    if (stored !== undefined) {
      const manifest = yield* validate(MemoryIndexManifest, stored);
      if (
        manifest.environmentId !== dependencies.environmentId ||
        manifest.projectId !== projectId ||
        manifest.sourceRecordId !== work.source.recordId ||
        manifest.sourceGeneration !== work.source.generation ||
        manifest.sourceRevision !== work.source.sourceRevision ||
        manifest.extractionId !== extraction.recordId ||
        manifest.observations.length !== observations.length ||
        manifest.observations.some(
          (entry, index) =>
            entry.observationId !== observations[index]?.recordId ||
            entry.body !== observations[index]?.body ||
            entry.payloadHash !== projectMemoryHash(observations[index]),
        )
      )
        return yield* deny("Frozen memory vectors do not match retained observations");
      return manifest;
    }
    if (recovering)
      return yield* deny("Embedding outcome is uncertain; request reconciliation is required");
    if (dependencies.models === undefined) return yield* deny("Memory model ports are disabled");
    yield* contentGuard.assertSafe(observations);
    const vectors = yield* validate(
      Schema.Array(MemoryVector).check(Schema.isMaxLength(32)),
      yield* dependencies.models.embed({
        requestId: projectMemoryId("memory-embed", [extraction.recordId]),
        source: work.source,
        ...(work.effect.taskId === undefined ? {} : { taskId: work.effect.taskId }),
        bodies: observations.map((observation) => observation.body),
      }),
    );
    if (vectors.length !== observations.length)
      return yield* deny("Embedding returned an incomplete vector set");
    const manifest = yield* validate(MemoryIndexManifest, {
      environmentId: dependencies.environmentId,
      projectId,
      sourceRecordId: work.source.recordId,
      sourceRevision: work.source.sourceRevision,
      sourceGeneration: work.source.generation,
      extractionId: extraction.recordId,
      observations: observations.map((observation, index) => ({
        observationId: observation.recordId,
        body: observation.body,
        payloadHash: projectMemoryHash(observation),
        vector: vectors[index],
      })),
    });
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        yield* currentIndex(projectId, effectId, ownerGeneration);
        yield* contentGuard.assertSafe(observations);
        yield* manifests.save(manifest);
        return [];
      }),
    );
    return manifest;
  });
  return {
    modelsEnabled: dependencies.models !== undefined,
    capture,
    captureRetained,
    retract,
    replaceShares,
    readWork,
    currentIndex,
    claim,
    extract,
    prepareManifest,
    commit,
  };
};
export type ProjectMemoryService = ReturnType<typeof makeProjectMemoryService>;
