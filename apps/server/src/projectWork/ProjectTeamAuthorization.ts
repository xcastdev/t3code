import {
  CommandId,
  ProjectId,
  canonicalProjectWorkPayload,
  ProjectTeamCredential,
  ProjectTeamRecord,
  ProjectTeamGuidedIntent,
  ProjectTeamIntegrationSources,
  ProjectWorkKnowledgeId,
  ProjectWorkAttribution,
  ProjectWorkWriteResult,
  IsoDateTime,
  EventId,
  ProjectWorkTaskId,
  ProjectWorkTask,
  type ProjectWorkActor,
  type ProjectWorkCommand,
  type ProjectWorkReadIntent,
  type ProjectTeamWriteIntent,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Option from "effect/Option";
import { ProjectWorkVerificationApproval } from "./ProjectWorkVerificationGate.ts";
import { deliveryDependencyIds } from "./ProjectTeamDeliveryAcceptanceState.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeProjectTeamIntegrationSources } from "./ProjectTeamIntegrationSources.ts";
import { ProjectWorkVerificationRequest } from "./ProjectWorkVerificationRequest.ts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
  type ProjectWorkReducerState,
  type ProjectWorkEvent,
} from "./ProjectWorkDecider.ts";
import { projectWorkCommandFingerprint } from "./ProjectWorkPolicy.ts";
import { readCurrentState, ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { makeProjectTeamReviewFindings } from "./ProjectTeamReviewFindings.ts";
import { makeProjectTeamReviewCompletionProposals } from "./ProjectTeamReviewCompletionProposals.ts";
import { decodeProjectWorkEvent } from "./ProjectWorkEventStore.ts";
import { assertProjectTeamGuidedReplayCurrent } from "./ProjectTeamGuidedLifecycle.ts";
import {
  compileProjectTeamConfiguration,
  assertProjectTeamConfigurationReplay,
} from "./ProjectTeamConfiguration.ts";
import {
  assertProjectTeamRunAuthority,
  assertProjectTeamAssignmentAuthorization,
  assertProjectTeamSemanticWork,
  projectTeamSpecificationHash,
  projectTeamPlanHash,
  projectTeamDerivedRecordId,
} from "./ProjectTeamPolicy.ts";

export class ProjectTeamAuthorizationError extends Schema.TaggedError<ProjectTeamAuthorizationError>()(
  "ProjectTeamAuthorizationError",
  { reason: Schema.String },
) {}
export interface ProjectTeamPrincipal {
  readonly actor: ProjectWorkActor;
  readonly managed?: ProjectTeamCredential;
}
type Binding = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
type Role = Extract<ProjectTeamRecord, { kind: "role-revision" }>;
export interface ProjectTeamAuthority {
  readonly credential: ProjectTeamCredential;
  readonly binding: Binding;
  readonly role: Role;
  readonly state: ProjectWorkReducerState;
}
const isAuthorizationError = Schema.is(ProjectTeamAuthorizationError);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const decodeAttribution = Schema.decodeUnknownSync(ProjectWorkAttribution);
const decodeWriteResult = Schema.decodeUnknownSync(Schema.fromJsonString(ProjectWorkWriteResult));
const decodeEventIds = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(EventId)));
const decodeMessageTask = Schema.decodeUnknownSync(ProjectWorkTask);
const decodeGuidedIntent = Schema.decodeUnknownSync(ProjectTeamGuidedIntent, {
  onExcessProperty: "error",
});
export const managedActorId = (
  credential: Pick<ProjectTeamCredential, "providerInstanceId" | "threadId">,
) => `agent:mcp:${credential.providerInstanceId}:${credential.threadId}`;
const deny = (reason: string) => new ProjectTeamAuthorizationError({ reason });
type QuestionRequest = Extract<ProjectTeamWriteIntent, { type: "project-team.question.request" }>;
type MessageRequest = Extract<ProjectTeamWriteIntent, { type: "project-team.message.send" }>;
type Membership = Extract<ProjectTeamRecord, { kind: "task-membership" }>;
export interface ProjectTeamMessageRecipient {
  readonly memberId: string;
  readonly taskId: ProjectWorkTaskId;
  readonly taskTitle: string;
  readonly expectedRecipientMembershipRevision: number;
  readonly relation: "same-task" | "approved-tree" | "active-mission";
}
export interface ProjectTeamMessageRecipients {
  readonly recipients: readonly ProjectTeamMessageRecipient[];
  readonly omitted: number;
  readonly degraded: boolean;
}
const decodeMessageFoundationEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      eventId: EventId,
      projectId: ProjectId,
      revision: Schema.Int.check(
        Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ),
      occurredAt: IsoDateTime,
      type: Schema.Literal("project-work.foundation.recorded"),
      record: ProjectTeamRecord,
    }),
  ),
  { onExcessProperty: "error" },
);
const messageWriteGranted = (binding: Binding, role: Role) =>
  role.tools.includes("project-work.write") &&
  binding.configuration.toolIds.includes("project-work.write");

const compileQuestionRequest = (
  state: ProjectWorkReducerState,
  input: QuestionRequest,
  attribution: ProjectWorkAttribution,
  credential: ProjectTeamCredential,
): ProjectWorkCommand => {
  const records = state.foundationRecords ?? [];
  const binding = records.find(
    (r) => r.kind === "run-binding" && r.recordId === credential.bindingId,
  );
  const role =
    binding?.kind === "run-binding"
      ? records.find((r) => r.kind === "role-revision" && r.recordId === binding.roleRevisionId)
      : undefined;
  const task = state.tasks.find((r) => r.taskId === input.taskId);
  const gates = records.filter((r) => r.kind === "gate" && r.recordId === input.targetGateId);
  const gate = gates[0];
  if (
    attribution.actor.kind !== "agent" ||
    attribution.actor.id !== managedActorId(credential) ||
    credential.projectId !== input.projectId ||
    binding?.kind !== "run-binding" ||
    binding.projectId !== input.projectId ||
    binding.taskId !== input.taskId ||
    binding.generation !== credential.generation ||
    binding.providerInstanceId !== credential.providerInstanceId ||
    binding.threadId !== credential.threadId ||
    role?.kind !== "role-revision" ||
    !role.tools.includes("project-work.write") ||
    !binding.configuration.toolIds.includes("project-work.write")
  )
    throw deny("Human question requires its original managed write authority");
  assertProjectTeamRunAuthority(state, binding, role, false);
  if (
    state.revision !== input.expectedRevision ||
    task === undefined ||
    task.revision !== input.expectedTaskRevision ||
    task.specRevision !== input.specRevision ||
    binding.specRevision !== input.specRevision ||
    binding.planRevision !== input.planRevision ||
    gates.length !== 1 ||
    gate?.kind !== "gate" ||
    gate.taskId !== input.taskId ||
    gate.revision !== input.expectedGateRevision ||
    gate.specRevision !== input.specRevision ||
    gate.planRevision !== input.planRevision ||
    !["proposed", "pending", "approved", "consumed"].includes(gate.status)
  )
    throw deny("Human question task, plan or gate target changed");
  if (records.some((r) => r.recordId === input.questionId))
    throw deny("Human question identity is already retained");
  if (input.body.trim().length === 0) throw deny("Human question body is empty");
  return {
    type: "project-work.foundation.commit",
    projectId: input.projectId,
    commandId: input.commandId,
    expectedRevision: input.expectedRevision,
    attribution,
    committedAt: attribution.recordedAt,
    records: [
      decodeRecord({
        kind: "question",
        recordId: input.questionId,
        projectId: input.projectId,
        revision: 0,
        generation: binding.generation,
        updatedAt: attribution.recordedAt,
        status: "pending",
        taskId: input.taskId,
        senderId: binding.memberId,
        targetGateId: gate.recordId,
        targetRevision: gate.revision,
        body: input.body,
        choices: [...input.choices],
      }),
    ],
  };
};

export class ProjectTeamAuthorization extends Context.Service<
  ProjectTeamAuthorization,
  {
    readonly issueCredential: (identity: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly bindingId?: string;
    }) => Effect.Effect<ProjectTeamAuthority | undefined, ProjectTeamAuthorizationError>;
    readonly discover: (identity: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<ProjectTeamCredential | undefined, ProjectTeamAuthorizationError>;
    readonly hasManagedThread: (
      threadId: ThreadId,
    ) => Effect.Effect<boolean, ProjectTeamAuthorizationError>;
    readonly resolve: (
      principal: ProjectTeamPrincipal,
    ) => Effect.Effect<ProjectTeamAuthority | undefined, ProjectTeamAuthorizationError>;
    readonly capability: (
      principal: ProjectTeamPrincipal,
      capability: string,
      projectId?: string,
    ) => Effect.Effect<void, ProjectTeamAuthorizationError>;
    readonly read: (
      principal: ProjectTeamPrincipal,
      input: ProjectWorkReadIntent,
    ) => Effect.Effect<void, ProjectTeamAuthorizationError>;
    readonly write: (
      principal: ProjectTeamPrincipal,
      command: ProjectWorkCommand,
    ) => Effect.Effect<void, ProjectTeamAuthorizationError>;
    readonly intent: (
      principal: ProjectTeamPrincipal,
      input: ProjectTeamWriteIntent,
      attribution: ProjectWorkAttribution,
      duplicate: boolean,
    ) => Effect.Effect<ProjectWorkCommand, ProjectTeamAuthorizationError>;
    readonly readMessageRecipientsInTransaction: (
      principal: ProjectTeamPrincipal,
    ) => Effect.Effect<ProjectTeamMessageRecipients, ProjectTeamAuthorizationError>;
    readonly guided: (
      principal: ProjectTeamPrincipal,
      input: ProjectTeamGuidedIntent,
      attribution: ProjectWorkAttribution,
      duplicate: boolean,
      mode?: "validate" | "compile",
    ) => Effect.Effect<ProjectWorkCommand, ProjectTeamAuthorizationError>;
  }
>()("t3/projectWork/ProjectTeamAuthorization") {}

export const layer = Layer.effect(
  ProjectTeamAuthorization,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const environmentIdentity = yield* Effect.serviceOption(
      ServerEnvironment.ServerEnvironmentIdentity,
    );
    const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
    const sourceService = Effect.fn("ProjectTeamAuthorization.sourceService")(function* () {
      const currentSql = yield* Effect.serviceOption(SqlClient.SqlClient);
      const transaction = yield* Effect.serviceOption(sql.transactionService);
      const repository = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(currentSql) ||
        currentSql.value !== sql ||
        Option.isNone(transaction) ||
        Option.isNone(repository)
      )
        return yield* deny("Integration source qualification requires its original transaction");
      const environmentId = Option.isSome(environmentIdentity)
        ? yield* environmentIdentity.value.getEnvironmentId.pipe(
            Effect.mapError(() => deny("Environment identity unavailable")),
          )
        : Option.isSome(serverEnvironment)
          ? yield* serverEnvironment.value.getEnvironmentId.pipe(
              Effect.mapError(() => deny("Environment identity unavailable")),
            )
          : undefined;
      if (environmentId === undefined) return yield* deny("Environment identity unavailable");
      return yield* makeProjectTeamIntegrationSources({ environmentId }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ProjectWorkRepository, repository.value),
        Effect.mapError(() => deny("Integration source reader unavailable")),
      );
    });
    const assertDeliveredDependencies = Effect.fn(
      "ProjectTeamAuthorization.assertDeliveredDependencies",
    )(function* (state: ProjectWorkReducerState, taskId: string) {
      const dependencies = yield* Effect.try({
        try: () => deliveryDependencyIds(state, taskId),
        catch: () => deny("Dependency lineage is invalid"),
      });
      if (dependencies.length === 0) return;
      const owner = yield* Effect.serviceOption(ProjectWorkRepository);
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isNone(owner) || (Option.isSome(client) && client.value !== sql))
        return yield* deny("Delivery history requires its original SQL and repository");
      const environmentId = Option.isSome(environmentIdentity)
        ? yield* environmentIdentity.value.getEnvironmentId.pipe(
            Effect.mapError(() => deny("Environment identity unavailable")),
          )
        : Option.isSome(serverEnvironment)
          ? yield* serverEnvironment.value.getEnvironmentId.pipe(
              Effect.mapError(() => deny("Environment identity unavailable")),
            )
          : undefined;
      if (environmentId === undefined || Option.isNone(settings))
        return yield* deny("Delivery qualification services unavailable");
      const { makeProjectTeamDeliveryAcceptance } = yield* Effect.promise(
        () => import("./ProjectTeamDeliveryAcceptance.ts"),
      );
      const service = yield* makeProjectTeamDeliveryAcceptance({ environmentId }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ProjectWorkRepository, owner.value),
        Effect.provideService(ServerSettingsService, settings.value),
        Effect.mapError(() => deny("Delivery reader unavailable")),
      );
      yield* service
        .assertTaskDependencies({
          projectId: ProjectId.make(state.projectId),
          taskId: ProjectWorkTaskId.make(taskId),
        })
        .pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, owner.value),
          Effect.mapError(() => deny("Delivered dependency history is no longer qualified")),
        );
    });
    const assertSelectedSources = Effect.fn("ProjectTeamAuthorization.assertSelectedSources")(
      function* (state: ProjectWorkReducerState, taskId: string) {
        const plan = (state.foundationRecords ?? [])
          .filter(
            (record): record is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
              record.kind === "plan-revision" &&
              record.taskId === taskId &&
              record.status === "proposed",
          )
          .sort((left, right) => right.planRevision - left.planRevision)[0];
        if (plan?.integrationSources === undefined) return;
        const service = yield* sourceService();
        yield* service
          .assertCurrentInTransaction({
            projectId: ProjectId.make(state.projectId),
            integrationTaskId: plan.taskId,
            sources: plan.integrationSources,
          })
          .pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(() => deny("Approved integration sources changed")),
          );
      },
    );
    const managedIdentities = new Set<string>();
    const managedThreads = new Set<string>();
    const stateFor = Effect.fn("ProjectTeamAuthorization.stateFor")(function* (projectId: string) {
      return yield* readCurrentState(sql, projectId);
    });
    const discover = Effect.fn("ProjectTeamAuthorization.discover")(
      function* (
        identity: {
          readonly providerInstanceId: ProviderInstanceId;
          readonly threadId: ThreadId;
          readonly bindingId?: string;
        },
        withdrawLegacy = false,
      ) {
        const rows = yield* sql<{
          projectId: string;
        }>`SELECT DISTINCT project_id AS projectId FROM project_team_run_binding WHERE provider_instance_id=${identity.providerInstanceId} AND thread_id=${identity.threadId}`;
        if (rows.length === 0) {
          const fences = yield* sql`SELECT thread_id FROM project_team_identity_fences
            WHERE provider_instance_id=${identity.providerInstanceId} AND thread_id=${identity.threadId}`;
          if (fences.length > 0) return yield* deny("Managed identity has no current binding");
          return undefined;
        }
        managedIdentities.add(managedActorId(identity));
        managedThreads.add(identity.threadId);
        if (withdrawLegacy) {
          // The observed binding owns this identity even if later validation or cancellation refuses issuance.
          const revokedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          yield* sql`UPDATE auth_sessions SET revoked_at=${revokedAt}
            WHERE subject=${managedActorId(identity)} AND revoked_at IS NULL`;
        }
        const bindings: Binding[] = [];
        for (const row of rows) {
          const state = yield* stateFor(row.projectId);
          for (const record of state.foundationRecords ?? [])
            if (
              record.kind === "run-binding" &&
              record.providerInstanceId === identity.providerInstanceId &&
              record.threadId === identity.threadId
            )
              bindings.push(decodeRecord(record) as Binding);
        }
        const active = bindings.filter(
          (binding) =>
            (binding.status === "running" || binding.status === "reserved") &&
            (identity.bindingId === undefined || binding.recordId === identity.bindingId),
        );
        if (active.length !== 1)
          return yield* deny("Managed session has no unique running binding");
        const binding = active[0]!;
        return {
          projectId: binding.projectId,
          bindingId: binding.recordId,
          generation: binding.generation,
          providerInstanceId: binding.providerInstanceId,
          threadId: binding.threadId,
        } satisfies ProjectTeamCredential;
      },
      Effect.mapError(() => deny("Cannot resolve managed session history")),
    );
    const hasManagedThread = Effect.fn("ProjectTeamAuthorization.hasManagedThread")(
      function* (threadId: ThreadId) {
        if (managedThreads.has(threadId)) return true;
        const rows =
          yield* sql`SELECT thread_id FROM project_team_identity_fences WHERE thread_id=${threadId}
            UNION ALL SELECT thread_id FROM project_team_run_binding WHERE thread_id=${threadId} LIMIT 1`;
        if (rows.length === 0) return false;
        // Retained proxy/catalog leases must stay fenced after history is purged.
        managedThreads.add(threadId);
        return true;
      },
      Effect.mapError(() => deny("Managed history unavailable")),
    );
    const resolve = Effect.fn("ProjectTeamAuthorization.resolve")(
      function* (principal: ProjectTeamPrincipal, issuing = false) {
        let credential = principal.managed;
        if (
          credential === undefined &&
          principal.actor.kind === "agent" &&
          principal.actor.id !== undefined
        ) {
          const rows = yield* sql<{
            provider: string;
            thread: string;
          }>`SELECT DISTINCT provider_instance_id AS provider, thread_id AS thread FROM project_team_run_binding WHERE ('agent:mcp:' || provider_instance_id || ':' || thread_id)=${principal.actor.id}
            UNION SELECT provider_instance_id AS provider,thread_id AS thread FROM project_team_identity_fences WHERE ('agent:mcp:' || provider_instance_id || ':' || thread_id)=${principal.actor.id}`;
          if (rows.length > 1) return yield* deny("Managed identity is ambiguous");
          if (rows.length > 0) {
            managedIdentities.add(principal.actor.id);
            for (const row of rows) managedThreads.add(row.thread);
            return yield* deny("Managed principal requires an issued binding marker");
          }
        }
        if (
          credential === undefined &&
          principal.actor.kind === "agent" &&
          principal.actor.id !== undefined &&
          managedIdentities.has(principal.actor.id)
        )
          return yield* deny(
            "Managed identity requires an issued marker after reissue or deletion",
          );
        if (credential === undefined) return undefined;
        if (principal.actor.kind !== "agent" || principal.actor.id !== managedActorId(credential))
          return yield* deny("Credential actor does not match managed identity");
        const retained =
          yield* sql`SELECT record_id FROM project_team_run_binding WHERE record_id=${credential.bindingId} AND project_id=${credential.projectId} AND generation=${credential.generation} AND provider_instance_id=${credential.providerInstanceId} AND thread_id=${credential.threadId}`;
        if (retained.length !== 1) return yield* deny("Managed binding missing or changed");
        managedIdentities.add(managedActorId(credential));
        managedThreads.add(credential.threadId);
        const state = yield* stateFor(credential.projectId);
        const binding = state.foundationRecords?.find(
          (r) => r.kind === "run-binding" && r.recordId === credential.bindingId,
        );
        if (
          binding?.kind !== "run-binding" ||
          (binding.status !== "running" && !(issuing && binding.status === "reserved")) ||
          binding.generation !== credential.generation ||
          binding.leaseGeneration !== credential.generation ||
          binding.providerInstanceId !== credential.providerInstanceId ||
          binding.threadId !== credential.threadId
        )
          return yield* deny("Managed binding revoked, replaced or missing");
        if (binding.status === "running" && binding.sessionId === undefined)
          return yield* deny("Running binding has no native session identity");
        const member = state.foundationRecords?.find(
          (r) => r.kind === "member" && r.recordId === binding.memberId,
        );
        const role = state.foundationRecords?.find(
          (r) => r.kind === "role-revision" && r.recordId === binding.roleRevisionId,
        );
        if (
          member?.kind !== "member" ||
          member.status !== "active" ||
          role?.kind !== "role-revision" ||
          role.status !== "available"
        )
          return yield* deny("Managed member or frozen role is inactive");
        const task = state.tasks.find((t) => t.taskId === binding.taskId);
        const attempt = state.attempts.find(
          (a) => a.attemptId === binding.attemptId && a.taskId === binding.taskId,
        );
        const now = yield* Clock.currentTimeMillis;
        if (
          task?.activeAttemptId !== binding.attemptId ||
          task.specRevision !== binding.specRevision ||
          (attempt?.state !== "leased" && attempt?.state !== "running") ||
          attempt.leasedUntil === undefined ||
          Date.parse(attempt.leasedUntil) <= now ||
          attempt.leaseToken === undefined
        )
          return yield* deny("Managed task ownership expired or changed");
        const projects =
          yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${credential.projectId} AND deleted_at IS NULL`;
        if (projects.length !== 1) return yield* deny("Managed project unavailable");
        yield* Effect.try({
          try: () => assertProjectTeamRunAuthority(state, binding, role, issuing),
          catch: () => deny("Managed assignment or approval changed"),
        });
        yield* assertDeliveredDependencies(state, binding.taskId);
        const lifecycleTable =
          yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='project_lifecycle'`;
        if (lifecycleTable.length) {
          const inactive =
            yield* sql`SELECT project_id FROM project_lifecycle WHERE project_id=${credential.projectId} AND state != 'active'`;
          if (inactive.length) return yield* deny("Managed project inactive");
        }
        return {
          credential,
          binding: decodeRecord(binding) as Binding,
          role: decodeRecord(role) as Role,
          state,
        };
      },
      Effect.mapError((error) =>
        isAuthorizationError(error) ? error : deny("Managed authority unavailable"),
      ),
    );
    const messageLoan = Effect.fn("ProjectTeamAuthorization.messageLoan")(function* () {
      const current = yield* Effect.serviceOption(SqlClient.SqlClient);
      const transaction = yield* Effect.serviceOption(sql.transactionService);
      const repository = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(current) ||
        current.value !== sql ||
        Option.isNone(transaction) ||
        Option.isNone(repository)
      )
        return yield* deny("Team messages require their original transaction");
    });
    // Each selection owns one state snapshot and bounded memoized original facts, never a cross-call cache.
    const messageSelection = (
      state: ProjectWorkReducerState,
      sender: Binding,
      now: number,
      beforeSequence?: number,
    ) => {
      const records = state.foundationRecords ?? [];
      const births = new Map<string, { record: ProjectTeamRecord; commandId: string }>();
      const receipts = new Map<
        string,
        {
          actorKind: string | null;
          actorId: string | null;
          sourceKind: string | null;
          sourceId: string | null;
          createdAt: string;
          fingerprint: string;
          result: ProjectWorkWriteResult;
          eventIds: readonly EventId[];
          records: ReadonlyMap<string, ProjectTeamRecord>;
          events: readonly ProjectWorkEvent[];
        }
      >();
      let reads = 0;
      let bytes = 0;
      const unique = (id: string) => {
        const matches = records.filter((r) => r.recordId === id);
        if (matches.length !== 1 || matches[0]?.projectId !== state.projectId)
          throw deny("Message fact is missing or ambiguous");
        return decodeRecord(matches[0]);
      };
      const audit = Effect.fn("messageSelection.audit")(function* (
        record: ProjectTeamRecord,
        first = false,
      ) {
        const key = `${first ? "first" : "current"}:${record.recordId}`;
        const cached = births.get(key);
        if (cached) return cached;
        if (++reads > 1024) return yield* deny("Message provenance work exceeds its bound");
        const rows = yield* sql<{
          payload: string | null;
          eventId: string;
          commandId: string;
          occurredAt: string;
          sequence: number;
        }>`
          SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload,
          event_id AS eventId,command_id AS commandId,occurred_at AS occurredAt,sequence
          FROM project_work_events WHERE project_id=${state.projectId} AND event_type='project-work.foundation.recorded'
          AND json_extract(payload_json,'$.record.recordId')=${record.recordId}
          ${beforeSequence === undefined ? sql`` : sql`AND sequence<${beforeSequence}`}
          ORDER BY sequence ${first ? sql`ASC` : sql`DESC`} LIMIT 1`;
        const row = rows[0];
        if (rows.length !== 1 || !row || row.payload === null)
          return yield* deny("Message provenance is unavailable");
        bytes += Buffer.byteLength(row.payload, "utf8");
        if (bytes > 4194304) return yield* deny("Message provenance exceeds its byte bound");
        const event = yield* Effect.try({
          try: () => decodeMessageFoundationEvent(row.payload),
          catch: () => deny("Message retained event is invalid"),
        });
        if (
          event.projectId !== state.projectId ||
          event.eventId !== row.eventId ||
          event.occurredAt !== row.occurredAt ||
          event.record.recordId !== record.recordId ||
          (!first &&
            canonicalProjectWorkPayload(event.record) !== canonicalProjectWorkPayload(record))
        )
          return yield* deny("Message retained fact changed");
        let receipt = receipts.get(row.commandId);
        if (!receipt) {
          const saved = yield* sql<{
            actorKind: string | null;
            actorId: string | null;
            sourceKind: string | null;
            sourceId: string | null;
            createdAt: string;
            fingerprint: string;
            result: string | null;
            eventIds: string | null;
          }>`
            SELECT actor_kind AS actorKind,actor_id AS actorId,source_kind AS sourceKind,source_id AS sourceId,created_at AS createdAt,
            payload_fingerprint AS fingerprint,
            CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result,
            CASE WHEN length(CAST(event_ids_json AS BLOB))<=1048576 THEN event_ids_json END AS eventIds
            FROM project_work_command_receipts WHERE project_id=${state.projectId} AND command_id=${row.commandId} LIMIT 2`;
          const item = saved[0];
          if (
            saved.length !== 1 ||
            !item ||
            item.result === null ||
            item.eventIds === null ||
            !/^(?:project-team-intent:[a-f0-9]{64}|[a-f0-9]{8})$/u.test(item.fingerprint)
          )
            return yield* deny("Message original command receipt is unavailable");
          bytes +=
            Buffer.byteLength(item.result, "utf8") + Buffer.byteLength(item.eventIds, "utf8");
          if (bytes > 4194304) return yield* deny("Message receipt bytes exceed their bound");
          const decoded = yield* Effect.try({
            try: () => ({
              result: decodeWriteResult(item.result),
              eventIds: decodeEventIds(item.eventIds),
            }),
            catch: () => deny("Message original receipt is invalid"),
          });
          if (
            decoded.eventIds.length > 512 ||
            new Set(decoded.eventIds).size !== decoded.eventIds.length ||
            decoded.result.projectId !== state.projectId ||
            decoded.result.receipt.projectId !== state.projectId ||
            decoded.result.receipt.commandId !== row.commandId ||
            decoded.result.receipt.status !== "accepted" ||
            decoded.result.receipt.eventCount !== decoded.eventIds.length ||
            decoded.result.receipt.revision !== decoded.result.revision ||
            decoded.result.delta.projectId !== state.projectId ||
            decoded.result.delta.revision !== decoded.result.revision ||
            canonicalProjectWorkPayload(decoded.result.delta.eventIds) !==
              canonicalProjectWorkPayload(decoded.eventIds.slice(0, 64))
          )
            return yield* deny("Message original command result changed");
          const commandRows = yield* sql<{
            payload: string | null;
            eventId: string;
            eventType: string;
            occurredAt: string;
          }>`
            SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload,
            event_id AS eventId,event_type AS eventType,occurred_at AS occurredAt
            FROM project_work_events WHERE project_id=${state.projectId} AND command_id=${row.commandId}
            ORDER BY sequence LIMIT 513`;
          if (commandRows.length === 0 || commandRows.length !== decoded.eventIds.length)
            return yield* deny("Message original command events are incomplete");
          const originalRecords = new Map<string, ProjectTeamRecord>();
          const originalEvents: ProjectWorkEvent[] = [];
          for (const [index, originalRow] of commandRows.entries()) {
            if (originalRow.payload === null)
              return yield* deny("Message original event exceeds its bound");
            bytes += Buffer.byteLength(originalRow.payload, "utf8");
            if (bytes > 4194304)
              return yield* deny("Message original events exceed their byte bound");
            const original = yield* Effect.try({
              try: () =>
                originalRow.eventType === "project-work.foundation.recorded"
                  ? decodeMessageFoundationEvent(originalRow.payload)
                  : decodeProjectWorkEvent(decodeUnknownJson(originalRow.payload)),
              catch: () => deny("Message original event is invalid"),
            });
            if (
              original.eventId !== originalRow.eventId ||
              original.projectId !== state.projectId ||
              original.type !== originalRow.eventType ||
              original.occurredAt !== originalRow.occurredAt ||
              original.eventId !== decoded.eventIds[index] ||
              original.revision !== decoded.result.revision - commandRows.length + index + 1
            )
              return yield* deny("Message original event metadata changed");
            if (original.type === "project-work.foundation.recorded")
              originalRecords.set(original.eventId, original.record);
            originalEvents.push(original);
          }
          if (
            commandRows.at(-1)?.occurredAt !== item.createdAt ||
            !decoded.result.delta.changedFields.includes("foundationRecords")
          )
            return yield* deny("Message original receipt disagrees with its events");
          receipt = { ...item, ...decoded, records: originalRecords, events: originalEvents };
          receipts.set(row.commandId, receipt);
        }
        const index = receipt.eventIds.indexOf(event.eventId);
        const retained = receipt.records.get(event.eventId);
        if (
          index < 0 ||
          receipt.result.revision - event.revision !== receipt.eventIds.length - index - 1 ||
          retained === undefined ||
          canonicalProjectWorkPayload(retained) !== canonicalProjectWorkPayload(event.record)
        )
          return yield* deny("Message fact is not in its accepted command result");
        if (
          event.record.kind === "gate" &&
          (first || event.record.status === "approved") &&
          (event.record.attribution.actor.kind !== receipt.actorKind ||
            (event.record.attribution.actor.id ?? null) !== receipt.actorId ||
            event.record.attribution.source.kind !== receipt.sourceKind ||
            (event.record.attribution.source.id ?? null) !== receipt.sourceId)
        )
          return yield* deny("Message grant attribution changed");
        if (!first && beforeSequence === undefined) {
          const physical = yield* sql<{
            payload: string | null;
          }>`SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload
            FROM ${sql(`project_team_${record.kind.replaceAll("-", "_")}`)} WHERE record_id=${record.recordId} AND project_id=${state.projectId} LIMIT 2`;
          if (
            physical.length !== 1 ||
            physical[0]?.payload === null ||
            canonicalProjectWorkPayload(decodeRecord(decodeUnknownJson(physical[0]?.payload))) !==
              canonicalProjectWorkPayload(record)
          )
            return yield* deny("Message physical record changed");
        }
        const value = { record: event.record, commandId: row.commandId };
        births.set(key, value);
        return value;
      });
      const membership = (taskId: string): Membership => {
        const matches = records.filter((r) => r.kind === "task-membership" && r.taskId === taskId);
        const record = matches[0];
        if (
          matches.length !== 1 ||
          record?.kind !== "task-membership" ||
          record.projectId !== state.projectId ||
          record.status !== "active" ||
          (record.controlState !== undefined && record.controlState !== "active")
        )
          throw deny("Message task membership is not active");
        return record;
      };
      const endpoint = Effect.fn("messageSelection.endpoint")(
        function* (binding: Binding) {
          const role = unique(binding.roleRevisionId);
          const member = unique(binding.memberId);
          const m = membership(binding.taskId);
          const task = state.tasks.find((t) => t.taskId === binding.taskId);
          const attempt = state.attempts.find(
            (a) => a.attemptId === binding.attemptId && a.taskId === binding.taskId,
          );
          if (
            role.kind !== "role-revision" ||
            member.kind !== "member" ||
            member.status !== "active" ||
            binding.status !== "running" ||
            binding.sessionId === undefined ||
            task?.state !== "in-progress" ||
            task.activeAttemptId !== binding.attemptId ||
            (attempt?.state !== "leased" && attempt?.state !== "running") ||
            attempt.leasedUntil === undefined ||
            Date.parse(attempt.leasedUntil) <= now
          )
            return yield* deny("Message recipient ownership is not current");
          yield* Effect.try({
            try: () => assertProjectTeamRunAuthority(state, binding, role, false),
            catch: () => deny("Message recipient grant or scope changed"),
          });
          if (binding.authorizationGateId === undefined)
            return yield* deny("Message endpoint has no original grant");
          for (const record of [
            binding,
            role,
            member,
            m,
            unique(binding.authorizationGateId),
            ...(binding.specificationGateId === undefined
              ? []
              : [unique(binding.specificationGateId)]),
            ...(binding.planGateId === undefined ? [] : [unique(binding.planGateId)]),
          ])
            yield* audit(record);
          return { binding, role, membership: m, task };
        },
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(
                Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
              )
            : Effect.fail(deny("Message endpoint facts are unavailable")),
        ),
      );
      const issuances = new Set<string>();
      const auditIssuance = Effect.fn("messageSelection.auditIssuance")(function* (
        birth: { record: Membership; commandId: string },
        grant: Extract<ProjectTeamRecord, { kind: "gate" }>,
      ) {
        if (issuances.has(birth.commandId)) return;
        const receipt = receipts.get(birth.commandId);
        if (!receipt || receipt.actorKind !== "human" || birth.record.parentTaskId === undefined)
          return yield* deny("Message lineage has no original human issuance");
        const metadata = yield* sql<{ size: number }>`
          SELECT length(CAST(payload_json AS BLOB)) AS size
          FROM project_work_events WHERE project_id=${state.projectId} AND sequence < (
            SELECT MIN(sequence) FROM project_work_events
            WHERE project_id=${state.projectId} AND command_id=${birth.commandId}
          ) ORDER BY sequence LIMIT 8193`;
        if (
          metadata.length > 8192 ||
          metadata.some(
            (row) => !Number.isSafeInteger(row.size) || row.size < 0 || row.size > 262144,
          )
        )
          return yield* deny("Message issuance prefix exceeds its bound");
        const prefixBytes = metadata.reduce((total, row) => total + row.size, 0);
        if (prefixBytes > 4194304 - bytes)
          return yield* deny("Message issuance bytes exceed their bound");
        const prefix = yield* sql<{ payload: string | null }>`
          SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload
          FROM project_work_events WHERE project_id=${state.projectId} AND sequence < (
            SELECT MIN(sequence) FROM project_work_events
            WHERE project_id=${state.projectId} AND command_id=${birth.commandId}
          ) ORDER BY sequence LIMIT 8193`;
        if (prefix.length !== metadata.length || prefix.some((row) => row.payload === null))
          return yield* deny("Message issuance prefix exceeds its bound");
        bytes += prefix.reduce(
          (total, row) => total + Buffer.byteLength(row.payload ?? "", "utf8"),
          0,
        );
        if (bytes > 4194304) return yield* deny("Message issuance bytes exceed their bound");
        yield* Effect.try({
          try: () => {
            const before = applyProjectWorkEvents(
              emptyProjectWorkReducerState(state.projectId),
              prefix.map((row) => decodeProjectWorkEvent(decodeUnknownJson(row.payload))),
            );
            const parent = before.tasks.find((task) => task.taskId === birth.record.parentTaskId);
            const created = receipt.events.filter(
              (event) => event.type === "project-work.task.created",
            );
            const event = created[0];
            if (
              !parent ||
              created.length !== 1 ||
              event?.type !== "project-work.task.created" ||
              birth.record.assignment === undefined
            )
              throw deny("Message original issued task is unavailable");
            const child = decodeMessageTask(event.task);
            if (child.taskId !== birth.record.taskId || child.summary === undefined)
              throw deny("Message original issued task changed");
            const fields = {
              projectId: ProjectId.make(state.projectId),
              taskId: parent.taskId,
              commandId: CommandId.make(birth.commandId),
              expectedRevision: before.revision,
              expectedTaskRevision: parent.revision,
              objective: child.summary,
              outputDescriptions: birth.record.assignment.outputDescriptions,
            };
            const candidates: ProjectTeamGuidedIntent[] = [];
            if (grant.gate === "investigation") {
              const base = { ...fields, type: "project-team.investigation.start" as const };
              candidates.push(decodeGuidedIntent(base));
              const issues = (before.foundationRecords ?? []).filter(
                (record) => record.kind === "issue",
              );
              if (issues.length > 128)
                throw deny("Message issuance issue candidates exceed their bound");
              for (const issue of issues)
                candidates.push(
                  decodeGuidedIntent({
                    ...base,
                    issueRecordId: issue.recordId,
                    expectedIssueRevision: issue.revision,
                  }),
                );
            } else {
              const inherited = grant.assignmentAuthorization;
              const specificationGate = before.foundationRecords?.find(
                (record) =>
                  record.kind === "gate" &&
                  record.recordId === inherited?.parentSpecificationGateId,
              );
              if (!inherited || specificationGate?.kind !== "gate")
                throw deny("Message original assignment parent approval is unavailable");
              const parentPlan = inherited.parentPlan;
              const plan = before.foundationRecords?.find(
                (record) =>
                  record.kind === "plan-revision" && record.recordId === parentPlan?.recordId,
              );
              const planGate = before.foundationRecords?.find(
                (record) => record.kind === "gate" && record.recordId === parentPlan?.gateId,
              );
              if (parentPlan && (plan?.kind !== "plan-revision" || planGate?.kind !== "gate"))
                throw deny("Message original assignment plan is unavailable");
              candidates.push(
                decodeGuidedIntent({
                  ...fields,
                  type: "project-team.assignment.start",
                  assignmentKind: inherited.assignmentKind,
                  specRevision: parent.specRevision,
                  specificationGateId: specificationGate.recordId,
                  expectedSpecificationGateRevision: specificationGate.revision,
                  ...(parentPlan && plan?.kind === "plan-revision" && planGate?.kind === "gate"
                    ? {
                        parentPlan: {
                          recordId: plan.recordId,
                          expectedRecordRevision: plan.revision,
                          planRevision: plan.planRevision,
                          gateId: planGate.recordId,
                          expectedGateRevision: planGate.revision,
                        },
                      }
                    : {}),
                }),
              );
            }
            const matches = candidates.filter((intent) => {
              const command: ProjectWorkCommand = {
                type: "project-work.foundation.commit",
                projectId: intent.projectId,
                commandId: intent.commandId,
                expectedRevision: intent.expectedRevision,
                attribution: grant.attribution,
                committedAt: receipt.createdAt,
                records: [],
                guided: { intent },
              };
              const fingerprint = receipt.fingerprint.startsWith("project-team-intent:")
                ? "project-team-intent:" +
                  NodeCrypto.createHash("sha256")
                    .update(
                      canonicalProjectWorkPayload({
                        intent,
                        actor: {
                          kind: receipt.actorKind,
                          ...(receipt.actorId === null ? {} : { id: receipt.actorId }),
                        },
                        source: {
                          kind: receipt.sourceKind,
                          ...(receipt.sourceId === null ? {} : { id: receipt.sourceId }),
                        },
                        managed: null,
                      }),
                    )
                    .digest("hex")
                : projectWorkCommandFingerprint(command);
              return (
                fingerprint === receipt.fingerprint &&
                canonicalProjectWorkPayload(decideProjectWorkCommand(before, command)) ===
                  canonicalProjectWorkPayload(receipt.events)
              );
            });
            if (matches.length !== 1)
              throw deny("Message lineage differs from its authenticated original issuance");
          },
          catch: () => deny("Message original issuance is invalid"),
        });
        issuances.add(birth.commandId);
      });
      const lineage = Effect.fn("messageSelection.lineage")(function* (taskId: string) {
        const path: string[] = [];
        while (true) {
          if (path.includes(taskId) || path.length >= 9)
            return yield* deny("Message task lineage is cyclic or exceeds its bound");
          path.push(taskId);
          const m = membership(taskId);
          yield* audit(m);
          const birth = yield* audit(m, true);
          if (
            birth.record.kind !== "task-membership" ||
            birth.record.parentTaskId !== m.parentTaskId
          )
            return yield* deny("Message original task lineage changed");
          if (m.parentTaskId === undefined) return path;
          const originalGrantId = birth.record.assignment?.authorizationGateId;
          if (originalGrantId === undefined)
            return yield* deny("Message child has no original human-issued grant");
          const grantFact = yield* audit(unique(originalGrantId), true);
          const grant = grantFact.record;
          if (
            grant.kind !== "gate" ||
            grantFact.commandId !== birth.commandId ||
            grant.status !== "approved" ||
            grant.attribution.actor.kind !== "human" ||
            grant.taskId !== m.taskId ||
            (grant.gate !== "investigation" && grant.gate !== "assignment")
          )
            return yield* deny("Message child lineage is not human-approved");
          const suffix =
            grant.gate === "investigation"
              ? "research"
              : grant.assignmentAuthorization?.assignmentKind;
          if (
            suffix === undefined ||
            m.taskId !== projectTeamDerivedRecordId(birth.commandId, suffix) ||
            grant.recordId !==
              projectTeamDerivedRecordId(
                birth.commandId,
                grant.gate === "investigation" ? "investigation" : "assignment",
              ) ||
            (grant.assignmentAuthorization !== undefined &&
              grant.assignmentAuthorization.parentTaskId !== m.parentTaskId)
          )
            return yield* deny("Message lineage differs from its issued task");
          if (grant.gate === "assignment")
            yield* Effect.try({
              try: () => assertProjectTeamAssignmentAuthorization(state, grant),
              catch: () => deny("Message inherited parent approval changed"),
            });
          yield* auditIssuance({ ...birth, record: birth.record }, grant);
          taskId = m.parentTaskId;
        }
      });
      const qualify = Effect.fn("messageSelection.qualify")(
        function* (binding: Binding) {
          if (binding.projectId !== sender.projectId || binding.memberId === sender.memberId)
            return yield* deny("Message recipient must be another project teammate");
          const target = yield* endpoint(binding);
          const ownMembership = membership(sender.taskId);
          let relation: ProjectTeamMessageRecipient["relation"];
          if (binding.taskId === sender.taskId) relation = "same-task";
          else {
            const activeMission = yield* Effect.gen(function* () {
              if (
                ownMembership.missionId === undefined ||
                ownMembership.missionId !== target.membership.missionId
              )
                return false;
              const mission = unique(ownMembership.missionId);
              if (mission.kind !== "mission" || mission.status !== "active") return false;
              yield* audit(ownMembership);
              yield* audit(mission);
              return true;
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(
                      Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
                    )
                  : Effect.succeed(false),
              ),
            );
            if (activeMission) relation = "active-mission";
            else {
              const own = yield* lineage(sender.taskId);
              const peer = yield* lineage(binding.taskId);
              if (!own.some((id) => peer.includes(id)))
                return yield* deny("Message tasks have no approved shared lineage");
              relation = "approved-tree";
            }
          }
          return {
            memberId: binding.memberId,
            taskId: binding.taskId,
            taskTitle: target.task.title,
            expectedRecipientMembershipRevision: target.membership.revision,
            relation,
          } satisfies ProjectTeamMessageRecipient;
        },
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(
                Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
              )
            : Effect.fail(deny("Message recipient is unavailable or not eligible")),
        ),
      );
      return { qualify, audit, membership, endpoint };
    };
    const readMessageRecipientsInTransaction = Effect.fn(
      "ProjectTeamAuthorization.readMessageRecipientsInTransaction",
    )(function* (principal: ProjectTeamPrincipal) {
      yield* messageLoan();
      const own = yield* resolve(principal, true);
      if (!own) return yield* deny("Message addresses require original managed authority");
      if (!messageWriteGranted(own.binding, own.role))
        return {
          recipients: [],
          omitted: 0,
          degraded: false,
        } satisfies ProjectTeamMessageRecipients;
      const bindings = (own.state.foundationRecords ?? []).filter(
        (r): r is Binding =>
          r.kind === "run-binding" && r.status === "running" && r.memberId !== own.binding.memberId,
      );
      const selector = messageSelection(own.state, own.binding, yield* Clock.currentTimeMillis);
      const recipients: ProjectTeamMessageRecipient[] = [];
      let omitted = Math.max(0, bindings.length - 128);
      let degraded = bindings.length > 128;
      let bytes = 0;
      for (const binding of [...bindings]
        .sort((a, b) => a.recordId.localeCompare(b.recordId))
        .slice(0, 128)) {
        const result = yield* selector.qualify(binding).pipe(Effect.result);
        if (result._tag === "Failure") {
          omitted++;
          degraded = true;
          continue;
        }
        const entry = result.success;
        const size = Buffer.byteLength(canonicalProjectWorkPayload(entry), "utf8");
        if (
          Buffer.byteLength(entry.taskTitle, "utf8") > 1024 ||
          bytes + size > 8192 ||
          recipients.length >= 64 ||
          recipients.some((r) => r.memberId === entry.memberId && r.taskId === entry.taskId)
        ) {
          omitted++;
          degraded = true;
          continue;
        }
        recipients.push(entry);
        bytes += size;
      }
      return { recipients, omitted, degraded } satisfies ProjectTeamMessageRecipients;
    });
    const compileMessageRequest = Effect.fn("ProjectTeamAuthorization.compileMessageRequest")(
      function* (
        state: ProjectWorkReducerState,
        input: MessageRequest,
        attribution: ProjectWorkAttribution,
        credential: ProjectTeamCredential,
        beforeSequence?: number,
      ) {
        const binding = (state.foundationRecords ?? []).find(
          (r) => r.kind === "run-binding" && r.recordId === credential.bindingId,
        );
        const role =
          binding?.kind === "run-binding"
            ? state.foundationRecords?.find(
                (r) => r.kind === "role-revision" && r.recordId === binding.roleRevisionId,
              )
            : undefined;
        const task = state.tasks.find((t) => t.taskId === input.taskId);
        if (
          binding?.kind !== "run-binding" ||
          role?.kind !== "role-revision" ||
          !messageWriteGranted(binding, role) ||
          attribution.actor.kind !== "agent" ||
          attribution.actor.id !== managedActorId(credential) ||
          binding.projectId !== input.projectId ||
          binding.taskId !== input.taskId ||
          binding.generation !== credential.generation ||
          binding.providerInstanceId !== credential.providerInstanceId ||
          binding.threadId !== credential.threadId ||
          state.revision !== input.expectedRevision ||
          task?.revision !== input.expectedTaskRevision ||
          task.specRevision !== input.specRevision ||
          binding.planRevision !== input.planRevision ||
          binding.specRevision !== input.specRevision ||
          input.body.trim().length === 0 ||
          state.foundationRecords?.some((r) => r.recordId === input.messageId)
        )
          return yield* deny("Message sender, scope or request changed");
        yield* Effect.try({
          try: () => assertProjectTeamRunAuthority(state, binding, role, false),
          catch: () => deny("Message sender authority changed"),
        });
        const targets = (state.foundationRecords ?? []).filter(
          (r): r is Binding =>
            r.kind === "run-binding" &&
            r.memberId === input.recipientId &&
            r.taskId === input.recipientTaskId &&
            r.status === "running",
        );
        if (targets.length !== 1 || !targets[0])
          return yield* deny("Message recipient is not uniquely assigned");
        const selector = messageSelection(
          state,
          binding,
          Date.parse(attribution.recordedAt),
          beforeSequence,
        );
        yield* selector.endpoint(binding);
        const selected = yield* selector.qualify(targets[0]);
        if (
          selected.expectedRecipientMembershipRevision !== input.expectedRecipientMembershipRevision
        )
          return yield* deny("Message recipient membership changed");
        if (input.replyTo !== undefined) {
          const incoming = (state.foundationRecords ?? []).find(
            (r) => r.recordId === input.replyTo,
          );
          if (
            incoming?.kind !== "message" ||
            incoming.recipientId !== binding.memberId ||
            incoming.taskId !== binding.taskId ||
            incoming.senderId !== input.recipientId ||
            incoming.status === "canceled"
          )
            return yield* deny("Message reply has no original incoming address");
          yield* selector.audit(incoming);
        }
        for (const id of input.evidenceIds) {
          const evidence = state.evidence.filter((e) => e.evidenceId === id);
          const applicability = (state.foundationRecords ?? []).filter(
            (r) => r.kind === "evidence-applicability" && r.evidenceId === id,
          );
          if (
            evidence.length !== 1 ||
            evidence[0]?.taskId !== binding.taskId ||
            evidence[0]?.scopeHash !== binding.scopeHash ||
            applicability.length > 1 ||
            applicability.some(
              (r) =>
                r.kind !== "evidence-applicability" ||
                r.status !== "current" ||
                r.taskId !== binding.taskId ||
                r.scopeHash !== binding.scopeHash ||
                r.specRevision !== binding.specRevision ||
                r.planRevision !== binding.planRevision,
            )
          )
            return yield* deny("Message evidence is not applicable to its sender");
          for (const record of applicability) yield* selector.audit(record);
        }
        return {
          type: "project-work.foundation.commit",
          commandId: input.commandId,
          projectId: input.projectId,
          expectedRevision: input.expectedRevision,
          attribution,
          committedAt: attribution.recordedAt,
          records: [
            decodeRecord({
              kind: "message",
              recordId: input.messageId,
              projectId: input.projectId,
              revision: 0,
              generation: binding.generation,
              updatedAt: attribution.recordedAt,
              status: "queued",
              commandId: input.commandId,
              senderId: binding.memberId,
              recipientId: input.recipientId,
              taskId: input.recipientTaskId,
              ...(selected.relation === "active-mission"
                ? { missionId: selector.membership(binding.taskId).missionId }
                : {}),
              ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
              body: input.body,
              evidenceIds: [...input.evidenceIds],
              deliveryGeneration: 0,
              deliveryCursor: 0,
            }),
          ],
        } satisfies ProjectWorkCommand;
      },
    );
    const capability = Effect.fn("ProjectTeamAuthorization.capability")(function* (
      principal: ProjectTeamPrincipal,
      requested: string,
      projectId?: string,
    ) {
      const authority = yield* resolve(principal);
      if (!authority) return;
      if (projectId !== undefined && authority.binding.projectId !== projectId)
        return yield* deny("Managed target project mismatch");
      if (requested === "project") return;
      if (
        requested === "terminal" ||
        requested === "pull-requests" ||
        requested === "preview" ||
        requested === "device"
      )
        return yield* deny(
          "Managed host toolkit requires an isolated or protected operation route",
        );
      if (requested === "external-mcp")
        return yield* deny("External MCP has no managed action policy");
      if (
        !authority.role.tools.includes(requested) ||
        !authority.binding.configuration.toolIds.includes(requested)
      )
        return yield* deny("Frozen profile does not grant tool");
    });
    const read = Effect.fn("ProjectTeamAuthorization.read")(function* (
      principal: ProjectTeamPrincipal,
      input: ProjectWorkReadIntent,
    ) {
      const authority = yield* resolve(principal);
      if (!authority) return;
      if (input.projectId !== authority.binding.projectId)
        return yield* deny("Managed project mismatch");
      if (input.operation === "memory-sources") {
        if (
          input.taskId !== authority.binding.taskId ||
          authority.role.memoryAccess === "none" ||
          !["project-work.read-task", "project-work.read-project"].some(
            (tool) =>
              authority.role.tools.includes(tool) &&
              authority.binding.configuration.toolIds.includes(tool),
          )
        )
          return yield* deny(
            "Memory discovery requires the assigned task and frozen memory access",
          );
        return;
      }
      if (
        authority.role.role === "coordinator" &&
        authority.role.tools.includes("project-work.read-project") &&
        authority.binding.configuration.toolIds.includes("project-work.read-project")
      ) {
        if (input.operation === "tasks" && input.limit !== undefined && input.limit <= 128) return;
        if (
          input.operation === "foundation-records" &&
          input.limit !== undefined &&
          input.limit <= 128 &&
          input.recordKinds !== undefined &&
          input.recordKinds.length > 0 &&
          input.recordKinds.every((kind) =>
            ["mission", "member", "task-membership", "message", "question", "run-binding"].includes(
              kind,
            ),
          )
        )
          return;
      }
      if (input.taskId !== authority.binding.taskId)
        return yield* deny("Managed read must target assigned task");
      if (input.operation !== "task" && input.operation !== "task-context")
        return yield* deny("Managed collection reads are not task scoped");
    });
    const write = Effect.fn("ProjectTeamAuthorization.write")(function* (
      principal: ProjectTeamPrincipal,
      command: ProjectWorkCommand,
    ) {
      if (
        command.type === "project-work.foundation.commit" &&
        command.records.some((record) => record.kind === "review-finding")
      )
        return yield* deny("Review findings require the authenticated typed report route");
      const authority = yield* resolve(principal);
      if (!authority) return;
      const targetTaskId =
        "taskId" in command
          ? command.taskId
          : command.type === "project-work.comment.add"
            ? command.comment.taskId
            : command.type === "project-work.evidence.add"
              ? command.evidence.taskId
              : undefined;
      if (
        command.type !== "project-work.comment.add" &&
        !(
          command.type === "project-work.evidence.add" &&
          command.evidence.kind === "observation" &&
          command.evidence.criterionId === undefined
        )
      )
        yield* Effect.try({
          try: () =>
            assertProjectTeamSemanticWork(authority.state, authority.binding, authority.role),
          catch: () => deny("Semantic work requires its canonical repair debit"),
        });
      if (
        command.projectId !== authority.binding.projectId ||
        targetTaskId !== authority.binding.taskId
      )
        return yield* deny("Managed write must target assigned task");
      if (
        command.type === "project-work.criterion.upsert" &&
        command.criterion.taskId !== authority.binding.taskId
      )
        return yield* deny("Criterion target mismatch");
      if (
        command.type === "project-work.evidence.add" &&
        command.evidence.criterionId !== undefined &&
        !authority.state.criteria.some(
          (criterion) =>
            criterion.criterionId === command.evidence.criterionId &&
            criterion.taskId === authority.binding.taskId,
        )
      )
        return yield* deny("Evidence criterion target mismatch");
      if (authority.role.role !== "implementer" && authority.role.role !== "integrator")
        return yield* deny("Frozen role is read-only");
      if (
        !authority.binding.configuration.toolIds.includes("project-work.write") ||
        !authority.role.tools.includes("project-work.write")
      )
        return yield* deny("Frozen profile denies task writes");
      if (
        command.type !== "project-work.evidence.add" &&
        command.type !== "project-work.comment.add" &&
        command.type !== "project-work.attempt.checkpoint"
      )
        return yield* deny("Managed command requires a typed lifecycle authority route");
      if ("attemptId" in command && command.attemptId !== authority.binding.attemptId)
        return yield* deny("Attempt target mismatch");
      if (
        "leaseToken" in command &&
        command.leaseToken !==
          authority.state.attempts.find((a) => a.attemptId === authority.binding.attemptId)
            ?.leaseToken
      )
        return yield* deny("Attempt lease mismatch");
    });
    const intent = Effect.fn("ProjectTeamAuthorization.intent")(function* (
      principal: ProjectTeamPrincipal,
      input: ProjectTeamWriteIntent,
      attribution: ProjectWorkAttribution,
      duplicate: boolean,
    ) {
      if (input.type === "project-team.memory.query") {
        const currentSql = yield* Effect.serviceOption(SqlClient.SqlClient);
        const repository = yield* Effect.serviceOption(ProjectWorkRepository);
        if (
          Option.isNone(currentSql) ||
          currentSql.value !== sql ||
          Option.isNone(repository) ||
          Option.isNone(yield* Effect.serviceOption(sql.transactionService))
        )
          return yield* deny("Semantic query requires its original gateway transaction");
        const { makeProjectMemoryQuery } = yield* Effect.promise(
          () => import("./memory/ProjectMemoryQuery.ts"),
        );
        const query = yield* makeProjectMemoryQuery().pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, repository.value),
        );
        return yield* query
          .compileInTransaction(input, principal, attribution, resolve, duplicate)
          .pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectWorkRepository, repository.value),
            Effect.mapError((error) => deny(error.reason)),
          );
      }
      if (input.type === "project-team.memory.process") {
        const currentSql = yield* Effect.serviceOption(SqlClient.SqlClient);
        const repository = yield* Effect.serviceOption(ProjectWorkRepository);
        if (
          Option.isNone(currentSql) ||
          currentSql.value !== sql ||
          Option.isNone(repository) ||
          Option.isNone(yield* Effect.serviceOption(sql.transactionService))
        )
          return yield* deny("Memory selection requires its original gateway transaction");
        const { makeProjectMemoryProcessing } = yield* Effect.promise(
          () => import("./memory/ProjectMemoryProcessing.ts"),
        );
        const processing = yield* makeProjectMemoryProcessing.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, repository.value),
        );
        return yield* processing
          .compileInTransaction(input, principal, attribution, resolve, duplicate)
          .pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectWorkRepository, repository.value),
            Effect.mapError(() => deny("Memory source selection or original owner is invalid")),
          );
      }
      if (input.type === "project-team.message.send") yield* messageLoan();
      if (input.type === "project-team.question.request") {
        const currentSql = yield* Effect.serviceOption(SqlClient.SqlClient);
        const repository = yield* Effect.serviceOption(ProjectWorkRepository);
        const transaction = yield* Effect.serviceOption(sql.transactionService);
        if (
          Option.isNone(currentSql) ||
          currentSql.value !== sql ||
          Option.isNone(repository) ||
          Option.isNone(transaction)
        )
          return yield* deny("Human question requires its original transaction");
      }
      if (
        (input.type === "project-team.question.request" ||
          input.type === "project-team.message.send") &&
        duplicate
      ) {
        if (
          principal.managed === undefined ||
          principal.actor.kind !== "agent" ||
          principal.actor.id !== managedActorId(principal.managed) ||
          principal.managed.projectId !== input.projectId
        )
          return yield* deny("Human question replay requires its original managed identity");
        const credential = principal.managed;
        const receipts = yield* sql<{
          actorKind: string | null;
          actorId: string | null;
          sourceKind: string | null;
          sourceId: string | null;
          createdAt: string;
          fingerprint: string;
          eventIds: string | null;
          result: string | null;
        }>`SELECT actor_kind AS actorKind,actor_id AS actorId,
          source_kind AS sourceKind,source_id AS sourceId,created_at AS createdAt,
          payload_fingerprint AS fingerprint,
          CASE WHEN length(CAST(event_ids_json AS BLOB)) <= 1048576 THEN event_ids_json END AS eventIds,
          CASE WHEN length(CAST(result_json AS BLOB)) <= 262144 THEN result_json END AS result
          FROM project_work_command_receipts
          WHERE project_id=${input.projectId} AND command_id=${input.commandId} LIMIT 2`;
        if (input.type === "project-team.message.send") {
          const commandMetadata = yield* sql<{ bytes: number | null }>`
            SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM project_work_events
            WHERE project_id=${input.projectId} AND command_id=${input.commandId}
            ORDER BY sequence ASC LIMIT 513`;
          const prefixMetadata = yield* sql<{ bytes: number | null }>`
            SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM project_work_events
            WHERE project_id=${input.projectId} AND sequence < (
              SELECT MIN(sequence) FROM project_work_events
              WHERE project_id=${input.projectId} AND command_id=${input.commandId}
            ) ORDER BY sequence ASC LIMIT 8193`;
          const metadata = [...commandMetadata, ...prefixMetadata];
          if (
            commandMetadata.length === 0 ||
            commandMetadata.length > 512 ||
            prefixMetadata.length > 8192 ||
            metadata.some(
              (row) =>
                row.bytes === null ||
                !Number.isSafeInteger(row.bytes) ||
                row.bytes < 0 ||
                row.bytes > 1048576,
            ) ||
            metadata.reduce((total, row) => total + (row.bytes ?? 0), 0) > 16777216
          )
            return yield* deny("Original message history is invalid");
        }
        const rows = yield* sql<{
          payload: string | null;
          eventId: string;
          eventType: string;
          occurredAt: string;
          sequence: number;
        }>`SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= 1048576 THEN payload_json END AS payload,
          event_id AS eventId,event_type AS eventType,occurred_at AS occurredAt,sequence
          FROM project_work_events WHERE project_id=${input.projectId} AND command_id=${input.commandId}
          ORDER BY sequence ASC LIMIT ${input.type === "project-team.message.send" ? 513 : -1}`;
        const preceding = yield* sql<{ payload: string | null }>`
          SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= 1048576 THEN payload_json END AS payload
          FROM project_work_events WHERE project_id=${input.projectId} AND sequence < (
            SELECT MIN(sequence) FROM project_work_events
            WHERE project_id=${input.projectId} AND command_id=${input.commandId}
          ) ORDER BY sequence ASC LIMIT ${input.type === "project-team.message.send" ? 8193 : -1}`;
        let replayedMessage: ProjectWorkCommand | undefined;
        if (input.type === "project-team.message.send") {
          const restored = yield* Effect.try({
            try: () => {
              const receipt = receipts[0];
              if (
                receipts.length !== 1 ||
                !receipt ||
                rows.length === 0 ||
                rows.length > 512 ||
                preceding.length > 8192 ||
                [...rows, ...preceding].reduce(
                  (n, r) => n + Buffer.byteLength(r.payload ?? "", "utf8"),
                  0,
                ) > 16777216
              )
                throw deny("Original message history exceeds its bound");
              return {
                before: applyProjectWorkEvents(
                  emptyProjectWorkReducerState(input.projectId),
                  preceding.map((r) => decodeProjectWorkEvent(decodeUnknownJson(r.payload))),
                ),
                attribution: decodeAttribution({
                  actor: { kind: receipt.actorKind, id: receipt.actorId },
                  source: {
                    kind: receipt.sourceKind,
                    ...(receipt.sourceId === null ? {} : { id: receipt.sourceId }),
                  },
                  recordedAt: receipt.createdAt,
                }),
              };
            },
            catch: () => deny("Original message history is invalid"),
          });
          replayedMessage = yield* compileMessageRequest(
            restored.before,
            input,
            restored.attribution,
            credential,
            rows[0]?.sequence,
          );
        }
        return yield* Effect.try({
          try: () => {
            const receipt = receipts[0];
            if (receipts.length !== 1 || receipt === undefined || rows.length === 0)
              throw deny("Original human question receipt is missing");
            const fingerprint =
              "project-team-intent:" +
              NodeCrypto.createHash("sha256")
                .update(
                  canonicalProjectWorkPayload({
                    intent: input,
                    actor: { kind: principal.actor.kind, id: principal.actor.id },
                    source: { kind: attribution.source.kind, id: attribution.source.id },
                    managed: principal.managed,
                  }),
                )
                .digest("hex");
            if (
              receipt.actorKind !== principal.actor.kind ||
              receipt.actorId !== principal.actor.id ||
              receipt.sourceKind !== attribution.source.kind ||
              receipt.sourceId !== (attribution.source.id ?? null) ||
              receipt.fingerprint !== fingerprint
            )
              throw deny("Original human question authority changed");
            const original = rows.map((r) => decodeProjectWorkEvent(decodeUnknownJson(r.payload)));
            const originalAttribution = decodeAttribution({
              actor: { kind: receipt.actorKind, id: receipt.actorId },
              source: {
                kind: receipt.sourceKind,
                ...(receipt.sourceId === null ? {} : { id: receipt.sourceId }),
              },
              recordedAt: receipt.createdAt,
            });
            const before = applyProjectWorkEvents(
              emptyProjectWorkReducerState(input.projectId),
              preceding.map((r) => decodeProjectWorkEvent(decodeUnknownJson(r.payload))),
            );
            const command =
              input.type === "project-team.message.send"
                ? replayedMessage
                : compileQuestionRequest(before, input, originalAttribution, credential);
            if (command === undefined) throw deny("Original message reconstruction is missing");
            const expected = decideProjectWorkCommand(before, command);
            if (
              canonicalProjectWorkPayload(expected) !== canonicalProjectWorkPayload(original) ||
              rows.some(
                (r, i) =>
                  r.eventId !== expected[i]?.eventId ||
                  r.eventType !== expected[i]?.type ||
                  r.occurredAt !== receipt.createdAt,
              )
            )
              throw deny("Original human question events changed");
            const eventIds = decodeEventIds(receipt.eventIds);
            const result = decodeWriteResult(receipt.result);
            const revision = expected.at(-1)?.revision;
            const fields = [
              ...new Set(
                expected.flatMap((event) => {
                  if (event.type.includes("foundation")) return ["foundationRecords"];
                  if (event.type.includes("criterion")) return ["criteria", "tasks"];
                  if (event.type.includes("evidence")) return ["evidence", "criteria", "tasks"];
                  if (event.type.includes("relationship")) return ["relationships", "tasks"];
                  if (event.type.includes("attempt") || event.type.includes("checkpoint"))
                    return ["attempts", "tasks", "checkpoints"];
                  if (event.type.includes("knowledge")) return ["knowledge"];
                  if (event.type.includes("decision")) return ["decisions"];
                  if (event.type.includes("comment")) return ["comments"];
                  if (event.type.includes("attention")) return ["attention", "tasks"];
                  return ["tasks"];
                }),
              ),
            ].slice(0, 64);
            if (
              canonicalProjectWorkPayload(eventIds) !==
                canonicalProjectWorkPayload(expected.map((e) => e.eventId)) ||
              result.projectId !== input.projectId ||
              result.revision !== revision ||
              result.receipt.commandId !== input.commandId ||
              result.receipt.projectId !== input.projectId ||
              result.receipt.status !== "accepted" ||
              result.receipt.revision !== revision ||
              result.receipt.eventCount !== expected.length ||
              result.delta.projectId !== input.projectId ||
              result.delta.revision !== revision ||
              canonicalProjectWorkPayload(result.delta.eventIds) !==
                canonicalProjectWorkPayload(eventIds.slice(0, 64)) ||
              canonicalProjectWorkPayload(result.delta.changedFields) !==
                canonicalProjectWorkPayload(fields)
            )
              throw deny("Original human question result changed");
            return command;
          },
          catch: () => deny("Human question receipt target changed"),
        });
      }
      if (input.type === "project-team.review.finding.record") {
        const currentSql = yield* Effect.serviceOption(SqlClient.SqlClient);
        const transaction = yield* Effect.serviceOption(sql.transactionService);
        const repository = yield* Effect.serviceOption(ProjectWorkRepository);
        if (
          Option.isNone(currentSql) ||
          currentSql.value !== sql ||
          Option.isNone(transaction) ||
          Option.isNone(repository)
        )
          return yield* deny("Review finding report requires its original transaction");
        const findings = yield* makeProjectTeamReviewFindings(resolve).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, repository.value),
        );
        return yield* findings.compile(principal, input, attribution, duplicate).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(() => deny("Review finding authority or retained proof is invalid")),
        );
      }
      const authority = yield* resolve(principal);
      const state = authority?.state ?? (yield* stateFor(input.projectId));
      if (input.type === "project-team.message.send") {
        if (
          authority === undefined ||
          principal.managed === undefined ||
          attribution.actor.kind !== principal.actor.kind ||
          attribution.actor.id !== principal.actor.id
        )
          return yield* deny("Message requires authenticated managed authority");
        return yield* compileMessageRequest(state, input, attribution, authority.credential);
      }
      if (input.type === "project-team.question.request") {
        if (
          authority === undefined ||
          principal.managed === undefined ||
          attribution.actor.kind !== principal.actor.kind ||
          attribution.actor.id !== principal.actor.id
        )
          return yield* deny("Human question requires current managed authority");
        return yield* Effect.try({
          try: () => compileQuestionRequest(state, input, attribution, authority.credential),
          catch: (error) =>
            isAuthorizationError(error)
              ? error
              : deny("Human question authority or target changed"),
        });
      }
      if (input.type === "project-team.gate.respond" && input.response === "approved")
        yield* assertSelectedSources(state, input.taskId);

      if (input.type === "project-team.configure") {
        if (
          principal.actor.kind !== "human" ||
          principal.managed !== undefined ||
          attribution.actor.kind !== principal.actor.kind ||
          attribution.actor.id !== principal.actor.id
        )
          return yield* deny("Only the authenticated human can configure a project team");
        if (duplicate) {
          const rows = yield* sql<{
            payload: string;
          }>`SELECT payload_json AS payload FROM project_work_events
            WHERE project_id=${input.projectId} AND command_id=${input.commandId} ORDER BY sequence ASC`;
          const records = yield* Effect.try({
            try: () =>
              rows
                .map((row) => decodeProjectWorkEvent(decodeUnknownJson(row.payload)))
                .flatMap((event) =>
                  event.type === "project-work.foundation.recorded" ? [event.record] : [],
                ),
            catch: () => deny("Configuration receipt is invalid"),
          });
          yield* Effect.try({
            try: () => assertProjectTeamConfigurationReplay(state, records),
            catch: () => deny("Configuration receipt target changed"),
          });
          return {
            type: "project-work.foundation.commit",
            commandId: input.commandId,
            projectId: input.projectId,
            expectedRevision: input.expectedRevision,
            attribution,
            records,
            committedAt: attribution.recordedAt,
          } satisfies ProjectWorkCommand;
        }
        return yield* Effect.try({
          try: () => compileProjectTeamConfiguration(state, input, attribution),
          catch: () => deny("Configuration is stale, invalid, or existing work has not drained"),
        });
      }
      if (input.type === "project-team.verification.propose") {
        if (
          principal.actor.kind !== "human" ||
          principal.managed !== undefined ||
          attribution.actor.kind !== "human" ||
          attribution.actor.id !== principal.actor.id
        )
          return yield* deny("Only the authenticated human can propose verification");
        const trusted = yield* Effect.serviceOption(ProjectWorkVerificationApproval);
        if (Option.isNone(trusted))
          return yield* deny("Private verification preparation unavailable");
        const { type: _type, commandId: _commandId, ...selection } = input;
        if (
          canonicalProjectWorkPayload(selection) !==
          canonicalProjectWorkPayload(trusted.value.selection)
        )
          return yield* deny("Verification selection does not match its private preparation");
        yield* trusted.value.assertCurrent(state, duplicate).pipe(
          Effect.mapError(() => deny("Verification preparation is no longer current")),
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        const receipt = trusted.value.receipt;
        const recordId =
          "verification:" +
          NodeCrypto.createHash("sha256")
            .update(
              canonicalProjectWorkPayload({
                environmentId: receipt.manifest.environmentId,
                projectId: input.projectId,
                taskId: input.taskId,
                jobId: input.jobId,
              }),
            )
            .digest("hex");
        const existing = (state.foundationRecords ?? []).filter(
          (row) => row.kind === "gate" && row.verificationJobId === input.jobId,
        );
        if (duplicate) {
          const gate = existing[0];
          if (
            existing.length !== 1 ||
            gate?.kind !== "gate" ||
            gate.recordId !== recordId ||
            gate.taskId !== input.taskId ||
            gate.gate !== "verification" ||
            gate.contentHash !== receipt.sha256 ||
            gate.status !== "pending"
          )
            return yield* deny("Verification proposal receipt target changed");
          return {
            type: "project-work.foundation.commit",
            commandId: input.commandId,
            projectId: input.projectId,
            expectedRevision: input.expectedRevision,
            attribution,
            records: [gate],
            committedAt: attribution.recordedAt,
          } satisfies ProjectWorkCommand;
        }
        if (existing.length !== 0)
          return yield* deny("Verification job already has an approval gate");
        return {
          type: "project-work.foundation.commit",
          commandId: input.commandId,
          projectId: input.projectId,
          expectedRevision: input.expectedRevision,
          attribution,
          records: [
            {
              kind: "gate",
              projectId: input.projectId,
              recordId,
              revision: 0,
              generation: input.generation,
              updatedAt: attribution.recordedAt,
              status: "pending",
              taskId: input.taskId,
              gate: "verification",
              specRevision: input.specRevision,
              planRevision: input.planRevision,
              contentHash: receipt.sha256,
              verificationJobId: input.jobId,
              attribution,
              evidenceIds: [],
            },
          ],
          committedAt: attribution.recordedAt,
        } satisfies ProjectWorkCommand;
      }
      if (
        authority &&
        (input.projectId !== authority.binding.projectId ||
          input.taskId !== authority.binding.taskId)
      )
        return yield* deny("Intent target mismatch");
      const task = state.tasks.find((t) => t.taskId === input.taskId);
      if (
        task === undefined ||
        task.revision !== input.expectedTaskRevision ||
        task.specRevision !== input.specRevision
      )
        return yield* deny("Task or specification revision changed");
      if (!duplicate && state.revision !== input.expectedRevision)
        return yield* deny("Project revision changed");
      if (input.type !== "project-team.delegation.request" && principal.actor.kind !== "human")
        return yield* deny("Only a human can respond to gates, answer or promote memory");
      const records = state.foundationRecords ?? [];
      const question =
        input.type === "project-team.question.answer"
          ? records.find((r) => r.kind === "question" && r.recordId === input.questionId)
          : undefined;
      const gateId =
        input.type === "project-team.gate.respond"
          ? input.gateId
          : question?.kind === "question"
            ? question.targetGateId
            : undefined;
      const targetGate = records.find((r) => r.kind === "gate" && r.recordId === gateId);
      const specificationTarget =
        targetGate?.kind === "gate" && targetGate.gate === "specification";
      const plans = records.filter(
        (r) => r.kind === "plan-revision" && r.taskId === input.taskId && r.status === "proposed",
      );
      if (
        !specificationTarget &&
        (plans.some((r) => r.kind === "plan-revision" && r.planRevision > input.planRevision) ||
          (input.planRevision > 0 &&
            !plans.some(
              (r) =>
                r.kind === "plan-revision" &&
                r.planRevision === input.planRevision &&
                r.specRevision === input.specRevision,
            )))
      )
        return yield* deny("Plan revision changed");
      const now = attribution.recordedAt;
      let record: ProjectTeamRecord;
      if (
        input.type === "project-team.gate.respond" ||
        input.type === "project-team.question.answer"
      ) {
        const gate = targetGate;
        if (
          gate?.kind !== "gate" ||
          gate.taskId !== input.taskId ||
          gate.specRevision !== input.specRevision ||
          gate.planRevision !== input.planRevision ||
          gate.revision !==
            input.expectedGateRevision +
              (duplicate && input.type === "project-team.gate.respond" ? 1 : 0)
        )
          return yield* deny("Gate target changed");
        if (
          gate.gate === "specification" &&
          (gate.planRevision !== 0 ||
            gate.contentHash !== projectTeamSpecificationHash(state, input.taskId))
        )
          return yield* deny("Specification approval target changed");
        if (
          gate.gate === "plan" &&
          !plans.some(
            (plan) =>
              plan.kind === "plan-revision" &&
              plan.planRevision === gate.planRevision &&
              plan.specRevision === gate.specRevision &&
              plan.contentHash === gate.contentHash &&
              projectTeamPlanHash(plan) === gate.contentHash,
          )
        )
          return yield* deny("Plan approval target changed");
        if (gate.gate === "verification" && input.type === "project-team.gate.respond") {
          const request = yield* Effect.serviceOption(ProjectWorkVerificationRequest);
          if (Option.isNone(request))
            return yield* deny("Current human verification request unavailable");
          yield* request.value
            .assertCurrent(principal, input.projectId, "write")
            .pipe(Effect.mapError(() => deny("Human verification request is no longer current")));
        }
        if (
          gate.gate === "verification" &&
          input.type === "project-team.gate.respond" &&
          input.response === "approved"
        ) {
          const trusted = yield* Effect.serviceOption(ProjectWorkVerificationApproval);
          if (
            Option.isNone(trusted) ||
            trusted.value.receipt.manifest.jobId !== gate.verificationJobId ||
            trusted.value.receipt.sha256 !== gate.contentHash
          )
            return yield* deny("Private verification approval target unavailable");
          yield* trusted.value.assertCurrent(state, duplicate).pipe(
            Effect.mapError(() => deny("Verification approval target changed")),
            Effect.provideService(SqlClient.SqlClient, sql),
          );
        }
        if (input.type === "project-team.gate.respond") {
          if (!duplicate && gate.status !== "pending" && gate.status !== "proposed")
            return yield* deny("Gate response is no longer eligible");
          if (duplicate && gate.status !== input.response)
            return yield* deny("Gate response changed since receipt");
          record = {
            ...gate,
            revision: gate.revision + 1,
            status: input.response,
            attribution,
            updatedAt: now,
          };
        } else {
          if (
            question?.kind !== "question" ||
            question.taskId !== input.taskId ||
            question.targetRevision !== input.expectedGateRevision ||
            question.revision !== input.expectedQuestionRevision + (duplicate ? 1 : 0) ||
            (duplicate ? question.answer !== input.answer : question.status !== "pending") ||
            (question.choices.length > 0 && !question.choices.includes(input.answer))
          )
            return yield* deny("Question target changed");
          record = {
            ...question,
            revision: question.revision + 1,
            status: "answered",
            answer: input.answer,
            answeredBy: attribution,
            updatedAt: now,
          };
        }
      } else if (input.type === "project-team.delegation.request") {
        if (
          !authority ||
          authority.role.delegationDepth === 0 ||
          authority.role.role !== "coordinator"
        )
          return yield* deny("Current role cannot delegate");
        if (
          !authority.role.tools.includes("project-work.delegate") ||
          !authority.binding.configuration.toolIds.includes("project-work.delegate")
        )
          return yield* deny("Frozen profile denies delegation");
        let depth = 0;
        let delegationDepth = authority.role.delegationDepth;
        let parent = authority.binding;
        const seen = new Set<string>();
        while (parent.parentRunId !== undefined) {
          if (seen.has(parent.recordId)) return yield* deny("Invalid delegation ancestry");
          seen.add(parent.recordId);
          const next = records.find(
            (r) => r.kind === "run-binding" && r.recordId === parent.parentRunId,
          );
          if (
            next?.kind !== "run-binding" ||
            next.status !== "running" ||
            next.projectId !== input.projectId
          )
            return yield* deny("Inactive parent run");
          const parentCredential = {
            projectId: next.projectId,
            bindingId: next.recordId,
            generation: next.generation,
            providerInstanceId: next.providerInstanceId,
            threadId: next.threadId,
          };
          const currentParent = yield* resolve({
            actor: { kind: "agent", id: managedActorId(parentCredential) },
            managed: parentCredential,
          });
          if (currentParent === undefined) return yield* deny("Missing parent authority");
          if (
            currentParent.role.role !== "coordinator" ||
            !currentParent.role.tools.includes("project-work.delegate") ||
            !currentParent.binding.configuration.toolIds.includes("project-work.delegate")
          )
            return yield* deny("Frozen ancestor profile denies delegation");
          // A descendant's wider profile cannot increase the frozen tree budget.
          delegationDepth = Math.min(delegationDepth, currentParent.role.delegationDepth);
          parent = currentParent.binding;
          depth++;
        }
        if (depth >= delegationDepth) return yield* deny("Delegation depth exhausted");
        const recipient = records.find(
          (r) => r.kind === "member" && r.recordId === input.recipientId,
        );
        if (
          recipient?.kind !== "member" ||
          recipient.status !== "active" ||
          !records.some(
            (r) =>
              r.kind === "role-revision" &&
              r.recordId === recipient.roleRevisionId &&
              r.status === "available",
          ) ||
          recipient.recordId === authority.binding.memberId
        )
          return yield* deny("Invalid delegation recipient");
        if (
          duplicate &&
          !records.some(
            (r) =>
              r.kind === "message" &&
              r.recordId === input.requestId &&
              r.revision === 0 &&
              r.status === "queued" &&
              r.commandId === input.commandId &&
              r.senderId === authority.binding.memberId &&
              r.recipientId === recipient.recordId &&
              r.taskId === input.taskId &&
              r.body === input.objective,
          )
        )
          return yield* deny("Delegation target changed since receipt");
        record = {
          kind: "message",
          recordId: input.requestId,
          projectId: input.projectId,
          revision: 0,
          generation: authority.binding.generation,
          updatedAt: now,
          status: "queued",
          commandId: input.commandId,
          senderId: authority.binding.memberId,
          recipientId: recipient.recordId,
          taskId: input.taskId,
          body: input.objective,
          evidenceIds: [],
          deliveryGeneration: 0,
          deliveryCursor: 0,
        };
      } else {
        const observation = records.find(
          (r) => r.kind === "memory-observation" && r.recordId === input.observationId,
        );
        const source =
          observation?.kind === "memory-observation"
            ? records.find((r) => r.kind === "memory-source" && r.recordId === observation.sourceId)
            : undefined;
        if (
          observation?.kind !== "memory-observation" ||
          observation.status !== "current" ||
          observation.revision !== input.expectedObservationRevision ||
          source?.kind !== "memory-source" ||
          source.status !== "current" ||
          source.revision !== input.expectedSourceRevision ||
          source.sourceRevision !== observation.sourceRevision ||
          source.generation !== observation.sourceGeneration
        )
          return yield* deny("Memory provenance changed");
        if (duplicate) {
          const knowledge = state.knowledge?.find((k) => k.knowledgeId === input.knowledgeId);
          const events = yield* sql<{
            payload: string;
          }>`SELECT payload_json AS payload FROM project_work_events WHERE project_id=${input.projectId} AND command_id=${input.commandId}`;
          if (
            knowledge?.revision !== 0 ||
            knowledge.title !== input.title ||
            knowledge.body !== observation.body ||
            knowledge.sourceId !== observation.recordId ||
            !events.some((row) => {
              const event = decodeUnknownJson(row.payload) as {
                type?: string;
                knowledge?: { knowledgeId?: string; sourceId?: string; revision?: number };
              };
              return (
                event.type === "project-work.knowledge.promoted" &&
                event.knowledge?.knowledgeId === input.knowledgeId &&
                event.knowledge.sourceId === observation.recordId &&
                event.knowledge.revision === knowledge.revision
              );
            })
          )
            return yield* deny("Memory receipt target changed");
        }
        return {
          type: "project-work.knowledge.promote",
          projectId: input.projectId,
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
          attribution,
          promotedAt: now,
          knowledge: {
            knowledgeId: ProjectWorkKnowledgeId.make(input.knowledgeId),
            projectId: input.projectId,
            title: input.title,
            body: observation.body,
            sourceKind: "manual",
            sourceId: observation.recordId,
            revision: 0,
            createdAt: now,
            updatedAt: now,
            attribution,
          },
        } satisfies ProjectWorkCommand;
      }
      if (duplicate) {
        const events = yield* sql<{
          payload: string;
        }>`SELECT payload_json AS payload FROM project_work_events WHERE project_id=${input.projectId} AND command_id=${input.commandId}`;
        const matching = events.some((row) => {
          const event = decodeUnknownJson(row.payload) as { record?: ProjectTeamRecord };
          return (
            event.record?.recordId === record.recordId &&
            event.record.kind === record.kind &&
            event.record.revision ===
              record.revision - (input.type === "project-team.delegation.request" ? 0 : 1)
          );
        });
        if (!matching) return yield* deny("Receipt is not bound to intended record");
      }
      return {
        type: "project-work.foundation.commit",
        projectId: input.projectId,
        commandId: CommandId.make(input.commandId),
        expectedRevision: input.expectedRevision,
        records: [decodeRecord(record)],
        attribution,
        committedAt: now,
      } satisfies ProjectWorkCommand;
    });
    const guided = Effect.fn("ProjectTeamAuthorization.guided")(function* (
      principal: ProjectTeamPrincipal,
      input: ProjectTeamGuidedIntent,
      attribution: ProjectWorkAttribution,
      duplicate: boolean,
      mode: "validate" | "compile" = "compile",
    ) {
      const intent = yield* Effect.try({
        try: () => decodeGuidedIntent(input),
        catch: () => deny("Invalid guided intent"),
      });
      if (
        principal.actor.kind !== attribution.actor.kind ||
        principal.actor.id !== attribution.actor.id
      )
        return yield* deny("Guided attribution does not match authenticated principal");
      if (
        intent.type === "project-team.criterion.waiver" &&
        (principal.actor.kind !== "human" || principal.managed !== undefined)
      )
        return yield* deny("Criterion waiver requires authenticated human authority");
      const requireProposalTransaction = Effect.gen(function* () {
        const currentSql = yield* Effect.serviceOption(SqlClient.SqlClient);
        const transaction = yield* Effect.serviceOption(sql.transactionService);
        const repository = yield* Effect.serviceOption(ProjectWorkRepository);
        if (
          Option.isNone(currentSql) ||
          currentSql.value !== sql ||
          Option.isNone(transaction) ||
          Option.isNone(repository)
        )
          return yield* deny("Review completion report requires its original transaction");
        return repository.value;
      });
      if (
        intent.type === "project-team.assignment.report" &&
        intent.outcome === "complete" &&
        principal.managed !== undefined
      )
        yield* requireProposalTransaction;
      const authority = yield* resolve(principal);
      if (principal.actor.kind !== "human") {
        if (authority === undefined)
          return yield* deny("Guided agent requires current managed authority");
        yield* Effect.try({
          try: () =>
            assertProjectTeamSemanticWork(authority.state, authority.binding, authority.role),
          catch: () => deny("Semantic work requires its canonical repair debit"),
        });
        const inheritedPlanTarget =
          intent.type === "project-team.plan.propose" &&
          authority.role.role === "planner" &&
          authority.state.foundationRecords?.some(
            (record) =>
              record.kind === "gate" &&
              record.recordId === authority.binding.authorizationGateId &&
              (record.gate === "assignment" || record.gate === "repair") &&
              record.assignmentAuthorization?.assignmentKind === "planning" &&
              record.assignmentAuthorization.parentTaskId === intent.taskId,
          );
        if (
          authority.binding.projectId !== intent.projectId ||
          (authority.binding.taskId !== intent.taskId && !inheritedPlanTarget)
        )
          return yield* deny("Guided intent must target the assigned task");
        const capability =
          intent.type === "project-team.assignment.report"
            ? "project-work.report"
            : intent.type === "project-team.plan.propose" &&
                (authority.role.role === "planner" || authority.role.role === "coordinator")
              ? "project-work.plan"
              : undefined;
        if (
          capability === undefined ||
          !authority.role.tools.includes(capability) ||
          !authority.binding.configuration.toolIds.includes(capability)
        )
          return yield* deny("Frozen role does not grant this guided action");
      }
      const state = authority?.state ?? (yield* stateFor(intent.projectId));
      let integrationSources: typeof ProjectTeamIntegrationSources.Type | undefined;
      if (
        intent.type === "project-team.plan.propose" &&
        intent.integrationSourceRefs !== undefined
      ) {
        if (principal.actor.kind !== "human" || principal.managed !== undefined)
          return yield* deny("Only the authenticated human can select integration sources");
        const service = yield* sourceService();
        integrationSources = yield* service
          .compileInTransaction({
            projectId: intent.projectId,
            integrationTaskId: intent.taskId,
            refs: intent.integrationSourceRefs,
          })
          .pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(() => deny("Selected integration sources are no longer qualified")),
          );
      }
      if (intent.type === "project-team.execution.start") {
        yield* assertSelectedSources(state, intent.taskId);
        yield* assertDeliveredDependencies(state, intent.taskId);
      }

      if (
        intent.type === "project-team.assignment.report" &&
        intent.outcome === "complete" &&
        state.foundationRecords?.some(
          (record) =>
            record.kind === "task-membership" &&
            record.taskId === intent.taskId &&
            record.executionKind === "managed" &&
            record.deliverableKind === "review",
        )
      ) {
        const repository = yield* requireProposalTransaction;
        const proposals = yield* makeProjectTeamReviewCompletionProposals(resolve).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, repository),
        );
        if (mode === "compile") return yield* proposals.compile(principal, intent, attribution);
        yield* proposals.validate(principal, intent, attribution, { duplicate });
        return {
          type: "project-work.foundation.commit",
          commandId: intent.commandId,
          projectId: intent.projectId,
          expectedRevision: intent.expectedRevision,
          attribution,
          records: [],
          committedAt: attribution.recordedAt,
        } satisfies ProjectWorkCommand;
      }
      if (duplicate) {
        if (intent.type === "project-team.criterion.waiver") yield* requireProposalTransaction;
        const rows = yield* sql<{
          payload: string;
          eventId: string;
          eventType: string;
          occurredAt: string;
        }>`
          SELECT payload_json AS payload, event_id AS eventId,
            event_type AS eventType, occurred_at AS occurredAt FROM project_work_events
          WHERE project_id=${intent.projectId} AND command_id=${intent.commandId}
          ORDER BY sequence ASC
        `;
        if (intent.type === "project-team.criterion.waiver") {
          const receipts = yield* sql<{
            actorKind: string | null;
            actorId: string | null;
            sourceKind: string | null;
            sourceId: string | null;
            createdAt: string;
            fingerprint: string;
            eventIds: string | null;
            result: string | null;
          }>`SELECT actor_kind AS actorKind, actor_id AS actorId,
            source_kind AS sourceKind, source_id AS sourceId,
            created_at AS createdAt, payload_fingerprint AS fingerprint,
            CASE WHEN length(CAST(event_ids_json AS BLOB)) <= 1048576 THEN event_ids_json END AS eventIds,
            CASE WHEN length(CAST(result_json AS BLOB)) <= 262144 THEN result_json END AS result
            FROM project_work_command_receipts
            WHERE project_id=${intent.projectId} AND command_id=${intent.commandId} LIMIT 2`;
          const preceding = yield* sql<{ payload: string }>`
            SELECT payload_json AS payload FROM project_work_events
            WHERE project_id=${intent.projectId} AND sequence < (
              SELECT MIN(sequence) FROM project_work_events
              WHERE project_id=${intent.projectId} AND command_id=${intent.commandId}
            ) ORDER BY sequence ASC
          `;
          yield* Effect.try({
            try: () => {
              const receipt = receipts[0];
              if (receipts.length !== 1 || receipt === undefined || rows.length === 0)
                throw deny("Retained waiver receipt is missing");
              const original = rows.map((row) =>
                decodeProjectWorkEvent(decodeUnknownJson(row.payload)),
              );
              const primary = original[0];
              const pending = original.find(
                (event) =>
                  event.type === "project-work.foundation.recorded" &&
                  event.record.kind === "gate" &&
                  event.record.status === "pending",
              );
              // Decorations are not retained in receipt metadata or its fingerprint.
              // Authority identities and time always come from the owning receipt.
              const pendingRecord =
                pending?.type === "project-work.foundation.recorded"
                  ? decodeRecord(pending.record)
                  : undefined;
              const decorated = decodeAttribution(
                primary?.type === "project-work.criterion.waived"
                  ? primary.waiver.attribution
                  : pendingRecord?.kind === "gate"
                    ? pendingRecord.attribution
                    : undefined,
              );
              const originalAttribution = decodeAttribution({
                actor: {
                  ...decorated.actor,
                  kind: receipt.actorKind,
                  ...(receipt.actorId === null ? { id: undefined } : { id: receipt.actorId }),
                },
                source: {
                  ...decorated.source,
                  kind: receipt.sourceKind,
                  ...(receipt.sourceId === null ? { id: undefined } : { id: receipt.sourceId }),
                },
                recordedAt: receipt.createdAt,
              });
              const fingerprint =
                "project-team-intent:" +
                NodeCrypto.createHash("sha256")
                  .update(
                    canonicalProjectWorkPayload({
                      intent,
                      actor: { kind: principal.actor.kind, id: principal.actor.id },
                      source: { kind: attribution.source.kind, id: attribution.source.id },
                      managed: null,
                    }),
                  )
                  .digest("hex");
              if (
                receipt.actorKind !== "human" ||
                receipt.actorKind !== principal.actor.kind ||
                receipt.actorId !== (principal.actor.id ?? null) ||
                receipt.sourceKind !== attribution.source.kind ||
                receipt.sourceId !== (attribution.source.id ?? null) ||
                receipt.fingerprint !== fingerprint
              )
                throw deny("Retained waiver authority changed");
              const before = applyProjectWorkEvents(
                emptyProjectWorkReducerState(intent.projectId),
                preceding.map((row) => decodeProjectWorkEvent(decodeUnknownJson(row.payload))),
              );
              const expected = decideProjectWorkCommand(before, {
                type: "project-work.foundation.commit",
                commandId: intent.commandId,
                projectId: intent.projectId,
                expectedRevision: intent.expectedRevision,
                attribution: originalAttribution,
                committedAt: receipt.createdAt,
                records: [],
                guided: { intent },
              });
              if (
                canonicalProjectWorkPayload(expected) !== canonicalProjectWorkPayload(original) ||
                rows.some(
                  (row, index) =>
                    row.eventId !== expected[index]?.eventId ||
                    row.eventType !== expected[index]?.type ||
                    row.occurredAt !== receipt.createdAt,
                )
              )
                throw deny("Retained waiver events changed");
              const eventIds = decodeEventIds(receipt.eventIds);
              const result = decodeWriteResult(receipt.result);
              const revision = expected.at(-1)?.revision;
              if (
                canonicalProjectWorkPayload(eventIds) !==
                  canonicalProjectWorkPayload(expected.map((event) => event.eventId)) ||
                result.projectId !== intent.projectId ||
                result.revision !== revision ||
                result.receipt.commandId !== intent.commandId ||
                result.receipt.projectId !== intent.projectId ||
                result.receipt.status !== "accepted" ||
                result.receipt.revision !== revision ||
                result.receipt.eventCount !== expected.length ||
                result.delta.projectId !== intent.projectId ||
                result.delta.revision !== revision ||
                canonicalProjectWorkPayload(result.delta.eventIds) !==
                  canonicalProjectWorkPayload(eventIds.slice(0, 64)) ||
                canonicalProjectWorkPayload(result.delta.changedFields) !==
                  canonicalProjectWorkPayload(["criteria", "tasks", "foundationRecords"])
              )
                throw deny("Retained waiver result changed");
            },
            catch: () => deny("Guided receipt target changed"),
          });
        }
        yield* Effect.try({
          try: () =>
            assertProjectTeamGuidedReplayCurrent(
              state,
              intent,
              rows.map((row) => decodeProjectWorkEvent(decodeUnknownJson(row.payload))),
            ),
          catch: () => deny("Guided receipt target changed"),
        });
      } else {
        const task = state.tasks.find((entry) => entry.taskId === intent.taskId);
        if (
          state.revision !== intent.expectedRevision ||
          task?.revision !== intent.expectedTaskRevision
        )
          return yield* deny("Guided project or task revision changed");
      }
      return {
        type: "project-work.foundation.commit",
        commandId: intent.commandId,
        projectId: intent.projectId,
        expectedRevision: intent.expectedRevision,
        attribution,
        records: [],
        guided: {
          intent,
          ...(integrationSources === undefined ? {} : { integrationSources }),
          ...(authority === undefined
            ? {}
            : { bindingId: authority.binding.recordId, generation: authority.binding.generation }),
        },
        committedAt: attribution.recordedAt,
      } satisfies ProjectWorkCommand;
    });
    const guard = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((error) =>
          isAuthorizationError(error) ? error : deny("Managed authority unavailable"),
        ),
      );
    return ProjectTeamAuthorization.of({
      discover: (identity) => discover(identity),
      hasManagedThread,
      issueCredential: (identity) =>
        guard(
          Effect.gen(function* () {
            const credential = yield* discover(identity, true);
            return credential === undefined
              ? undefined
              : yield* resolve(
                  { actor: { kind: "agent", id: managedActorId(credential) }, managed: credential },
                  true,
                );
          }),
        ),
      resolve: (p) => guard(resolve(p)),
      readMessageRecipientsInTransaction: (p) => guard(readMessageRecipientsInTransaction(p)),
      capability: (p, c, id) => guard(capability(p, c, id)),
      read: (p, i) => guard(read(p, i)),
      write: (p, c) => guard(write(p, c)),
      intent: (p, i, a, d) => guard(intent(p, i, a, d)),
      guided: (p, i, a, d, mode) => {
        try {
          return guard(guided(structuredClone(p), structuredClone(i), structuredClone(a), d, mode));
        } catch {
          return Effect.fail(deny("Invalid guided input"));
        }
      },
    });
  }),
);
