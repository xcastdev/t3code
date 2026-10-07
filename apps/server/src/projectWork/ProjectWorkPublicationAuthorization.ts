import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  CommandId,
  EnvironmentId,
  GitRunStackedActionInput,
  ProjectId,
  ProjectTeamEffect,
  ProjectTeamRecord,
  ProjectWorkCriterion,
  ProjectTeamIntegrationSource,
  ProjectTeamIntegrationSourceRef,
  ProjectWorkAttribution,
  ProjectWorkEvidence,
  ProjectWorkEvidenceId,
  ProjectWorkPublicationRequest,
  ProjectWorkWriteResult,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { projectWorkCommandFingerprint } from "./ProjectWorkPolicy.ts";
import {
  makeProjectTeamReviewedWorkReader,
  ProjectTeamReviewedWorkError,
} from "./ProjectTeamReviewedWorkReader.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceEvidence,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectWorkVerificationResultReader } from "./ProjectWorkVerificationExecutionJournal.ts";
import { readIssueRepositoryState } from "./ProjectIssueRepositoryState.ts";
import { PublicationError, type PreparedPublication } from "./ProjectWorkPullRequests.ts";
import type { ProjectWorkHumanPublicationRequest } from "./ProjectWorkHumanPublicationRequest.ts";

const strict = { onExcessProperty: "error" } as const;
const Text = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.makeFilter((v) => !v.includes("\0")),
);
const Oid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
export const HostCapturedPublicationTarget = Schema.Struct({
  cwd: Text,
  localBranch: Text,
  testedTree: Oid,
  indexTree: Oid,
  headSha: Oid,
  remoteUrl: Text,
  remoteName: Text,
});
export type HostCapturedPublicationTarget = typeof HostCapturedPublicationTarget.Type;
const Options = Schema.Struct({ environmentId: EnvironmentId });
const LocalInput = Schema.Struct({
  input: GitRunStackedActionInput,
  target: HostCapturedPublicationTarget,
});
const Detail = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("project-work.human-publication"),
  environmentId: EnvironmentId,
  operationId: Text,
  inputSha256: Digest,
  requestSha256: Digest,
  sourceRef: ProjectTeamIntegrationSourceRef,
  source: ProjectTeamIntegrationSource,
  local: HostCapturedPublicationTarget,
  human: ProjectWorkAttribution,
});
const EventBase = { eventId: Text, projectId: ProjectId, revision: Safe, occurredAt: Text };
const EvidenceEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("project-work.evidence.added"),
  evidence: ProjectWorkEvidence,
  addedAt: Text,
});
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeLocal = Schema.decodeUnknownSync(LocalInput, strict);
const decodeRequest = Schema.decodeUnknownSync(ProjectWorkPublicationRequest, strict);
const decodeEvidence = Schema.decodeUnknownSync(ProjectWorkEvidence, strict);
const decodeRef = Schema.decodeUnknownSync(ProjectTeamIntegrationSourceRef, strict);
const decodeDetail = Schema.decodeUnknownEffect(Schema.fromJsonString(Detail), strict);
const decodeEffect = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectTeamEffect), strict);
const decodeEvidenceEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EvidenceEvent),
  strict,
);
const EnqueueEvent = Schema.Union([
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("project-work.foundation.recorded"),
    record: ProjectTeamRecord,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("project-work.criterion.upserted"),
    taskId: Text,
    criterion: ProjectWorkCriterion,
    updatedAt: Text,
  }),
]);
const decodeEnqueueEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(EnqueueEvent), strict);
const decodeWrite = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkWriteResult),
  strict,
);
const decodeAttribution = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkAttribution),
  strict,
);
const decodeStoredRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkPublicationRequest),
  strict,
);
const decodeIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Text).check(Schema.isMaxLength(512))),
  strict,
);
const decodeWorkspace = Schema.decodeUnknownEffect(ProjectTeamWorkspaceEvidence, strict);
const isPublicationError = Schema.is(PublicationError);
const isReviewedError = Schema.is(Schema.suspend(() => ProjectTeamReviewedWorkError));
const canonical = canonicalProjectWorkPayload;
const hash = (v: unknown) => NodeCrypto.createHash("sha256").update(canonical(v)).digest("hex");
const deny = () => new PublicationError({ reason: "authorization-denied" });
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isPublicationError(cause)
        ? cause
        : isReviewedError(cause) && cause.code !== "unavailable"
          ? deny()
          : new PublicationError({ reason: "persistence", cause }),
    ),
  );
function capture<A>(decode: (v: unknown) => A, input: unknown): A | undefined {
  try {
    const copy: unknown = structuredClone(input);
    const value = decode(copy);
    return canonical(copy) === canonical(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function remoteIdentity(value: string) {
  const scp = /^git@([a-z0-9.-]+):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(value);
  if (scp) return { host: scp[1]!, name: scp[2]! };
  try {
    const url = new URL(value);
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      (url.protocol === "https:" && url.username) ||
      (url.protocol === "ssh:" && url.username !== "git")
    )
      return undefined;
    const name = url.pathname.slice(1).replace(/\.git$/u, "");
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name)
      ? { host: url.hostname, name }
      : undefined;
  } catch {
    return undefined;
  }
}

export class ProjectWorkPublicationAuthorization extends Context.Service<
  ProjectWorkPublicationAuthorization,
  {
    readonly prepareInTransaction: (input: {
      readonly input: GitRunStackedActionInput;
      readonly target: HostCapturedPublicationTarget;
      readonly permission: ProjectWorkHumanPublicationRequest["Service"];
    }) => Effect.Effect<PreparedPublication, PublicationError>;
    readonly assertCurrent: (
      request: ProjectWorkPublicationRequest,
      phase: "enqueue" | "dispatch",
    ) => Effect.Effect<void, PublicationError>;
    readonly readCurrentReviewedInTransaction: (
      request: ProjectWorkPublicationRequest,
    ) => Effect.Effect<
      {
        readonly detail: typeof Detail.Type;
        readonly source: ProjectTeamIntegrationSource;
        readonly state: Effect.Success<ReturnType<typeof readCurrentState>>;
      },
      PublicationError
    >;
  }
>()("t3/projectWork/ProjectWorkPublicationAuthorization") {}

/** Human enqueue owns the transaction. Background dispatch audits that retained decision without a session baseline. */
export const makeProjectWorkPublicationAuthorization = (input: {
  readonly environmentId: string;
}) => {
  const options = capture(decodeOptions, input);
  return Effect.gen(function* () {
    if (!options) return yield* deny();
    const environmentId = options.environmentId;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const settings = yield* ServerSettingsService;
    const reviewed = yield* makeProjectTeamReviewedWorkReader({ environmentId });
    const results = yield* makeProjectWorkVerificationResultReader({ environmentId });
    const history = yield* makeProjectTeamDispatchJournal({
      environmentId,
      maximumEnvironmentModelCalls: 1,
    });
    const originalLoan = Effect.gen(function* () {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      const owner = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(client) ||
        client.value !== sql ||
        Option.isNone(owner) ||
        owner.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny();
    });
    const enabled = Effect.gen(function* () {
      if (!(yield* settings.getSettings).projectWorkEnabled) return yield* deny();
    });
    const activeProject = Effect.fn("PublicationAuthorization.activeProject")(function* (
      projectId: ProjectId,
    ) {
      const rows =
        yield* sql`SELECT p.project_id FROM projection_projects p LEFT JOIN project_lifecycle l ON l.project_id=p.project_id WHERE p.project_id=${projectId} AND p.deleted_at IS NULL AND (l.state IS NULL OR l.state='active') LIMIT 2`;
      if (rows.length !== 1) return yield* deny();
    });
    const repositoryFor = Effect.fn("PublicationAuthorization.repositoryFor")(function* (
      projectId: ProjectId,
      local: HostCapturedPublicationTarget,
    ) {
      const remote = remoteIdentity(local.remoteUrl);
      if (!remote) return yield* deny();
      const bindings =
        yield* sql`SELECT host,repository_node_id,account_node_id FROM project_issue_binding WHERE project_id=${projectId} AND status='active' LIMIT 2`;
      const binding = bindings[0];
      if (
        bindings.length !== 1 ||
        !binding ||
        binding.host !== remote.host ||
        typeof binding.repository_node_id !== "string"
      )
        return yield* deny();
      const sizes =
        yield* sql`SELECT length(CAST(payload_json AS BLOB)) AS size FROM project_issue_repository WHERE host=${remote.host} AND repository_node_id=${binding.repository_node_id} LIMIT 2`;
      if (sizes.length !== 1 || typeof sizes[0]?.size !== "number" || sizes[0].size > 65536)
        return yield* deny();
      const state = yield* readIssueRepositoryState(sql, {
        host: remote.host,
        repositoryNodeId: binding.repository_node_id,
      });
      if (
        !state ||
        state.status !== "ready" ||
        state.repositoryName !== remote.name ||
        state.accountNodeId !== binding.account_node_id
      )
        return yield* deny();
      return {
        host: state.host,
        nodeId: state.repositoryNodeId,
        nameWithOwner: state.repositoryName,
      };
    });
    const currentFacts = Effect.fn("PublicationAuthorization.currentFacts")(function* (
      projectId: ProjectId,
      ref: ProjectTeamIntegrationSourceRef,
      local: HostCapturedPublicationTarget,
    ) {
      yield* enabled;
      yield* activeProject(projectId);
      const qualified = yield* reviewed.readCurrentInTransaction({ projectId, ref });
      const source = qualified.source;
      if (
        local.headSha !== source.headSha ||
        local.testedTree !== source.testedTree ||
        local.indexTree !== source.testedTree ||
        source.branchRef !== `refs/heads/${local.localBranch}`
      )
        return yield* deny();
      const original = yield* history.readHistoricalInTransaction(source.dispatchId);
      const git = original.snapshot.intent.request.git;
      if (
        git.worktreePath !== local.cwd ||
        git.branchRef !== source.branchRef ||
        git.baseOid !== source.baseSha
      )
        return yield* deny();
      const verification = yield* results.readInTransaction({
        jobId: source.jobId,
        expectedManifestHash: source.manifestHash,
      });
      if (verification._tag !== "Terminal" || verification.result.outcome !== "success")
        return yield* deny();
      const job = verification.snapshot.intent.receipt.manifest;
      if (job.integration === true) {
        const intent = original.snapshot.intent.integration;
        const ready = original.receipts.filter((r) => r.stage === "workspace-ready");
        if (!intent || ready.length !== 1 || !ready[0]) return yield* deny();
        const workspace = yield* decodeWorkspace(ready[0].evidence);
        if (
          !workspace.integration ||
          !job.integrationCoverage ||
          hash(intent.selection) !== job.integrationCoverage.selectionSha256 ||
          hash(workspace.integration) !== job.integrationCoverage.combinationSha256 ||
          workspace.integration.selectionSha256 !== job.integrationCoverage.selectionSha256
        )
          return yield* deny();
      }
      let baseRef: string | undefined;
      if (git.baseRef.startsWith("refs/heads/")) baseRef = git.baseRef.slice("refs/heads/".length);
      else if (git.baseRef.startsWith(`refs/remotes/${local.remoteName}/`))
        baseRef = git.baseRef.slice(`refs/remotes/${local.remoteName}/`.length);
      if (!baseRef || baseRef === local.localBranch) return yield* deny();
      return { ...qualified, baseRef, repository: yield* repositoryFor(projectId, local) };
    });
    const audit = Effect.fn("PublicationAuthorization.auditPermission")(function* (
      request: ProjectWorkPublicationRequest,
    ) {
      const state = yield* readCurrentState(sql, request.target.projectId);
      const id = ProjectWorkEvidenceId.make(
        `publication-permission:${hash({ environmentId, operationId: request.operationId })}`,
      );
      const evidence = state.evidence.filter((e) => e.evidenceId === id);
      const proof = evidence[0];
      if (
        evidence.length !== 1 ||
        !proof ||
        !proof.detail ||
        Buffer.byteLength(proof.detail) > 32000 ||
        proof.kind !== "observation" ||
        proof.taskId !== request.target.taskId ||
        !proof.attribution ||
        proof.attribution.actor.kind !== "human" ||
        proof.attribution.source.kind !== "web" ||
        canonical(request.authorizationRecordIds) !== canonical([id])
      )
        return yield* deny();
      const detail = yield* decodeDetail(proof.detail);
      if (
        canonical(detail) !== proof.detail ||
        detail.environmentId !== environmentId ||
        detail.operationId !== request.operationId ||
        detail.requestSha256 !== hash(request) ||
        canonical(detail.human) !== canonical(proof.attribution) ||
        proof.scopeHash !== detail.source.scopeHash
      )
        return yield* deny();
      const commandId = CommandId.make(`publication-permission:${request.operationId}`);
      const commands =
        yield* sql`SELECT actor_kind,actor_id,source_kind,source_id,payload_fingerprint,created_at,CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result_json,CASE WHEN length(CAST(event_ids_json AS BLOB))<=1048576 THEN event_ids_json END AS event_ids_json FROM project_work_command_receipts WHERE project_id=${request.target.projectId} AND command_id=${commandId} LIMIT 2`;
      const command = commands[0];
      const rows =
        yield* sql`SELECT event_id,event_type,command_id,CASE WHEN length(CAST(payload_json AS BLOB))<=524288 THEN payload_json END AS payload_json FROM project_work_events WHERE project_id=${request.target.projectId} AND command_id=${commandId} ORDER BY sequence LIMIT 2`;
      if (
        commands.length !== 1 ||
        !command ||
        rows.length !== 1 ||
        typeof rows[0]?.payload_json !== "string" ||
        typeof command.result_json !== "string" ||
        typeof command.event_ids_json !== "string"
      )
        return yield* deny();
      const event = yield* decodeEvidenceEvent(rows[0].payload_json);
      const result = yield* decodeWrite(command.result_json);
      const ids = yield* decodeIds(command.event_ids_json);
      const original: ProjectWorkCommand = {
        type: "project-work.evidence.add",
        commandId,
        projectId: request.target.projectId,
        expectedRevision: event.revision - 1,
        attribution: proof.attribution,
        evidence: proof,
        addedAt: proof.recordedAt,
      };
      if (
        command.actor_kind !== proof.attribution.actor.kind ||
        command.actor_id !== proof.attribution.actor.id ||
        command.source_kind !== proof.attribution.source.kind ||
        command.source_id !== proof.attribution.source.id ||
        command.payload_fingerprint !== projectWorkCommandFingerprint(original) ||
        command.created_at !== proof.recordedAt ||
        canonical(event.evidence) !== canonical(proof) ||
        event.projectId !== request.target.projectId ||
        event.addedAt !== proof.recordedAt ||
        event.occurredAt !== proof.recordedAt ||
        event.eventId !== `${commandId}:project-work:0` ||
        rows[0].event_id !== event.eventId ||
        rows[0].event_type !== event.type ||
        canonical(ids) !== canonical([event.eventId]) ||
        result.projectId !== request.target.projectId ||
        result.revision !== event.revision ||
        result.receipt.commandId !== commandId ||
        result.receipt.status !== "accepted" ||
        result.receipt.projectId !== request.target.projectId ||
        result.receipt.revision !== event.revision ||
        result.receipt.eventCount !== 1 ||
        result.delta.projectId !== request.target.projectId ||
        result.delta.revision !== event.revision ||
        canonical(result.delta.eventIds) !== canonical(ids) ||
        canonical(result.delta.changedFields) !== canonical(["evidence", "criteria", "tasks"])
      )
        return yield* deny();
      const physical =
        yield* sql`SELECT * FROM project_work_evidence WHERE project_id=${request.target.projectId} AND evidence_id=${id} LIMIT 2`;
      if (
        physical.length !== 1 ||
        physical[0]?.detail !== proof.detail ||
        physical[0]?.summary !== proof.summary ||
        physical[0]?.revision !== proof.revision ||
        physical[0]?.task_id !== proof.taskId ||
        physical[0]?.kind !== proof.kind ||
        physical[0]?.recorded_at !== proof.recordedAt ||
        physical[0]?.scope_hash !== proof.scopeHash ||
        physical[0]?.criterion_id !== null ||
        physical[0]?.uri !== null ||
        typeof physical[0]?.attribution_json !== "string" ||
        physical[0]?.output_artifact_ids_json !==
          (proof.outputArtifactIds === undefined ? null : canonical(proof.outputArtifactIds))
      )
        return yield* deny();
      if (
        canonical(yield* decodeAttribution(physical[0].attribution_json)) !==
        canonical(proof.attribution)
      )
        return yield* deny();
      const effects =
        yield* sql`SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=131072 THEN payload_json END AS payload_json FROM project_team_effect WHERE project_id=${request.target.projectId} AND record_id=${request.operationId} LIMIT 2`;
      if (effects.length !== 1 || typeof effects[0]?.payload_json !== "string")
        return yield* deny();
      const effect = yield* decodeEffect(effects[0].payload_json);
      if (
        effect.effectKind !== "publication" ||
        effect.payload.summary !== canonical(request) ||
        effect.taskId !== request.target.taskId ||
        effect.payload.expectedRevision !== request.expectedTaskRevision ||
        canonical(effect.payload.recordIds) !== canonical(request.authorizationRecordIds)
      )
        return yield* deny();
      const enqueueId = `publication-enqueue:${request.operationId}`;
      const enqueued =
        yield* sql`SELECT event_id,event_type,CASE WHEN length(CAST(payload_json AS BLOB))<=524288 THEN payload_json END AS payload_json FROM project_work_events WHERE project_id=${request.target.projectId} AND command_id=${enqueueId} ORDER BY sequence LIMIT 513`;
      if (enqueued.length < 1 || enqueued.length > 512) return yield* deny();
      const events = yield* Effect.forEach(
        enqueued,
        Effect.fn("PublicationAuthorization.decodeEnqueueEvent")(function* (row) {
          if (typeof row.payload_json !== "string") return yield* deny();
          return yield* decodeEnqueueEvent(row.payload_json);
        }),
      );
      const enqueue = events[0];
      if (
        !enqueue ||
        enqueue.type !== "project-work.foundation.recorded" ||
        enqueue.record.kind !== "effect"
      )
        return yield* deny();
      const receipts =
        yield* sql`SELECT actor_kind,actor_id,source_kind,source_id,payload_fingerprint,created_at,CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result_json,CASE WHEN length(CAST(event_ids_json AS BLOB))<=1048576 THEN event_ids_json END AS event_ids_json FROM project_work_command_receipts WHERE project_id=${request.target.projectId} AND command_id=${enqueueId} LIMIT 2`;
      const receipt = receipts[0];
      const recordedAt = enqueue.record.updatedAt;
      const enqueueCommand: ProjectWorkCommand = {
        type: "project-work.foundation.commit",
        commandId: CommandId.make(enqueueId),
        projectId: request.target.projectId,
        expectedRevision: enqueue.revision - 1,
        attribution: {
          actor: { kind: "system", id: "project-work-github-outbox" },
          source: { kind: "system", id: "project-work-github-outbox" },
          recordedAt,
        },
        committedAt: recordedAt,
        records: [enqueue.record],
      };
      if (
        enqueue.projectId !== request.target.projectId ||
        enqueue.record.status !== "pending" ||
        enqueue.record.recordId !== request.operationId ||
        enqueue.record.payload.summary !== canonical(request) ||
        enqueue.revision !== event.revision + 1 ||
        receipts.length !== 1 ||
        !receipt ||
        receipt.actor_kind !== "system" ||
        receipt.actor_id !== "project-work-github-outbox" ||
        receipt.source_kind !== "system" ||
        receipt.source_id !== "project-work-github-outbox" ||
        receipt.payload_fingerprint !== projectWorkCommandFingerprint(enqueueCommand) ||
        typeof receipt.result_json !== "string" ||
        typeof receipt.event_ids_json !== "string" ||
        receipt.created_at !== recordedAt
      )
        return yield* deny();
      for (const [index, entry] of events.entries()) {
        if (
          entry.projectId !== request.target.projectId ||
          entry.revision !== enqueue.revision + index ||
          entry.occurredAt !== recordedAt ||
          entry.eventId !== `${enqueueId}:project-work:${index}` ||
          enqueued[index]?.event_id !== entry.eventId ||
          enqueued[index]?.event_type !== entry.type
        )
          return yield* deny();
        if (index === 0) continue;
        if (entry.type === "project-work.criterion.upserted") {
          if (
            entry.taskId !== entry.criterion.taskId ||
            entry.updatedAt !== recordedAt ||
            entry.taskId === request.target.taskId
          )
            return yield* deny();
        } else {
          const record = entry.record;
          const negative =
            (record.kind === "gate" &&
              record.gate !== "specification" &&
              record.status === "invalidated") ||
            (record.kind === "evidence-applicability" && record.status === "stale") ||
            (record.kind === "run-binding" && record.status === "stopping") ||
            (record.kind === "effect" &&
              ((record.effectKind === "stop" && record.status === "pending") ||
                (["dispatch", "setup"].includes(record.effectKind) &&
                  record.status === "canceled")));
          if (
            !negative ||
            record.updatedAt !== recordedAt ||
            !("taskId" in record) ||
            record.taskId === request.target.taskId
          )
            return yield* deny();
        }
      }
      const write = yield* decodeWrite(receipt.result_json);
      const enqueueIds = yield* decodeIds(receipt.event_ids_json);
      const revision = enqueue.revision + events.length - 1;
      const changed = events.some((entry) => entry.type === "project-work.criterion.upserted")
        ? ["foundationRecords", "criteria", "tasks"]
        : ["foundationRecords"];
      if (
        write.projectId !== request.target.projectId ||
        write.receipt.status !== "accepted" ||
        write.receipt.commandId !== enqueueId ||
        write.receipt.projectId !== request.target.projectId ||
        write.receipt.eventCount !== events.length ||
        write.receipt.revision !== revision ||
        write.revision !== revision ||
        write.delta.projectId !== request.target.projectId ||
        write.delta.revision !== revision ||
        canonical(enqueueIds) !== canonical(events.map((entry) => entry.eventId)) ||
        canonical(write.delta.eventIds) !== canonical(enqueueIds.slice(0, 64)) ||
        canonical(write.delta.changedFields) !== canonical(changed)
      )
        return yield* deny();
      return { evidence: proof, detail, state };
    });
    const readReviewed = Effect.fn("PublicationAuthorization.readReviewed")(function* (
      request: ProjectWorkPublicationRequest,
    ) {
      const { detail, state } = yield* audit(request);
      const facts = yield* currentFacts(request.target.projectId, detail.sourceRef, detail.local);
      if (
        canonical(facts.source) !== canonical(detail.source) ||
        canonical(facts.repository) !== canonical(request.repository) ||
        facts.baseRef !== request.target.baseRef ||
        request.target.headRef !== detail.local.localBranch ||
        request.target.headSelector !== detail.local.localBranch ||
        request.target.headRepositoryNodeId !== facts.repository.nodeId ||
        request.target.scopeHash !== facts.source.scopeHash ||
        request.target.specRevision !== facts.source.specRevision ||
        request.target.planRevision !== facts.source.planRevision ||
        request.target.baseSha !== facts.source.baseSha ||
        request.target.headSha !== facts.source.headSha
      )
        return yield* deny();
      return { detail, source: facts.source, state };
    });
    const assertInside = Effect.fn("PublicationAuthorization.assertInside")(function* (
      request: ProjectWorkPublicationRequest,
    ) {
      const { state } = yield* readReviewed(request);
      if (
        state.tasks.filter(
          (t) => t.taskId === request.target.taskId && t.revision === request.expectedTaskRevision,
        ).length !== 1
      )
        return yield* deny();
    });
    const prepare = Effect.fn("PublicationAuthorization.prepare")(function* (
      localInput: typeof LocalInput.Type | undefined,
      permission: ProjectWorkHumanPublicationRequest["Service"],
    ) {
      if (!localInput || localInput.input.action !== "create_pr") return yield* deny();
      yield* originalLoan;
      const { input, target } = localInput;
      const owned =
        yield* sql`SELECT project_id,task_id,binding_id FROM project_team_dispatch WHERE environment_id=${environmentId} AND worktree=${target.cwd} AND branch=${`refs/heads/${target.localBranch}`} LIMIT 2`;
      const assignment = owned[0];
      if (
        owned.length !== 1 ||
        !assignment ||
        typeof assignment.project_id !== "string" ||
        typeof assignment.task_id !== "string"
      )
        return yield* deny();
      const projectId = ProjectId.make(assignment.project_id);
      const human = yield* permission.assertCurrent(projectId, input);
      if (human.actor.kind !== "human" || human.source.kind !== "web") return yield* deny();
      const operationId = `human-publication:${hash({ environmentId, actor: human.actor, actionId: input.actionId })}`;
      const existing =
        yield* sql`SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=131072 THEN payload_json END AS payload_json FROM project_team_effect WHERE record_id=${operationId} LIMIT 2`;
      if (existing.length > 0) {
        if (existing.length !== 1 || typeof existing[0]?.payload_json !== "string")
          return yield* deny();
        const effect = yield* decodeEffect(existing[0].payload_json);
        const request = capture(decodeRequest, yield* decodeStoredRequest(effect.payload.summary));
        if (!request || request.target.projectId !== projectId) return yield* deny();
        const original = yield* audit(request);
        if (
          original.detail.inputSha256 !== hash(input) ||
          canonical(original.detail.local) !== canonical(target) ||
          canonical(original.detail.human.actor) !== canonical(human.actor)
        )
          return yield* deny();
        yield* assertInside(request);
        return { request, authorizationEvidence: original.evidence };
      }
      const state = yield* readCurrentState(sql, projectId);
      const bindings =
        state.foundationRecords?.filter(
          (r) => r.kind === "run-binding" && r.recordId === assignment.binding_id,
        ) ?? [];
      const binding = bindings[0];
      if (bindings.length !== 1 || binding?.kind !== "run-binding") return yield* deny();
      const candidates =
        yield* sql`SELECT dispatch_id,sha256,review_task_id,json_extract(manifest_json,'$.prepared.jobId') AS job_id,json_extract(manifest_json,'$.prepared.sha256') AS manifest_hash FROM project_team_review_completion_proposal WHERE environment_id=${environmentId} AND project_id=${projectId} AND parent_task_id=${assignment.task_id} AND json_extract(manifest_json,'$.target.headSha')=${target.headSha} ORDER BY dispatch_id LIMIT 65`;
      if (candidates.length > 64) return yield* deny();
      const refs: ProjectTeamIntegrationSourceRef[] = [];
      for (const row of candidates) {
        if (
          !state.tasks.some(
            (task) => task.taskId === row.review_task_id && task.state === "completed",
          )
        )
          continue;
        if (
          typeof row.dispatch_id !== "string" ||
          typeof row.sha256 !== "string" ||
          typeof row.job_id !== "string" ||
          typeof row.manifest_hash !== "string"
        )
          return yield* deny();
        const verification = yield* results.readInTransaction({
          jobId: row.job_id,
          expectedManifestHash: row.manifest_hash,
        });
        if (verification._tag !== "Terminal" || verification.result.outcome !== "success") continue;
        const job = verification.snapshot.intent.receipt.manifest;
        const ref = capture(decodeRef, {
          taskId: assignment.task_id,
          bindingId: binding.recordId,
          expectedBindingRevision: binding.revision,
          generation: binding.generation,
          reviewDispatchId: row.dispatch_id,
          expectedReviewProposalSha256: row.sha256,
          verificationJobId: job.jobId,
          expectedManifestHash: row.manifest_hash,
          expectedBranchRef: job.target.branchRef,
          expectedBaseSha: job.target.baseSha,
          expectedHeadSha: job.target.headSha,
          expectedTestedTree: job.target.testedTree,
        });
        if (!ref) return yield* deny();
        const candidate = yield* reviewed
          .readCurrentInTransaction({ projectId, ref })
          .pipe(Effect.result);
        if (candidate._tag === "Success") refs.push(ref);
        else if (candidate.failure.code === "unavailable" || candidate.failure.code === "invalid")
          return yield* candidate.failure;
      }
      if (refs.length !== 1 || !refs[0]) return yield* deny();
      const facts = yield* currentFacts(projectId, refs[0], target);
      const task = state.tasks.filter((t) => t.taskId === facts.source.taskId);
      if (task.length !== 1 || !task[0]) return yield* deny();
      if (
        input.cwd !== target.cwd ||
        !input.precondition ||
        input.precondition.expectedHeadCommit !== target.headSha ||
        input.precondition.expectedIndexTree !== target.indexTree ||
        (input.precondition.expectedRefName !== undefined &&
          input.precondition.expectedRefName !== `refs/heads/${target.localBranch}` &&
          input.precondition.expectedRefName !== target.localBranch) ||
        (input.precondition.expectedMergeHeads?.length ?? 0) !== 0
      )
        return yield* deny();
      if (input.threadId !== undefined) {
        const threads =
          yield* sql`SELECT project_id FROM projection_threads WHERE thread_id=${input.threadId} AND deleted_at IS NULL LIMIT 2`;
        if (threads.length !== 1 || threads[0]?.project_id !== projectId) return yield* deny();
      }
      const evidenceId = ProjectWorkEvidenceId.make(
        `publication-permission:${hash({ environmentId, operationId })}`,
      );
      const request = capture(decodeRequest, {
        version: 1,
        kind: "create-pr",
        operationId,
        marker: `t3_${hash({ environmentId, operationId })}`,
        repository: facts.repository,
        target: {
          projectId,
          taskId: facts.source.taskId,
          specRevision: facts.source.specRevision,
          planRevision: facts.source.planRevision,
          scopeHash: facts.source.scopeHash,
          baseSha: facts.source.baseSha,
          headSha: facts.source.headSha,
          baseRef: facts.baseRef,
          headRef: target.localBranch,
          headRepositoryNodeId: facts.repository.nodeId,
          headSelector: target.localBranch,
        },
        expectedTaskRevision: task[0].revision,
        authorizationRecordIds: [evidenceId],
        threadId: binding.threadId,
        title: facts.taskTitle,
        body: `Reviewed project work: ${facts.taskTitle}\n\nCommit: ${facts.source.headSha}\nVerification: ${facts.source.jobId}\nAccepted review: ${facts.source.reviewDispatchId}`,
      });
      if (!request) return yield* deny();
      const detail = canonical({
        version: 1,
        kind: "project-work.human-publication",
        environmentId,
        operationId,
        inputSha256: hash(input),
        requestSha256: hash(request),
        sourceRef: refs[0],
        source: facts.source,
        local: target,
        human,
      });
      if (Buffer.byteLength(detail) > 32000) return yield* deny();
      const authorizationEvidence = capture(decodeEvidence, {
        evidenceId,
        taskId: facts.source.taskId,
        kind: "observation",
        summary: "Human requested publication of reviewed work",
        detail,
        scopeHash: facts.source.scopeHash,
        recordedAt: human.recordedAt,
        revision: 0,
        attribution: human,
      });
      if (!authorizationEvidence) return yield* deny();
      return { request, authorizationEvidence };
    });
    return ProjectWorkPublicationAuthorization.of({
      readCurrentReviewedInTransaction(input) {
        const request = capture(decodeRequest, input);
        return boundary(
          Effect.gen(function* () {
            if (!request) return yield* deny();
            yield* originalLoan;
            return yield* readReviewed(request).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
          }),
        );
      },
      prepareInTransaction(input) {
        const captured = capture(decodeLocal, { input: input.input, target: input.target });
        return boundary(
          Effect.gen(function* () {
            yield* originalLoan;
            return yield* prepare(captured, input.permission).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.provideService(ProjectWorkRepository, repository),
            );
          }),
        );
      },
      assertCurrent(input, _phase) {
        const request = capture(decodeRequest, input);
        return boundary(
          Effect.gen(function* () {
            if (!request) return yield* deny();
            const suppliedSql = yield* Effect.serviceOption(SqlClient.SqlClient);
            const suppliedRepository = yield* Effect.serviceOption(ProjectWorkRepository);
            if (
              (Option.isSome(suppliedSql) && suppliedSql.value !== sql) ||
              (Option.isSome(suppliedRepository) && suppliedRepository.value !== repository)
            )
              return yield* deny();
            const action = assertInside(request).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.provideService(ProjectWorkRepository, repository),
            );
            if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) yield* action;
            else yield* sql.withTransaction(action);
          }),
        );
      },
    });
  });
};
