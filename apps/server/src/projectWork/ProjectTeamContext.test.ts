import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import {
  ProjectWorkFoundationCommitCommand,
  ProjectTeamWriteIntent,
  canonicalProjectWorkPayload,
  EventId,
  ProjectId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  ProjectWorkCommand,
  ProjectWorkWriteIntent,
  ProjectTeamRecord as TeamRecordSchema,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  at,
  attribution,
  projectId,
  seed,
  scoped,
  createManagedAssignment,
  restoreHistoricalBinding,
  gatewayRuntime,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkProjection } from "./ProjectWorkProjection.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamContext, ProjectTeamContextError } from "./ProjectTeamContext.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";
import * as Accounting from "./ProjectTeamModelAccounting.ts";
import { makeProjectTeamReviewTargets } from "./ProjectTeamReviewTargets.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import { ProjectTeamAuthorization } from "./ProjectTeamAuthorization.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import * as Layer from "effect/Layer";
import { ProjectWorkVerificationRequest } from "./ProjectWorkVerificationRequest.ts";
import {
  makeProjectWorkVerificationGate,
  ProjectWorkVerificationApproval,
  ProjectWorkVerificationGateError,
} from "./ProjectWorkVerificationGate.ts";
import { managedActorId } from "./ProjectTeamAuthorization.ts";
import type {
  PiModelRequestReservation,
  PiModelRequestSettlement,
} from "../provider/pi/PiModelBroker.ts";

const encodeRetainedEvent = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeVerificationIntent = Schema.decodeUnknownEffect(ProjectTeamWriteIntent);
const decodeCommand = Schema.decodeUnknownEffect(ProjectWorkCommand);
const decodeRecord = Schema.decodeUnknownEffect(TeamRecordSchema);
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const decodeRetainedIntent = Schema.decodeUnknownEffect(ProjectWorkWriteIntent);

const makeFixture = (
  role: "implementer" | "integrator" | "planner" | "reviewer" | "investigator" = "implementer",
  writableWorkers = 1,
  readonlyKind?: "planning" | "review" | "investigation",
  verified = false,
  memoryAccess: "none" | "project" | "shared" = "none",
  messageAddresses = false,
) =>
  Effect.gen(function* () {
    const repository = yield* ProjectWorkRepository;
    const sql = yield* SqlClient.SqlClient;
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    // The real fixture commits approvals and the execution grant; intercept only its final claim.
    const parentVerification = verified ? yield* verificationFixture : undefined;
    const reviewId = verified ? "review-binding" : "binding";
    const roleId = verified ? "review-role" : "role";
    const memberId = verified ? "review-member" : "member";
    if (parentVerification) {
      const f = parentVerification;
      const auth = yield* ProjectTeamAuthorization;
      const gates = yield* makeProjectWorkVerificationGate({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
      });
      const human = {
        actor: f.principal.actor,
        source: { kind: "web" as const, id: "review-fixture" },
        recordedAt: at,
      };
      const trust = (selection: typeof f.selection) =>
        ProjectWorkVerificationApproval.of({
          selection,
          receipt: f.prepared,
          assertCurrent: (state, duplicate) =>
            gates.assertCurrent(state, f.prepared, selection, duplicate).pipe(
              Effect.mapError(
                () =>
                  new ProjectWorkVerificationGateError({
                    reason: "Controlled prepared target validation failed",
                  }),
              ),
            ),
        });
      const proposal = yield* decodeVerificationIntent({
        ...f.selection,
        type: "project-team.verification.propose",
        commandId: "review-verification-propose",
      });
      yield* repository.execute(
        yield* auth
          .intent(f.principal, proposal, human, false)
          .pipe(Effect.provideService(ProjectWorkVerificationApproval, trust(f.selection))),
      );
      const current = yield* readCurrentState(sql, projectId);
      const gate = current.foundationRecords?.find(
        (r) => r.kind === "gate" && r.verificationJobId === f.selection.jobId,
      );
      if (gate?.kind !== "gate") return yield* Effect.die("Missing verification proposal");
      const response = yield* decodeVerificationIntent({
        type: "project-team.gate.respond",
        commandId: "review-verification-approve",
        projectId,
        taskId: f.selection.taskId,
        expectedRevision: current.revision,
        expectedTaskRevision: f.selection.expectedTaskRevision,
        specRevision: f.selection.specRevision,
        planRevision: f.selection.planRevision,
        gateId: gate.recordId,
        expectedGateRevision: gate.revision,
        response: "approved",
      });
      yield* repository.execute(
        yield* auth
          .intent(f.principal, response, human, false)
          .pipe(
            Effect.provideService(
              ProjectWorkVerificationApproval,
              trust({ ...f.selection, expectedRevision: current.revision }),
            ),
            Effect.provideService(
              ProjectWorkVerificationRequest,
              ProjectWorkVerificationRequest.of({ assertCurrent: () => Effect.void }),
            ),
          ),
      );
      const records = (yield* readCurrentState(sql, projectId)).foundationRecords ?? [];
      const originalRole = records.find((r) => r.kind === "role-revision");
      const originalMember = records.find((r) => r.kind === "member");
      if (originalRole?.kind !== "role-revision" || originalMember?.kind !== "member")
        return yield* Effect.die("Missing original fixture member");
      yield* repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "review-member-setup",
          expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
          attribution,
          committedAt: at,
          records: [
            {
              ...originalRole,
              recordId: roleId,
              roleId: "reviewer",
              role: "reviewer",
              tools: ["pi.read"],
            },
            { ...originalMember, recordId: memberId, roleRevisionId: roleId },
          ],
        }),
      );
    }
    const result = parentVerification
      ? { _tag: "Failure" as const }
      : yield* seed(role, "reserved", {
          roleTools:
            role === "integrator" || readonlyKind
              ? ["pi.read"]
              : ["pi.read", "pi.write", ...(messageAddresses ? ["project-work.write"] : [])],
          toolIds:
            role === "integrator" || readonlyKind
              ? ["pi.read"]
              : ["pi.read", "pi.write", ...(messageAddresses ? ["project-work.write"] : [])],
          issueCredential: false,
        }).pipe(
          Effect.provideService(ProjectWorkRepository, {
            ...repository,
            execute: (command) => {
              if (
                command.type === "project-work.foundation.commit" &&
                command.commandId === "setup"
              )
                return repository.execute({
                  ...command,
                  records: command.records.map((record) =>
                    record.kind === "role-revision" ? { ...record, memoryAccess } : record,
                  ),
                });
              if (
                readonlyKind !== undefined &&
                readonlyKind !== "review" &&
                command.type === "project-work.foundation.commit" &&
                command.guided?.intent.type === "project-team.plan.propose"
              )
                return Effect.fail(
                  new ProjectWorkPolicyError("invalid-state", "Stop before first parent plan"),
                );
              if (
                command.type === "project-work.foundation.commit" &&
                command.transition?.kind === "claim"
              ) {
                pending = command;
                return Effect.fail(
                  new ProjectWorkPolicyError(
                    "invalid-state",
                    "Fixture retains the uncommitted claim",
                  ),
                );
              }
              return repository.execute(command);
            },
          }),
          Effect.result,
        );
    expect(result._tag).toBe("Failure");
    if (readonlyKind !== undefined) {
      let state = yield* readCurrentState(sql, projectId);
      const parent = state.tasks.find((task) => task.taskId === "authorization-task");
      const specGate = state.foundationRecords?.find(
        (r) => r.kind === "gate" && r.taskId === parent?.taskId && r.gate === "specification",
      );
      const plan = state.foundationRecords?.find(
        (r) => r.kind === "plan-revision" && r.taskId === parent?.taskId,
      );
      const planGate = state.foundationRecords?.find(
        (r) => r.kind === "gate" && r.taskId === parent?.taskId && r.gate === "plan",
      );
      if (!parent || specGate?.kind !== "gate")
        return yield* Effect.die("Missing real parent specification");
      const human = {
        actor: { kind: "human", id: "readonly-context-human" },
        source: { kind: "web", id: "readonly-context-browser" },
        recordedAt: at,
      } as const;
      const envelope = {
        projectId,
        taskId: parent.taskId,
        commandId: "readonly-context-grant",
        expectedRevision: state.revision,
        expectedTaskRevision: parent.revision,
      };
      yield* repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: envelope.commandId,
          expectedRevision: state.revision,
          attribution: human,
          committedAt: at,
          records: [],
          guided: {
            intent:
              readonlyKind === "investigation"
                ? {
                    ...envelope,
                    type: "project-team.investigation.start",
                    objective: "Investigate original bounded scope",
                    outputDescriptions: ["Sourced investigation findings"],
                  }
                : {
                    ...envelope,
                    type: "project-team.assignment.start",
                    assignmentKind: readonlyKind,
                    objective:
                      readonlyKind === "planning"
                        ? "Draft the first approved plan"
                        : "Review original approved scope",
                    outputDescriptions: [
                      readonlyKind === "planning"
                        ? "Proposed first plan"
                        : "Independent review findings",
                    ],
                    specRevision: parent.specRevision,
                    specificationGateId: specGate.recordId,
                    expectedSpecificationGateRevision: specGate.revision,
                    ...(readonlyKind === "review" &&
                    plan?.kind === "plan-revision" &&
                    planGate?.kind === "gate"
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
                  },
          },
        }),
      );
      state = yield* readCurrentState(sql, projectId);
      const grant = state.foundationRecords?.find(
        (r) =>
          r.kind === "gate" &&
          r.taskId !== parent.taskId &&
          (r.gate === "assignment" || r.gate === "investigation"),
      );
      const task = state.tasks.find(
        (task) => task.taskId === (grant?.kind === "gate" ? grant.taskId : undefined),
      );
      const roleRecord = state.foundationRecords?.find(
        (r) => r.kind === "role-revision" && r.recordId === roleId,
      );
      if (!task || grant?.kind !== "gate" || roleRecord?.kind !== "role-revision")
        return yield* Effect.die("Missing real readonly child grant");
      const binding = {
        kind: "run-binding",
        projectId,
        recordId: reviewId,
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "reserved",
        taskId: task.taskId,
        attemptId: verified ? "review-attempt" : "attempt",
        memberId,
        roleRevisionId: roleRecord.recordId,
        providerInstanceId: ProviderInstanceId.make("pi"),
        threadId: ThreadId.make(verified ? "review-thread" : "authorization-thread"),
        environmentId: "environment",
        model: roleRecord.model,
        configuration: {
          instructionsHash: "hash",
          toolIds: ["pi.read"],
          skillIds: [],
          runtimeVersion: "test",
          maxTokens: 1000,
          maxDurationMs: 1000,
          paidFallback: false,
        },
        worktree: "/workspace",
        branch: "task",
        leaseGeneration: 0,
        specRevision: task.specRevision,
        planRevision: 0,
        authorizationGateId: grant.recordId,
        scopeHash: projectTeamScopeHash(state, task.taskId),
      };
      pending = yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "readonly-context-claim",
        expectedRevision: state.revision,
        attribution,
        committedAt: at,
        records: [],
        transition: {
          kind: "claim",
          taskId: task.taskId,
          expectedTaskRevision: task.revision,
          authorizationGateId: grant.recordId,
          expectedGateRevision: grant.revision,
          binding,
          claim: {
            type: "project-work.task.claim",
            projectId,
            taskId: task.taskId,
            commandId: "readonly-context-claim",
            attemptId: verified ? "review-attempt" : "attempt",
            leaseToken: "readonly-context-lease",
            leasedUntil: "2030-01-01T00:00:00.000Z",
            claimedAt: at,
          },
        },
      });
    }
    if (!pending || pending.transition?.kind !== "claim")
      return yield* Effect.die("Fixture did not capture its claim");
    yield* repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: verified ? "review-configure-limits" : "configure-limits",
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution,
        committedAt: at,
        records: [
          {
            kind: "limits",
            projectId,
            recordId: "limits",
            revision: verified ? 1 : 0,
            generation: 0,
            updatedAt: at,
            status: "configured",
            environmentModelCalls: 4,
            projectWritableWorkers: writableWorkers,
            modelCalls: 2,
            delegationDepth: 2,
            repairAllowance: 2,
            model: "test",
            tokenLimit: 2000,
            durationLimitMs: 2000,
          },
        ],
      }),
    );
    yield* TestClock.setTime(Date.parse(at) + 1);
    const claim = {
      ...pending,
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      transition: {
        ...pending.transition,
        binding: {
          ...pending.transition.binding,
          branch: "refs/heads/assigned",
          worktree: "/workspace-assigned",
        },
      },
    };
    const request: ProjectTeamDispatchRequest = {
      dispatchId: verified ? "review-dispatch" : "dispatch-intent",
      claim,
      git: {
        effectId: verified ? "review-dispatch" : "dispatch-intent",
        runId: reviewId,
        generation: 0,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: "/workspace-assigned",
        branchRef: "refs/heads/assigned",
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: "owner",
        policyHash: "b".repeat(64),
      },
      setupId: "setup",
      initializeOperationId: verified ? "review-initialize" : "initialize",
      assignmentOperationId: verified ? "review-assignment" : "assignment",
      assignment: "Implement the approved task",
    };
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const reserved = yield* journal.reserve(request);
    const snapshot = yield* journal.claimEffect(reserved.fence);
    const reader = yield* makeProjectTeamContext({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const change = Effect.fn("contextFixture.change")(function* (record: ProjectTeamRecord) {
      yield* repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "change-" + record.recordId + "-" + record.revision,
          expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
          attribution,
          committedAt: at,
          records: [record],
        }),
      );
    });
    return { sql, repository, request, journal, snapshot, reader, change, parentVerification };
  });

it.effect(
  "provides accepted decisions and current retained knowledge on a later prepared context read",
  () =>
    Effect.gen(function* () {
      const f = yield* makeFixture("implementer", 1, undefined, false, "project");
      const gateway = yield* ProjectWorkGateway;
      const actor = { kind: "human" as const, id: "context-human" };
      const source = { kind: "web" as const, id: "context-browser" };
      const write = (input: unknown) =>
        decodeRetainedIntent(input).pipe(
          Effect.flatMap((intent) => gateway.write(intent, actor, source)),
        );
      const before = yield* f.reader.readRequired(f.snapshot);
      yield* write({
        type: "project-work.decision.propose",
        projectId,
        commandId: "context-propose",
        decision: {
          decisionId: "context-decision",
          projectId,
          title: "Compatibility",
          body: "Keep the existing format",
          state: "proposed",
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        proposedAt: at,
      });
      yield* write({
        type: "project-work.decision.accept",
        projectId,
        commandId: "context-accept",
        decisionId: "context-decision",
        acceptedAt: at,
      });
      yield* write({
        type: "project-work.knowledge.promote",
        projectId,
        commandId: "context-promote",
        knowledge: {
          knowledgeId: "context-knowledge",
          projectId,
          title: "Build",
          body: "Use the retained build recipe",
          sourceKind: "manual",
          sourceId: "context-human",
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        promotedAt: at,
      });
      const original = yield* f.sql<{
        actor: string;
        source: string;
        recordedAt: string;
        occurredAt: string;
        receiptAt: string;
      }>`SELECT
      json_extract(e.payload_json,'$.attribution.actor.id') AS actor,json_extract(e.payload_json,'$.attribution.source.id') AS source,
      json_extract(e.payload_json,'$.attribution.recordedAt') AS recordedAt,e.occurred_at AS occurredAt,r.created_at AS receiptAt
      FROM project_work_events e JOIN project_work_command_receipts r ON r.project_id=e.project_id AND r.command_id=e.command_id
      WHERE e.project_id=${projectId} AND e.command_id='context-accept'`;
      expect(original).toHaveLength(1);
      expect(original[0]).toMatchObject({
        actor: actor.id,
        source: source.id,
        occurredAt: at,
        receiptAt: at,
      });
      expect(original[0]?.recordedAt).not.toBe(original[0]?.receiptAt);
      const after = yield* f.reader.readRequired(f.snapshot);
      expect(before.required).toMatchObject({ decisions: [] });
      expect(after.required).toMatchObject({
        decisions: [{ decisionId: "context-decision", state: "accepted" }],
      });
      expect(after).toMatchObject({
        retainedKnowledge: {
          status: "available",
          records: [{ knowledgeId: "context-knowledge", sourceKind: "manual" }],
          omitted: [],
        },
      });
      expect(after.text).toContain("Keep the existing format");
      expect(after.text).toContain("Use the retained build recipe");
      expect(after.provenance).not.toEqual(before.provenance);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

const denied = Effect.fn("contextFixture.denied")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const result = yield* effect.pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ProjectTeamContextError);
});
const retainedWriter = Effect.fn("contextFixture.retainedWriter")(function* (decorations?: {
  readonly displayName: string;
  readonly uri: string;
  readonly createdAt?: string;
}) {
  const gateway = yield* ProjectWorkGateway;
  const actor = {
    kind: "human" as const,
    id: "retained-human",
    ...(decorations === undefined ? {} : { displayName: decorations.displayName }),
  };
  const source = {
    kind: "web" as const,
    id: "retained-browser",
    ...(decorations === undefined ? {} : { uri: decorations.uri }),
  };
  const write = (input: unknown) =>
    decodeRetainedIntent(input).pipe(
      Effect.flatMap((intent) => gateway.write(intent, actor, source)),
    );
  const decision = (decisionId: string, body = "Retained constraint", owner = projectId) => ({
    decisionId,
    projectId: owner,
    title: decisionId,
    body,
    state: "proposed",
    revision: 0,
    createdAt: decorations?.createdAt ?? at,
    updatedAt: at,
  });
  return {
    propose: (id: string, body?: string, owner = projectId) =>
      write({
        type: "project-work.decision.propose",
        projectId: owner,
        commandId: "propose-" + id,
        decision: decision(id, body, owner),
        proposedAt: at,
      }),
    accept: (id: string, owner = projectId) =>
      write({
        type: "project-work.decision.accept",
        projectId: owner,
        commandId: "accept-" + id,
        decisionId: id,
        acceptedAt: at,
      }),
    reject: (id: string) =>
      write({
        type: "project-work.decision.reject",
        projectId,
        commandId: "reject-" + id,
        decisionId: id,
        reason: "Rejected constraint",
        rejectedAt: at,
      }),
    replace: (id: string, replacement: string) =>
      write({
        type: "project-work.decision.supersede",
        projectId,
        commandId: "replace-" + id,
        decisionId: id,
        replacement: decision(replacement),
        supersededAt: at,
        attribution: { actor, source, recordedAt: at },
      }),
    promote: (id: string, previous?: string, body = "Retained knowledge", owner = projectId) =>
      write({
        type: "project-work.knowledge.promote",
        projectId: owner,
        commandId: "promote-" + id,
        knowledge: {
          knowledgeId: id,
          projectId: owner,
          title: id,
          body,
          sourceKind: "manual",
          sourceId: actor.id,
          revision: 0,
          createdAt: decorations?.createdAt ?? at,
          updatedAt: at,
          ...(previous === undefined ? {} : { supersedesKnowledgeId: previous }),
        },
        promotedAt: at,
      }),
  };
});
const withRetainedGateway = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(gatewayRuntime)));

it.effect(
  "private communication addresses survive memory none and degrade without hiding required context",
  () =>
    withRetainedGateway(
      Effect.gen(function* () {
        const f = yield* makeFixture("implementer", 2, undefined, false, "none", true);
        const before = yield* readCurrentState(f.sql, projectId);
        const own =
          f.snapshot.intent.request.claim.transition?.kind === "claim"
            ? f.snapshot.intent.request.claim.transition.binding
            : undefined;
        const role = before.foundationRecords?.find(
          (r) => r.kind === "role-revision" && r.recordId === own?.roleRevisionId,
        );
        const member = before.foundationRecords?.find(
          (r) => r.kind === "member" && r.recordId === own?.memberId,
        );
        if (!own || role?.kind !== "role-revision" || member?.kind !== "member")
          return yield* Effect.die("Missing original communication owner");
        yield* f.change({ ...member, recordId: "context-message-peer", coordinator: false });
        const peer = yield* createManagedAssignment({
          taskId: ProjectWorkTaskId.make("context-message-task"),
          recordId: "context-message-binding",
          attemptId: "context-message-attempt",
          commandId: "context-message-claim",
          providerInstanceId: own.providerInstanceId,
          threadId: ThreadId.make("context-message-thread"),
          role,
          status: "running",
          configuration: own.configuration,
          memberId: "context-message-peer",
          sessionId: "context-message-session",
        });
        const issued = yield* readCurrentState(f.sql, projectId);
        const memberships =
          issued.foundationRecords?.filter(
            (r) =>
              r.kind === "task-membership" && (r.taskId === own.taskId || r.taskId === peer.taskId),
          ) ?? [];
        expect(memberships).toHaveLength(2);
        yield* f.repository.execute(
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "context-message-mission",
            expectedRevision: issued.revision,
            committedAt: at,
            attribution: {
              actor: { kind: "human", id: "context-message-human" },
              source: { kind: "web", id: "context-message-browser" },
              recordedAt: at,
            },
            records: [
              {
                kind: "mission",
                recordId: "context-message-mission",
                projectId,
                revision: 0,
                generation: 0,
                updatedAt: at,
                status: "active",
                title: "Communication",
                objective: "Bounded coordination",
                requiredTaskIds: [own.taskId, peer.taskId],
              },
              ...memberships.map((r) => ({
                ...r,
                missionId: "context-message-mission",
                revision: r.revision + 1,
              })),
            ],
          }),
        );
        const available = yield* f.reader.readRequired(f.snapshot);
        expect(available.retainedKnowledge).toEqual({
          status: "disabled",
          records: [],
          omitted: [],
        });
        expect(available.communication.recipients).toEqual([
          expect.objectContaining({
            memberId: peer.memberId,
            taskId: peer.taskId,
            relation: "active-mission",
          }),
        ]);
        expect(available.text).toContain("context-message-peer");
        expect(available.required).not.toHaveProperty("communication");
        const protectedText =
          "Required context from retained T3 authority. This read snapshot grants no new approval.\n" +
          canonicalProjectWorkPayload(available.required);
        const limited = yield* f.reader.readRequired(f.snapshot, {
          optionalTextBudgetBytes: Buffer.byteLength(protectedText, "utf8"),
        });
        expect(limited.required).toEqual(available.required);
        expect(limited.communication).toEqual({ recipients: [], omitted: 1, degraded: true });
        expect(limited.text).toBe(protectedText);
        expect(limited.provenance).not.toEqual(available.provenance);
        const current = yield* readCurrentState(f.sql, projectId);
        const membership = current.foundationRecords?.find(
          (r) => r.kind === "task-membership" && r.taskId === peer.taskId,
        );
        if (membership?.kind !== "task-membership")
          return yield* Effect.die("Missing current peer membership");
        yield* f.change({
          ...membership,
          revision: membership.revision + 1,
          controlState: "paused",
        });
        const paused = yield* readCurrentState(f.sql, projectId);
        const omitted = yield* f.reader.readRequired(f.snapshot);
        expect(omitted.required).toEqual({
          ...available.required,
          sourceRevision: paused.revision,
        });
        expect(omitted.communication).toEqual({ recipients: [], omitted: 1, degraded: true });
        expect(omitted.provenance).not.toEqual(available.provenance);
      }),
    ),
);

it.effect(
  "retained context includes only accepted decisions and observes an accepted replacement",
  () =>
    withRetainedGateway(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const w = yield* retainedWriter();
        yield* w.propose("pending");
        yield* w.propose("rejected");
        yield* w.reject("rejected");
        yield* w.propose("original");
        yield* w.accept("original");
        const original = yield* f.reader.readRequired(f.snapshot);
        expect(original.required.decisions.map((record) => record.decisionId)).toEqual([
          "original",
        ]);
        yield* w.replace("original", "replacement");
        expect((yield* f.reader.readRequired(f.snapshot)).required.decisions).toEqual([]);
        yield* w.accept("replacement");
        const current = yield* f.reader.readRequired(f.snapshot);
        expect(current.required.decisions.map((record) => record.decisionId)).toEqual([
          "replacement",
        ]);
        expect(current.required.decisions[0]?.attribution).toMatchObject({
          actor: { kind: "human", id: "retained-human" },
          source: { kind: "web", id: "retained-browser" },
        });
        expect(current.text).not.toContain('"state":"superseded"');
        expect(current.provenance.decisions).not.toEqual(original.provenance.decisions);
      }),
    ),
);

for (const memoryAccess of ["none", "project", "shared"] as const)
  it.effect(`retained context honors frozen ${memoryAccess} knowledge access`, () =>
    withRetainedGateway(
      Effect.gen(function* () {
        const f = yield* makeFixture("implementer", 1, undefined, false, memoryAccess);
        const w = yield* retainedWriter();
        yield* w.promote("local", undefined, "Same-project manual recipe");
        if (memoryAccess === "none")
          yield* f.sql`DELETE FROM project_work_command_receipts WHERE command_id='promote-local'`;
        const result = yield* f.reader.readRequired(f.snapshot);
        expect(result.retainedKnowledge.status).toBe(
          memoryAccess === "none" ? "disabled" : "available",
        );
        expect(result.retainedKnowledge.records.map((record) => record.knowledgeId)).toEqual(
          memoryAccess === "none" ? [] : ["local"],
        );
        expect(result.text.includes("Same-project manual recipe")).toBe(memoryAccess !== "none");
      }),
    ),
  );

it.effect(
  "retained context selects a complete knowledge replacement chain without crossing projects",
  () =>
    withRetainedGateway(
      Effect.gen(function* () {
        const f = yield* makeFixture("implementer", 1, undefined, false, "shared");
        const w = yield* retainedWriter();
        const foreign = ProjectId.make("foreign-context-project");
        yield* f.sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${foreign},'Foreign','/foreign','[]',${at},${at})`;
        yield* w.promote("foreign", undefined, "Foreign secret", foreign);
        yield* w.propose("foreign-decision", "Foreign constraint", foreign);
        yield* w.accept("foreign-decision", foreign);
        yield* w.promote("a", undefined, "Old knowledge");
        yield* w.promote("b", "a", "Intermediate knowledge");
        const before = yield* f.reader.readRequired(f.snapshot);
        expect(before.retainedKnowledge.records.map((record) => record.knowledgeId)).toEqual(["b"]);
        yield* w.promote("c", "b", "Current knowledge");
        const after = yield* f.reader.readRequired(f.snapshot);
        expect(after.retainedKnowledge.records.map((record) => record.knowledgeId)).toEqual(["c"]);
        expect(after.required.decisions).toEqual([]);
        expect(after.text).toContain("Current knowledge");
        for (const hidden of [
          "Old knowledge",
          "Intermediate knowledge",
          "Foreign secret",
          "Foreign constraint",
        ])
          expect(after.text).not.toContain(hidden);
        expect(after.provenance.retainedKnowledge).not.toEqual(before.provenance.retainedKnowledge);
      }),
    ),
);

for (const closure of ["missing", "foreign", "self", "fork", "cycle"] as const)
  it.effect(
    `retained knowledge degrades for ${closure} replacement closure while preserving required decisions`,
    () =>
      withRetainedGateway(
        Effect.gen(function* () {
          const f = yield* makeFixture("implementer", 1, undefined, false, "project");
          const w = yield* retainedWriter();
          yield* w.propose("required");
          yield* w.accept("required");
          if (closure === "missing") yield* w.promote("a", "missing");
          if (closure === "foreign") {
            const foreign = ProjectId.make("foreign-context-project");
            yield* f.sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${foreign},'Foreign','/foreign','[]',${at},${at})`;
            yield* w.promote("foreign", undefined, "Foreign secret", foreign);
            yield* w.promote("a", "foreign");
          }
          if (closure === "self") yield* w.promote("a", "a");
          if (closure === "fork") {
            yield* w.promote("a");
            yield* w.promote("b", "a");
            yield* w.promote("c", "a");
          }
          if (closure === "cycle") {
            yield* w.promote("a", "b");
            yield* w.promote("b", "a");
          }
          const result = yield* f.reader.readRequired(f.snapshot);
          expect(result.retainedKnowledge).toMatchObject({ status: "degraded", records: [] });
          expect(result.retainedKnowledge.omitted.length).toBeGreaterThan(0);
          expect(result.required.decisions.map((record) => record.decisionId)).toEqual([
            "required",
          ]);
          expect(result.text).not.toContain('"body":"Retained knowledge"');
          expect(result.text).toContain("Optional same-project knowledge status: degraded.");
        }),
      ),
  );

for (const corruption of [
  "receipt-actor",
  "receipt-membership",
  "receipt-delta",
  "projection",
  "missing-proposal",
] as const)
  it.effect(`required retained decisions deny ${corruption} corruption`, () =>
    withRetainedGateway(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const w = yield* retainedWriter();
        yield* w.propose("required");
        yield* w.accept("required");
        expect((yield* f.reader.readRequired(f.snapshot)).required.decisions).toHaveLength(1);
        if (corruption === "receipt-actor")
          yield* f.sql`UPDATE project_work_command_receipts SET actor_id='substituted-human' WHERE command_id='accept-required'`;
        if (corruption === "receipt-membership")
          yield* f.sql`UPDATE project_work_command_receipts SET event_ids_json='[]' WHERE command_id='accept-required'`;
        if (corruption === "receipt-delta")
          yield* f.sql`UPDATE project_work_command_receipts SET result_json=json_set(result_json,'$.delta.changedFields',json('[]')) WHERE command_id='accept-required'`;
        if (corruption === "projection")
          yield* f.sql`UPDATE project_work_decisions SET body='Substituted constraint' WHERE decision_id='required'`;
        if (corruption === "missing-proposal")
          yield* f.sql`DELETE FROM project_work_events WHERE command_id='propose-required'`;
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
  );

for (const corruption of [
  "receipt",
  "projection",
  "missing-event",
  "duplicate",
  "storage",
] as const)
  it.effect(`optional retained knowledge degrades for ${corruption} corruption`, () =>
    withRetainedGateway(
      Effect.gen(function* () {
        const f = yield* makeFixture("implementer", 1, undefined, false, "project");
        const w = yield* retainedWriter();
        yield* w.promote("optional");
        const before = yield* f.reader.readRequired(f.snapshot);
        expect(before.retainedKnowledge.status).toBe("available");
        if (corruption === "receipt")
          yield* f.sql`UPDATE project_work_command_receipts SET actor_id='substituted-human' WHERE command_id='promote-optional'`;
        if (corruption === "projection")
          yield* f.sql`UPDATE project_work_knowledge SET body='Substituted body' WHERE knowledge_id='optional'`;
        if (corruption === "missing-event")
          yield* f.sql`DELETE FROM project_work_events WHERE command_id='promote-optional'`;
        if (corruption === "duplicate") {
          yield* w.promote("other");
          yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.knowledge.knowledgeId','optional') WHERE command_id='promote-other'`;
        }
        if (corruption === "storage") yield* f.sql`DROP TABLE project_work_knowledge`;
        const after = yield* f.reader.readRequired(f.snapshot);
        if (corruption === "duplicate")
          expect(after.required.decisions).toEqual(before.required.decisions);
        else expect(after.required).toEqual(before.required);
        expect(after.retainedKnowledge).toMatchObject({ status: "degraded", records: [] });
        expect(after.text).toContain("Optional same-project knowledge status: degraded.");
        expect(after.provenance.retainedKnowledge).not.toEqual(before.provenance.retainedKnowledge);
      }),
    ),
  );

it.effect(
  "retained knowledge respects the real caller text allowance without dropping required decisions",
  () =>
    withRetainedGateway(
      Effect.gen(function* () {
        const f = yield* makeFixture("implementer", 1, undefined, false, "project");
        const w = yield* retainedWriter();
        yield* w.propose("required");
        yield* w.accept("required");
        yield* w.promote("optional");
        const available = yield* f.reader.readRequired(f.snapshot);
        const requiredBytes = Buffer.byteLength(
          "Required context from retained T3 authority. This read snapshot grants no new approval.\n" +
            canonicalProjectWorkPayload(available.required),
          "utf8",
        );
        const limited = yield* f.reader.readRequired(f.snapshot, {
          optionalTextBudgetBytes: requiredBytes,
        });
        expect(limited.required).toEqual(available.required);
        expect(limited.retainedKnowledge).toMatchObject({ status: "degraded", records: [] });
        expect(Buffer.byteLength(limited.text, "utf8")).toBe(requiredBytes);
        expect(limited.text).not.toContain("Retained knowledge");
        expect(
          (yield* f.reader.readRequired(f.snapshot, {
            optionalTextBudgetBytes: Buffer.byteLength(available.text, "utf8"),
          })).text,
        ).toBe(available.text);
        for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
          const read = yield* f.reader.readRequired(f.snapshot, {
            optionalTextBudgetBytes: invalid,
          });
          expect(read.required).toEqual(available.required);
          expect(read.retainedKnowledge.status).toBe("degraded");
        }
      }),
    ),
);

for (const bound of ["selection", "UTF8", "closure"] as const)
  it.effect(`retained knowledge ${bound} overflow falls back to required context`, () =>
    withRetainedGateway(
      Effect.gen(function* () {
        const f = yield* makeFixture("implementer", 1, undefined, false, "project");
        const w = yield* retainedWriter();
        if (bound === "selection")
          for (let index = 0; index < 13; index++) yield* w.promote("optional-" + index);
        if (bound === "UTF8") yield* w.promote("optional", undefined, "界".repeat(3000));
        if (bound === "closure") {
          // Invalid physical rows exercise the bounded fallback, without manufacturing trusted knowledge.
          for (let index = 0; index < 257; index++)
            yield* f.sql`INSERT INTO project_work_knowledge (knowledge_id,project_id,title,body,source_kind,source_id,revision,created_at,updated_at) VALUES (${"untrusted-" + index},${projectId},'Untrusted','Untrusted','manual','untrusted',0,${at},${at})`;
        }
        const read = yield* f.reader.readRequired(f.snapshot);
        expect(read.retainedKnowledge).toMatchObject({ status: "degraded", records: [] });
        expect(read.required.runId).toBe("binding");
        expect(read.text).not.toContain("Untrusted");
      }),
    ),
  );

it.effect("required retained decision UTF8 overflow denies instead of omitting constraints", () =>
  withRetainedGateway(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const w = yield* retainedWriter();
      for (let index = 0; index < 3; index++) {
        const id = "large-" + index;
        yield* w.propose(id, "界".repeat(32000));
        yield* w.accept(id);
      }
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);
for (const kind of ["decision", "knowledge"] as const)
  for (const metadata of ["event", "receipt"] as const)
    it.effect(`retained context bounds oversized ${kind} ${metadata} metadata`, () =>
      withRetainedGateway(
        Effect.gen(function* () {
          const f = yield* makeFixture("implementer", 1, undefined, false, "project");
          const w = yield* retainedWriter();
          yield* w.propose("required");
          yield* w.accept("required");
          yield* w.promote("optional");
          const before = yield* f.reader.readRequired(f.snapshot);
          const command = kind === "decision" ? "accept-required" : "promote-optional";
          const oversized = "x".repeat(262145);
          if (metadata === "event")
            yield* f.sql`UPDATE project_work_events SET command_id=${oversized} WHERE command_id=${command}`;
          else
            yield* f.sql`UPDATE project_work_command_receipts SET actor_id=${oversized} WHERE command_id=${command}`;
          if (kind === "decision") yield* denied(f.reader.readRequired(f.snapshot));
          else {
            const after = yield* f.reader.readRequired(f.snapshot);
            expect(after.required).toEqual(before.required);
            expect(after.retainedKnowledge).toMatchObject({ status: "degraded", records: [] });
            expect(after.text).toContain("Optional same-project knowledge status: degraded.");
          }
        }),
      ),
    );
for (const producer of ["proposal", "replacement", "knowledge"] as const)
  for (const corruption of [
    "missing",
    "actor-kind",
    "actor-id",
    "source-kind",
    "source-id",
    "recordedAt",
  ] as const)
    it.effect(`retained context binds nested ${producer} attribution for ${corruption}`, () =>
      withRetainedGateway(
        Effect.gen(function* () {
          const f = yield* makeFixture("implementer", 1, undefined, false, "project");
          const w = yield* retainedWriter();
          const id = "nested-current";
          if (producer === "knowledge") yield* w.promote(id);
          else {
            yield* w.propose(producer === "replacement" ? "nested-original" : id);
            if (producer === "replacement") {
              yield* w.accept("nested-original");
              yield* w.replace("nested-original", id);
            }
            yield* w.accept(id);
          }
          const before = yield* f.reader.readRequired(f.snapshot);
          const commandId =
            producer === "knowledge"
              ? "promote-" + id
              : producer === "replacement"
                ? "replace-nested-original"
                : "propose-" + id;
          const custody = () => f.sql`
            SELECT json_extract(e.payload_json,'$.attribution') AS attribution,
            e.event_id,e.occurred_at,r.actor_kind,r.actor_id,r.source_kind,r.source_id,r.created_at,r.event_ids_json,r.result_json
            FROM project_work_events e JOIN project_work_command_receipts r
            ON r.project_id=e.project_id AND r.command_id=e.command_id
            WHERE e.project_id=${projectId} AND e.command_id=${commandId}`;
          const original = yield* custody();
          expect(original).toHaveLength(1);
          expect(original[0]).toMatchObject({
            actor_id: "retained-human",
            source_id: "retained-browser",
          });
          const field =
            corruption === "actor-kind"
              ? ".actor.kind"
              : corruption === "actor-id"
                ? ".actor.id"
                : corruption === "source-kind"
                  ? ".source.kind"
                  : corruption === "source-id"
                    ? ".source.id"
                    : corruption === "recordedAt"
                      ? ".recordedAt"
                      : "";
          const value =
            corruption === "actor-kind"
              ? "agent"
              : corruption === "source-kind"
                ? "mcp"
                : corruption === "recordedAt"
                  ? "2026-01-02T00:00:00.000Z"
                  : "substituted-authority";
          const nested =
            producer === "knowledge"
              ? "knowledge"
              : producer === "replacement"
                ? "replacement"
                : "decision";
          const eventPath = "$." + nested + ".attribution" + field;
          const stateField = producer === "knowledge" ? "knowledge" : "decisions";
          const idField = producer === "knowledge" ? "knowledgeId" : "decisionId";
          if (corruption === "missing") {
            yield* f.sql`UPDATE project_work_events SET payload_json=json_remove(payload_json,${eventPath}) WHERE project_id=${projectId} AND command_id=${commandId}`;
            if (producer === "knowledge")
              yield* f.sql`UPDATE project_work_knowledge SET attribution_json=NULL WHERE project_id=${projectId} AND knowledge_id=${id}`;
            else
              yield* f.sql`UPDATE project_work_decisions SET attribution_json=NULL WHERE project_id=${projectId} AND decision_id=${id}`;
            yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_remove(state_json,(SELECT fullkey||'.attribution' FROM json_each(state_json,${"$." + stateField}) WHERE json_extract(value,${"$." + idField})=${id})) WHERE project_id=${projectId}`;
          } else {
            yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,${eventPath},${value}) WHERE project_id=${projectId} AND command_id=${commandId}`;
            if (producer === "knowledge")
              yield* f.sql`UPDATE project_work_knowledge SET attribution_json=json_set(attribution_json,${"$" + field},${value}) WHERE project_id=${projectId} AND knowledge_id=${id}`;
            else
              yield* f.sql`UPDATE project_work_decisions SET attribution_json=json_set(attribution_json,${"$" + field},${value}) WHERE project_id=${projectId} AND decision_id=${id}`;
            yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,(SELECT fullkey||'.attribution'||${field} FROM json_each(state_json,${"$." + stateField}) WHERE json_extract(value,${"$." + idField})=${id}),${value}) WHERE project_id=${projectId}`;
          }
          expect(yield* custody()).toEqual(original);
          const changed = yield* readCurrentState(f.sql, projectId);
          const record =
            producer === "knowledge"
              ? changed.knowledge?.find((entry) => entry.knowledgeId === id)
              : changed.decisions?.find((entry) => entry.decisionId === id);
          expect(record).toBeDefined();
          if (corruption === "missing") expect(record?.attribution).toBeUndefined();
          else
            expect(record?.attribution).not.toEqual(
              producer === "knowledge"
                ? before.retainedKnowledge.records[0]?.attribution
                : before.required.decisions[0]?.attribution,
            );
          if (producer === "knowledge") {
            const after = yield* f.reader.readRequired(f.snapshot);
            expect(after.required).toEqual(before.required);
            expect(after.retainedKnowledge).toMatchObject({ status: "degraded", records: [] });
            expect(after.text).toContain("Optional same-project knowledge status: degraded.");
          } else yield* denied(f.reader.readRequired(f.snapshot));
        }),
      ),
    );

it.effect("retained context preserves nested producer decorations and distinct timestamps", () =>
  withRetainedGateway(
    Effect.gen(function* () {
      const f = yield* makeFixture("implementer", 1, undefined, false, "project");
      const createdAt = "2025-12-31T00:00:00.000Z";
      const w = yield* retainedWriter({
        displayName: "Original human",
        uri: "https://example.test/source",
        createdAt,
      });
      yield* w.propose("decorated-proposal");
      yield* w.accept("decorated-proposal");
      yield* w.propose("decorated-original");
      yield* w.accept("decorated-original");
      yield* w.replace("decorated-original", "decorated-replacement");
      yield* w.accept("decorated-replacement");
      yield* w.promote("decorated-knowledge");
      const produced = yield* f.sql<{
        recordedAt: string;
        nestedAt: string;
        receiptAt: string;
        eventAt: string;
        createdAt: string;
      }>`SELECT
        json_extract(e.payload_json,'$.attribution.recordedAt') AS recordedAt,
        COALESCE(json_extract(e.payload_json,'$.decision.attribution.recordedAt'),json_extract(e.payload_json,'$.replacement.attribution.recordedAt'),json_extract(e.payload_json,'$.knowledge.attribution.recordedAt')) AS nestedAt,
        COALESCE(json_extract(e.payload_json,'$.decision.createdAt'),json_extract(e.payload_json,'$.replacement.createdAt'),json_extract(e.payload_json,'$.knowledge.createdAt')) AS createdAt,
        e.occurred_at AS eventAt,r.created_at AS receiptAt
        FROM project_work_events e JOIN project_work_command_receipts r ON r.project_id=e.project_id AND r.command_id=e.command_id
        WHERE e.project_id=${projectId} AND e.command_id IN ('propose-decorated-proposal','replace-decorated-original','promote-decorated-knowledge')`;
      expect(produced).toHaveLength(3);
      for (const row of produced) {
        expect(row.recordedAt).toBe(row.nestedAt);
        expect(row.recordedAt).not.toBe(row.receiptAt);
        expect(row.createdAt).toBe(createdAt);
        expect(row.createdAt).not.toBe(row.eventAt);
        expect(row.eventAt).toBe(row.receiptAt);
      }
      const before = yield* f.reader.readRequired(f.snapshot);
      for (const record of [...before.required.decisions, ...before.retainedKnowledge.records])
        expect(record.attribution).toMatchObject({
          actor: { kind: "human", id: "retained-human", displayName: "Original human" },
          source: { kind: "web", id: "retained-browser", uri: "https://example.test/source" },
        });
      // Decorations may differ without substituting authority or its server timestamp.
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.decision.attribution.actor.displayName','Record label','$.decision.attribution.source.uri','https://example.test/record') WHERE project_id=${projectId} AND command_id='propose-decorated-proposal'`;
      yield* f.sql`UPDATE project_work_decisions SET attribution_json=json_set(attribution_json,'$.actor.displayName','Record label','$.source.uri','https://example.test/record') WHERE project_id=${projectId} AND decision_id='decorated-proposal'`;
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,(SELECT fullkey||'.attribution.actor.displayName' FROM json_each(state_json,'$.decisions') WHERE json_extract(value,'$.decisionId')='decorated-proposal'),'Record label',(SELECT fullkey||'.attribution.source.uri' FROM json_each(state_json,'$.decisions') WHERE json_extract(value,'$.decisionId')='decorated-proposal'),'https://example.test/record') WHERE project_id=${projectId}`;
      const after = yield* f.reader.readRequired(f.snapshot);
      expect(after.required.decisions.map((record) => record.decisionId)).toEqual(
        before.required.decisions.map((record) => record.decisionId),
      );
      expect(
        after.required.decisions.find((record) => record.decisionId === "decorated-proposal")
          ?.attribution,
      ).toMatchObject({
        actor: { kind: "human", id: "retained-human", displayName: "Record label" },
        source: { kind: "web", id: "retained-browser", uri: "https://example.test/record" },
      });
      expect(after.retainedKnowledge).toEqual(before.retainedKnowledge);
    }),
  ),
);

const makeBudgetFixture = (writableWorkers = 1) =>
  Effect.gen(function* () {
    const f = yield* makeFixture("implementer", writableWorkers);
    const claim = f.snapshot.intent.compiledClaim.transition;
    if (claim?.kind !== "claim") return yield* Effect.die("Fixture claim missing");
    const binding = { ...claim.binding, status: "running" as const, revision: 1 };
    yield* f.change(binding);
    const managed = {
      projectId,
      bindingId: binding.recordId,
      generation: binding.generation,
      providerInstanceId: binding.providerInstanceId,
      threadId: binding.threadId,
    };
    const principal = { actor: { kind: "agent" as const, id: managedActorId(managed) }, managed };
    const accounting = yield* Accounting.make({
      environmentId: "environment",
      routeId: "configured",
      model: "test",
      acceptedReportedModels: ["test"],
      resolveOperation: (_authority, reservation) =>
        Effect.succeed({
          workerId: reservation.workerId,
          operationId: reservation.operationId,
          rootTaskId: f.snapshot.intent.limits.rootTaskId,
          maximumTokens: f.snapshot.intent.limits.maximumTokens,
          deadlineAtMs: f.snapshot.intent.limits.rootDeadlineAtMs,
          operationMaximumTokens: f.snapshot.intent.limits.attemptMaximumTokens,
          operationDeadlineAtMs: f.snapshot.intent.limits.deadlineAtMs,
        }),
    });
    const reservation = (requestId: number): PiModelRequestReservation => ({
      workerId: "worker",
      generation: binding.generation,
      operationId: "assignment",
      requestId,
      routeId: "configured",
      provider: "command-code",
      model: "test",
      maxInputTokens: 100,
      maxOutputTokens: 100,
      callCount: 1,
      deadlineAtMs: f.snapshot.intent.limits.deadlineAtMs,
    });
    const reserve = (id: number) => accounting.reserve(principal, reservation(id));
    const settle = (
      reservationId: string,
      id: number,
      outcome: "reported" | "failed" | "unknown",
      drained = true,
    ) => {
      const value: PiModelRequestSettlement = {
        ...reservation(id),
        reservationId,
        transportDrained: drained,
        outcome,
        chargedInputTokens: outcome === "reported" ? 10 : 100,
        chargedOutputTokens: outcome === "reported" ? 20 : 100,
        ...(outcome === "reported"
          ? {
              reportedModel: "test",
              reportedUsage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }
          : {}),
      };
      return accounting.settle(value);
    };
    return { ...f, reserve, settle, reservation, accounting };
  });

const budgetFixture = makeBudgetFixture();

for (const kind of ["planning", "review", "investigation"] as const)
  it.effect(
    kind === "review"
      ? "required context denies legacy review without a verification target"
      : `required context reconstructs legal planless ${kind} original authority`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* makeFixture(
            kind === "planning" ? "planner" : kind === "review" ? "reviewer" : "investigator",
            1,
            kind,
          );
          const claim = f.snapshot.intent.compiledClaim.transition;
          if (claim?.kind !== "claim") return yield* Effect.die("Missing readonly original claim");
          expect(claim.binding.planRevision).toBe(0);
          const state = yield* readCurrentState(f.sql, projectId);
          expect(
            state.foundationRecords?.filter(
              (record) => record.kind === "plan-revision" && record.taskId === claim.binding.taskId,
            ),
          ).toEqual([]);
          const grant = state.foundationRecords?.find(
            (record) => record.recordId === claim.binding.authorizationGateId,
          );
          expect(grant).toMatchObject({
            kind: "gate",
            gate: kind === "investigation" ? "investigation" : "assignment",
            status: "consumed",
            attribution: { actor: { kind: "human" } },
          });
          if (kind === "review") {
            yield* denied(f.reader.readRequired(f.snapshot));
            return;
          }
          const required = yield* f.reader.readForOperation({
            projectId,
            bindingId: claim.binding.recordId,
            generation: claim.binding.generation,
            providerInstanceId: claim.binding.providerInstanceId,
            threadId: claim.binding.threadId,
            operationId: f.request.initializeOperationId,
            operationKind: "initialize",
          });
          expect(required.required.tasks[0]?.plan).toBeUndefined();
          expect(required.required.tasks[0]?.criteria[0]?.description).toBe(
            kind === "planning" ? "Proposed first plan" : "Sourced investigation findings",
          );
          expect(required.required.tasks[1]?.task.taskId).toBe("authorization-task");
          expect(required.required.approvals).toContainEqual(
            expect.objectContaining({ recordId: claim.binding.authorizationGateId }),
          );
        }),
      ),
  );

it.effect("required context denies actual duplicate equal plan revisions", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const plan = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
        (record) => record.kind === "plan-revision",
      );
      if (plan?.kind !== "plan-revision") return yield* Effect.die("Missing original plan");
      yield* f.change({ ...plan, recordId: "duplicate-equal-plan" });
      expect(
        (yield* readCurrentState(f.sql, projectId)).foundationRecords?.filter(
          (record) => record.kind === "plan-revision" && record.planRevision === plan.planRevision,
        ),
      ).toHaveLength(2);
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

for (const operationKind of ["initialize", "prompt"] as const)
  it.effect(`required operation lookup resolves exact original ${operationKind} context`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* Effect.die("Missing claim");
        const resolved = yield* f.reader.readForOperation({
          projectId,
          bindingId: claim.binding.recordId,
          generation: claim.binding.generation,
          providerInstanceId: claim.binding.providerInstanceId,
          threadId: claim.binding.threadId,
          operationId:
            operationKind === "initialize"
              ? f.request.initializeOperationId
              : f.request.assignmentOperationId,
          operationKind,
        });
        expect(resolved).toEqual(yield* f.reader.readRequired(f.snapshot));
      }),
    ),
  );

for (const mismatch of [
  "project",
  "binding",
  "generation",
  "provider",
  "thread",
  "operation",
  "kind",
  "missing",
  "corrupt",
  "transaction",
] as const)
  it.effect(`required operation lookup denies ${mismatch} before delivering context`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* Effect.die("Missing claim");
        const input = {
          projectId: mismatch === "project" ? "foreign-project" : projectId,
          bindingId: mismatch === "binding" ? "foreign-binding" : claim.binding.recordId,
          generation:
            mismatch === "generation" ? claim.binding.generation + 1 : claim.binding.generation,
          providerInstanceId:
            mismatch === "provider"
              ? ProviderInstanceId.make("foreign-provider")
              : claim.binding.providerInstanceId,
          threadId:
            mismatch === "thread" ? ThreadId.make("foreign-thread") : claim.binding.threadId,
          operationId:
            mismatch === "operation" ? "foreign-operation" : f.request.initializeOperationId,
          operationKind: mismatch === "kind" ? ("prompt" as const) : ("initialize" as const),
        };
        if (mismatch === "missing") yield* f.sql`DELETE FROM project_team_dispatch`;
        if (mismatch === "corrupt") {
          yield* f.sql`DROP TRIGGER project_team_dispatch_immutable`;
          yield* f.sql`UPDATE project_team_dispatch SET intent_json='{}'`;
        }
        if (mismatch === "transaction") {
          yield* f.sql`DROP TABLE project_team_dispatch`;
          const result = yield* f.sql
            .withTransaction(f.reader.readForOperation(input))
            .pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { reason: "Required context must own its read transaction" },
          });
        } else yield* denied(f.reader.readForOperation(input));
      }),
    ),
  );

for (const count of [2, 129])
  it.effect(`required operation lookup denies ${count} ambiguous retained dispatches`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* Effect.die("Missing original claim");
        // Corrupt duplicate rows cannot occur through journal writes; exercise denial against retained SQL corruption.
        yield* f.sql`ALTER TABLE project_team_dispatch RENAME TO original_context_dispatch`;
        yield* f.sql`CREATE TABLE project_team_dispatch AS SELECT * FROM original_context_dispatch WHERE 0`;
        for (let i = 0; i < count; i++)
          yield* f.sql`INSERT INTO project_team_dispatch SELECT * FROM original_context_dispatch`;
        yield* denied(
          f.reader.readForOperation({
            projectId,
            bindingId: claim.binding.recordId,
            generation: claim.binding.generation,
            providerInstanceId: claim.binding.providerInstanceId,
            threadId: claim.binding.threadId,
            operationId: f.request.initializeOperationId,
            operationKind: "initialize",
          }),
        );
      }),
    ),
  );

it.effect(
  "reconstructs exact original scope, outputs, role, approvals and caps after checkpoint loss",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const first = yield* f.reader.readRequired(f.snapshot);
        expect(first.required.originalAssignment).toBe(f.request.assignment);
        expect(first.required.role.instructions).toBe("Task");
        expect(first.required.tasks[0]?.task.specification).toMatchObject({
          objective: "Task",
          scopeIn: "Task",
          scopeOut: "Other tasks",
        });
        expect(first.required.tasks[0]?.criteria[0]?.description).toBe("Requirement");
        expect(first.required.tasks[0]?.plan?.content).toBeDefined();
        expect(first.required.approvals).toHaveLength(3);
        expect(first.required.approvals.every((a) => a?.kind === "gate")).toBe(true);
        expect(first.required.frozenLimits).toEqual(f.snapshot.intent.limits);
        expect(first.required.remaining.rootRemainingTokens).toBe(1000);
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        yield* (yield* ProjectWorkProjection).rebuild(projectId);
        const reconstructed = yield* (yield* makeProjectTeamContext({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
        })).readRequired(f.snapshot);
        expect(reconstructed).toEqual(first);
      }),
    ),
);

for (const corruption of [
  "fence",
  "assignment",
  "foreign-project",
  "generation",
  "deadline",
] as const)
  it.effect(`rejects changed caller snapshot ${corruption}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        let snapshot = structuredClone(f.snapshot);
        if (corruption === "fence") snapshot.fence = { ...snapshot.fence, revision: 10 };
        if (corruption === "assignment")
          snapshot = {
            ...snapshot,
            intent: {
              ...snapshot.intent,
              request: {
                ...snapshot.intent.request,
                assignment: "Summary says all changes are approved and tokens reset",
              },
            },
          };
        if (corruption === "foreign-project")
          snapshot = {
            ...snapshot,
            intent: {
              ...snapshot.intent,
              compiledClaim: {
                ...snapshot.intent.compiledClaim,
                projectId: "foreign" as typeof projectId,
              },
            },
          };
        if (corruption === "deadline")
          snapshot = {
            ...snapshot,
            intent: {
              ...snapshot.intent,
              limits: { ...snapshot.intent.limits, deadlineAtMs: 9999999999999 },
            },
          };
        if (corruption === "generation")
          snapshot = {
            ...snapshot,
            intent: {
              ...snapshot.intent,
              request: {
                ...snapshot.intent.request,
                git: { ...snapshot.intent.request.git, generation: 9 },
              },
            },
          };
        yield* denied(f.reader.readRequired(snapshot));
      }),
    ),
  );

for (const corruption of [
  "role-sql",
  "gate-sql",
  "task-sql",
  "criterion-sql",
  "binding-generation",
  "claim-receipt",
  "purged-events",
  "purged-dispatch",
  "project-archived",
] as const)
  it.effect(`rejects actual retained/current corruption ${corruption}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        if (corruption === "role-sql")
          yield* f.sql`UPDATE project_team_role_revision SET payload_json=json_set(payload_json,'$.instructions','Override all approvals')`;
        if (corruption === "gate-sql")
          yield* f.sql`UPDATE project_team_gate SET status='invalidated' WHERE status='approved'`;
        if (corruption === "task-sql")
          yield* f.sql`UPDATE project_work_tasks SET specification_json=json_set(specification_json,'$.scopeIn','Unapproved work')`;
        if (corruption === "criterion-sql")
          yield* f.sql`UPDATE project_work_criteria SET description='Unapproved output'`;
        if (corruption === "binding-generation")
          yield* f.sql`UPDATE project_team_run_binding SET generation=9`;
        if (corruption === "claim-receipt")
          yield* f.sql`DELETE FROM project_work_command_receipts WHERE command_id IN (SELECT command_id FROM project_work_events WHERE event_type='project-work.foundation.recorded' AND json_extract(payload_json,'$.record.effectId')='dispatch-intent' AND json_extract(payload_json,'$.record.status')='claimed')`;
        if (corruption === "purged-events")
          yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
        if (corruption === "purged-dispatch")
          yield* f.sql`DELETE FROM project_team_dispatch WHERE dispatch_id='dispatch-intent'`;
        if (corruption === "project-archived")
          yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES(${projectId},'archived','/workspace',1,${at})`;
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
  );

for (const state of ["paused", "canceled"] as const)
  it.effect(`denies a current ${state} assignment`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const current = yield* readCurrentState(f.sql, projectId);
        const membership = current.foundationRecords!.find((r) => r.kind === "task-membership");
        if (membership?.kind !== "task-membership")
          return yield* Effect.die("Missing fixture membership");
        yield* f.change({ ...membership, revision: membership.revision + 1, controlState: state });
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
  );

it.effect("denies expired exact deadlines", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* TestClock.setTime(f.snapshot.intent.limits.deadlineAtMs);
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect(
  "reconstructs conservative actual accounting without resetting usage on a fresh reader",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* budgetFixture;
        const a = yield* f.reserve(1);
        yield* f.settle(a.reservationId, 1, "reported");
        const b = yield* f.reserve(2);
        yield* f.settle(b.reservationId, 2, "unknown", false);
        yield* f.reserve(3);
        const result = yield* f.reader.readRequired(f.snapshot);
        expect(result.required.remaining).toMatchObject({
          rootUsedTokens: 430,
          rootRemainingTokens: 570,
          attemptUsedTokens: 430,
          outstandingRequests: 2,
        });
        const fresh = yield* makeProjectTeamContext({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
        });
        expect((yield* fresh.readRequired(f.snapshot)).required.remaining).toEqual(
          result.required.remaining,
        );
        expect(result.required.frozenLimits.attemptMaximumTokens).toBe(1000);
      }),
    ),
);

for (const corruption of [
  "wrong-root",
  "reservation-json",
  "wrong-generation",
  "released-zero-charge",
  "settlement-json",
  "legacy-capacity",
  "frozen-budget",
] as const)
  it.effect(`denies actual model ledger corruption ${corruption}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* budgetFixture;
        const r = yield* f.reserve(1);
        yield* f.settle(r.reservationId, 1, "unknown");
        if (corruption === "wrong-root") {
          yield* f.sql`INSERT INTO project_team_model_budget VALUES('environment',${projectId},'foreign-root',1000,${f.snapshot.intent.limits.rootDeadlineAtMs})`;
          yield* f.sql`UPDATE project_team_model_request SET root_task_id='foreign-root'`;
        }
        if (corruption === "reservation-json")
          yield* f.sql`UPDATE project_team_model_request SET reservation_json=json_set(reservation_json,'$.maxInputTokens',1)`;
        if (corruption === "wrong-generation")
          yield* f.sql`UPDATE project_team_model_request SET generation=1`;
        if (corruption === "released-zero-charge")
          yield* f.sql`UPDATE project_team_model_request SET charged_input_tokens=0,charged_output_tokens=0`;
        if (corruption === "settlement-json")
          yield* f.sql`UPDATE project_team_model_request SET settlement_json=json_set(settlement_json,'$.transportDrained',0)`;
        if (corruption === "frozen-budget")
          yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=2000`;
        if (corruption === "legacy-capacity")
          yield* f.sql`UPDATE project_team_model_request SET capacity_state='legacy'`;
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
  );

it.effect(
  "retains an original human answer in required question context without granting its gate",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const current = yield* readCurrentState(f.sql, projectId);
        const target = current.foundationRecords!.find(
          (r) => r.kind === "gate" && r.gate === "plan",
        );
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (target?.kind !== "gate" || claim?.kind !== "claim")
          return yield* Effect.die("Missing original question target");
        const human = {
          actor: { kind: "human" as const, id: "answer-human" },
          source: { kind: "web" as const, id: "answer-device" },
          recordedAt: at,
        };
        const pending = yield* decodeRecord({
          kind: "question",
          recordId: "answered-context-question",
          projectId,
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "pending",
          taskId: claim.taskId,
          senderId: claim.binding.memberId,
          targetGateId: target.recordId,
          targetRevision: target.revision,
          body: "Which history should be preserved?",
          choices: ["Recorded history"],
        });
        yield* f.change(pending);
        yield* f.change(
          yield* decodeRecord({
            kind: "member",
            recordId: "answer-private-member",
            projectId,
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "active",
            name: "Private member",
            coordinator: false,
            roleRevisionId: "role",
          }),
        );
        const excluded = [
          yield* decodeRecord({
            ...pending,
            recordId: "answer-private-question",
            senderId: "answer-private-member",
            body: "Private teammate answer",
          }),
          yield* decodeRecord({
            ...pending,
            recordId: "answer-stale-question",
            targetRevision: target.revision + 1,
            body: "Stale target answer",
          }),
        ];
        for (const entry of excluded) yield* f.change(entry);
        yield* f.change(
          yield* decodeRecord({
            ...pending,
            recordId: "answer-canceled-question",
            status: "canceled",
            body: "Canceled answer context",
          }),
        );
        const beforeAnswer = yield* f.reader.readRequired(f.snapshot);
        expect(beforeAnswer.required.questions).toContainEqual(pending);
        const repo = yield* ProjectWorkRepository;
        yield* repo.execute(
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            commandId: "context-human-answer",
            projectId,
            expectedRevision: (yield* readCurrentState(f.sql, projectId)).revision,
            attribution: human,
            committedAt: at,
            records: [pending, ...excluded].map((entry) => ({
              ...entry,
              revision: 1,
              status: "answered",
              answer: "Recorded history",
              answeredBy: human,
            })),
          }),
        );
        const result = yield* f.reader.readRequired(f.snapshot);
        expect(result.required.questions).toHaveLength(1);
        expect(result.required.questions[0]).toMatchObject({
          status: "answered",
          revision: 1,
          answer: "Recorded history",
          answeredBy: human,
        });
        expect(result.text).toContain("Recorded history");
        expect(result.text).toContain("answer-human");
        expect(result.text).not.toContain("Private teammate answer");
        expect(result.text).not.toContain("Stale target answer");
        expect(result.text).not.toContain("Canceled answer context");
        expect(
          (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
            (r) => r.recordId === target.recordId,
          ),
        ).toEqual(target);
      }),
    ),
);

it.effect(
  "denies substituted human answer attribution despite matching question projection and event",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const state = yield* readCurrentState(f.sql, projectId);
        const target = state.foundationRecords?.find((r) => r.kind === "gate" && r.gate === "plan");
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (target?.kind !== "gate" || claim?.kind !== "claim")
          return yield* Effect.die("Missing original answer target");
        const pending = yield* decodeRecord({
          kind: "question",
          recordId: "answer-attribution-question",
          projectId,
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "pending",
          taskId: claim.taskId,
          senderId: claim.binding.memberId,
          targetGateId: target.recordId,
          targetRevision: target.revision,
          body: "Which answer belongs to the original human?",
          choices: ["Original answer"],
        });
        yield* f.change(pending);
        const human = {
          actor: { kind: "human" as const, id: "original-answer-human" },
          source: { kind: "web" as const, id: "original-answer-device" },
          recordedAt: at,
        };
        const repo = yield* ProjectWorkRepository;
        const commandId = "original-context-answer";
        yield* repo.execute(
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            commandId,
            projectId,
            expectedRevision: (yield* readCurrentState(f.sql, projectId)).revision,
            attribution: human,
            committedAt: at,
            records: [
              {
                ...pending,
                revision: 1,
                status: "answered",
                answer: "Original answer",
                answeredBy: human,
              },
            ],
          }),
        );
        expect((yield* f.reader.readRequired(f.snapshot)).required.questions[0]).toMatchObject({
          answeredBy: human,
        });
        const receipt =
          yield* f.sql`SELECT * FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${commandId}`;
        yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.record.answeredBy.actor.id','substituted-human') WHERE project_id=${projectId} AND command_id=${commandId}`;
        yield* f.sql`UPDATE project_team_question SET payload_json=json_set(payload_json,'$.answeredBy.actor.id','substituted-human') WHERE project_id=${projectId} AND record_id='answer-attribution-question'`;
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        expect(
          (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
            (r) => r.recordId === "answer-attribution-question",
          ),
        ).toMatchObject({ answeredBy: { actor: { id: "substituted-human" } } });
        expect(
          yield* f.sql`SELECT * FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${commandId}`,
        ).toEqual(receipt);
        yield* denied(f.reader.readRequired(f.snapshot));
        yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.record.answeredBy.actor.id',${human.actor.id}) WHERE project_id=${projectId} AND command_id=${commandId}`;
        yield* f.sql`UPDATE project_team_question SET payload_json=json_set(payload_json,'$.answeredBy.actor.id',${human.actor.id}) WHERE project_id=${projectId} AND record_id='answer-attribution-question'`;
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        expect((yield* f.reader.readRequired(f.snapshot)).required.questions[0]).toMatchObject({
          answeredBy: human,
        });
        yield* f.sql`UPDATE project_work_command_receipts SET source_id='substituted-device' WHERE project_id=${projectId} AND command_id=${commandId}`;
        yield* denied(f.reader.readRequired(f.snapshot));
        yield* f.sql`UPDATE project_work_command_receipts SET source_id=${human.source.id},created_at='2026-01-02T00:00:00.000Z' WHERE project_id=${projectId} AND command_id=${commandId}`;
        yield* denied(f.reader.readRequired(f.snapshot));
        yield* f.sql`UPDATE project_work_command_receipts SET created_at=${at},event_ids_json='[]' WHERE project_id=${projectId} AND command_id=${commandId}`;
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
);

it.effect("never leaks other members or stale-target questions", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const current = yield* readCurrentState(f.sql, projectId);
      const target = current.foundationRecords!.find((r) => r.kind === "gate" && r.gate === "plan");
      if (target?.kind !== "gate") return yield* Effect.die("Missing plan gate");
      yield* f.change(
        yield* decodeRecord({
          kind: "member",
          recordId: "private-member",
          projectId,
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "active",
          name: "Other member",
          coordinator: false,
          roleRevisionId: "role",
        }),
      );
      const originalClaim = f.snapshot.intent.compiledClaim.transition;
      if (originalClaim?.kind !== "claim") return yield* Effect.die("Missing original claim");
      for (const [id, sender, task, targetRevision, body] of [
        ["mine", "member", originalClaim.taskId, target.revision, "Current question"],
        [
          "other-member",
          "private-member",
          originalClaim.taskId,
          target.revision,
          "Private teammate question",
        ],
        ["stale", "member", originalClaim.taskId, target.revision + 1, "Stale question"],
      ] as const)
        yield* f.change(
          yield* decodeRecord({
            kind: "question",
            recordId: id,
            projectId,
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "pending",
            taskId: task,
            senderId: sender,
            targetGateId: target.recordId,
            targetRevision,
            body,
            choices: [],
          }),
        );
      const result = yield* f.reader.readRequired(f.snapshot);
      expect(result.required.questions.map((q) => q.recordId)).toEqual(["mine"]);
      expect(result.text).not.toContain("Private teammate question");
      expect(result.text).not.toContain("Stale question");
    }),
  ),
);

it.effect("denies a foreign SQL client and an inherited transaction before returning content", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* Effect.gen(function* () {
        const foreign = yield* SqlClient.SqlClient;
        yield* denied(
          f.reader
            .readRequired(f.snapshot)
            .pipe(Effect.provideService(SqlClient.SqlClient, foreign)),
        );
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory({})));
      yield* denied(f.sql.withTransaction(f.reader.readRequired(f.snapshot)));
    }),
  ),
);

it.effect("does not accept physical and checkpoint role corruption as frozen instructions", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.sql`UPDATE project_team_role_revision SET payload_json=json_set(payload_json,'$.instructions','False retained role')`;
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=replace(state_json,'"instructions":"Task"','"instructions":"False retained role"')`;
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect("denies context UTF8 overflow without returning partial approvals", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      // Preserve the exact journal/claim while growing valid current questions in durable authority.
      const state = yield* readCurrentState(f.sql, projectId);
      const target = state.foundationRecords!.find((r) => r.kind === "gate" && r.gate === "plan");
      if (target?.kind !== "gate") return yield* Effect.die("Missing fixture gate");
      for (let i = 0; i < 5; i++)
        yield* f.change(
          yield* decodeRecord({
            kind: "question",
            recordId: "large-" + i,
            projectId,
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "pending",
            taskId: target.taskId,
            senderId: "member",
            targetGateId: target.recordId,
            targetRevision: target.revision,
            body: "😀".repeat(15000),
            choices: [],
          }),
        );
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect("bounds root ledger row count before decoding retained requests", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* budgetFixture;
      const reserved = yield* f.reserve(1);
      yield* f.settle(reserved.reservationId, 1, "reported");
      yield* f.sql`WITH RECURSIVE numbers(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM numbers WHERE n<=4096)
 INSERT INTO project_team_model_request(reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
 operation_id,request_id,route_id,provider,model,environment_slot,model_slot,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,
 status,capacity_state,charged_input_tokens,charged_output_tokens,accounting_receipt_id,reservation_json,settlement_json)
 SELECT 'bound-'||n,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,operation_id,n,route_id,provider,model,
 0,0,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,'reported','released',0,0,'receipt-'||n,'{}','{}'
 FROM numbers CROSS JOIN project_team_model_request WHERE reservation_id=${reserved.reservationId}`;
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect("bounds total retained ledger bytes before decoding request content", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* budgetFixture;
      const reserved = yield* f.reserve(1);
      yield* f.settle(reserved.reservationId, 1, "reported");
      yield* f.sql`WITH RECURSIVE numbers(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM numbers WHERE n<1026)
    INSERT INTO project_team_model_request(reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
    operation_id,request_id,route_id,provider,model,environment_slot,model_slot,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,
    status,capacity_state,charged_input_tokens,charged_output_tokens,accounting_receipt_id,reservation_json,settlement_json)
    SELECT 'byte-bound-'||n,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,operation_id,n,route_id,provider,model,
    0,0,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,'reported','released',0,0,'receipt-'||n,'{}',printf('%16384s','')
    FROM numbers CROSS JOIN project_team_model_request WHERE reservation_id=${reserved.reservationId}`;
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect(
  "denies coordinated checkpoint and task scope corruption against retained approval history",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.sql`UPDATE project_work_tasks SET specification_json=replace(specification_json,'"scopeIn":"Task"','"scopeIn":"False approved scope"')`;
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=replace(state_json,'"scopeIn":"Task"','"scopeIn":"False approved scope"')`;
        expect(
          (yield* f.sql<{
            scope: string;
          }>`SELECT json_extract(specification_json,'$.scopeIn') AS scope FROM project_work_tasks`)[0]
            ?.scope,
        ).toBe("False approved scope");
        expect((yield* readCurrentState(f.sql, projectId)).tasks[0]?.specification?.scopeIn).toBe(
          "False approved scope",
        );
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
);

it.effect(
  "denies coordinated checkpoint and required criterion corruption against original gate content",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.sql`UPDATE project_work_criteria SET description='False approved output'`;
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=replace(state_json,'"description":"Requirement"','"description":"False approved output"')`;
        expect(
          (yield* f.sql<{ description: string }>`SELECT description FROM project_work_criteria`)[0]
            ?.description,
        ).toBe("False approved output");
        expect((yield* readCurrentState(f.sql, projectId)).criteria[0]?.description).toBe(
          "False approved output",
        );
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
);

it.effect(
  "denies coordinated criterion completion corruption without retained completion evidence",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.sql`UPDATE project_work_criteria SET status='satisfied'`;
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=replace(state_json,'"status":"unsatisfied"','"status":"satisfied"')`;
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_work_criteria`)[0]?.status,
        ).toBe("satisfied");
        expect((yield* readCurrentState(f.sql, projectId)).criteria[0]?.status).toBe("satisfied");
        yield* f.journal.inspect(f.snapshot.fence.dispatchId, { requireClaim: true });
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
);

it.effect("accepts exact retained typed criterion progress after actual projection replay", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const state = yield* readCurrentState(f.sql, projectId);
      const criterion = state.criteria[0];
      if (criterion === undefined) return yield* Effect.die("Missing fixture criterion");
      // Restore an actual historical event shape; no worker receipt or new approval is minted.
      const event: ProjectWorkEvent = {
        eventId: EventId.make("retained-criterion-progress"),
        projectId,
        revision: state.revision + 1,
        occurredAt: at,
        type: "project-work.criterion.upserted",
        taskId: criterion.taskId,
        criterion: {
          ...criterion,
          status: "satisfied",
          revision: criterion.revision + 1,
          updatedAt: at,
        },
        updatedAt: at,
      };
      const payload = yield* encodeRetainedEvent(event);
      yield* f.sql`INSERT INTO project_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json)
    VALUES(${event.eventId},${projectId},${event.type},${at},'retained-progress-fixture',${payload})`;
      yield* (yield* ProjectWorkProjection).rebuild(projectId);
      const result = yield* f.reader.readRequired(f.snapshot);
      expect(result.required.tasks[0]?.criteria[0]).toEqual(event.criterion);
      expect(result.provenance.criterionEventIds).toContain(event.eventId);
      expect(result.required.frozenLimits).toEqual(f.snapshot.intent.limits);
    }),
  ),
);

it.effect("denies malformed retained criterion progress despite agreeing derived copies", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.criterion.status','invented')
    WHERE project_id=${projectId} AND event_type='project-work.criterion.upserted'`;
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect("keeps unrelated project history outside required criterion bounds and content", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const before = yield* f.reader.readRequired(f.snapshot);
      yield* f.sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<4097)
    INSERT INTO project_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json)
    SELECT 'foreign-history-'||n,'foreign-project','project-work.criterion.upserted',${at},'foreign-command-'||n,'{}' FROM numbers`;
      expect(yield* f.reader.readRequired(f.snapshot)).toEqual(before);
    }),
  ),
);

it.effect("bounds retained criterion history before decoding completion payloads", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const claim = f.snapshot.intent.compiledClaim.transition;
      if (claim?.kind !== "claim") return yield* Effect.die("Missing fixture claim");
      yield* f.sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<4097)
    INSERT INTO project_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json)
    SELECT 'criterion-bound-'||n,${projectId},'project-work.task.completed',${at},'criterion-command-'||n,
      json_object('eventId','criterion-bound-'||n,'projectId',${projectId},'type','project-work.task.completed','taskId',${claim.taskId}) FROM numbers`;
      // Corrupt the checkpoint's cursor so current derived authority cannot expose the tail itself.
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET last_sequence=(SELECT max(sequence) FROM project_work_events WHERE project_id=${projectId}) WHERE project_id=${projectId}`;
      yield* f.journal.inspect(f.snapshot.fence.dispatchId, { requireClaim: true });
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect(
  "preserves actual initial-upsert timestamp semantics and denies an unsupported derived timestamp",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const older = "2025-12-31T00:00:00.000Z";
        yield* f.repository.execute(
          yield* decodeCommand({
            type: "project-work.task.create",
            projectId,
            commandId: "timestamp-legacy-task",
            taskId: "timestamp-task",
            title: "Legacy timestamp control",
            createdAt: at,
          }),
        );
        yield* f.repository.execute(
          yield* decodeCommand({
            type: "project-work.criterion.upsert",
            projectId,
            commandId: "timestamp-legacy-criterion",
            taskId: "timestamp-task",
            updatedAt: at,
            criterion: {
              criterionId: "timestamp-criterion",
              taskId: "timestamp-task",
              description: "Legacy output",
              required: true,
              status: "unsatisfied",
              satisfiedByEvidenceIds: [],
              revision: 0,
              updatedAt: older,
            },
          }),
        );
        const events = yield* f.repository.replay(projectId);
        const produced = events.find(
          (e) =>
            e.type === "project-work.criterion.upserted" &&
            e.criterion.criterionId === "timestamp-criterion",
        );
        const original = events.find(
          (e) =>
            e.type === "project-work.criterion.upserted" &&
            e.criterion.criterionId !== "timestamp-criterion",
        );
        if (
          produced?.type !== "project-work.criterion.upserted" ||
          original?.type !== "project-work.criterion.upserted"
        )
          return yield* Effect.die("Missing actual timestamp producer events");
        expect(produced.updatedAt).toBe(at);
        expect(produced.criterion.updatedAt).toBe(older);
        // Restore that verified initial-upsert date relationship to the original retained criterion.
        const restored = {
          ...original,
          criterion: { ...original.criterion, updatedAt: produced.criterion.updatedAt },
        };
        const payload = yield* encodeRetainedEvent(restored);
        yield* f.sql`UPDATE project_work_events SET payload_json=${payload} WHERE event_id=${original.eventId}`;
        yield* (yield* ProjectWorkProjection).rebuild(projectId);
        expect(
          (yield* f.reader.readRequired(f.snapshot)).required.tasks[0]?.criteria[0]?.updatedAt,
        ).toBe(older);
        yield* f.sql`UPDATE project_work_criteria SET updated_at=${at} WHERE criterion_id=${original.criterion.criterionId}`;
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=replace(state_json,${older},${at}) WHERE project_id=${projectId}`;
        yield* f.journal.inspect(f.snapshot.fence.dispatchId, { requireClaim: true });
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
);

const lineageFixture = Effect.gen(function* () {
  const f = yield* makeBudgetFixture(2);
  const a = yield* f.reserve(1);
  yield* f.settle(a.reservationId, 1, "reported");
  const state = yield* readCurrentState(f.sql, projectId);
  const limits = state.foundationRecords!.find((r) => r.kind === "limits")!;
  if (limits.kind !== "limits") return yield* Effect.die("Missing limits");
  yield* f.change({ ...limits, revision: limits.revision + 1, projectWritableWorkers: 2 });
  const role = state.foundationRecords!.find((r) => r.kind === "role-revision")!;
  const oldClaim = f.snapshot.intent.compiledClaim.transition;
  if (role.kind !== "role-revision" || oldClaim?.kind !== "claim")
    return yield* Effect.die("Missing role/claim");
  yield* f.repository.execute(
    yield* decodeCommand({
      type: "project-work.task.create",
      projectId,
      taskId: "sibling-task",
      commandId: "sibling-create",
      title: "Sibling",
      createdAt: at,
    }),
  );
  yield* f.change(
    yield* decodeRecord({
      kind: "task-membership",
      projectId,
      recordId: "sibling-membership",
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "active",
      taskId: "sibling-task",
      executionKind: "managed",
      deliverableKind: "code",
      controlState: "active",
      parentTaskId: oldClaim.binding.taskId,
    }),
  );
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  yield* createManagedAssignment({
    taskId: ProjectWorkTaskId.make("sibling-task"),
    recordId: "sibling-binding",
    attemptId: "sibling-attempt",
    commandId: "sibling-dispatch",
    providerInstanceId: ProviderInstanceId.make("pi"),
    threadId: ThreadId.make("sibling-thread"),
    role,
    status: "reserved",
    configuration: oldClaim.binding.configuration,
  }).pipe(
    Effect.provideService(ProjectWorkRepository, {
      ...f.repository,
      execute: (command) => {
        if (
          command.type === "project-work.foundation.commit" &&
          command.transition?.kind === "claim"
        ) {
          pending = command;
          return Effect.fail(
            new ProjectWorkPolicyError("invalid-state", "Control captures second claim"),
          );
        }
        return f.repository.execute(command);
      },
    }),
    Effect.result,
  );
  if (!pending || pending.transition?.kind !== "claim")
    return yield* Effect.die("Second claim not captured");
  const nextState = yield* readCurrentState(f.sql, projectId);
  const membership = nextState.foundationRecords!.find(
    (r) => r.kind === "task-membership" && r.taskId === "sibling-task",
  )!;
  if (membership.kind !== "task-membership") return yield* Effect.die("Missing sibling membership");
  expect(membership.parentTaskId).toBe(oldClaim.binding.taskId);
  const request: ProjectTeamDispatchRequest = {
    ...f.request,
    dispatchId: "sibling-dispatch",
    claim: {
      ...pending,
      expectedRevision: (yield* readCurrentState(f.sql, projectId)).revision,
      transition: {
        ...pending.transition,
        binding: {
          ...pending.transition.binding,
          branch: "refs/heads/sibling",
          worktree: "/sibling-worktree",
        },
      },
    },
    git: {
      ...f.request.git,
      effectId: "sibling-dispatch",
      runId: "sibling-binding",
      branchRef: "refs/heads/sibling",
      worktreePath: "/sibling-worktree",
      ownershipToken: "sibling-owner",
    },
    setupId: "sibling-setup",
    initializeOperationId: "sibling-init",
    assignmentOperationId: "sibling-assignment",
  };
  const next = yield* f.journal.claimEffect((yield* f.journal.reserve(request)).fence);
  return { ...f, next, a };
});

it.effect(
  "denies historical owner loss with a relocated charge and accepts exact restoration",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* lineageFixture;
        const before = yield* f.reader.readRequired(f.next);
        expect(before.required.remaining).toMatchObject({
          rootUsedTokens: 30,
          rootRemainingTokens: 970,
        });
        const dispatch =
          (yield* f.sql`SELECT * FROM project_team_dispatch WHERE dispatch_id='dispatch-intent'`)[0]!;
        yield* f.sql`INSERT INTO project_team_model_budget SELECT environment_id,project_id,'moved-root',maximum_tokens,deadline_at_ms FROM project_team_model_budget`;
        yield* f.sql`UPDATE project_team_model_request SET root_task_id='moved-root' WHERE reservation_id=${f.a.reservationId}`;
        yield* denied(f.reader.readRequired(f.next));
        yield* f.sql`UPDATE project_team_model_request SET root_task_id=${f.snapshot.intent.limits.rootTaskId} WHERE reservation_id=${f.a.reservationId}`;
        expect(yield* f.reader.readRequired(f.next)).toEqual(before);
        yield* f.sql`DELETE FROM project_team_dispatch WHERE dispatch_id='dispatch-intent'`;
        yield* denied(f.reader.readRequired(f.next));
        yield* f.sql`UPDATE project_team_model_request SET root_task_id='moved-root' WHERE reservation_id=${f.a.reservationId}`;
        yield* f.journal.inspect(f.next.fence.dispatchId, { requireClaim: true });
        const altered = yield* f.reader.readRequired(f.next).pipe(Effect.result);
        yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert(dispatch)}`;
        yield* f.sql`UPDATE project_team_model_request SET root_task_id=${f.snapshot.intent.limits.rootTaskId} WHERE reservation_id=${f.a.reservationId}`;
        const restored = yield* f.reader.readRequired(f.next);
        expect(restored).toEqual(before);
        expect(altered._tag).toBe("Failure");
      }),
    ),
);

it.effect("denies unapproved ancestor scope despite agreeing physical and checkpoint copies", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* lineageFixture;
      const before = yield* f.reader.readRequired(f.next);
      expect(before.required.tasks[1]?.task.specification?.scopeIn).toBe("Task");
      const parentBefore = yield* f.reader.readRequired(f.snapshot);
      const retainedBefore =
        yield* f.sql`SELECT * FROM project_work_events WHERE project_id=${projectId} ORDER BY sequence`;
      yield* f.sql`UPDATE project_work_tasks SET specification_json=json_set(specification_json,'$.scopeIn','Unapproved ancestor scope') WHERE task_id='authorization-task'`;
      yield* denied(f.reader.readRequired(f.next));
      yield* f.sql`UPDATE project_work_tasks SET specification_json=json_set(specification_json,'$.scopeIn','Task') WHERE task_id='authorization-task'`;
      expect(yield* f.reader.readRequired(f.next)).toEqual(before);
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.tasks[0].specification.scopeIn','Unapproved ancestor scope') WHERE project_id=${projectId}`;
      yield* denied(f.reader.readRequired(f.next));
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.tasks[0].specification.scopeIn','Task') WHERE project_id=${projectId}`;
      expect(yield* f.reader.readRequired(f.next)).toEqual(before);
      yield* f.sql`UPDATE project_work_tasks SET specification_json=json_set(specification_json,'$.scopeIn','Unapproved ancestor scope') WHERE task_id='authorization-task'`;
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.tasks[0].specification.scopeIn','Unapproved ancestor scope') WHERE project_id=${projectId}`;
      const state = yield* readCurrentState(f.sql, projectId);
      expect(
        state.tasks.find((t) => t.taskId === "authorization-task")?.specification?.scopeIn,
      ).toBe("Unapproved ancestor scope");
      expect(
        yield* f.sql`SELECT * FROM project_work_events WHERE project_id=${projectId} ORDER BY sequence`,
      ).toEqual(retainedBefore);
      yield* denied(f.reader.readRequired(f.snapshot));
      yield* f.journal.inspect(f.next.fence.dispatchId, { requireClaim: true });
      const result = yield* f.reader.readRequired(f.next).pipe(Effect.result);
      yield* f.sql`UPDATE project_work_tasks SET specification_json=json_set(specification_json,'$.scopeIn','Task') WHERE task_id='authorization-task'`;
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.tasks[0].specification.scopeIn','Task') WHERE project_id=${projectId}`;
      expect(yield* f.reader.readRequired(f.next)).toEqual(before);
      expect(yield* f.reader.readRequired(f.snapshot)).toEqual(parentBefore);
      expect(result._tag).toBe("Failure");
    }),
  ),
);

it.effect(
  "review initialization cannot expose scope without the parent's exact prepared human approval",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture("reviewer", 0, "review");
        const result = yield* f.reader
          .readForOperation({
            projectId,
            bindingId: "binding",
            generation: 0,
            providerInstanceId: ProviderInstanceId.make("pi"),
            threadId: ThreadId.make("authorization-thread"),
            operationId: "initialize",
            operationKind: "initialize",
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }),
    ),
);

it.effect("review initialization captures exact prepared parent target into required context", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture("reviewer", 0, "review", true);
      const claim = f.snapshot.intent.compiledClaim.transition;
      if (claim?.kind !== "claim") return yield* Effect.die("Missing review claim");
      const context = yield* f.reader.readForOperation({
        projectId,
        bindingId: claim.binding.recordId,
        generation: 0,
        providerInstanceId: claim.binding.providerInstanceId,
        threadId: claim.binding.threadId,
        operationId: f.request.initializeOperationId,
        operationKind: "initialize",
      });
      expect(context.required.reviewTarget?.prepared.manifest).toEqual(
        f.parentVerification?.prepared.manifest,
      );
      expect(context.text).toContain('"testedTree":"' + "d".repeat(40) + '"');
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_review_target`).toEqual([
        { dispatch_id: "review-dispatch" },
      ]);
    }),
  ),
);

const reviewFixture = () => makeFixture("reviewer", 0, "review", true);
const reviewOperation = (
  f: Effect.Success<ReturnType<typeof reviewFixture>>,
  kind: "initialize" | "prompt" = "initialize",
) => {
  const claim = f.snapshot.intent.compiledClaim.transition;
  if (claim?.kind !== "claim") throw new Error("Missing original review claim");
  return {
    projectId,
    bindingId: claim.binding.recordId,
    generation: claim.binding.generation,
    providerInstanceId: claim.binding.providerInstanceId,
    threadId: claim.binding.threadId,
    operationId:
      kind === "initialize" ? f.request.initializeOperationId : f.request.assignmentOperationId,
    operationKind: kind,
  };
};
const verificationGate = Effect.fn("reviewFixture.gate")(function* (
  f: Effect.Success<ReturnType<typeof reviewFixture>>,
) {
  const gates =
    (yield* readCurrentState(f.sql, projectId)).foundationRecords?.filter(
      (r) => r.kind === "gate" && r.gate === "verification",
    ) ?? [];
  const gate = gates[0];
  if (gate?.kind !== "gate" || gates.length !== 1)
    return yield* Effect.die("Missing exact human gate");
  return gate;
});
it.effect("review prompt cannot capture a missing association", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* reviewFixture();
      yield* denied(f.reader.readForOperation(reviewOperation(f, "prompt")));
      expect(yield* f.sql`SELECT * FROM project_team_review_target`).toEqual([]);
    }),
  ),
);
it.effect(
  "review retries and a recreated reader retain the first target despite a later approved job",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* reviewFixture();
        const first = yield* f.reader.readForOperation(reviewOperation(f));
        const gate = yield* verificationGate(f);
        const parent = f.parentVerification;
        if (!parent) return yield* Effect.die("Missing preparation");
        const newer = yield* parent.jobs.retainPrepared({
          ...parent.prepared.manifest,
          jobId: "later-job",
          target: {
            ...parent.prepared.manifest.target,
            testedCommit: "9".repeat(40),
            headSha: "9".repeat(40),
          },
        });
        yield* restoreHistoricalBinding({
          ...gate,
          recordId: "later-approved-verification",
          verificationJobId: newer.manifest.jobId,
          contentHash: newer.sha256,
          revision: 0,
        });
        const reader = yield* makeProjectTeamContext({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
        });
        const replay = yield* reader.readForOperation(reviewOperation(f, "prompt"));
        expect(replay.required.reviewTarget).toEqual(first.required.reviewTarget);
        expect(replay.required.reviewTarget?.prepared.manifest.jobId).toBe("verification-1");
        expect(yield* f.sql`SELECT count(*) AS count FROM project_team_review_target`).toEqual([
          { count: 1 },
        ]);
      }),
    ),
);
for (const status of ["pending", "rejected", "invalidated"] as const)
  it.effect(`review denies ${status} original verification gate`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* reviewFixture();
        const gate = yield* verificationGate(f);
        yield* restoreHistoricalBinding({ ...gate, status, revision: gate.revision + 1 });
        yield* denied(f.reader.readForOperation(reviewOperation(f)));
        expect(yield* f.sql`SELECT * FROM project_team_review_target`).toEqual([]);
      }),
    ),
  );
it.effect("review denies ambiguous human approvals instead of choosing the newest job", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* reviewFixture();
      const gate = yield* verificationGate(f);
      yield* restoreHistoricalBinding({ ...gate, recordId: "other-approved-gate" });
      yield* denied(f.reader.readForOperation(reviewOperation(f)));
    }),
  ),
);
for (const moment of ["initial", "replay"] as const)
  it.effect(
    `review accepts exact retained consumed human approval at ${moment} without asserting test success`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* reviewFixture();
          if (moment === "replay") yield* f.reader.readForOperation(reviewOperation(f));
          const gate = yield* verificationGate(f);
          yield* restoreHistoricalBinding({
            ...gate,
            status: "consumed",
            revision: gate.revision + 1,
            consumedByRunId: "verification-attempt",
            consumedByCommandId:
              ProjectWorkFoundationCommitCommand.fields.commandId.make("verification-consume"),
          });
          const context = yield* f.reader.readForOperation(reviewOperation(f));
          expect(context.required.reviewTarget?.prepared.manifest.jobId).toBe("verification-1");
          expect(context.text).not.toContain('"passed"');
        }),
      ),
  );
for (const change of ["human", "revision", "hash", "job"] as const)
  it.effect(`review denies replacement ${change} after target capture`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* reviewFixture();
        yield* f.reader.readForOperation(reviewOperation(f));
        const gate = yield* verificationGate(f);
        yield* restoreHistoricalBinding({
          ...gate,
          status: "consumed",
          revision: gate.revision + (change === "revision" ? 2 : 1),
          consumedByRunId: "verification-attempt",
          consumedByCommandId:
            ProjectWorkFoundationCommitCommand.fields.commandId.make("verification-consume"),
          ...(change === "human"
            ? {
                attribution: {
                  ...gate.attribution,
                  actor: { kind: "human", id: "replacement-human" },
                },
              }
            : {}),
          ...(change === "hash" ? { contentHash: "0".repeat(64) } : {}),
          ...(change === "job" ? { verificationJobId: "replacement-job" } : {}),
        });
        yield* denied(f.reader.readForOperation(reviewOperation(f, "prompt")));
      }),
    ),
  );
for (const status of ["prepared", "starting", "running", "settled", "quarantine"] as const)
  it.effect(
    `review association ${status === "prepared" ? "can precede" : "cannot backfill after"} ${status} initialization`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* reviewFixture();
          const claim = f.snapshot.intent.compiledClaim.transition;
          if (claim?.kind !== "claim") return yield* Effect.die("Missing claim");
          const b = claim.binding;
          yield* f.sql`INSERT INTO project_team_pi_operation VALUES (${f.request.initializeOperationId},'environment',${projectId},${b.recordId},0,${b.providerInstanceId},${b.threadId},'review-worker',0,'initialize','request-hash',${b.recordId},${b.taskId},1000,9999999999999,${status},'{}',NULL,NULL)`;
          if (status === "prepared") {
            const prepared = yield* preparedReviewShape(f);
            const preparedIdentity = prepared.json;
            yield* f.sql`UPDATE project_team_pi_operation SET intent_json=${preparedIdentity},request_hash=${prepared.requestHash} WHERE operation_id=${f.request.initializeOperationId}`;
            yield* f.sql`INSERT INTO project_team_pi_process VALUES ('review-unit',${f.request.initializeOperationId},'{"unit":"review-unit"}','allocated',NULL,NULL)`;
            expect(
              (yield* f.reader.readForOperation(reviewOperation(f))).required.reviewTarget?.prepared
                .manifest.jobId,
            ).toBe("verification-1");
          } else {
            yield* denied(f.reader.readForOperation(reviewOperation(f)));
            expect(yield* f.sql`SELECT * FROM project_team_review_target`).toEqual([]);
          }
        }),
      ),
  );
it.effect("review cannot backfill a prepared operation with a retained native entry", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* reviewFixture();
      const b = f.request.claim.transition;
      if (b?.kind !== "claim") return yield* Effect.die("Missing claim");
      yield* f.sql`INSERT INTO project_team_pi_operation VALUES (${f.request.initializeOperationId},'environment',${projectId},${b.binding.recordId},0,${b.binding.providerInstanceId},${b.binding.threadId},'review-worker',0,'initialize','request-hash',${b.binding.recordId},${b.binding.taskId},1000,9999999999999,'prepared','{}','{}',NULL)`;
      yield* denied(f.reader.readForOperation(reviewOperation(f)));
    }),
  ),
);
for (const corruption of [
  "owner",
  "hash",
  "manifest",
  "job-owner",
  "task-revision",
  "binding-revision",
  "criterion-revision",
] as const)
  it.effect(`review denies original target ${corruption} mutation`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* reviewFixture();
        yield* f.reader.readForOperation(reviewOperation(f));
        if (corruption === "owner" || corruption === "hash" || corruption === "manifest") {
          yield* f.sql`DROP TRIGGER project_team_review_target_immutable`;
          if (corruption === "owner")
            yield* f.sql`UPDATE project_team_review_target SET project_id='foreign-project'`;
          if (corruption === "hash")
            yield* f.sql`UPDATE project_team_review_target SET sha256=${"0".repeat(64)}`;
          if (corruption === "manifest")
            yield* f.sql`UPDATE project_team_review_target SET manifest_json='{}'`;
        }
        if (corruption === "job-owner") {
          yield* f.sql`DROP TRIGGER project_work_verification_jobs_immutable`;
          yield* f.sql`UPDATE project_work_verification_jobs SET project_id='foreign-project'`;
        }
        if (corruption === "task-revision")
          yield* f.sql`UPDATE project_work_tasks SET revision=revision+1 WHERE task_id='authorization-task'`;
        if (corruption === "binding-revision")
          yield* f.sql`UPDATE project_team_run_binding SET payload_json=json_set(payload_json,'$.revision',json_extract(payload_json,'$.revision')+1) WHERE record_id='binding'`;
        if (corruption === "criterion-revision")
          yield* f.sql`UPDATE project_work_criteria SET revision=revision+1 WHERE task_id='authorization-task'`;
        yield* denied(f.reader.readForOperation(reviewOperation(f, "prompt")));
      }),
    ),
  );
it.effect(
  "review context does not escape a failed capture COMMIT or the hidden failed transaction",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* reviewFixture();
        yield* f.sql`PRAGMA foreign_keys=ON`;
        yield* f.sql`CREATE TABLE review_commit_parent(id INTEGER PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE review_commit_child(id INTEGER REFERENCES review_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER controlled_review_commit_failure AFTER INSERT ON project_team_review_target BEGIN INSERT INTO review_commit_child VALUES(1); END`;
        let escaped = false;
        expect(
          (yield* f.reader.readForOperation(reviewOperation(f)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.exit,
          ))._tag,
        ).toBe("Failure");
        expect(escaped).toBe(false);
        expect(
          (yield* f.reader.readForOperation(reviewOperation(f, "prompt")).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* f.sql.reserve;
            yield* connection.executeUnprepared("ROLLBACK", [], undefined);
          }),
        );
        expect(yield* f.sql`SELECT * FROM project_team_review_target`).toEqual([]);
        yield* f.sql`DROP TRIGGER controlled_review_commit_failure`;
        expect(
          (yield* f.reader.readForOperation(reviewOperation(f))).required.reviewTarget?.prepared
            .manifest.jobId,
        ).toBe("verification-1");
      }),
    ),
);

it.effect("review capture snapshots caller input synchronously before SQL can yield", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* reviewFixture();
      const targets = yield* makeProjectTeamReviewTargets({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
      });
      const input = structuredClone(f.snapshot);
      const capture = targets.captureInitial(input);
      Reflect.set(input.intent.request, "initializeOperationId", "substituted-initialize");
      const retained = yield* f.sql.withTransaction(capture);
      expect(retained.reviewer.initializeOperationId).toBe("review-initialize");
      expect((yield* f.reader.readForOperation(reviewOperation(f))).required.reviewTarget).toEqual(
        retained,
      );
    }),
  ),
);
it.effect("ignored review target INSERT cannot expose a successful context", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* reviewFixture();
      yield* f.sql`CREATE TRIGGER controlled_ignore_review BEFORE INSERT ON project_team_review_target BEGIN SELECT RAISE(IGNORE); END`;
      yield* denied(f.reader.readForOperation(reviewOperation(f)));
      expect(yield* f.sql`SELECT * FROM project_team_review_target`).toEqual([]);
      yield* f.sql`DROP TRIGGER controlled_ignore_review`;
      expect(
        (yield* f.reader.readForOperation(reviewOperation(f))).required.reviewTarget?.prepared
          .manifest.jobId,
      ).toBe("verification-1");
    }),
  ),
);

for (const status of ["allocated", "claimed", "captured", "drained", "quarantine"] as const)
  it.effect(
    `review initial target ${status === "allocated" ? "allows an unentered" : "denies an entered"} ${status} descriptor`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* reviewFixture();
          const claim = f.snapshot.intent.compiledClaim.transition;
          if (claim?.kind !== "claim") return yield* Effect.die("Missing claim");
          const b = claim.binding;
          yield* f.sql`INSERT INTO project_team_pi_operation VALUES (${f.request.initializeOperationId},'environment',${projectId},${b.recordId},0,${b.providerInstanceId},${b.threadId},'review-worker',0,'initialize','request-hash',${b.recordId},${b.taskId},1000,9999999999999,'prepared','{}',NULL,NULL)`;
          // A controlled retained phase row exercises the entry fence, not allocation validity or native admission.
          const prepared = yield* preparedReviewShape(f);
          const preparedIdentity = prepared.json;
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=${preparedIdentity},request_hash=${prepared.requestHash} WHERE operation_id=${f.request.initializeOperationId}`;
          yield* f.sql`INSERT INTO project_team_pi_process VALUES ('review-unit',${f.request.initializeOperationId},'{"unit":"review-unit"}',${status},NULL,NULL)`;
          if (status === "allocated")
            expect(
              (yield* f.reader.readForOperation(reviewOperation(f))).required.reviewTarget?.prepared
                .manifest.jobId,
            ).toBe("verification-1");
          else {
            yield* denied(f.reader.readForOperation(reviewOperation(f)));
            expect(yield* f.sql`SELECT * FROM project_team_review_target`).toEqual([]);
          }
        }),
      ),
  );

for (const corruption of ["owner", "drain", "descriptor", "unit", "identity", "duplicate"] as const)
  it.effect(`review prepared allocation denies ${corruption} before target capture`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* reviewFixture();
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* Effect.die("Missing claim");
        const b = claim.binding;
        const prepared = yield* preparedReviewShape(f);
        const intent = prepared.json;
        yield* f.sql`INSERT INTO project_team_pi_operation VALUES (${f.request.initializeOperationId},'environment',${projectId},${b.recordId},0,${b.providerInstanceId},${b.threadId},'review-worker',0,'initialize',${prepared.requestHash},${b.recordId},${b.taskId},1000,9999999999999,'prepared',${intent},NULL,NULL)`;
        yield* f.sql`INSERT INTO project_team_pi_process VALUES ('review-unit',${f.request.initializeOperationId},'{"unit":"review-unit"}','allocated',NULL,NULL)`;
        if (corruption === "owner")
          yield* f.sql`UPDATE project_team_pi_process SET owner_json='{}'`;
        if (corruption === "drain")
          yield* f.sql`UPDATE project_team_pi_process SET drain_json='{}'`;
        if (corruption === "descriptor")
          yield* f.sql`UPDATE project_team_pi_process SET allocation_json='{}'`;
        if (corruption === "unit")
          yield* f.sql`UPDATE project_team_pi_process SET unit='replacement-unit'`;
        if (corruption === "identity")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.binding.generation',99)`;
        if (corruption === "duplicate")
          yield* f.sql`INSERT INTO project_team_pi_process VALUES ('other-unit',${f.request.initializeOperationId},'{}','allocated',NULL,NULL)`;
        yield* denied(f.reader.readForOperation(reviewOperation(f)));
        expect(yield* f.sql`SELECT * FROM project_team_review_target`).toEqual([]);
      }),
    ),
  );

const preparedReviewShape = Effect.fn("reviewFixture.preparedShape")(function* (
  f: Effect.Success<ReturnType<typeof reviewFixture>>,
) {
  const claim = f.snapshot.intent.compiledClaim.transition;
  if (claim?.kind !== "claim") return yield* Effect.die("Missing claim");
  const b = claim.binding;
  const records = (yield* readCurrentState(f.sql, projectId)).foundationRecords ?? [];
  const binding = records.find((r) => r.recordId === b.recordId);
  const role = records.find((r) => r.recordId === b.roleRevisionId);
  if (binding?.kind !== "run-binding" || role?.kind !== "role-revision")
    return yield* Effect.die("Missing prepared authority");
  const request = {
    threadId: b.threadId,
    kind: "initialize",
    operationId: f.request.initializeOperationId,
  };
  const allocation = { unit: "review-unit" };
  const limits = f.snapshot.intent.limits;
  const intent = {
    request,
    binding,
    role,
    allocation,
    rootBudget: {
      rootTaskId: limits.rootTaskId,
      maximumTokens: limits.maximumTokens,
      deadlineAtMs: limits.rootDeadlineAtMs,
    },
    operationLimits: {
      maximumTokens: limits.attemptMaximumTokens,
      deadlineAtMs: limits.deadlineAtMs,
    },
    resourceHash: "a".repeat(64),
  };
  const requestHash = NodeCrypto.createHash("sha256")
    .update(canonicalProjectWorkPayload(request))
    .digest("hex");
  return { b, request, intent, requestHash, json: canonicalProjectWorkPayload(intent) };
});
it.effect("review accepts the producer's request-containing prepared initializer shape", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* reviewFixture();
      const p = yield* preparedReviewShape(f);
      const b = p.b;
      yield* f.sql`INSERT INTO project_team_pi_operation VALUES (${f.request.initializeOperationId},'environment',${projectId},${b.recordId},0,${b.providerInstanceId},${b.threadId},'review-worker',0,'initialize',${p.requestHash},${b.recordId},${b.taskId},1000,9999999999999,'prepared',${p.json},NULL,NULL)`;
      yield* f.sql`INSERT INTO project_team_pi_process VALUES ('review-unit',${f.request.initializeOperationId},'{"unit":"review-unit"}','allocated',NULL,NULL)`;
      expect(
        (yield* f.reader.readForOperation(reviewOperation(f))).required.reviewTarget?.prepared
          .manifest.jobId,
      ).toBe("verification-1");
    }),
  ),
);

for (const corruption of ["missing", "malformed", "kind", "thread", "operation", "hash"] as const)
  it.effect(`review prepared initializer denies ${corruption} request`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* reviewFixture();
        const p = yield* preparedReviewShape(f);
        const b = p.b;
        yield* f.sql`INSERT INTO project_team_pi_operation VALUES (${f.request.initializeOperationId},'environment',${projectId},${b.recordId},0,${b.providerInstanceId},${b.threadId},'review-worker',0,'initialize',${p.requestHash},${b.recordId},${b.taskId},1000,9999999999999,'prepared',${p.json},NULL,NULL)`;
        yield* f.sql`INSERT INTO project_team_pi_process VALUES ('review-unit',${f.request.initializeOperationId},'{"unit":"review-unit"}','allocated',NULL,NULL)`;
        if (corruption === "missing")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_remove(intent_json,'$.request')`;
        if (corruption === "malformed")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.request',99)`;
        if (corruption === "kind")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.request.kind','prompt')`;
        if (corruption === "thread")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.request.threadId','foreign-thread')`;
        if (corruption === "operation")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.request.operationId','foreign-initialize')`;
        if (corruption === "hash")
          yield* f.sql`UPDATE project_team_pi_operation SET request_hash=${"0".repeat(64)}`;
        if (corruption === "kind" || corruption === "thread" || corruption === "operation") {
          const changed = {
            ...p.request,
            ...(corruption === "kind" ? { kind: "prompt" } : {}),
            ...(corruption === "thread" ? { threadId: "foreign-thread" } : {}),
            ...(corruption === "operation" ? { operationId: "foreign-initialize" } : {}),
          };
          const changedHash = NodeCrypto.createHash("sha256")
            .update(canonicalProjectWorkPayload(changed))
            .digest("hex");
          yield* f.sql`UPDATE project_team_pi_operation SET request_hash=${changedHash}`;
        }
        yield* denied(f.reader.readForOperation(reviewOperation(f)));
        expect(yield* f.sql`SELECT * FROM project_team_review_target`).toEqual([]);
      }),
    ),
  );
