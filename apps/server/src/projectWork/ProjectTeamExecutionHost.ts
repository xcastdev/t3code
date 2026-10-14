import { makeProjectTaskResources } from "./ProjectTaskResources.ts";
import {
  canonicalProjectWorkPayload,
  CommandId,
  MessageId,
  ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  PiManagedProcessAllocationSchema,
  reconcilePiManagedProcess,
} from "../provider/pi/PiManagedProcess.ts";
import { makeProjectManagedSetupJournal } from "../project/ProjectManagedSetupJournal.ts";
import {
  isProjectManagedSetupReceiptValid,
  ProjectManagedSetupError,
  type ProjectManagedSetupReceipt,
} from "../project/ProjectManagedSetup.ts";
import { makeProjectTeamDispatch, type ProjectTeamDispatchReceipt } from "./ProjectTeamDispatch.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
  ProjectTeamWorkspaceReceipt,
  ProjectTeamIntegrationCombinationReceipt,
  type ProjectTeamDispatchSnapshot,
  type ProjectTeamDispatchFence,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamRecovery } from "./ProjectTeamRecovery.ts";
import { makeProjectTeamReviewCompletion } from "./ProjectTeamReviewCompletion.ts";
import {
  makeProjectTeamReviewCurrentTarget,
  ProjectTeamReviewCurrentTarget,
} from "./ProjectTeamReviewCurrentTarget.ts";
import {
  makeProjectTeamSessionReceipts,
  type ProjectTeamInitializationReceipt,
  type ProjectTeamAssignmentReceipt,
} from "./ProjectTeamSessionReceipts.ts";
import { makeProjectTeamWorkspace } from "./ProjectTeamWorkspace.ts";
import { makeProjectTeamMailboxConsumption } from "./ProjectTeamMailboxConsumption.ts";
import {
  makeProjectTeamMailboxTurns,
  makeProjectTeamMailboxTurnDecisionReader,
} from "./ProjectTeamMailboxTurns.ts";
import { makeProjectTeamPiOperations } from "./ProjectTeamPiOperations.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";
import { makeProjectTeamIntegrationSources } from "./ProjectTeamIntegrationSources.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";

type Snapshot = ProjectTeamDispatchSnapshot;
type ReviewCompletion = Effect.Success<ReturnType<typeof makeProjectTeamReviewCompletion>>;
type ReviewCompletionEffect = ReturnType<ReviewCompletion["prepare"]>;
type Journal = Effect.Success<
  ReturnType<
    typeof makeProjectTeamDispatchJournal<
      Effect.Error<ReviewCompletionEffect>,
      Effect.Services<ReviewCompletionEffect>
    >
  >
>;
type Receipt = ProjectTeamDispatchReceipt<
  ProjectManagedSetupReceipt,
  ProjectTeamInitializationReceipt,
  ProjectTeamAssignmentReceipt
>;
type Owner = { readonly token: symbol; snapshot: Snapshot };
const same = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
const denied = (reason: string) => new ProjectTeamDispatchJournalError({ reason });
const isJournalError = Schema.is(ProjectTeamDispatchJournalError);
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isJournalError(error) ? error : denied("Retained execution evidence is unavailable"),
    ),
  );
const asJson = Schema.decodeUnknownEffect(Schema.JsonObject, { onExcessProperty: "error" });
const workspaceDecode = Schema.decodeUnknownEffect(ProjectTeamWorkspaceReceipt, {
  onExcessProperty: "error",
});
const decodeIntegrationCombination = Schema.decodeUnknownEffect(
  ProjectTeamIntegrationCombinationReceipt,
);
const decodeRecord = Schema.decodeUnknownEffect(ProjectTeamRecord, { onExcessProperty: "error" });
const OwnerSchema = Schema.Struct({
  type: Schema.Literal("owner"),
  unit: Schema.String,
  invocation: Schema.String,
  cgroup: Schema.String,
  pid: Schema.Int,
  memoryBytes: Schema.Int,
  swapBytes: Schema.Int,
  oomGroup: Schema.Int,
  nonce: Schema.String,
});
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(OwnerSchema), {
  onExcessProperty: "error",
});
const decodeAllocation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiManagedProcessAllocationSchema),
  { onExcessProperty: "error" },
);
const bindingFor = (snapshot: Snapshot) => {
  const transition = snapshot.intent.compiledClaim.transition;
  if (transition?.kind !== "claim") throw denied("Original dispatch binding is missing");
  return transition.binding;
};

/** Reads the bounded ownership history; individual receipts still require reconciliation. */
export const readProjectTeamOwnedOperationHistory = Effect.fn(
  "ProjectTeamExecutionHost.operationRows",
)(function* (sql: SqlClient.SqlClient, environmentId: string, snapshot: Snapshot) {
  const binding = bindingFor(snapshot);
  const rows = yield* sql<{
    operation_id: string;
    status: string;
  }>`SELECT operation_id,status FROM project_team_pi_operation
    WHERE environment_id=${environmentId} AND binding_id=${binding.recordId} AND generation=${binding.generation}
    ORDER BY operation_ordinal LIMIT 131`;
  // Initialization and assignment precede at most 128 later mailbox prompts.
  if (rows.length > 130) return yield* denied("Owned operation history exceeds its cleanup bound");
  return rows;
});
const setupInput = (snapshot: Snapshot) => {
  const binding = bindingFor(snapshot);
  return {
    setupId: snapshot.intent.request.setupId,
    dispatchId: snapshot.fence.dispatchId,
    bindingId: binding.recordId,
    generation: binding.generation,
    threadId: binding.threadId,
    worktreePath: binding.worktree,
    deadlineAtMs: snapshot.intent.limits.deadlineAtMs,
  };
};

export const waitForProjectTeamAssignmentChange = Effect.fn("waitForProjectTeamAssignmentChange")(
  function* <A, E, R>(wait: Effect.Effect<A, E, R>, deadlineAtMs: number) {
    const remaining = deadlineAtMs - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) return yield* denied("Original assignment deadline elapsed");
    return yield* wait.pipe(
      Effect.timeoutOrElse({
        duration: remaining,
        orElse: () => Effect.fail(denied("Original assignment deadline elapsed")),
      }),
    );
  },
);

/** Delivers a bounded chain of queued messages while the original executor owns each safe boundary. */
export const continueProjectTeamMailboxTurn = Effect.fn("continueProjectTeamMailboxTurn")(
  function* (input: {
    readonly original: Snapshot;
    readonly turns: Effect.Success<ReturnType<typeof makeProjectTeamMailboxTurns>>;
    readonly assertCurrent: Effect.Effect<void, ProjectTeamDispatchJournalError>;
  }) {
    const engine = yield* OrchestrationEngineService;
    const binding = bindingFor(input.original);
    const changes = yield* engine.subscribeDomainEvents;
    const pull = yield* Stream.toPull(
      changes.pipe(
        Stream.filter(
          (event) => "threadId" in event.payload && event.payload.threadId === binding.threadId,
        ),
      ),
    );
    let afterOperationId: string | undefined;
    for (let boundaryIndex = 0; boundaryIndex <= 128; boundaryIndex++) {
      yield* input.assertCurrent;
      const claimed = yield* input.turns.claim(
        input.original,
        afterOperationId === undefined ? undefined : { afterOperationId },
      );
      if (claimed._tag === "None") return;
      if (claimed._tag === "Retained") {
        afterOperationId = claimed.decision.request.operationId;
        continue;
      }
      if (claimed._tag === "Uncertain") {
        const reflected = yield* input.turns.reflect({
          operationId: claimed.decision.request.operationId,
        });
        if (reflected._tag === "Delivered" || reflected._tag === "Retained") {
          afterOperationId = claimed.decision.request.operationId;
          continue;
        }
        return yield* denied("Original mailbox turn requires reconciliation");
      }
      const decision = claimed.decision;
      if (claimed._tag === "Selected") {
        yield* input.assertCurrent;
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: decision.commandId,
          threadId: decision.request.threadId,
          message: {
            messageId: decision.userMessageId,
            role: "user",
            text: decision.request.prompt,
            displayText: `Team message\n\n${decision.message.body}`,
            attachments: [],
          },
          ...(decision.request.modelSelection === undefined
            ? {}
            : { modelSelection: decision.request.modelSelection }),
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: decision.message.updatedAt,
        });
      }
      for (;;) {
        yield* input.assertCurrent;
        const reflected = yield* input.turns.reflect({ operationId: decision.request.operationId });
        if (reflected._tag === "Delivered" || reflected._tag === "Retained") {
          afterOperationId = decision.request.operationId;
          break;
        }
        if (reflected._tag === "Uncertain")
          return yield* denied("Original mailbox turn has no qualified delivery");
        const events = yield* waitForProjectTeamAssignmentChange(
          pull,
          Math.min(
            input.original.intent.limits.deadlineAtMs,
            input.original.intent.limits.rootDeadlineAtMs,
          ),
        );
        if (
          events.some(
            (event) =>
              event.type === "thread.session-set" &&
              (event.payload.session.status === "error" ||
                event.payload.session.status === "stopped" ||
                event.payload.session.status === "interrupted"),
          )
        )
          return yield* denied("Original mailbox turn terminated without qualified delivery");
      }
    }
    return yield* denied("Mailbox chain exceeded its retained boundary limit");
  },
  Effect.scoped,
);

/** Owns only registered dispatches. A failed drain never releases the journal's reservations. */
export const makeProjectTeamExecutionHost = Effect.fn("makeProjectTeamExecutionHost")(
  function* (options: {
    readonly environmentId: string;
    readonly maximumEnvironmentModelCalls: number;
    readonly protectedRoots: readonly string[];
    readonly launchPolicy: { readonly memoryBytes: number; readonly runtimeSeconds: number };
    readonly assertEnabled: Effect.Effect<void, ProjectTeamDispatchJournalError>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const taskResources = yield* makeProjectTaskResources(options.environmentId);
    const repository = yield* ProjectWorkRepository;
    const provider = yield* ProviderService;
    const pi = yield* ProjectTeamPiRuntime;
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const scope = yield* Scope.Scope;
    const services = yield* Effect.context<
      | Effect.Services<ReturnType<typeof makeProjectTeamWorkspace>>
      | Effect.Services<ReturnType<typeof reconcilePiManagedProcess>>
    >();
    const owners = new Map<string, Owner>();
    let stopping = false;
    const owned = Effect.fn("ProjectTeamExecutionHost.owned")(function* (owner: Owner) {
      if (owners.get(owner.snapshot.fence.dispatchId) !== owner)
        return yield* denied("Executor ownership changed");
    });
    const setupJournal = yield* makeProjectManagedSetupJournal({
      ...options,
      validateSelection: () =>
        Effect.fail(new ProjectManagedSetupError({ reason: "Cleanup cannot authorize setup" })),
    });
    const integrationSources = yield* makeProjectTeamIntegrationSources({
      environmentId: options.environmentId,
    });
    const receipts = yield* makeProjectTeamSessionReceipts(options);
    const mailbox = yield* makeProjectTeamMailboxConsumption({
      environmentId: options.environmentId,
    });
    const operations = yield* makeProjectTeamPiOperations({ environmentId: options.environmentId });
    const mailboxTurns = yield* makeProjectTeamMailboxTurns({
      environmentId: options.environmentId,
      lookupInTransaction: operations.lookupInTransaction,
    });
    const mailboxTurnDecisions = yield* makeProjectTeamMailboxTurnDecisionReader({
      environmentId: options.environmentId,
    });
    const retainedSetup = Effect.fn("ProjectTeamExecutionHost.retainedSetup")(function* (
      snapshot: Snapshot,
    ) {
      const retained = yield* setupJournal.readOwnership(setupInput(snapshot));
      if (
        retained === null ||
        retained.retained.uncertain ||
        !isProjectManagedSetupReceiptValid(retained.retained)
      )
        return yield* denied("Setup has no qualified retained completion");
      const receipt = retained.retained.receipt;
      if (receipt === null || (receipt.outcome !== "skipped" && receipt.outcome !== "succeeded"))
        return yield* denied("Setup did not complete successfully");
      return receipt;
    });
    const verifyStage = Effect.fn("ProjectTeamExecutionHost.verifyStage")(function* (
      input: { stage: string; evidence: Schema.JsonObject },
      snapshot: Snapshot,
    ) {
      const owner = owners.get(snapshot.fence.dispatchId);
      if (owner === undefined) return yield* denied("Stage writer has no registered executor");
      yield* owned(owner);
      const joinedReplay =
        input.stage === "settled" &&
        snapshot.fence.stage === "settled" &&
        owner.snapshot.fence.claimGeneration === snapshot.fence.claimGeneration &&
        same(owner.snapshot.intent, snapshot.intent);
      if (!joinedReplay && !same(owner.snapshot.fence, snapshot.fence))
        return yield* denied("Stage executor fence changed");
      if (input.stage === "quarantine" || input.stage === "stopping") {
        if (
          !same(input.evidence, {
            version: 1,
            dispatchId: snapshot.fence.dispatchId,
            claimGeneration: snapshot.fence.claimGeneration,
            reason: "Original writer outcome requires reconciliation",
          })
        )
          return yield* denied("Cleanup stage evidence changed");
        return;
      }
      if (input.stage === "settled") {
        if (!same(input.evidence, yield* collectDrain(snapshot)))
          return yield* denied("Joined cleanup evidence changed");
        return;
      }
      const workspace = yield* workspaceDecode(input.evidence.workspace);
      yield* (yield* workspaceService).verifyWorkspace(snapshot, workspace);
      const integration =
        input.evidence.integration === undefined
          ? undefined
          : yield* decodeIntegrationCombination(input.evidence.integration);
      if ((snapshot.intent.integration !== undefined) !== (integration !== undefined))
        return yield* denied("Integration stage evidence does not match its approved selection");
      if (integration !== undefined)
        yield* (yield* workspaceService).verifyIntegration(snapshot, integration);
      const setup = input.stage === "workspace-ready" ? undefined : yield* retainedSetup(snapshot);
      const session =
        input.stage === "session-bound" ||
        input.stage === "assignment-intent" ||
        input.stage === "assignment-observed"
          ? yield* receipts.readInitialization(snapshot)
          : undefined;
      if (
        session === undefined &&
        (input.stage === "session-bound" ||
          input.stage === "assignment-intent" ||
          input.stage === "assignment-observed")
      )
        return yield* denied("Original initialization receipt is unavailable");
      const assignment =
        input.stage === "assignment-observed"
          ? yield* receipts.readAssignment(snapshot)
          : undefined;
      if (input.stage === "assignment-observed" && assignment === undefined)
        return yield* denied("Original assignment receipt is unavailable");
      const expected = yield* asJson({
        workspace,
        ...(integration === undefined ? {} : { integration }),
        ...(setup === undefined ? {} : { setup }),
        ...(session === undefined ? {} : { session }),
        ...(assignment === undefined ? {} : { assignment }),
      });
      if (!same(input.evidence, expected))
        return yield* denied("Stage evidence differs from retained physical receipts");
    });
    const currentTarget = yield* makeProjectTeamReviewCurrentTarget({
      environmentId: options.environmentId,
    });
    const reviewCompletionFactory = makeProjectTeamReviewCompletion({
      environmentId: options.environmentId,
      maximumEnvironmentModelCalls: options.maximumEnvironmentModelCalls,
    });
    const reviewCompletion = yield* Effect.gen(function* () {
      return yield* reviewCompletionFactory;
    }).pipe(Effect.provideService(ProjectTeamReviewCurrentTarget, currentTarget));
    const journal: Journal = yield* makeProjectTeamDispatchJournal({
      ...options,
      prepareReviewCompletion: reviewCompletion.prepare,
      prepareFailure: (snapshot) =>
        boundary(operations.readJoinedQuarantinedFailureInTransaction(snapshot)),
      verifyReviewTarget: currentTarget.assertOriginalInTransaction,
      verifyStage: (receipt, snapshot) =>
        boundary(verifyStage(receipt, snapshot)).pipe(Effect.provideService(Scope.Scope, scope)),
      verifySettlement: (receipt, snapshot) =>
        boundary(verifyStage(receipt, snapshot)).pipe(Effect.provideService(Scope.Scope, scope)),
    });
    const assertCurrent = Effect.fn("ProjectTeamExecutionHost.assertCurrent")(function* (
      owner: Owner,
      expected: ProjectTeamDispatchFence,
    ) {
      yield* owned(owner);
      if (stopping) return yield* denied("Executor is stopping");
      yield* options.assertEnabled;
      const current = yield* journal.inspect(
        expected.dispatchId,
        expected.claimGeneration > 0 ? { requireClaim: true } : undefined,
      );
      if (!same(current.fence, expected) || !same(current.intent, owner.snapshot.intent))
        return yield* denied("Executor fence changed");
      owner.snapshot = current;
      return current;
    });
    const assertIntegrationCurrent = Effect.fn("ProjectTeamExecutionHost.assertIntegrationCurrent")(
      function* (snapshot: Snapshot) {
        if (snapshot.intent.integration === undefined) return;
        const claim = snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* denied("Integration has no original binding");
        yield* sql
          .withTransaction(
            integrationSources.assertCurrentInTransaction({
              projectId: claim.binding.projectId,
              integrationTaskId: claim.binding.taskId,
              sources: snapshot.intent.integration.selection,
            }),
          )
          .pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectWorkRepository, repository),
            Effect.mapError(() => denied("Approved integration sources changed")),
          );
      },
    );
    const workspaceService = yield* makeProjectTeamWorkspace({
      ...options,
      assertCurrent: (snapshot) =>
        boundary(
          Effect.gen(function* () {
            const owner = owners.get(snapshot.fence.dispatchId);
            if (owner === undefined) return yield* denied("Workspace has no registered executor");
            yield* assertCurrent(owner, snapshot.fence);
          }),
        ),
    }).pipe(Effect.provide(services), Effect.provideService(Scope.Scope, scope), Effect.cached);
    const operationRows = (snapshot: Snapshot) =>
      readProjectTeamOwnedOperationHistory(sql, options.environmentId, snapshot);
    const collectDrain = Effect.fn("ProjectTeamExecutionHost.collectDrain")(function* (
      snapshot: Snapshot,
    ) {
      const binding = bindingFor(snapshot);
      const rows = yield* operationRows(snapshot);
      const setup = yield* setupJournal.readOwnership(setupInput(snapshot));
      // Before the first effect claim, this host cannot have started Git, setup or Pi writers.
      if (snapshot.fence.claimGeneration === 0) {
        if (rows.length !== 0 || setup !== null)
          return yield* denied("Unclaimed dispatch has unexpected writer history");
        return yield* asJson({
          version: 1,
          dispatchId: snapshot.fence.dispatchId,
          bindingId: binding.recordId,
          generation: binding.generation,
          claimGeneration: 0,
          setup: null,
          operations: [],
        });
      }
      // A crash during the first Git effect has no process-join receipt. Do not infer absence from a missing setup row.
      if (snapshot.fence.stage === "reserved" || setup === null)
        return yield* denied("Claimed workspace writer has no joined ownership receipt");
      const setupReceipt = yield* (yield* workspaceService).reconcile(snapshot);
      const operations = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const processRows = yield* sql<{
            allocation_json: string;
            owner_json: string | null;
            status: string;
          }>`SELECT allocation_json,owner_json,status FROM project_team_pi_process WHERE operation_id=${row.operation_id} LIMIT 2`;
          const process = processRows[0];
          if (
            processRows.length !== 1 ||
            process === undefined ||
            Buffer.byteLength(process.allocation_json) > 262144 ||
            (process.owner_json !== null && Buffer.byteLength(process.owner_json) > 262144)
          )
            return yield* denied("Original native process ownership is unavailable");
          const allocation = yield* decodeAllocation(process.allocation_json);
          const owner =
            process.owner_json === null ? undefined : yield* decodeOwner(process.owner_json);
          const result = yield* reconcilePiManagedProcess(
            {
              allocation,
              activation:
                owner !== undefined
                  ? "owned"
                  : process.status === "allocated"
                    ? "unlaunched"
                    : "claimed",
              ...(owner === undefined ? {} : { owner }),
            },
            { stop: true },
          ).pipe(Effect.provide(services));
          if (result.state === "owned")
            return yield* denied("Original native writer has not drained");
          if (result.state === "drained")
            yield* sql
              .withTransaction(taskResources.pi(row.operation_id, allocation).cleanupDrain(result))
              .pipe(Effect.mapError(() => denied("Original task resource drain remains unproved")));
          return {
            operationId: row.operation_id,
            allocation,
            ...(owner === undefined ? {} : { owner }),
            reconciliation: result,
          };
        }),
      );
      return yield* asJson({
        version: 1,
        dispatchId: snapshot.fence.dispatchId,
        bindingId: binding.recordId,
        generation: binding.generation,
        claimGeneration: snapshot.fence.claimGeneration,
        setup: setupReceipt,
        operations,
      });
    });
    const quarantine = Effect.fn("ProjectTeamExecutionHost.quarantine")(function* (owner: Owner) {
      yield* owned(owner);
      const snapshot = yield* journal.readRetained(owner.snapshot.fence.dispatchId);
      owner.snapshot = snapshot;
      if (snapshot.fence.stage === "settled") return;
      if (snapshot.fence.stage !== "quarantine") {
        const next = yield* journal.advanceStage(snapshot.fence, {
          receiptId: projectTeamDerivedRecordId(
            snapshot.fence.dispatchId,
            `quarantine:${snapshot.fence.revision}`,
          ),
          stage: "quarantine",
          evidence: {
            version: 1,
            dispatchId: snapshot.fence.dispatchId,
            claimGeneration: snapshot.fence.claimGeneration,
            reason: "Original writer outcome requires reconciliation",
          },
        });
        owner.snapshot = next;
      }
      const binding = bindingFor(snapshot);
      yield* repository.executeAtomic(
        Effect.gen(function* () {
          const state = yield* readCurrentState(sql, binding.projectId);
          const records = [];
          const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
          for (const record of state.foundationRecords ?? []) {
            if (
              record.kind === "run-binding" &&
              record.recordId === binding.recordId &&
              record.status !== "quarantined" &&
              record.status !== "settled"
            )
              records.push(
                yield* decodeRecord({
                  ...record,
                  status: "quarantined",
                  revision: record.revision + 1,
                  updatedAt: at,
                }),
              );
            if (
              snapshot.fence.claimGeneration > 0 &&
              record.kind === "effect" &&
              record.runId === binding.recordId &&
              record.effectKind === "dispatch" &&
              (record.status === "pending" || record.status === "claimed")
            )
              records.push(
                yield* decodeRecord({
                  ...record,
                  status: "uncertain",
                  revision: record.revision + 1,
                  updatedAt: at,
                }),
              );
          }
          return records.length === 0
            ? []
            : [
                {
                  type: "project-work.foundation.commit" as const,
                  projectId: binding.projectId,
                  commandId: CommandId.make(
                    projectTeamDerivedRecordId(
                      snapshot.fence.dispatchId,
                      `quarantine-domain:${snapshot.fence.revision}`,
                    ),
                  ),
                  expectedRevision: state.revision,
                  attribution: {
                    actor: { kind: "system" as const, id: "project-team-runtime" },
                    source: { kind: "system" as const, id: "project-team-runtime" },
                    recordedAt: at,
                  },
                  records,
                  committedAt: at,
                },
              ];
        }),
      );
    });
    const joinCleanup = Effect.fn("ProjectTeamExecutionHost.joinCleanup")(function* (owner: Owner) {
      yield* owned(owner);
      const snapshot = yield* journal.readRetained(owner.snapshot.fence.dispatchId);
      owner.snapshot = snapshot;
      const binding = bindingFor(snapshot);
      const operations = yield* operationRows(snapshot);
      // Stop only this exact registered thread; retained physical reconciliation still decides release.
      if (operations.some((row) => row.status !== "settled"))
        yield* pi
          .withInstance(binding.providerInstanceId, ({ runtime }) =>
            runtime.requestStop(binding.threadId),
          )
          .pipe(Effect.result);
      const evidence = yield* boundary(collectDrain(snapshot)).pipe(Effect.result);
      if (evidence._tag === "Failure")
        return { _tag: "Uncertain" as const, cause: Cause.fail(evidence.failure) };
      const decision = yield* sql.withTransaction(
        mailboxTurnDecisions.readHeadInTransaction({ dispatchId: snapshot.fence.dispatchId }),
      );
      if (decision?.kind === "one")
        yield* mailboxTurns.reflect({ operationId: decision.request.operationId });
      return { _tag: "Joined" as const, receipt: evidence.success };
    });
    const settle = Effect.fn("ProjectTeamExecutionHost.settle")(function* (
      owner: Owner,
      evidence: Schema.JsonObject,
    ) {
      yield* owned(owner);
      const snapshot = yield* journal.readRetained(owner.snapshot.fence.dispatchId);
      owner.snapshot = snapshot;
      const joined = {
        receiptId: projectTeamDerivedRecordId(
          snapshot.fence.dispatchId,
          `joined:${snapshot.fence.claimGeneration}`,
        ),
        stage: "settled" as const,
        evidence,
      };
      owner.snapshot = yield* currentTarget.withOriginalTarget(
        snapshot,
        joined,
        journal.settleAfterJoined(snapshot.fence, joined),
      );
    });
    const stopAndJoin = Effect.fn("ProjectTeamExecutionHost.stopAndJoin")(function* (owner: Owner) {
      const outcome = yield* joinCleanup(owner);
      if (outcome._tag === "Joined") yield* settle(owner, outcome.receipt);
      else yield* quarantine(owner);
    });
    const withOwner = <A, E, R>(
      snapshot: Snapshot,
      run: (owner: Owner) => Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          if (owners.has(snapshot.fence.dispatchId)) return undefined;
          const owner: Owner = { token: Symbol("dispatch executor"), snapshot };
          owners.set(snapshot.fence.dispatchId, owner);
          return owner;
        }),
        (owner): Effect.Effect<A | { readonly _tag: "Busy" }, E, R> =>
          owner === undefined ? Effect.succeed({ _tag: "Busy" as const }) : run(owner),
        (owner) =>
          Effect.sync(() => {
            if (owner !== undefined && owners.get(snapshot.fence.dispatchId) === owner)
              owners.delete(snapshot.fence.dispatchId);
          }),
      );
    const readReceipt = Effect.fn("ProjectTeamExecutionHost.readReceipt")(function* (
      snapshot: Snapshot,
    ): Effect.fn.Return<
      Receipt | undefined,
      Effect.Error<ReturnType<Journal["readStageReceipts"]>>
    > {
      if (snapshot.fence.stage === "reserved") return;
      const history = yield* journal.readStageReceipts(snapshot.fence.dispatchId);
      const stored = history.find((row) => row.stage === "workspace-ready");
      if (stored === undefined) return yield* denied("Retained workspace stage is missing");
      const workspace = yield* workspaceDecode(stored.evidence.workspace).pipe(
        Effect.mapError(() => denied("Retained workspace stage is invalid")),
      );
      const integration =
        stored.evidence.integration === undefined
          ? undefined
          : yield* decodeIntegrationCombination(stored.evidence.integration).pipe(
              Effect.mapError(() => denied("Retained integration stage is invalid")),
            );
      if ((snapshot.intent.integration !== undefined) !== (integration !== undefined))
        return yield* denied("Retained combination does not match original selected sources");
      const physical = { workspace, ...(integration === undefined ? {} : { integration }) };
      if (snapshot.fence.stage === "workspace-ready")
        return { stage: "workspace-ready", ...physical };
      const setup = yield* retainedSetup(snapshot).pipe(
        Effect.mapError(() => denied("Retained setup stage is invalid")),
      );
      if (snapshot.fence.stage === "setup-complete")
        return { stage: "setup-complete", ...physical, setup };
      const session = yield* receipts
        .readInitialization(snapshot)
        .pipe(Effect.mapError(() => denied("Retained initialization stage is invalid")));
      if (session === undefined) return yield* denied("Retained initialization stage is missing");
      if (snapshot.fence.stage === "session-bound" || snapshot.fence.stage === "assignment-intent")
        return { stage: snapshot.fence.stage, ...physical, setup, session };
      const assignment = yield* receipts
        .readAssignment(snapshot)
        .pipe(Effect.mapError(() => denied("Retained assignment stage is invalid")));
      if (snapshot.fence.stage !== "assignment-observed" || assignment === undefined)
        return yield* denied("Dispatch cannot resume its retained cleanup stage");
      return { stage: "assignment-observed", ...physical, setup, session, assignment };
    });
    const readAssignmentObservation = Effect.fn(
      "ProjectTeamExecutionHost.readAssignmentObservation",
    )(function* (snapshot: Snapshot) {
      const batches = yield* sql<{
        operation_id: string;
      }>`SELECT operation_id FROM project_team_mailbox_batch WHERE operation_id=${snapshot.intent.request.assignmentOperationId} LIMIT 2`;
      if (batches.length > 1) return yield* denied("Assignment mailbox identity is ambiguous");
      if (batches.length === 1) {
        const reflection = yield* mailbox.reflectAssignment(snapshot);
        if (reflection.status === "delivered" || reflection.status === "unchanged")
          return reflection.receipt;
        return undefined;
      }
      // Legacy assignments have no sealed batch and cannot qualify mailbox delivery.
      const rows = yield* sql<{
        status: string;
      }>`SELECT status FROM project_team_pi_operation WHERE operation_id=${snapshot.intent.request.assignmentOperationId} LIMIT 2`;
      if (rows.length > 1) return yield* denied("Assignment operation identity is ambiguous");
      if (rows[0]?.status !== "settled") return undefined;
      return yield* receipts.readAssignment(snapshot);
    });
    const sendAssignment = Effect.fn("ProjectTeamExecutionHost.sendAssignment")(function* (
      owner: Owner,
      snapshot: Snapshot,
    ) {
      yield* assertCurrent(owner, snapshot.fence);
      const binding = bindingFor(snapshot);
      const changes = yield* engine.subscribeDomainEvents;
      const pull = yield* Stream.toPull(
        changes.pipe(
          Stream.filter(
            (event) => "threadId" in event.payload && event.payload.threadId === binding.threadId,
          ),
        ),
      );
      const prior = yield* readAssignmentObservation(snapshot);
      if (prior !== undefined) return { _tag: "Observed" as const, receipt: prior };
      // The ordinary reactor owns sendTurn and visible user-message history. This command is deduplicated;
      // recovery never emits a replacement command after assignment-intent.
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(
          projectTeamDerivedRecordId(snapshot.fence.dispatchId, "assignment-turn"),
        ),
        threadId: binding.threadId,
        message: {
          messageId: MessageId.make(
            projectTeamDerivedRecordId(snapshot.fence.dispatchId, "assignment-message"),
          ),
          role: "user",
          text: snapshot.intent.request.assignment,
          attachments: [],
        },
        modelSelection: { instanceId: binding.providerInstanceId, model: binding.model },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: snapshot.intent.compiledClaim.committedAt,
      });
      for (;;) {
        yield* assertCurrent(owner, snapshot.fence);
        const receipt = yield* readAssignmentObservation(snapshot);
        if (receipt !== undefined) return { _tag: "Observed" as const, receipt };
        const events = yield* waitForProjectTeamAssignmentChange(
          pull,
          snapshot.intent.limits.deadlineAtMs,
        );
        if (
          events.some(
            (event) =>
              event.type === "thread.session-set" &&
              (event.payload.session.status === "error" ||
                event.payload.session.status === "stopped" ||
                event.payload.session.status === "interrupted"),
          )
        )
          return {
            _tag: "Uncertain" as const,
            cause: Cause.fail(denied("Original assignment terminated without a qualified receipt")),
          };
      }
    }, Effect.scoped);
    const dispatch = makeProjectTeamDispatch<
      Owner,
      Owner,
      ProjectManagedSetupReceipt,
      ProjectTeamInitializationReceipt,
      ProjectTeamAssignmentReceipt,
      ProjectTeamDispatchJournalError,
      Scope.Scope
    >({
      withExecutor: (id, run) =>
        boundary(journal.inspect(id)).pipe(Effect.flatMap((snapshot) => withOwner(snapshot, run))),
      withRecoveryExecutor: (claim: Owner, run) =>
        owned(claim).pipe(Effect.andThen(run(claim, claim.snapshot))),
      inspect: (id) => boundary(journal.inspect(id)),
      claimEffect: (owner: Owner, expected) =>
        boundary(
          owned(owner).pipe(
            Effect.andThen(options.assertEnabled),
            Effect.andThen(journal.claimEffect(expected)),
            Effect.tap((snapshot) =>
              Effect.sync(() => {
                owner.snapshot = snapshot;
              }),
            ),
          ),
        ),
      assertCurrent: (owner: Owner, expected) => boundary(assertCurrent(owner, expected)),
      readReceipt: (_owner, snapshot) => boundary(readReceipt(snapshot)),
      appendStage: (owner, snapshot, receipt: Receipt) =>
        boundary(
          Effect.gen(function* () {
            const { stage, ...evidence } = receipt;
            const next = yield* journal.advanceStage(snapshot.fence, {
              receiptId: projectTeamDerivedRecordId(snapshot.fence.dispatchId, `stage:${stage}`),
              stage,
              evidence: yield* asJson(evidence),
            });
            const current = { fence: next.fence, intent: next.intent };
            owner.snapshot = current;
            return current;
          }),
        ),
      withWorkspace: (_owner, snapshot, use) =>
        boundary(
          Effect.gen(function* () {
            yield* assertIntegrationCurrent(snapshot);
            return yield* (yield* workspaceService).withWorkspace(snapshot, use);
          }),
        ),
      setup: (_owner, snapshot, workspace) =>
        boundary(
          Effect.gen(function* () {
            yield* assertIntegrationCurrent(snapshot);
            return yield* (yield* workspaceService).setup(snapshot, workspace);
          }),
        ),
      initialize: (owner, snapshot) =>
        boundary(
          Effect.gen(function* () {
            yield* assertIntegrationCurrent(snapshot);
            yield* assertCurrent(owner, snapshot.fence);
            const binding = bindingFor(snapshot);
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make(
                projectTeamDerivedRecordId(snapshot.fence.dispatchId, "thread"),
              ),
              threadId: binding.threadId,
              projectId: binding.projectId,
              title: `Managed task ${binding.taskId}`,
              modelSelection: { instanceId: binding.providerInstanceId, model: binding.model },
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: binding.branch,
              worktreePath: binding.worktree,
              createdAt: snapshot.intent.compiledClaim.committedAt,
            });
            const thread = yield* query.getThreadShellById(binding.threadId);
            if (
              Option.isNone(thread) ||
              thread.value.projectId !== binding.projectId ||
              thread.value.worktreePath !== binding.worktree ||
              thread.value.branch !== binding.branch ||
              !same(thread.value.modelSelection, {
                instanceId: binding.providerInstanceId,
                model: binding.model,
              }) ||
              thread.value.runtimeMode !== "approval-required"
            )
              return yield* denied("Original managed thread identity changed");
            const prior = yield* receipts.readInitialization(snapshot);
            if (prior !== undefined) return prior;
            yield* assertCurrent(owner, snapshot.fence);
            yield* provider.startSession(binding.threadId, {
              threadId: binding.threadId,
              providerInstanceId: binding.providerInstanceId,
              cwd: binding.worktree,
              modelSelection: { instanceId: binding.providerInstanceId, model: binding.model },
              runtimeMode: "approval-required",
            });
            const receipt = yield* receipts.readInitialization(snapshot);
            if (receipt === undefined)
              return yield* denied("Initialize returned without qualified terminal/drain evidence");
            return receipt;
          }),
        ),
      sendAssignment: (owner: Owner, snapshot) =>
        boundary(
          assertIntegrationCurrent(snapshot).pipe(Effect.andThen(sendAssignment(owner, snapshot))),
        ),
      readAssignmentObservation: (_owner, snapshot) =>
        boundary(readAssignmentObservation(snapshot)),
      recordUncertain: (owner) => boundary(quarantine(owner)),
      stopAndJoin: (owner) => boundary(stopAndJoin(owner)),
    });
    const recovery = makeProjectTeamRecovery<
      Owner,
      Schema.JsonObject,
      ProjectTeamDispatchJournalError,
      Scope.Scope
    >({
      readPage: (input) =>
        boundary(journal.readRecoveryCandidates(input)).pipe(
          Effect.map((items) =>
            items.map((item) => ({
              ...item,
              snapshot: Exit.mapError(item.snapshot, (error) =>
                isJournalError(error)
                  ? error
                  : denied("Retained dispatch discovery is unavailable"),
              ),
            })),
          ),
        ),
      recordDiscoveryFailure: (id, _cause) =>
        Effect.logWarning("Project team retained dispatch is unavailable", { dispatchId: id }),
      withClaim: (snapshot, run) => withOwner(snapshot, run),
      assess: (owner: Owner) =>
        boundary(
          Effect.gen(function* () {
            yield* owned(owner);
            const snapshot = yield* journal.readRetained(owner.snapshot.fence.dispatchId);
            owner.snapshot = snapshot;
            const current = yield* boundary(
              options.assertEnabled.pipe(
                Effect.andThen(journal.inspect(snapshot.fence.dispatchId)),
              ),
            ).pipe(Effect.result);
            if (
              current._tag === "Failure" ||
              // An existing claim cannot prove that its first Git writer completed before a crash.
              (snapshot.fence.stage === "reserved" && snapshot.fence.claimGeneration > 0) ||
              snapshot.fence.stage === "quarantine" ||
              snapshot.fence.stage === "stopping"
            )
              return {
                _tag: "Cleanup" as const,
                cause:
                  current._tag === "Failure"
                    ? Cause.fail(current.failure)
                    : Cause.fail(denied("Retained dispatch requires cleanup")),
              };
            const rows = yield* operationRows(snapshot);
            if (rows.some((row) => row.status !== "settled"))
              return {
                _tag: "Cleanup" as const,
                cause: Cause.fail(denied("Original operation requires physical reconciliation")),
              };
            if (snapshot.fence.claimGeneration === 0) {
              // Recovery requires a claimed continuation. Keep the registered owner across the first CAS.
              yield* assertCurrent(owner, snapshot.fence);
              owner.snapshot = yield* journal.claimEffect(snapshot.fence);
            }
            return { _tag: "Resume" as const, claim: owner, snapshot: owner.snapshot };
          }),
        ),
      resume: (owner) =>
        boundary(
          Effect.gen(function* () {
            const outcome = yield* dispatch.resume(owner);
            if (outcome._tag !== "Observed") return outcome;
            const original = yield* journal.readRetained(owner.snapshot.fence.dispatchId);
            owner.snapshot = original;
            yield* continueProjectTeamMailboxTurn({
              original,
              turns: mailboxTurns,
              assertCurrent: boundary(assertCurrent(owner, owner.snapshot.fence)).pipe(
                Effect.asVoid,
              ),
            }).pipe(Effect.provideService(OrchestrationEngineService, engine));
            // A native terminal is observation, not release. Join every original writer before settlement.
            yield* stopAndJoin(owner);
            const retained = yield* journal.readRetained(owner.snapshot.fence.dispatchId);
            if (retained.fence.stage !== "settled")
              return yield* denied("Observed assignment has no qualified joined settlement");
            return { _tag: "Observed" as const, fence: retained.fence };
          }),
        ),
      joinCleanup: (owner) => boundary(joinCleanup(owner)),
      settle: (owner, evidence) => boundary(settle(owner, evidence)),
      quarantine: (owner) => boundary(quarantine(owner)),
    });
    const stop = Effect.gen(function* () {
      stopping = true;
      yield* Effect.forEach(
        [...owners.values()],
        (owner) =>
          stopAndJoin(owner).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Project team cleanup retained uncertainty", cause),
            ),
          ),
        { discard: true },
      );
    });
    return {
      recover: () => recovery.sweep().pipe(Effect.provideService(Scope.Scope, scope)),
      stop,
    };
  },
);
