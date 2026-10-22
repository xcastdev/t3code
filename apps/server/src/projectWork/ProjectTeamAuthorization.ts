import {
  compileProjectTeamCommunication,
  planMailboxAttention,
} from "./ProjectTeamMailboxTurns.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthSessionId,
  ThreadId,
  RunId,
  RunAttemptId,
  ProviderThreadId,
  ProviderSessionId,
  ProjectTeamGuidedIntent,
  type ProjectWorkAttribution,
  type ProjectWorkCommand,
  type ProjectWorkWriteIntent,
  ProjectWorkRpcError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as RunAdmission from "../orchestration-v2/RunAdmission.ts";
import * as Reviews from "./ProjectTeamReviewFreshness.ts";
import * as IntegrationSources from "./ProjectTeamIntegrationSources.ts";
import * as Verification from "./ProjectWorkVerification.ts";
import { currentVerificationPlan } from "./ProjectWorkVerificationState.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import type { ProjectWorkPrincipal } from "./ProjectWorkGateway.ts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { compileProjectTeamConfiguration } from "./ProjectTeamConfiguration.ts";
import { projectTeamSpecificationHash, projectTeamPlanHash } from "./ProjectTeamPolicy.ts";

const isGuidedIntent = Schema.is(ProjectTeamGuidedIntent);
const denied = () => new ProjectWorkRpcError({ operation: "write", reason: "forbidden" });
const rejected = () => new ProjectWorkRpcError({ operation: "write", reason: "rejected" });

export interface ProjectTeamManagedIdentity {
  readonly bindingId: string;
  readonly generation: number;
  readonly memberId: string;
}

export class ProjectTeamAuthorization extends Context.Service<
  ProjectTeamAuthorization,
  {
    readonly assertHuman: (
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<void, ProjectWorkRpcError>;
    readonly assertHumanSourceControl: (
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<void, ProjectWorkRpcError>;
    readonly assertManaged: (
      state: ProjectWorkReducerState,
      input: ProjectWorkWriteIntent,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<ProjectTeamManagedIdentity, ProjectWorkRpcError>;
    readonly compile: (
      state: ProjectWorkReducerState,
      input: ProjectWorkWriteIntent,
      attribution: ProjectWorkAttribution,
      managed?: ProjectTeamManagedIdentity,
    ) => Effect.Effect<ProjectWorkCommand, ProjectWorkRpcError>;
  }
>()("t3/projectWork/ProjectTeamAuthorization") {}

const make = Effect.gen(function* () {
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const sql = yield* SqlClient.SqlClient;
  const reviews = yield* Effect.serviceOption(Reviews.ProjectTeamReviewFreshness);
  const integrationSources = yield* Effect.serviceOption(
    IntegrationSources.ProjectTeamIntegrationSources,
  );
  const verification = yield* Effect.serviceOption(Verification.ProjectWorkVerification);
  const assertHuman = Effect.fn("ProjectTeamAuthorization.assertHuman")(function* (
    principal: ProjectWorkPrincipal,
    requiredScope?: typeof AuthSourceControlWriteScope,
  ) {
    if (
      principal.actor.kind !== "human" ||
      principal.source.id === undefined ||
      !["web", "desktop", "mobile"].includes(principal.source.kind)
    )
      return yield* denied();
    const session = yield* sessions
      .getById({ sessionId: AuthSessionId.make(principal.source.id) })
      .pipe(Effect.mapError(() => denied()));
    const now = yield* DateTime.now;
    if (
      Option.isNone(session) ||
      session.value.subject !== principal.actor.id ||
      session.value.revokedAt !== null ||
      session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
      !session.value.scopes.includes(AuthOrchestrationOperateScope) ||
      (requiredScope !== undefined && !session.value.scopes.includes(requiredScope))
    )
      return yield* denied();
  });
  const assertManaged = Effect.fn("ProjectTeamAuthorization.assertManaged")(function* (
    state: ProjectWorkReducerState,
    input: ProjectWorkWriteIntent,
    principal: ProjectWorkPrincipal,
  ) {
    if (
      principal.actor.kind !== "agent" ||
      principal.source.kind !== "mcp" ||
      principal.source.id === undefined ||
      principal.projectId !== input.projectId ||
      ![
        "project-team.message.send",
        "project-team.question.request",
        "project-team.assignment.report",
        "project-team.plan.propose",
        "project-team.review.finding.record",
      ].includes(input.type)
    )
      return yield* denied();
    const rows = yield* sql<{
      thread_id: string;
      run_id: string;
      binding_id: string;
      generation: number;
      fence: number;
      attempt_id: string;
      provider_thread_id: string;
      provider_session_id: string;
    }>`
      SELECT r.thread_id,r.run_id,d.binding_id,d.generation,d.fence,a.attempt_id,p.provider_thread_id,s.provider_session_id
      FROM orchestration_v2_projection_provider_sessions s
      JOIN orchestration_v2_projection_provider_threads p ON p.provider_session_id=s.provider_session_id AND p.thread_id=s.thread_id
      JOIN orchestration_v2_projection_run_attempts a ON a.provider_thread_id=p.provider_thread_id AND a.thread_id=s.thread_id
      JOIN orchestration_v2_projection_runs r ON r.run_id=a.run_id AND r.thread_id=a.thread_id
      JOIN t3_workflow_v2_run_admissions d ON d.thread_id=r.thread_id AND d.run_id=r.run_id
      WHERE s.provider_session_id=${principal.source.id} AND s.thread_id=${principal.actor.id}
        AND d.project_id=${input.projectId} AND json_extract(r.payload_json,'$.activeAttemptId')=a.attempt_id
        AND r.completed_at IS NULL AND r.status IN ('starting','running','waiting')
        AND a.status IN ('pending','running') AND p.status IN ('idle','active')
        AND s.status IN ('starting','ready','running','waiting')
    `.pipe(Effect.mapError(() => denied()));
    if (rows.length !== 1) return yield* denied();
    const row = rows[0]!;
    const binding = state.foundationRecords?.find(
      (r) => r.kind === "run-binding" && r.recordId === row.binding_id,
    );
    const member = state.foundationRecords?.find(
      (r) =>
        r.kind === "member" && binding?.kind === "run-binding" && r.recordId === binding.memberId,
    );
    if (
      binding?.kind !== "run-binding" ||
      binding.leaseGeneration !== row.fence ||
      binding.generation !== binding.leaseGeneration ||
      binding.threadId !== row.thread_id ||
      binding.status !== "running" ||
      member?.kind !== "member" ||
      member.status !== "active" ||
      ("taskId" in input &&
        binding.taskId !== input.taskId &&
        input.type !== "project-team.plan.propose" &&
        input.type !== "project-team.review.finding.record")
    )
      return yield* denied();
    const admission = yield* Effect.serviceOption(RunAdmission.RunAdmission);
    if (Option.isNone(admission)) return yield* denied();
    const now = yield* DateTime.now;
    const checked = yield* admission.value
      .check({
        threadId: ThreadId.make(row.thread_id),
        runId: RunId.make(row.run_id),
        originSessionId: principal.source.id,
        operation: "completion",
        nativeTarget: {
          runAttemptId: RunAttemptId.make(row.attempt_id),
          providerThreadId: ProviderThreadId.make(row.provider_thread_id),
          providerSessionId: ProviderSessionId.make(row.provider_session_id),
        },
        now: DateTime.formatIso(now),
      })
      .pipe(Effect.mapError(() => denied()));
    if (
      checked._tag !== "admitted" ||
      checked.owner.bindingId !== binding.recordId ||
      checked.owner.fence !== binding.leaseGeneration
    )
      return yield* denied();
    return {
      bindingId: binding.recordId,
      generation: binding.generation,
      memberId: member.recordId,
    };
  });
  const compile = Effect.fn("ProjectTeamAuthorization.compile")(function* (
    state: ProjectWorkReducerState,
    input: ProjectWorkWriteIntent,
    attribution: ProjectWorkAttribution,
    managed?: ProjectTeamManagedIdentity,
  ) {
    if (input.type === "project-team.review.finding.record") {
      if (managed === undefined || Option.isNone(reviews)) return yield* denied();
      return yield* reviews.value
        .compile(state, input, attribution)
        .pipe(Effect.mapError(() => rejected()));
    }
    if (input.type === "project-team.message.attention") {
      if (attribution.actor.kind !== "human" || state.revision !== input.expectedRevision)
        return yield* rejected();
      return yield* Effect.try({
        try: () => ({
          type: "project-work.foundation.commit" as const,
          projectId: input.projectId,
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
          attribution,
          committedAt: attribution.recordedAt,
          records: [
            planMailboxAttention(state, {
              messageId: input.messageId,
              expectedRevision: input.expectedMessageRevision,
              action: input.action,
              at: attribution.recordedAt,
            }),
          ],
        }),
        catch: () => rejected(),
      });
    }
    if (input.type === "project-team.configure")
      return yield* Effect.try({
        try: () => compileProjectTeamConfiguration(state, input, attribution),
        catch: () => rejected(),
      });
    if (
      input.type === "project-team.message.send" ||
      input.type === "project-team.question.request" ||
      input.type === "project-team.question.answer"
    )
      return yield* Effect.try({
        try: () => {
          const command = compileProjectTeamCommunication(
            state,
            input,
            managed === undefined
              ? attribution
              : { ...attribution, actor: { ...attribution.actor, id: managed.memberId } },
          );
          return { ...command, attribution };
        },
        catch: () => rejected(),
      });
    if (isGuidedIntent(input)) {
      if (
        (input.type === "project-team.assignment.report" && managed === undefined) ||
        (input.type === "project-team.plan.propose" &&
          input.integrationSourceRefs !== undefined &&
          Option.isNone(integrationSources))
      )
        return yield* new ProjectWorkRpcError({ operation: "write", reason: "unavailable" });
      const sources =
        input.type === "project-team.plan.propose" &&
        input.integrationSourceRefs !== undefined &&
        Option.isSome(integrationSources)
          ? yield* integrationSources.value
              .compile(state, {
                integrationTaskId: input.taskId,
                refs: input.integrationSourceRefs,
              })
              .pipe(Effect.mapError(() => rejected()))
          : undefined;
      return {
        type: "project-work.foundation.commit",
        projectId: input.projectId,
        commandId: input.commandId,
        expectedRevision: input.expectedRevision,
        attribution,
        records: [],
        committedAt: attribution.recordedAt,
        guided: {
          intent: input,
          ...(sources === undefined ? {} : { integrationSources: sources }),
          ...(managed === undefined
            ? {}
            : { bindingId: managed.bindingId, generation: managed.generation }),
        },
      } satisfies ProjectWorkCommand;
    }
    if (input.type !== "project-team.gate.respond")
      return yield* new ProjectWorkRpcError({ operation: "write", reason: "unavailable" });
    const task = state.tasks.find((task) => task.taskId === input.taskId);
    const gate = (state.foundationRecords ?? []).find(
      (record) => record.kind === "gate" && record.recordId === input.gateId,
    );
    if (
      state.revision !== input.expectedRevision ||
      task?.revision !== input.expectedTaskRevision ||
      task.specRevision !== input.specRevision ||
      gate?.kind !== "gate" ||
      ![
        "specification",
        "plan",
        "investigation",
        "assignment",
        "repair",
        "verification",
        "execution",
        "merge",
        "publication",
      ].includes(gate.gate) ||
      gate.taskId !== input.taskId ||
      gate.revision !== input.expectedGateRevision ||
      gate.specRevision !== input.specRevision ||
      gate.planRevision !== input.planRevision ||
      !(input.response === "invalidated"
        ? ["approved", "rejected"].includes(gate.status)
        : ["pending", "proposed"].includes(gate.status))
    )
      return yield* rejected();
    if (
      gate.gate === "specification" &&
      (gate.planRevision !== 0 ||
        gate.contentHash !== projectTeamSpecificationHash(state, input.taskId))
    )
      return yield* rejected();
    if (
      gate.gate === "plan" &&
      !(state.foundationRecords ?? []).some(
        (record) =>
          record.kind === "plan-revision" &&
          record.taskId === input.taskId &&
          record.status === "proposed" &&
          record.planRevision === gate.planRevision &&
          record.specRevision === gate.specRevision &&
          record.contentHash === gate.contentHash &&
          projectTeamPlanHash(record) === gate.contentHash,
      )
    )
      return yield* rejected();
    if (gate.gate === "verification" && input.response === "approved") {
      if (Option.isNone(verification) || gate.verificationJobId === undefined)
        return yield* rejected();
      const receipt = yield* verification.value
        .read(input.projectId, gate.verificationJobId)
        .pipe(Effect.mapError(() => rejected()));
      if (
        Option.isNone(receipt) ||
        receipt.value.manifest.taskId !== input.taskId ||
        receipt.value.manifest.specRevision !== input.specRevision ||
        receipt.value.manifest.planRevision !== input.planRevision ||
        receipt.value.manifestHash !== gate.contentHash
      )
        return yield* rejected();
      yield* Effect.try({
        try: () =>
          currentVerificationPlan(state, input.taskId, input.specRevision, input.planRevision),
        catch: () => rejected(),
      });
    }
    return {
      type: "project-work.foundation.commit",
      commandId: input.commandId,
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      attribution,
      committedAt: attribution.recordedAt,
      records: [
        {
          ...gate,
          revision: gate.revision + 1,
          status: input.response,
          attribution: input.response === "invalidated" ? gate.attribution : attribution,
          updatedAt: attribution.recordedAt,
        },
      ],
    } satisfies ProjectWorkCommand;
  });
  return ProjectTeamAuthorization.of({
    assertHuman,
    assertHumanSourceControl: Effect.fn("ProjectTeamAuthorization.assertHumanSourceControl")(
      (principal: ProjectWorkPrincipal) => assertHuman(principal, AuthSourceControlWriteScope),
    ),
    assertManaged,
    compile,
  });
});
export const layer = Layer.effect(ProjectTeamAuthorization, make).pipe(
  Layer.provide(AuthSessions.layer),
);
