import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectWorkAttemptId,
  ProjectWorkFoundationCommitCommand,
  type ProjectTeamGuidedIntent,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  stopProjectTeamOwnedThread,
  waitForProjectTeamAssignmentChange,
} from "./ProjectTeamExecutionHost.ts";
import { ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import { makeProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { PiManagedRuntimeError } from "../provider/pi/PiManagedRuntime.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  at,
  attribution,
  projectId,
  taskId,
  seed,
  gatewayRuntime,
  decodeRecord,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
  ProjectTeamDispatchJournalError,
} from "./ProjectTeamDispatchJournal.ts";
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
type AwaitedState = Effect.Success<ReturnType<typeof readCurrentState>>;
const makeFixture = (role: "implementer" | "integrator" = "implementer") =>
  Effect.gen(function* () {
    const repository = yield* ProjectWorkRepository;
    const sql = yield* SqlClient.SqlClient;
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    // The real fixture commits approvals and the execution grant; intercept only its final claim.
    const result = yield* seed(role, "reserved", {
      roleTools: role === "integrator" ? ["pi.read"] : ["pi.read", "pi.write"],
      toolIds: role === "integrator" ? ["pi.read"] : ["pi.read", "pi.write"],
      issueCredential: false,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (command) => {
          if (
            command.type === "project-work.foundation.commit" &&
            command.transition?.kind === "claim"
          ) {
            pending = command;
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Fixture retains the uncommitted claim"),
            );
          }
          return repository.execute(command);
        },
      }),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (!pending || pending.transition?.kind !== "claim")
      return yield* Effect.die("Fixture did not capture its claim");
    yield* repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "configure-limits",
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution,
        committedAt: at,
        records: [
          {
            kind: "limits",
            projectId,
            recordId: "limits",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "configured",
            environmentModelCalls: 4,
            projectWritableWorkers: 1,
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
      dispatchId: "dispatch-intent",
      claim,
      git: {
        effectId: "dispatch-intent",
        runId: "binding",
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
      initializeOperationId: "initialize",
      assignmentOperationId: "assignment",
      assignment: "Implement the approved task",
    };
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    return { sql, repository, request, journal };
  });
const fixture = makeFixture();

const nextClaim = (
  state: AwaitedState,
  original: typeof ProjectWorkFoundationCommitCommand.Type,
  label: string,
  memberId?: string,
) => {
  const t = original.transition;
  if (t?.kind !== "claim") throw new Error("Claim fixture required");
  const assignment = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
      r.kind === "task-membership" && r.taskId === t.taskId,
  )!;
  const grant = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
      r.kind === "gate" && r.recordId === assignment.assignment!.authorizationGateId,
  )!;
  const commandId = CommandId.make(label);
  const attemptId = ProjectWorkAttemptId.make(`${label}-attempt`);
  return {
    ...original,
    commandId,
    expectedRevision: state.revision,
    transition: {
      ...t,
      expectedTaskRevision: state.tasks.find((task) => task.taskId === t.taskId)!.revision,
      authorizationGateId: grant.recordId,
      expectedGateRevision: grant.revision,
      claim: { ...t.claim, commandId, attemptId },
      binding: {
        ...t.binding,
        recordId: `${label}-run`,
        attemptId,
        authorizationGateId: grant.recordId,
        generation: 1,
        leaseGeneration: 1,
        ...(memberId === undefined ? {} : { memberId }),
      },
    },
  };
};

for (const action of ["pause", "cancel", "reassign"] as const) {
  it.effect(
    `${action} through gateway retains original writer until joined durable settlement`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const gateway = yield* ProjectWorkGateway;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const initial = yield* readCurrentState(f.sql, projectId);
        const member = initial.foundationRecords?.find((r) => r.kind === "member");
        if (member?.kind !== "member") return yield* Effect.die("Missing original member");
        yield* f.repository.execute(
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "configure-successor",
            expectedRevision: initial.revision,
            attribution,
            committedAt: at,
            records: [decodeRecord({ ...member, recordId: "successor", name: "Successor" })],
          }),
        );
        const sendControl = Effect.fn("ownershipAcceptance.control")(function* (
          id: string,
          control: Extract<
            ProjectTeamGuidedIntent,
            { type: "project-team.task.control" }
          >["control"],
        ) {
          const state = yield* readCurrentState(f.sql, projectId);
          return yield* gateway.write(
            {
              type: "project-team.task.control",
              projectId,
              taskId,
              commandId: CommandId.make(id),
              expectedRevision: state.revision,
              expectedTaskRevision: state.tasks.find((t) => t.taskId === taskId)!.revision,
              control,
            },
            { kind: "human", id: "maintainer" },
            { kind: "web", id: "control-device" },
          );
        });
        const ownerJoined = yield* Deferred.make<{
          dispatchId: string;
          bindingId: string;
          claimGeneration: number;
        }>();
        const stopping = yield* Deferred.make<void>();
        const terminal = {
          receiptId: `joined-${action}`,
          stage: "settled" as const,
          evidence: {
            dispatchId: claimed.fence.dispatchId,
            bindingId: "binding",
            claimGeneration: claimed.fence.claimGeneration,
          },
        };
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: (receipt, snapshot) =>
            receipt.evidence.dispatchId === snapshot.fence.dispatchId
              ? Effect.void
              : Effect.die("Foreign controlled owner receipt"),
          verifySettlement: (receipt, snapshot) =>
            Effect.gen(function* () {
              const joined = yield* Deferred.await(ownerJoined);
              expect(joined).toEqual(receipt.evidence);
              expect(joined.dispatchId).toBe(snapshot.fence.dispatchId);
              expect(joined.claimGeneration).toBe(snapshot.fence.claimGeneration);
            }),
        });
        const pi = yield* makeProjectTeamPiRuntime();
        const transition = claimed.intent.compiledClaim.transition;
        if (transition?.kind !== "claim") return yield* Effect.die("Missing retained binding");
        const binding = transition.binding;
        const requests: string[] = [];
        const unused = Effect.fail(
          new PiManagedRuntimeError({
            code: "denied",
            detail: "Unused controlled runtime operation",
          }),
        );
        yield* pi.publishAssets(
          binding.providerInstanceId,
          {
            instanceConfiguration: { enabled: true, configuration: {} },
            runtimeFacts: { runtimeVersion: "0.99.1", maxInputTokens: 100, maxOutputTokens: 100 },
            runtimeFiles: [],
            revalidate: Effect.void,
            borrow: (body) => body,
          },
          {
            inspect: unused,
            prepareOperation: () => unused,
            readSession: () => unused,
            readThread: () => unused,
            stopAll: unused,
            authorizeSkills: () => unused,
            discoverNativeSkills: () => unused,
            requestStop: (threadId) =>
              Effect.gen(function* () {
                requests.push(threadId);
                yield* Deferred.succeed(stopping, undefined);
                yield* Deferred.await(ownerJoined);
              }),
          },
        );
        const entered = yield* Deferred.make<void>();
        // The production Host wait observes committed controls even if the provider remains silent.
        const settlement = yield* waitForProjectTeamAssignmentChange(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          Date.parse(at) + 300000,
          {
            projectId,
            assertCurrent: f.journal.inspect(claimed.fence.dispatchId).pipe(
              Effect.asVoid,
              Effect.mapError(
                () =>
                  new ProjectTeamDispatchJournalError({
                    reason: "Current dispatch authority changed",
                  }),
              ),
            ),
          },
        ).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              yield* stopProjectTeamOwnedThread(pi, claimed);
              yield* journal.settleAfterJoined(claimed.fence, terminal);
            }).pipe(Effect.orDie),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        yield* sendControl(
          `control-${action}`,
          action === "reassign"
            ? {
                action,
                reason: "Transfer exact owner",
                recipientMemberId: "successor",
                expectedMemberRevision: 0,
              }
            : { action, reason: "Stop exact owner" },
        );
        const stopped = yield* readCurrentState(f.sql, projectId);
        expect(stopped.foundationRecords?.find((r) => r.recordId === "binding")).toMatchObject({
          status: "stopping",
        });
        expect(
          stopped.foundationRecords?.find((r) => r.kind === "effect" && r.effectKind === "stop"),
        ).toMatchObject({ status: "pending", runId: "binding", claimGeneration: 0 });
        const held = yield* f.sql`SELECT * FROM project_team_reservation WHERE status='held'`;
        expect(held).toHaveLength(1);
        yield* Deferred.await(stopping);
        expect(requests).toEqual([binding.threadId]);
        const resumeAction = action === "cancel" ? "reopen" : "resume";
        expect(
          yield* sendControl("too-early", {
            action: resumeAction,
            reason: "Attempt successor before drain",
          }).pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { message: expect.stringContaining("authoritatively drained") },
        });
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(stopped);
        expect(yield* f.sql`SELECT * FROM project_team_reservation WHERE status='held'`).toEqual(
          held,
        );
        expect(
          yield* f.sql`SELECT * FROM project_team_dispatch_receipt WHERE stage='settled'`,
        ).toEqual([]);
        expect(settlement.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(ownerJoined, terminal.evidence);
        expect(Exit.isFailure(yield* Fiber.await(settlement))).toBe(true);
        expect((yield* journal.readRetained(claimed.fence.dispatchId)).fence.stage).toBe("settled");
        const drained = yield* readCurrentState(f.sql, projectId);
        expect(drained.foundationRecords?.find((r) => r.recordId === "binding")).toMatchObject({
          status: "settled",
          attemptId: "attempt",
          memberId: "member",
        });
        expect(drained.attempts.find((a) => a.attemptId === "attempt")?.state).toBe("canceled");
        expect(yield* f.sql`SELECT * FROM project_team_reservation WHERE status='held'`).toEqual(
          [],
        );
        yield* sendControl("after-drain", {
          action: resumeAction,
          reason: "Resume after exact owner join",
        });
        const resumed = yield* readCurrentState(f.sql, projectId);
        const successor = nextClaim(
          resumed,
          f.request.claim,
          "successor-claim",
          action === "reassign" ? "successor" : "member",
        );
        if (action === "reassign") {
          expect(
            yield* f.repository
              .execute(nextClaim(resumed, f.request.claim, "old-member-claim", "member"))
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
        }
        const successorBinding = successor.transition.binding;
        const request: ProjectTeamDispatchRequest = {
          ...f.request,
          dispatchId: "successor-dispatch",
          claim: {
            ...successor,
            transition: {
              ...successor.transition,
              binding: {
                ...successorBinding,
                worktree: "/workspace-successor",
                branch: "refs/heads/successor",
              },
            },
          },
          git: {
            ...f.request.git,
            effectId: "successor-dispatch",
            runId: successorBinding.recordId,
            generation: successorBinding.generation,
            worktreePath: "/workspace-successor",
            branchRef: "refs/heads/successor",
            ownershipToken: "successor-owner",
          },
          setupId: "successor-setup",
          initializeOperationId: "successor-initialize",
          assignmentOperationId: "successor-assignment",
        };
        yield* f.journal.reserve(request);
        const heldSuccessors = (yield* readCurrentState(
          f.sql,
          projectId,
        )).foundationRecords?.filter((r) => r.kind === "reservation" && r.status === "held");
        expect(heldSuccessors).toHaveLength(1);
        expect(heldSuccessors?.[0]).toMatchObject({
          runId: successorBinding.recordId,
          resourceKey: "writable",
        });
        const current = yield* readCurrentState(f.sql, projectId);
        expect(
          current.foundationRecords?.find((r) => r.recordId === "successor-claim-run"),
        ).toMatchObject({
          memberId: action === "reassign" ? "successor" : "member",
          status: "reserved",
        });
        expect(current.foundationRecords?.find((r) => r.recordId === "binding")).toEqual(
          drained.foundationRecords?.find((r) => r.recordId === "binding"),
        );
        expect((yield* journal.settleAfterJoined(claimed.fence, terminal)).duplicate).toBe(true);
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(current);
      }).pipe(
        Effect.provide(
          ProjectWorkProjectionLive.pipe(
            Layer.provideMerge(gatewayRuntime.pipe(Layer.provideMerge(ProjectWorkEventBusLive))),
          ),
        ),
      ),
  );
}
