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
  EventId,
  ProjectWorkTaskId,
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
} from "./ProjectWorkDecider.ts";
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
  assertProjectTeamSemanticWork,
  projectTeamSpecificationHash,
  projectTeamPlanHash,
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
const decodeGuidedIntent = Schema.decodeUnknownSync(ProjectTeamGuidedIntent, {
  onExcessProperty: "error",
});
export const managedActorId = (
  credential: Pick<ProjectTeamCredential, "providerInstanceId" | "threadId">,
) => `agent:mcp:${credential.providerInstanceId}:${credential.threadId}`;
const deny = (reason: string) => new ProjectTeamAuthorizationError({ reason });

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
