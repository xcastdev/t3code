import { assertProjectTeamCommunicationReplay } from "./ProjectTeamMailboxTurns.ts";
import * as Dispatch from "./ProjectTeamDispatch.ts";
import * as Supervision from "./ProjectTeamSupervisionGateway.ts";
import * as VerificationGateway from "./ProjectWorkVerificationGateway.ts";
import * as Verification from "./ProjectWorkVerification.ts";
import * as IntegrationSources from "./ProjectTeamIntegrationSources.ts";
import * as MemoryQuery from "./memory/ProjectMemoryQuery.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Publication from "./ProjectWorkHumanPublicationRequest.ts";
import * as ManagedMerge from "./ProjectWorkManagedMerge.ts";
import * as Acceptance from "./ProjectTeamDeliveryAcceptance.ts";
import * as Reviews from "./ProjectTeamReviewFreshness.ts";
import * as MemoryRuntime from "./memory/ProjectMemoryRuntime.ts";
import * as PublicationJournal from "./ProjectWorkPublicationJournal.ts";
import * as DeliveryGateway from "./ProjectWorkDeliveryGateway.ts";
import * as MemoryConfiguration from "./memory/ProjectMemoryConfiguration.ts";
import * as IssueBindings from "./ProjectIssueBindingGateway.ts";
import * as IssueSync from "./ProjectIssueSyncWorker.ts";
import * as TeamAuthorization from "./ProjectTeamAuthorization.ts";
import { assertProjectTeamConfigurationReplay } from "./ProjectTeamConfiguration.ts";
import { assertProjectTeamGuidedReplayCurrent } from "./ProjectTeamGuidedLifecycle.ts";
import { PROJECT_WORK_HUMAN_COMMAND_TYPES as humanCommandTypes } from "./ProjectWorkDecider.ts";
import {
  type ProjectIssueRequest,
  projectWorkPayloadFingerprint,
  projectWorkProtectedRevisionFingerprintPayload,
  type ProjectWorkAttribution,
  type ProjectWorkDecision,
  ProjectWorkRpcError,
  ProjectWorkBoundedReadEnvelope,
  ProjectWorkCommand,
  ProjectWorkReadIntent,
  ProjectWorkStreamInput,
  ProjectWorkStreamItem,
  ProjectWorkWriteIntent,
  ProjectWorkWriteResult,
  type ProjectId,
  type EnvironmentId,
  type ProjectWorkActor,
  type ProjectWorkSource,
  type ProjectWorkDeliveryRequest,
  type ProjectWorkDeliveryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import * as Query from "./ProjectWorkQuery.ts";
import * as Search from "./ProjectWorkSearch.ts";
import * as Briefing from "./ProjectWorkBriefing.ts";
import * as Export from "./ProjectWorkExport.ts";
import * as WorkStream from "./ProjectWorkStream.ts";

/** Transport-owned authority; never decoded from a command or tool's parameters. */
export interface ProjectWorkPrincipal {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly actor: ProjectWorkActor;
  readonly source: ProjectWorkSource;
}

type HumanProjectWorkCommand = Extract<
  ProjectWorkCommand,
  { type: (typeof humanCommandTypes)[number] }
>;
const isHumanProjectWorkCommand = (
  input: ProjectWorkWriteIntent,
): input is HumanProjectWorkCommand =>
  (humanCommandTypes as readonly string[]).includes(input.type);

export class ProjectWorkGateway extends Context.Service<
  ProjectWorkGateway,
  {
    readonly delivery: (
      input: ProjectWorkDeliveryRequest,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<ProjectWorkDeliveryResult, ProjectWorkRpcError>;
    readonly issue: (
      input: ProjectIssueRequest,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<unknown, ProjectWorkRpcError>;
    readonly read: (
      input: ProjectWorkReadIntent,
      principal?: ProjectWorkPrincipal,
    ) => Effect.Effect<unknown, ProjectWorkRpcError>;
    readonly write: (
      input: ProjectWorkWriteIntent,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<ProjectWorkWriteResult, ProjectWorkRpcError>;
    readonly subscribe: (
      input: ProjectWorkStreamInput,
      principal?: ProjectWorkPrincipal,
    ) => Stream.Stream<ProjectWorkStreamItem, ProjectWorkRpcError>;
  }
>()("t3/projectWork/ProjectWorkGateway") {}

const decodeCommand = Schema.decodeUnknownEffect(ProjectWorkCommand);
const decodeWriteResult = Schema.decodeUnknownEffect(ProjectWorkWriteResult);
const decodeEnvelope = Schema.decodeUnknownEffect(ProjectWorkBoundedReadEnvelope);

const failure = (
  operation: "read" | "write" | "subscribe",
  reason: ProjectWorkRpcError["reason"],
) => new ProjectWorkRpcError({ operation, reason });

const make = Effect.gen(function* () {
  const issueBindings = yield* Effect.serviceOption(IssueBindings.ProjectIssueBindingGateway);
  const issueSync = yield* Effect.serviceOption(IssueSync.ProjectIssueSyncWorker);
  const dispatchService = yield* Effect.serviceOption(Dispatch.ProjectTeamDispatch);
  const supervision = yield* Effect.serviceOption(Supervision.ProjectTeamSupervisionGateway);
  const verificationGateway = yield* Effect.serviceOption(
    VerificationGateway.ProjectWorkVerificationGateway,
  );
  const verification = yield* Effect.serviceOption(Verification.ProjectWorkVerification);
  const integrationSources = yield* Effect.serviceOption(
    IntegrationSources.ProjectTeamIntegrationSources,
  );
  const memory = yield* Effect.serviceOption(MemoryQuery.ProjectMemoryQuery);
  const sql = yield* SqlClient.SqlClient;
  const publication = yield* Effect.serviceOption(Publication.ProjectWorkHumanPublicationRequest);
  const merge = yield* Effect.serviceOption(ManagedMerge.ProjectWorkManagedMerge);
  const acceptance = yield* Effect.serviceOption(Acceptance.ProjectTeamDeliveryAcceptance);
  const reviews = yield* Effect.serviceOption(Reviews.ProjectTeamReviewFreshness);
  const memoryRuntime = yield* Effect.serviceOption(MemoryRuntime.ProjectMemoryRuntime);
  const publicationJournal = yield* Effect.serviceOption(
    PublicationJournal.ProjectWorkPublicationJournal,
  );
  const deliveryGateway = yield* Effect.serviceOption(DeliveryGateway.ProjectWorkDeliveryGateway);
  const memoryConfiguration = yield* Effect.serviceOption(
    MemoryConfiguration.ProjectMemoryConfiguration,
  );
  const teamAuthorization = yield* TeamAuthorization.ProjectTeamAuthorization;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const repository = yield* Repository.ProjectWorkRepository;
  const query = yield* Query.ProjectWorkQuery;
  const search = yield* Search.ProjectWorkSearch;
  const briefing = yield* Briefing.ProjectWorkBriefing;
  const exporter = yield* Export.ProjectWorkExport;
  const stream = yield* WorkStream.ProjectWorkStream;
  const authorize = Effect.fn("ProjectWorkGateway.authorize")(function* (
    projectId: ProjectId,
    operation: "read" | "write" | "subscribe",
    principal?: ProjectWorkPrincipal,
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    if (
      (principal?.environmentId !== undefined && principal.environmentId !== environmentId) ||
      (principal?.projectId !== undefined && principal.projectId !== projectId)
    )
      return yield* failure(operation, "forbidden");
    const project = yield* projects
      .get(projectId)
      .pipe(Effect.mapError(() => failure(operation, "unavailable")));
    if (Option.isNone(project)) return yield* failure(operation, "forbidden");
    return environmentId;
  });

  const issue = Effect.fn("ProjectWorkGateway.issue")(function* (
    input: ProjectIssueRequest,
    principal: ProjectWorkPrincipal,
  ) {
    yield* authorize(input.input.projectId, "write", principal);
    if (Option.isNone(issueBindings) || Option.isNone(issueSync))
      return yield* failure("write", "unavailable");
    const human = teamAuthorization
      .assertHuman(principal)
      .pipe(
        Effect.mapError(
          () => new IssueBindings.IssueBindingGatewayError({ reason: "human-required" }),
        ),
      );
    const bindings = issueBindings.value;
    const sync = issueSync.value;
    const operation: Effect.Effect<unknown, IssueBindings.IssueBindingGatewayError> =
      input.operation === "identity"
        ? bindings.identity(input.input, human)
        : input.operation === "bind"
          ? bindings.bind(input.input, human)
          : input.operation === "list"
            ? bindings.list(input.input, human)
            : input.operation === "detach"
              ? bindings.detach(input.input, human).pipe(Effect.as({ status: "detached" as const }))
              : sync.readOnce(input.input, human);
    return yield* operation.pipe(
      Effect.mapError((error) =>
        failure(
          "write",
          error.reason === "human-required"
            ? "forbidden"
            : error.reason === "unavailable" || error.reason === "storage"
              ? "unavailable"
              : "rejected",
        ),
      ),
    );
  });
  const delivery = Effect.fn("ProjectWorkGateway.delivery")(function* (
    input: ProjectWorkDeliveryRequest,
    principal: ProjectWorkPrincipal,
  ) {
    yield* teamAuthorization.assertHumanSourceControl(principal);
    if (input.operation === "preview") {
      yield* authorize(input.input.projectId, "write", principal);
      if (Option.isNone(deliveryGateway)) return yield* failure("write", "unavailable");
      return yield* deliveryGateway.value
        .preview(input.input, principal)
        .pipe(Effect.mapError(() => failure("write", "rejected")));
    }
    if (input.operation === "publish") {
      yield* authorize(input.input.projectId, "write", principal);
      if (Option.isNone(publication)) return yield* failure("write", "unavailable");
      const result = yield* publication.value
        .execute(input.input, principal)
        .pipe(Effect.mapError(() => failure("write", "rejected")));
      if (Option.isSome(deliveryGateway))
        yield* deliveryGateway.value
          .link(result)
          .pipe(Effect.mapError(() => failure("write", "rejected")));
      return {
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
      };
    }
    if (Option.isNone(publicationJournal)) return yield* failure("write", "unavailable");
    const retained = yield* publicationJournal.value
      .read(
        input.operation === "merge" ? input.input.publicationOperationId : input.input.operationId,
      )
      .pipe(Effect.mapError(() => failure("write", "unavailable")));
    if (Option.isNone(retained)) return yield* failure("write", "rejected");
    yield* authorize(retained.value.decision.request.target.projectId, "write", principal);
    if (input.operation === "merge") {
      if (Option.isNone(merge)) return yield* failure("write", "unavailable");
      const result = yield* merge.value
        .execute(input.input, principal)
        .pipe(Effect.mapError(() => failure("write", "rejected")));
      if (Option.isSome(deliveryGateway))
        yield* deliveryGateway.value
          .link(result)
          .pipe(Effect.mapError(() => failure("write", "rejected")));
      return DeliveryGateway.publicDeliveryResult(result);
    }
    if (Option.isNone(acceptance)) return yield* failure("write", "unavailable");
    const result = yield* acceptance.value
      .execute(input.input, principal)
      .pipe(Effect.mapError(() => failure("write", "rejected")));
    return {
      operationId: result.operationId,
      kind: "accept" as const,
      stage: "confirmed" as const,
    };
  });

  const write = Effect.fn("ProjectWorkGateway.write")(function* (
    input: ProjectWorkWriteIntent,
    principal: ProjectWorkPrincipal,
  ) {
    const environmentId = yield* authorize(input.projectId, "write", principal);
    const references = [input as unknown];
    while (references.length > 0) {
      const value = references.pop();
      if (value === null || typeof value !== "object") continue;
      for (const [key, entry] of Object.entries(value)) {
        if (
          (key === "environmentId" && entry !== environmentId) ||
          (key === "projectId" &&
            entry !== input.projectId &&
            !(
              input.type.startsWith("project-team.memory.") &&
              "kind" in value &&
              value.kind === "project"
            ))
        )
          return yield* failure("write", "forbidden");
        if (entry !== null && typeof entry === "object") references.push(entry);
      }
    }
    if (input.type === "project-team.dispatch") {
      yield* teamAuthorization.assertHuman(principal);
      if (Option.isNone(dispatchService)) return yield* failure("write", "unavailable");
      return yield* dispatchService.value
        .dispatch(input, {
          actor: principal.actor,
          source: principal.source,
          recordedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.mapError(() => failure("write", "rejected")));
    }
    if (input.type === "project-team.memory.configure") {
      if (Option.isNone(memoryRuntime)) return yield* failure("write", "unavailable");
      return yield* memoryRuntime.value
        .configure(input, principal)
        .pipe(Effect.mapError(() => failure("write", "rejected")));
    }
    if (
      [
        "project-team.memory.promote",
        "project-team.memory.process",
        "project-team.memory.query",
        "project-team.memory.retract",
        "project-team.memory.shares.replace",
      ].includes(input.type)
    ) {
      if (Option.isNone(memory)) return yield* failure("write", "unavailable");
      const result = yield* memory.value.write(input, principal);
      if (input.type === "project-team.memory.process" && Option.isSome(memoryRuntime))
        yield* memoryRuntime.value.process(input).pipe(Effect.ignore);
      return result;
    }
    if (input.type === "project-team.verification.propose") {
      if (Option.isNone(verificationGateway)) return yield* failure("write", "unavailable");
      return yield* verificationGateway.value
        .propose(input, principal)
        .pipe(Effect.mapError(() => failure("write", "rejected")));
    }
    if (
      input.type === "project-team.assignment.report" &&
      input.outcome === "complete" &&
      input.criterionAssessments !== undefined
    ) {
      if (Option.isNone(reviews)) return yield* failure("write", "unavailable");
      const state = yield* Repository.readCurrentState(sql, input.projectId).pipe(
        Effect.mapError(() => failure("write", "unavailable")),
      );
      const managed = yield* teamAuthorization.assertManaged(state, input, principal);
      const snapshot = yield* reviews.value
        .read(input.projectId, managed.bindingId)
        .pipe(Effect.mapError(() => failure("write", "rejected")));
      yield* reviews.value
        .assertPhysical(input.projectId, snapshot.manifest.jobId)
        .pipe(Effect.mapError(() => failure("write", "rejected")));
      const at = DateTime.formatIso(yield* DateTime.now);
      const attribution = { actor: principal.actor, source: principal.source, recordedAt: at };
      const result = yield* repository
        .executeReserved(
          {
            type: "project-work.foundation.commit",
            projectId: input.projectId,
            commandId: input.commandId,
            expectedRevision: input.expectedRevision,
            attribution,
            committedAt: at,
            records: [],
            guided: {
              intent: input,
              bindingId: managed.bindingId,
              generation: managed.generation,
              reviewProposal: true,
            },
          },
          () =>
            Effect.gen(function* () {
              if (Option.isNone(reviews)) return yield* failure("write", "unavailable");
              const current = yield* Repository.readCurrentState(sql, input.projectId);
              yield* teamAuthorization.assertManaged(current, input, principal);
              yield* reviews.value
                .propose(current, input, attribution)
                .pipe(Effect.mapError(() => failure("write", "rejected")));
            }),
          projectWorkPayloadFingerprint({
            input,
            actor: principal.actor,
            source: principal.source,
          }),
        )
        .pipe(Effect.mapError(() => failure("write", "rejected")));
      return result.writeResult;
    }
    if (input.type === "project-team.review.finding.record") {
      if (Option.isNone(reviews)) return yield* failure("write", "unavailable");
      const state = yield* Repository.readCurrentState(sql, input.projectId).pipe(
        Effect.mapError(() => failure("write", "unavailable")),
      );
      const managed = yield* teamAuthorization.assertManaged(state, input, principal);
      const snapshot = yield* reviews.value
        .read(input.projectId, managed.bindingId)
        .pipe(Effect.mapError(() => failure("write", "rejected")));
      yield* reviews.value
        .assertPhysical(input.projectId, snapshot.manifest.jobId)
        .pipe(Effect.mapError(() => failure("write", "rejected")));
    }
    if (input.type.startsWith("project-team.")) {
      if (principal.actor.kind === "human") yield* teamAuthorization.assertHuman(principal);
      const attribution: ProjectWorkAttribution = {
        actor: principal.actor,
        source: principal.source,
        recordedAt: DateTime.formatIso(yield* DateTime.now),
      };
      const envelope: Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }> = {
        type: "project-work.foundation.commit",
        projectId: input.projectId,
        commandId: input.commandId,
        expectedRevision: input.expectedRevision ?? 0,
        attribution,
        committedAt: attribution.recordedAt,
        records: [],
      };
      const result = yield* repository
        .executeAuthorized(
          envelope,
          ({ state }) =>
            Effect.gen(function* () {
              const managed =
                principal.actor.kind === "human"
                  ? undefined
                  : yield* teamAuthorization.assertManaged(state, input, principal);
              return yield* teamAuthorization.compile(state, input, attribution, managed);
            }),
          ({ duplicate, state, events }) =>
            Effect.gen(function* () {
              if (principal.actor.kind === "human") yield* teamAuthorization.assertHuman(principal);
              else yield* teamAuthorization.assertManaged(state, input, principal);
              if (!duplicate) return;
              yield* Effect.try({
                try: () => {
                  if (input.type === "project-team.configure")
                    assertProjectTeamConfigurationReplay(
                      state,
                      events.flatMap((event) =>
                        event.type === "project-work.foundation.recorded" ? [event.record] : [],
                      ),
                    );
                  else if (input.type === "project-team.gate.respond") {
                    const record = events.find(
                      (event) =>
                        event.type === "project-work.foundation.recorded" &&
                        event.record.recordId === input.gateId,
                    );
                    if (
                      record?.type !== "project-work.foundation.recorded" ||
                      !(state.foundationRecords ?? []).some(
                        (current) =>
                          current.recordId === record.record.recordId &&
                          current.revision === record.record.revision,
                      )
                    )
                      throw new Error("Gate response target changed");
                  } else if (
                    [
                      "project-team.message.send",
                      "project-team.question.request",
                      "project-team.question.answer",
                      "project-team.message.attention",
                    ].includes(input.type)
                  ) {
                    assertProjectTeamCommunicationReplay(state, events);
                  } else
                    assertProjectTeamGuidedReplayCurrent(
                      state,
                      input as import("@t3tools/contracts").ProjectTeamGuidedIntent,
                      events,
                    );
                },
                catch: () => failure("write", "rejected"),
              });
            }),
          projectWorkPayloadFingerprint({
            input,
            actor: principal.actor,
            source: principal.source,
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ProjectWorkRpcError"
              ? error
              : failure(
                  "write",
                  error._tag === "ProjectWorkPolicyError" ? "rejected" : "unavailable",
                ),
          ),
        );
      if (input.type === "project-team.gate.respond" && input.response === "approved") {
        const gate = result.state.foundationRecords?.find(
          (record) => record.kind === "gate" && record.recordId === input.gateId,
        );
        if (
          gate?.kind === "gate" &&
          gate.gate === "verification" &&
          gate.verificationJobId !== undefined
        ) {
          if (Option.isNone(verificationGateway)) return yield* failure("write", "unavailable");
          yield* verificationGateway.value
            .execute(input.projectId, gate.verificationJobId, principal)
            .pipe(Effect.mapError(() => failure("write", "rejected")));
        }
      }
      return result.writeResult;
    }
    if (!isHumanProjectWorkCommand(input)) return yield* failure("write", "unavailable");
    if (
      principal.actor.kind !== "human" &&
      [
        "project-work.task.approve",
        "project-work.task.revise-protected-specification",
        "project-work.criterion.waive",
        "project-work.criterion.revoke-waiver",
        "project-work.decision.accept",
        "project-work.decision.reject",
        "project-work.decision.supersede",
        "project-work.knowledge.promote",
      ].includes(input.type)
    )
      return yield* failure("write", "forbidden");
    if (input.type === "project-work.criterion.revoke-waiver")
      yield* teamAuthorization.assertHuman(principal);
    // Verify the reviewed payload before changing its transport attribution. A
    // server-minted fingerprint must never legitimize changed business fields.
    if (
      input.type === "project-work.task.revise-protected-specification" &&
      projectWorkPayloadFingerprint(projectWorkProtectedRevisionFingerprintPayload(input)) !==
        input.approval.payloadFingerprint
    )
      return yield* failure("write", "rejected");
    const attribution: ProjectWorkAttribution = {
      actor: principal.actor,
      source: principal.source,
      recordedAt: DateTime.formatIso(yield* DateTime.now),
    };
    const attributeDecision = (decision: ProjectWorkDecision) => ({
      ...decision,
      attribution,
      ...(decision.stateTransitionAttribution === undefined
        ? {}
        : { stateTransitionAttribution: attribution }),
    });
    const attributeCommand = (command: HumanProjectWorkCommand): ProjectWorkCommand => {
      const attributed = { ...command, attribution };
      switch (attributed.type) {
        case "project-work.task.revise-protected-specification":
          // Criterion snapshots are historical proof, compared to stored records
          // by the decider; their existing attribution must remain unchanged.
          return { ...attributed, approval: { ...attributed.approval, attribution } };
        case "project-work.criterion.upsert":
          return {
            ...attributed,
            criterion: {
              ...attributed.criterion,
              ...(attributed.criterion.waiver === undefined
                ? {}
                : { waiver: { ...attributed.criterion.waiver, attribution } }),
            },
          };
        case "project-work.criterion.revoke-waiver":
          return { ...attributed, revokedAt: attribution.recordedAt };
        case "project-work.criterion.waive":
          return { ...attributed, waiver: { ...attributed.waiver, attribution } };
        case "project-work.evidence.add":
          return { ...attributed, evidence: { ...attributed.evidence, attribution } };
        case "project-work.relationship.link":
          return { ...attributed, relationship: { ...attributed.relationship, attribution } };
        case "project-work.knowledge.promote":
          return { ...attributed, knowledge: { ...attributed.knowledge, attribution } };
        case "project-work.decision.propose":
          return { ...attributed, decision: attributeDecision(attributed.decision) };
        case "project-work.decision.supersede":
          return { ...attributed, replacement: attributeDecision(attributed.replacement) };
        case "project-work.comment.add":
          return { ...attributed, comment: { ...attributed.comment, attribution } };
        default:
          return attributed;
      }
    };
    const attributed = yield* decodeCommand(attributeCommand(input)).pipe(
      Effect.mapError(() => failure("write", "invalid-request")),
    );
    const command =
      attributed.type === "project-work.task.revise-protected-specification"
        ? {
            ...attributed,
            approval: {
              ...attributed.approval,
              payloadFingerprint: projectWorkPayloadFingerprint(
                projectWorkProtectedRevisionFingerprintPayload(attributed),
              ),
            },
          }
        : attributed;
    if (command.type === "project-work.issue.refine") {
      if (Option.isNone(issueBindings)) return yield* failure("write", "unavailable");
      yield* issueBindings.value
        .assertRefinable(
          command,
          teamAuthorization
            .assertHuman(principal)
            .pipe(
              Effect.mapError(
                () => new IssueBindings.IssueBindingGatewayError({ reason: "human-required" }),
              ),
            ),
        )
        .pipe(
          Effect.mapError((error) =>
            failure("write", error.reason === "human-required" ? "forbidden" : "rejected"),
          ),
        );
    }
    const result = yield* repository
      .executeAuthorized(
        command,
        () => Effect.succeed(command),
        command.type === "project-work.criterion.revoke-waiver"
          ? () => teamAuthorization.assertHuman(principal)
          : command.type !== "project-work.issue.refine"
            ? undefined
            : () =>
                Effect.gen(function* () {
                  if (Option.isNone(issueBindings)) return yield* failure("write", "unavailable");
                  yield* issueBindings.value
                    .assertRefinable(
                      command,
                      teamAuthorization.assertHuman(principal).pipe(
                        Effect.mapError(
                          () =>
                            new IssueBindings.IssueBindingGatewayError({
                              reason: "human-required",
                            }),
                        ),
                      ),
                    )
                    .pipe(
                      Effect.mapError((error) =>
                        failure(
                          "write",
                          error.reason === "human-required" ? "forbidden" : "rejected",
                        ),
                      ),
                    );
                }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ProjectWorkRpcError"
            ? error
            : failure(
                "write",
                error._tag === "ProjectWorkPolicyError" ? "rejected" : "unavailable",
              ),
        ),
      );
    return yield* decodeWriteResult(result.writeResult).pipe(
      Effect.mapError(() => failure("write", "unavailable")),
    );
  });

  const read = Effect.fn("ProjectWorkGateway.read")(function* (
    input: ProjectWorkReadIntent,
    principal?: ProjectWorkPrincipal,
  ) {
    const environmentId = yield* authorize(input.projectId, "read", principal);
    const bounded = {
      projectId: input.projectId,
      limit: input.limit ?? 50,
      offset: input.offset ?? 0,
    };
    const selectors = {
      ...bounded,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.state === undefined ? {} : { state: input.state }),
    };
    if (input.operation === "delivery-recovery") {
      if (Option.isNone(deliveryGateway) || principal === undefined || input.taskId === undefined)
        return yield* failure("read", "forbidden");
      return yield* deliveryGateway.value
        .recover(
          {
            projectId: input.projectId,
            taskId: input.taskId,
            limit: Math.min(32, input.limit ?? 32),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          },
          principal,
        )
        .pipe(Effect.mapError(() => failure("read", "rejected")));
    }
    if (input.operation === "memory-configuration") {
      if (Option.isNone(memoryConfiguration)) return yield* failure("read", "unavailable");
      return yield* memoryConfiguration.value
        .read({
          environmentId,
          owner: { kind: "project", projectId: input.projectId },
          ownerRevision: 0,
        })
        .pipe(Effect.mapError(() => failure("read", "rejected")));
    }
    if (
      [
        "memory-sources",
        "memory-shared-sources",
        "memory-current",
        "memory-recall",
        "memory-observations",
      ].includes(input.operation)
    ) {
      if (Option.isNone(memory)) return yield* failure("read", "unavailable");
      return yield* memory.value.read(input, principal);
    }
    if (input.operation === "verification-job") {
      if (Option.isNone(verification) || input.verificationJobId === undefined)
        return yield* failure("read", "unavailable");
      const receipt = yield* verification.value
        .read(input.projectId, input.verificationJobId)
        .pipe(Effect.mapError(() => failure("read", "unavailable")));
      if (Option.isNone(receipt) || receipt.value.manifest.taskId !== input.taskId) return null;
      return {
        kind: "verification-job",
        manifest: receipt.value.manifest,
        sha256: receipt.value.manifestHash,
      };
    }
    if (input.operation === "integration-sources") {
      if (Option.isNone(integrationSources) || input.taskId === undefined)
        return yield* failure("read", "unavailable");
      const state = yield* Repository.readCurrentState(sql, input.projectId).pipe(
        Effect.mapError(() => failure("read", "unavailable")),
      );
      return yield* integrationSources.value
        .read(state, {
          integrationTaskId: input.taskId,
          ...(input.ownSourceCursor === undefined
            ? {}
            : { ownSourceCursor: input.ownSourceCursor }),
          offset: input.offset ?? 0,
          limit: Math.min(64, input.limit ?? 32),
        })
        .pipe(Effect.mapError(() => failure("read", "rejected")));
    }
    const readCollection = <A>(
      load: (
        value: typeof selectors & { trusted?: true },
      ) => Effect.Effect<
        ReadonlyArray<A>,
        import("../persistence/Errors.ts").ProjectionRepositoryError
      >,
    ): Effect.Effect<unknown, ProjectWorkRpcError> =>
      query
        .withProjectRevision(
          input.projectId,
          load({ ...selectors, limit: bounded.limit + 1, trusted: true }),
        )
        .pipe(
          Effect.flatMap(({ value, revision }): Effect.Effect<unknown, Schema.SchemaError> =>
            input.envelope === true
              ? decodeEnvelope({
                  ...bounded,
                  revision,
                  hasMore: value.length > bounded.limit,
                  items: value.slice(0, bounded.limit),
                })
              : Effect.succeed(value.slice(0, bounded.limit)),
          ),
          Effect.mapError(() => failure("read", "unavailable")),
        );
    switch (input.operation) {
      case "supervision":
        if (Option.isNone(supervision)) return yield* failure("read", "unavailable");
        return yield* query
          .withProjectRevision(input.projectId, supervision.value.read(input.projectId))
          .pipe(
            Effect.map(({ value }) => value),
            Effect.mapError(() => failure("read", "unavailable")),
          );

      case "foundation-records":
        return yield* readCollection((value) =>
          query.listFoundationRecords({
            ...value,
            ...(input.recordKind === undefined ? {} : { kind: input.recordKind }),
          }),
        );
      case "tasks":
        return yield* readCollection(query.listTasks);
      case "criteria":
        return yield* readCollection(query.listCriteria);
      case "evidence":
        return yield* readCollection((value) =>
          query.listEvidence({
            ...value,
            ...(input.criterionId === undefined ? {} : { criterionId: input.criterionId }),
          }),
        );
      case "relationships":
        return yield* readCollection(query.listRelationships);
      case "blockers":
        return yield* readCollection(query.listBlockers);
      case "attention":
        return yield* readCollection(query.listAttention);
      case "activities":
        return yield* readCollection(query.listActivities);
      case "checkpoints":
        return yield* readCollection(query.listCheckpoints);
      case "knowledge":
        return yield* readCollection(query.listKnowledge);
      case "decisions":
        return yield* readCollection(query.listDecisions);
      case "comments":
        return yield* readCollection(query.listComments);
      case "task":
      case "task-context": {
        if (input.taskId === undefined) return yield* failure("read", "invalid-request");
        if (input.operation === "task")
          return yield* query.getTask(input.projectId, input.taskId).pipe(
            Effect.map(Option.getOrNull),
            Effect.mapError(() => failure("read", "unavailable")),
          );
        return yield* query.getTaskContext(input.projectId, input.taskId).pipe(
          Effect.map(Option.getOrNull),
          Effect.mapError(() => failure("read", "unavailable")),
        );
      }
      case "snapshot":
        return yield* query
          .snapshot(input.projectId)
          .pipe(Effect.mapError(() => failure("read", "unavailable")));
      case "search":
        return yield* search
          .search({
            ...selectors,
            query: input.query ?? "",
            ...(input.recordKinds === undefined ? {} : { recordKinds: input.recordKinds }),
            includeActivity: input.includeActivity ?? false,
          })
          .pipe(Effect.mapError(() => failure("read", "unavailable")));
      case "briefing":
        return yield* briefing
          .generate({ projectId: input.projectId, kind: input.kind ?? "standard" })
          .pipe(Effect.mapError(() => failure("read", "unavailable")));
      case "export-json":
      case "export-markdown": {
        if (input.exportVersion === 2) return yield* failure("read", "unavailable");
        const { snapshot, history } = yield* query
          .exportSnapshot(input.projectId, input.includeHistory ?? false)
          .pipe(Effect.mapError(() => failure("read", "unavailable")));
        const options = {
          environmentId,
          ...(history === undefined ? {} : { history }),
          version: input.exportVersion ?? 1,
        };
        return yield* input.operation === "export-json"
          ? exporter.json(snapshot, options)
          : exporter.markdown(snapshot, options);
      }
      default:
        return yield* failure("read", "unavailable");
    }
  });

  const subscribe = (input: ProjectWorkStreamInput, principal?: ProjectWorkPrincipal) =>
    Stream.unwrap(
      authorize(input.projectId, "subscribe", principal).pipe(
        Effect.andThen(stream.stream(input)),
        Effect.map((events) =>
          events.pipe(Stream.mapError(() => failure("subscribe", "unavailable"))),
        ),
        Effect.mapError((error) =>
          error._tag === "ProjectWorkRpcError" ? error : failure("subscribe", "unavailable"),
        ),
      ),
    );
  return ProjectWorkGateway.of({ read, write, subscribe, issue, delivery });
});

export const layer = Layer.effect(ProjectWorkGateway, make);
