import { decodeProjectWorkEvent } from "./ProjectWorkEventStore.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Semaphore from "effect/Semaphore";
import { planMailboxClaim, planMailboxReflection } from "./ProjectTeamMailboxTurns.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import { OwnerDeadlineControlPayload } from "../orchestration-v2/EffectOutbox.ts";
import type { ProjectWorkCommand } from "@t3tools/contracts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Schema from "effect/Schema";
import * as Bus from "./ProjectWorkEventBus.ts";
import * as Stream from "effect/Stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Stable assignment identities survive retries without allocating replacement threads.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  ThreadId,
  ProjectWorkAttemptId,
  canonicalProjectWorkPayload,
  type ProjectTeamDispatchIntent,
  type ProjectTeamRecord,
  type ProjectWorkWriteResult,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Registry from "../provider/ProviderRegistry.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import * as Journal from "./ProjectTeamDispatchJournal.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import { projectTaskAssignment } from "./ProjectTaskResources.ts";
import * as Recovery from "./ProjectTeamRecovery.ts";
import * as Reviews from "./ProjectTeamReviewFreshness.ts";
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
const decodeRuntimeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isJournalError = Schema.is(Journal.ProjectTeamDispatchJournalError);
const decodeControl = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OwnerDeadlineControlPayload),
);
const rejected = () => new Journal.ProjectTeamDispatchJournalError({ reason: "identity-conflict" });
export class ProjectTeamDispatch extends Context.Service<
  ProjectTeamDispatch,
  {
    readonly dispatch: (
      input: ProjectTeamDispatchIntent,
      attribution: ProjectWorkAttribution,
    ) => Effect.Effect<ProjectWorkWriteResult, Journal.ProjectTeamDispatchJournalError>;
    readonly mailbox: Effect.Effect<void, Journal.ProjectTeamDispatchJournalError>;
    readonly reconcile: Effect.Effect<void, Journal.ProjectTeamDispatchJournalError>;
    readonly recover: Effect.Effect<void, Journal.ProjectTeamDispatchJournalError>;
  }
>()("t3/projectWork/ProjectTeamDispatch") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* Repository.ProjectWorkRepository;
  const threads = yield* Threads.ThreadManagementService;
  const journal = yield* Journal.ProjectTeamDispatchJournal;
  const launch = yield* Launch.ThreadLaunchService;
  const registry = yield* Registry.ProviderRegistry;
  const environment = yield* Environment.ServerEnvironment;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const terminals = yield* Effect.serviceOption(Terminals.TerminalManager);
  const eventBus = yield* Effect.serviceOption(Bus.ProjectWorkEventBus);
  const reviews = yield* Effect.serviceOption(Reviews.ProjectTeamReviewFreshness);
  const publishRuntime = Effect.fn("ProjectTeamDispatch.publishRuntime")(function* (
    commandId: string,
  ) {
    if (Option.isNone(eventBus)) return;
    const rows = yield* sql<{
      sequence: number;
      payload_json: string;
    }>`SELECT sequence,payload_json FROM t3_workflow_v2_work_events WHERE command_id=${`admission:${commandId}`} ORDER BY sequence`;
    yield* eventBus.value.publish(
      rows.map((row) => ({
        cursor: row.sequence,
        event: decodeProjectWorkEvent(decodeRuntimeEvent(row.payload_json)),
      })),
    );
  });
  const mailboxLock = yield* Semaphore.make(1);
  const reconcileLock = yield* Semaphore.make(1);
  const reconcileProjectTeamDispatch = yield* Recovery.make;
  const assertObservedOwner = Effect.fn("ProjectTeamDispatch.assertObservedOwner")(function* (
    snapshot: Journal.DispatchSnapshot,
    projection: import("@t3tools/contracts").OrchestrationV2ThreadProjection,
  ) {
    const run = projection.runs.find(
      (run) => run.userMessageId === `${snapshot.dispatchId}:message`,
    );
    if (run === undefined) return yield* rejected();
    const rows =
      yield* sql`SELECT admission_id FROM t3_workflow_v2_run_admissions WHERE project_id=${snapshot.projectId} AND binding_id=${snapshot.bindingId} AND thread_id=${snapshot.threadId} AND run_id=${run.id} AND fence=${snapshot.generation}`;
    const state = yield* Repository.readCurrentState(sql, snapshot.projectId);
    const binding = state.foundationRecords?.find(
      (record) => record.kind === "run-binding" && record.recordId === snapshot.bindingId,
    );
    if (
      rows.length !== 1 ||
      binding?.kind !== "run-binding" ||
      binding.generation !== snapshot.generation ||
      binding.runId !== run.id
    )
      return yield* rejected();
  });
  const advanceDispatch = Effect.fn("ProjectTeamDispatch.advance")(function* (
    snapshot: Journal.DispatchSnapshot,
    stage: "uncertain" | "observed",
    at: string,
  ) {
    const advance = journal.advance(snapshot, stage, at);
    return yield* advance.pipe(
      Effect.catchTags({
        ProjectTeamDispatchJournalError: (error) =>
          Effect.gen(function* () {
            if (error.reason !== "stale-fence") return yield* error;
            const current = yield* journal.read(snapshot.dispatchId);
            if (
              Option.isNone(current) ||
              current.value.bindingId !== snapshot.bindingId ||
              current.value.generation !== snapshot.generation ||
              current.value.fingerprint !== snapshot.fingerprint
            )
              return yield* error;
            if (current.value.stage === stage || current.value.stage === "observed")
              return current.value;
            if (stage === "observed" && current.value.stage === "uncertain")
              return yield* journal.advance(current.value, stage, at);
            return yield* error;
          }),
      }),
    );
  });
  const resume = Effect.fn("ProjectTeamDispatch.resume")(
    function* (snapshot: Journal.DispatchSnapshot) {
      if (
        snapshot.stage === "stopping" ||
        snapshot.stage === "settled" ||
        snapshot.stage === "observed"
      )
        return snapshot.result;
      const at = DateTime.formatIso(yield* DateTime.now);
      const current = yield* Repository.readCurrentState(sql, snapshot.projectId);
      const binding = (current.foundationRecords ?? []).find(
        (record) => record.kind === "run-binding" && record.recordId === snapshot.bindingId,
      );
      if (
        binding?.kind !== "run-binding" ||
        binding.generation !== snapshot.generation ||
        !["reserved", "running"].includes(binding.status)
      )
        return yield* rejected();
      const reconciled = yield* reconcileProjectTeamDispatch(snapshot);
      if (reconciled.status === "observed") {
        yield* assertObservedOwner(snapshot, reconciled.projection);
        yield* advanceDispatch(snapshot, "observed", at);
        return snapshot.result;
      }
      // Retain uncertainty before crossing the launch boundary. Replays always use this exact thread/message/command identity.
      const pending =
        snapshot.stage === "uncertain"
          ? snapshot
          : yield* advanceDispatch(snapshot, "uncertain", at);
      if (pending.stage === "observed") return pending.result;
      yield* launch.launch({
        commandId: CommandId.make(snapshot.dispatchId),
        threadId: ThreadId.make(snapshot.threadId),
        projectId: snapshot.request.projectId,
        title:
          current.tasks.find((task) => task.taskId === snapshot.taskId)?.title ?? "Project Work",
        modelSelection: snapshot.request.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: snapshot.request.workspace,
        initialMessage: {
          messageId: MessageId.make(`${snapshot.dispatchId}:message`),
          text: snapshot.assignment,
          attachments: [],
        },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const observed = yield* reconcileProjectTeamDispatch(pending);
      if (observed.status !== "observed") return yield* rejected();
      yield* assertObservedOwner(pending, observed.projection);
      yield* advanceDispatch(pending, "observed", DateTime.formatIso(yield* DateTime.now));
      return snapshot.result;
    },
    Effect.mapError((cause) =>
      isJournalError(cause)
        ? cause
        : new Journal.ProjectTeamDispatchJournalError({ reason: "storage", cause }),
    ),
  );
  const dispatch = Effect.fn("ProjectTeamDispatch.dispatch")(
    function* (input: ProjectTeamDispatchIntent, attribution: ProjectWorkAttribution) {
      const dispatchId = `work-dispatch:${hash({ projectId: input.projectId, commandId: input.commandId })}`;
      const fingerprint = hash({ input, actor: attribution.actor, source: attribution.source });
      const existing = yield* journal.read(dispatchId);
      if (Option.isSome(existing)) {
        if (existing.value.fingerprint !== fingerprint) return yield* rejected();
        return yield* resume(existing.value);
      }
      const provider = (yield* registry.getProviders).find(
        (provider) => provider.instanceId === input.modelSelection.instanceId,
      );
      if (
        !provider?.enabled ||
        !provider.models.some((model) => model.slug === input.modelSelection.model)
      )
        return yield* rejected();
      const environmentId = yield* environment.getEnvironmentId;
      const snapshot = yield* Effect.gen(function* () {
        const raced = yield* journal.read(dispatchId);
        if (Option.isSome(raced)) {
          if (raced.value.fingerprint !== fingerprint) return yield* rejected();
          return raced.value;
        }
        const state = yield* Repository.readCurrentState(sql, input.projectId);
        if (state.revision !== input.expectedRevision) return yield* rejected();
        const records = state.foundationRecords ?? [];
        const member = records.find(
          (record) => record.kind === "member" && record.recordId === input.memberId,
        );
        const role = records.find(
          (record) =>
            record.kind === "role-revision" &&
            record.recordId === (member?.kind === "member" ? member.roleRevisionId : undefined),
        );
        const task = state.tasks.find((task) => task.taskId === input.taskId);
        if (
          member?.kind !== "member" ||
          member.revision !== input.expectedMemberRevision ||
          role?.kind !== "role-revision" ||
          role.model !== input.modelSelection.model ||
          task === undefined
        )
          return yield* rejected();
        if (
          ["implementer", "integrator"].includes(role.role) &&
          input.workspace.type !== "worktree"
        )
          return yield* rejected();
        const plan = records
          .filter(
            (record): record is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
              record.kind === "plan-revision" &&
              record.taskId === input.taskId &&
              record.status === "proposed",
          )
          .sort((a, b) => b.planRevision - a.planRevision)[0];
        const limits = records.find(
          (record) =>
            record.kind === "limits" &&
            record.model === role.model &&
            record.status === "configured",
        );
        const at = DateTime.formatIso(yield* DateTime.now);
        const generation =
          Math.max(
            -1,
            ...records.flatMap((record) =>
              record.kind === "run-binding" && record.taskId === input.taskId
                ? [record.generation]
                : [],
            ),
          ) + 1;
        const binding: Extract<ProjectTeamRecord, { kind: "run-binding" }> = {
          recordId: `${dispatchId}:binding`,
          projectId: input.projectId,
          revision: 0,
          generation,
          updatedAt: at,
          kind: "run-binding",
          status: "reserved",
          taskId: input.taskId,
          attemptId: ProjectWorkAttemptId.make(`${dispatchId}:attempt`),
          memberId: member.recordId,
          roleRevisionId: role.recordId,
          providerInstanceId: input.modelSelection.instanceId,
          threadId: ThreadId.make(`${dispatchId}:thread`),
          environmentId,
          model: role.model,
          configuration: {
            ...(input.modelSelection.options === undefined
              ? {}
              : { options: input.modelSelection.options }),
            instructionsHash: hash(role.instructions),
            toolIds: role.tools,
            skillIds: role.skills,
            runtimeVersion: "v2",
            maxTokens: limits?.kind === "limits" ? limits.tokenLimit : 100000,
            maxDurationMs: limits?.kind === "limits" ? limits.durationLimitMs : 3600000,
            paidFallback: false,
          },
          workspaceState: "pending",
          workspaceKind: input.workspace.type,
          worktree: null,
          branch: null,
          leaseGeneration: generation,
          specRevision: task.specRevision,
          planRevision: plan?.planRevision ?? 0,
          authorizationGateId: input.authorizationGateId,
          scopeHash: projectTeamScopeHash(state, input.taskId, plan),
          ...(records.find(
            (record) =>
              record.kind === "gate" &&
              record.gate === "specification" &&
              record.taskId === input.taskId &&
              record.status === "approved",
          ) === undefined
            ? {}
            : {
                specificationGateId: records.find(
                  (record) =>
                    record.kind === "gate" &&
                    record.gate === "specification" &&
                    record.taskId === input.taskId &&
                    record.status === "approved",
                )!.recordId,
              }),
          ...(records.find(
            (record) =>
              record.kind === "gate" &&
              record.gate === "plan" &&
              record.taskId === input.taskId &&
              record.status === "approved",
          ) === undefined
            ? {}
            : {
                planGateId: records.find(
                  (record) =>
                    record.kind === "gate" &&
                    record.gate === "plan" &&
                    record.taskId === input.taskId &&
                    record.status === "approved",
                )!.recordId,
              }),
        };
        const leasedUntil = DateTime.formatIso(
          DateTime.makeUnsafe(Date.parse(at) + binding.configuration.maxDurationMs),
        );
        const command = {
          type: "project-work.foundation.commit",
          projectId: input.projectId,
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
          attribution,
          committedAt: at,
          records: [],
          transition: {
            kind: "claim",
            taskId: input.taskId,
            expectedTaskRevision: input.expectedTaskRevision,
            authorizationGateId: input.authorizationGateId,
            expectedGateRevision: input.expectedGateRevision,
            binding,
            claim: {
              type: "project-work.task.claim",
              projectId: input.projectId,
              commandId: input.commandId,
              taskId: input.taskId,
              attemptId: binding.attemptId,
              leaseToken: dispatchId,
              leasedUntil,
              claimedAt: at,
            },
          },
        } satisfies import("@t3tools/contracts").ProjectWorkCommand;
        const assignment = projectTaskAssignment(state, binding);
        const reviewAssignment = state.foundationRecords?.some(
          (record) =>
            record.kind === "task-membership" &&
            record.taskId === binding.taskId &&
            record.deliverableKind === "review",
        );
        if (reviewAssignment) {
          if (Option.isNone(reviews) || input.reviewVerificationJobId === undefined)
            return yield* rejected();
          yield* reviews.value
            .assertPhysical(input.projectId, input.reviewVerificationJobId)
            .pipe(Effect.mapError(() => rejected()));
        } else if (input.reviewVerificationJobId !== undefined) return yield* rejected();
        if (Buffer.byteLength(assignment) > 131072) return yield* rejected();
        let retained: Journal.DispatchSnapshot | undefined;
        yield* repository.executeReserved(
          command,
          (result) =>
            Effect.gen(function* () {
              const old = yield* journal.read(dispatchId);
              if (Option.isSome(old)) {
                if (old.value.fingerprint !== fingerprint) return yield* rejected();
                retained = old.value;
                return;
              }
              if (result.duplicate) return yield* rejected();
              if (reviewAssignment) {
                if (Option.isNone(reviews) || input.reviewVerificationJobId === undefined)
                  return yield* rejected();
                yield* reviews.value
                  .freeze(result.state, {
                    reviewBindingId: binding.recordId,
                    jobId: input.reviewVerificationJobId,
                  })
                  .pipe(Effect.mapError(() => rejected()));
              }
              const snapshot: Journal.DispatchSnapshot = {
                dispatchId,
                projectId: input.projectId,
                taskId: input.taskId,
                bindingId: binding.recordId,
                threadId: binding.threadId,
                generation,
                fingerprint,
                assignment,
                request: input,
                result: result.writeResult,
                stage: "reserved",
                createdAt: at,
                updatedAt: at,
              };
              yield* journal.retain(snapshot);
              retained = snapshot;
            }),
          fingerprint,
        );
        if (retained === undefined) return yield* rejected();
        return retained;
      });
      return yield* resume(snapshot);
    },
    Effect.mapError((cause) =>
      isJournalError(cause)
        ? cause
        : new Journal.ProjectTeamDispatchJournalError({ reason: "storage", cause }),
    ),
  );
  const reconcile = Effect.gen(function* () {
    let after = "";
    while (true) {
      const pending = yield* sql<{
        record_id: string;
        project_id: string;
      }>`SELECT record_id,project_id FROM t3_workflow_v2_team_records WHERE kind='effect' AND record_id>${after} AND json_extract(payload_json,'$.effectKind')='stop' AND json_extract(payload_json,'$.status') IN ('pending','claimed','uncertain') ORDER BY record_id LIMIT 128`;
      if (pending.length === 0) break;
      yield* Effect.forEach(
        pending,
        (row) =>
          Effect.gen(function* () {
            const state = yield* Repository.readCurrentState(sql, row.project_id);
            const records = state.foundationRecords ?? [];
            const stop = records.find(
              (record) => record.kind === "effect" && record.recordId === row.record_id,
            );
            const binding = records.find(
              (record) =>
                record.kind === "run-binding" &&
                record.recordId === (stop?.kind === "effect" ? stop.sourceId : undefined),
            );
            if (
              stop?.kind !== "effect" ||
              binding?.kind !== "run-binding" ||
              binding.generation !== stop.sourceGeneration ||
              !["stopping", "quarantined"].includes(binding.status)
            )
              return;
            yield* launch.requestPreparationStop(binding.threadId);
            yield* sql`UPDATE t3_workflow_v2_team_dispatches SET stage='stopping' WHERE binding_id=${binding.recordId} AND generation=${binding.generation} AND stage NOT IN ('stopping','settled')`;
            const controls = yield* sql<{
              payload_json: string;
            }>`SELECT c.payload_json FROM t3_workflow_v2_admission_controls c JOIN t3_workflow_v2_run_admissions a ON a.admission_id=c.admission_id WHERE a.binding_id=${binding.recordId} AND a.fence=${binding.leaseGeneration} AND a.phase<>'settled'`;
            yield* Effect.forEach(
              controls,
              (row) =>
                Effect.gen(function* () {
                  const control = yield* decodeControl(row.payload_json);
                  yield* Effect.all(
                    [
                      threads.stopOwnedRun({
                        control,
                        commandId: CommandId.make(`${stop.effectId}:${control.controlId}:stop`),
                      }),
                      Option.isSome(terminals)
                        ? terminals.value.closeProjectOwner(control)
                        : Effect.void,
                    ],
                    { concurrency: "unbounded" },
                  );
                }),
              { concurrency: 16, discard: true },
            );
            if (yield* launch.preparationActive(binding.threadId)) return;
            if (binding.runId !== undefined) {
              const preparation = yield* receipts.getByCommandId(
                CommandId.make(`v2-preparation-drained:${binding.threadId}:${binding.runId}`),
              );
              if (
                Option.isNone(preparation) ||
                preparation.value.threadId !== binding.threadId ||
                preparation.value.commandType !== "thread.preparation.drained" ||
                preparation.value.status !== "accepted"
              )
                return;
            }
            const changed = yield* sql.withTransaction(
              Effect.gen(function* () {
                const current = yield* Repository.readCurrentState(sql, binding.projectId);
                const currentEffect = current.foundationRecords?.find(
                  (record) => record.kind === "effect" && record.recordId === stop.recordId,
                );
                if (
                  currentEffect?.kind !== "effect" ||
                  currentEffect.sourceGeneration !== binding.generation ||
                  currentEffect.outcome === "owned-processes-drained"
                )
                  return false;
                const at = DateTime.formatIso(yield* DateTime.now);
                yield* Repository.appendAdmissionFoundationRecords(
                  sql,
                  binding.projectId,
                  `${stop.effectId}:process-drain`,
                  [
                    {
                      ...currentEffect,
                      status: "claimed",
                      outcome: "owned-processes-drained",
                      revision: currentEffect.revision + 1,
                      updatedAt: at,
                    },
                  ],
                  at,
                );
                return true;
              }),
            );
            if (changed) yield* publishRuntime(`${stop.effectId}:process-drain`);
          }).pipe(Effect.ignore),
        { concurrency: 16, discard: true },
      );
      after = pending.at(-1)!.record_id;
    }
    after = "";
    while (true) {
      const bindings = yield* sql<{
        record_id: string;
        project_id: string;
      }>`SELECT record_id,project_id FROM t3_workflow_v2_team_records WHERE kind='run-binding' AND record_id>${after} AND json_extract(payload_json,'$.status') IN ('running','stopping','quarantined') ORDER BY record_id LIMIT 128`;
      if (bindings.length === 0) break;
      for (const row of bindings) {
        const state = yield* Repository.readCurrentState(sql, row.project_id);
        const records = state.foundationRecords ?? [];
        const binding = records.find(
          (record) => record.kind === "run-binding" && record.recordId === row.record_id,
        );
        if (
          binding?.kind !== "run-binding" ||
          !["running", "stopping", "quarantined"].includes(binding.status)
        )
          continue;
        const task = state.tasks.find((task) => task.taskId === binding.taskId);
        const attempt = state.attempts.find((attempt) => attempt.attemptId === binding.attemptId);
        if (task === undefined || attempt === undefined) continue;
        const admissions = yield* sql<{
          phase: string;
          uncertain: number;
        }>`SELECT phase,uncertain FROM t3_workflow_v2_run_admissions WHERE binding_id=${binding.recordId}`;
        if (
          admissions.some(
            (row) => row.uncertain === 1 || !["settled", "prepared"].includes(row.phase),
          )
        )
          continue;
        if (
          !["stopping", "quarantined"].includes(binding.status) &&
          !admissions.some((row) => row.phase === "settled")
        )
          continue;
        if (
          records.some(
            (record) =>
              record.kind === "effect" &&
              record.effectKind === "stop" &&
              record.sourceId === binding.recordId &&
              record.sourceGeneration === binding.generation &&
              record.status !== "succeeded" &&
              record.outcome !== "owned-processes-drained",
          )
        )
          continue;
        yield* launch.requestPreparationStop(binding.threadId);
        if (yield* launch.preparationActive(binding.threadId)) continue;
        if (binding.runId !== undefined) {
          const preparation = yield* receipts.getByCommandId(
            CommandId.make(`v2-preparation-drained:${binding.threadId}:${binding.runId}`),
          );
          if (
            Option.isNone(preparation) ||
            preparation.value.threadId !== binding.threadId ||
            preparation.value.commandType !== "thread.preparation.drained" ||
            preparation.value.status !== "accepted"
          )
            continue;
        }
        const resourceControls = yield* sql<{
          payload_json: string;
        }>`SELECT c.payload_json FROM t3_workflow_v2_admission_controls c JOIN t3_workflow_v2_run_admissions a ON a.admission_id=c.admission_id WHERE a.binding_id=${binding.recordId} AND a.fence=${binding.leaseGeneration}`;
        const cleanup = yield* Effect.forEach(
          resourceControls,
          (row) =>
            Effect.gen(function* () {
              const control = yield* decodeControl(row.payload_json);
              if (Option.isSome(terminals)) yield* terminals.value.closeProjectOwner(control);
            }),
          { discard: true },
        ).pipe(Effect.result);
        if (cleanup._tag === "Failure") continue;
        const at = DateTime.formatIso(yield* DateTime.now);
        let reviewCompletion:
          | import("@t3tools/contracts").ProjectTeamReviewCompletionProof
          | undefined;
        const reviewAssignment = records.some(
          (record) =>
            record.kind === "task-membership" &&
            record.taskId === binding.taskId &&
            record.deliverableKind === "review",
        );
        if (
          reviewAssignment &&
          Option.isSome(reviews) &&
          binding.runId !== undefined &&
          binding.runAttemptId !== undefined &&
          binding.nodeId !== undefined
        ) {
          const reviewed = yield* Effect.gen(function* () {
            const snapshot = yield* reviews.value.read(binding.projectId, binding.recordId);
            yield* reviews.value.assertPhysical(binding.projectId, snapshot.manifest.jobId);
            const projection = yield* threads.getThreadProjection(binding.threadId);
            const run = projection.runs.find((run) => run.id === binding.runId);
            const nativeAttempt = projection.attempts.find(
              (attempt) => attempt.id === binding.runAttemptId,
            );
            const node = projection.nodes.find((node) => node.id === binding.nodeId);
            if (
              run?.status !== "completed" ||
              nativeAttempt?.status !== "completed" ||
              node?.status !== "completed"
            )
              return yield* rejected();
            const dispatchRows = yield* sql<{
              dispatch_id: string;
              request_json: string;
              result_json: string;
            }>`SELECT dispatch_id,request_json,result_json FROM t3_workflow_v2_team_dispatches WHERE binding_id=${binding.recordId} AND generation=${binding.generation}`;
            if (dispatchRows.length !== 1) return yield* rejected();
            const dispatchRow = dispatchRows[0]!;
            const accepted = yield* receipts.getByCommandId(
              CommandId.make(`${dispatchRow.dispatch_id}:initial-message`),
            );
            if (
              Option.isNone(accepted) ||
              accepted.value.status !== "accepted" ||
              accepted.value.threadId !== binding.threadId ||
              accepted.value.commandType !== "message.dispatch"
            )
              return yield* rejected();
            const join = {
              assignmentOperationId: dispatchRow.dispatch_id,
              assignmentRequestHash: hash(dispatchRow.request_json),
              assignmentReceiptSha256: hash(accepted.value),
              joinedReceiptId: `v2-preparation-drained:${binding.threadId}:${binding.runId}`,
              joinedEvidenceSha256: hash({
                run,
                nativeAttempt,
                node,
                dispatch: dispatchRow.result_json,
              }),
            };
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const current = yield* Repository.readCurrentState(sql, binding.projectId);
                if (Option.isNone(reviews)) return yield* rejected();
                return yield* reviews.value.completeRetained(current, binding.recordId, join);
              }),
            );
          }).pipe(Effect.result);
          if (reviewed._tag === "Success") reviewCompletion = reviewed.success;
        }
        const command: ProjectWorkCommand = {
          type: "project-work.foundation.commit",
          projectId: binding.projectId,
          commandId: CommandId.make(`${binding.recordId}:settle:${binding.generation}`),
          expectedRevision: state.revision,
          attribution: {
            actor: { kind: "system", id: "project-team-runtime" },
            source: { kind: "system", id: "project-team-runtime" },
            recordedAt: at,
          },
          committedAt: at,
          records: [],
          transition: {
            kind: "run.settle",
            ...(reviewCompletion === undefined ? {} : { reviewCompletion }),
            bindingId: binding.recordId,
            generation: binding.generation,
            expectedBindingRevision: binding.revision,
            taskId: binding.taskId,
            expectedTaskRevision: task.revision,
            attemptId: binding.attemptId,
            expectedAttemptRevision: attempt.revision,
            dispatchId: binding.recordId,
            receiptId: `${binding.recordId}:v2-drain`,
            effectIds: records.flatMap((record) =>
              record.kind === "effect" &&
              record.effectKind === "stop" &&
              record.sourceId === binding.recordId &&
              record.sourceGeneration === binding.generation &&
              record.status !== "succeeded"
                ? [record.recordId]
                : [],
            ),
          },
        };
        yield* repository
          .executeReserved(
            command,
            () =>
              Effect.gen(function* () {
                const live =
                  yield* sql`SELECT admission_id FROM t3_workflow_v2_run_admissions WHERE binding_id=${binding.recordId} AND (uncertain=1 OR phase NOT IN ('settled','prepared'))`;
                if (live.length > 0) return yield* rejected();
                yield* sql`UPDATE t3_workflow_v2_team_dispatches SET stage='settled',updated_at=${at} WHERE binding_id=${binding.recordId} AND generation=${binding.generation}`;
              }),
            hash({ bindingId: binding.recordId, generation: binding.generation }),
          )
          .pipe(Effect.ignore);
      }
      after = bindings.at(-1)!.record_id;
    }
  }).pipe(
    Effect.mapError(
      (cause) => new Journal.ProjectTeamDispatchJournalError({ reason: "storage", cause }),
    ),
  );
  const mailbox = Effect.gen(function* () {
    let after = "";
    while (true) {
      const targets = yield* sql<{
        record_id: string;
        project_id: string;
      }>`SELECT record_id,project_id FROM t3_workflow_v2_team_records WHERE kind='run-binding' AND record_id>${after} AND json_extract(payload_json,'$.status')='running' ORDER BY record_id LIMIT 128`;
      if (targets.length === 0) break;
      yield* Effect.forEach(
        targets,
        (row) =>
          Effect.gen(function* () {
            const claim = yield* sql.withTransaction(
              Effect.gen(function* () {
                const state = yield* Repository.readCurrentState(sql, row.project_id);
                const records = state.foundationRecords ?? [];
                const binding = records.find(
                  (record) => record.kind === "run-binding" && record.recordId === row.record_id,
                );
                if (
                  binding?.kind !== "run-binding" ||
                  binding.status !== "running" ||
                  binding.workspaceState === "pending"
                )
                  return undefined;
                const prior = records.find(
                  (record) =>
                    record.kind === "effect" &&
                    record.effectKind === "mailbox-wake" &&
                    record.sourceId === binding.recordId &&
                    record.sourceGeneration === binding.generation &&
                    ["claimed", "uncertain"].includes(record.status),
                );
                const messages = records.filter(
                  (record): record is Extract<ProjectTeamRecord, { kind: "message" }> =>
                    record.kind === "message" &&
                    record.recipientId === binding.memberId &&
                    record.taskId === binding.taskId,
                );
                const message =
                  prior?.kind === "effect"
                    ? messages.find((message) => message.recordId === prior.targetId)
                    : messages.find((message) => message.status === "queued");
                if (message === undefined) return undefined;
                const operationId =
                  prior?.kind === "effect"
                    ? prior.effectId
                    : `work-mailbox:${hash({ bindingId: binding.recordId, generation: binding.generation, messageId: message.recordId })}`;
                const at = DateTime.formatIso(yield* DateTime.now);
                const changes = yield* Effect.try({
                  try: () =>
                    planMailboxClaim(state, {
                      bindingId: binding.recordId,
                      generation: binding.generation,
                      operationId,
                      at,
                    }),
                  catch: () => rejected(),
                });
                if (changes.length === 0 && prior === undefined) return undefined;
                if (changes.length > 0)
                  yield* Repository.appendAdmissionFoundationRecords(
                    sql,
                    binding.projectId,
                    operationId,
                    changes,
                    at,
                  );
                const journals = yield* sql<{
                  dispatch_id: string;
                }>`SELECT dispatch_id FROM t3_workflow_v2_team_dispatches WHERE binding_id=${binding.recordId} AND generation=${binding.generation}`;
                const snapshot =
                  journals[0] === undefined
                    ? Option.none<Journal.DispatchSnapshot>()
                    : yield* journal.read(journals[0].dispatch_id);
                if (Option.isNone(snapshot)) return undefined;
                return {
                  binding,
                  message,
                  operationId,
                  claimedNew: changes.length > 0,
                  modelSelection: snapshot.value.request.modelSelection,
                };
              }),
            );
            if (claim === undefined) return;
            if (claim.claimedNew) yield* publishRuntime(claim.operationId);
            const commandId = CommandId.make(claim.operationId);
            let receipt = yield* receipts.getByCommandId(commandId);
            if (Option.isNone(receipt)) {
              yield* threads.dispatch({
                type: "message.dispatch",
                commandId,
                threadId: claim.binding.threadId,
                messageId: MessageId.make(`${claim.operationId}:message`),
                text: canonicalProjectWorkPayload({
                  kind: "project-work.mailbox",
                  messageId: claim.message.recordId,
                  senderId: claim.message.senderId,
                  body: claim.message.body,
                  evidenceIds: claim.message.evidenceIds,
                }),
                attachments: [],
                modelSelection: claim.modelSelection,
                dispatchMode: { type: "queue_after_active" },
                createdBy: "agent",
                creationSource: "mcp",
              });
              receipt = yield* receipts.getByCommandId(commandId);
            }
            if (
              Option.isNone(receipt) ||
              receipt.value.status !== "accepted" ||
              receipt.value.commandType !== "message.dispatch" ||
              receipt.value.threadId !== claim.binding.threadId
            )
              return;
            const projection = yield* threads.getThreadProjection(claim.binding.threadId);
            const run = projection.runs.find(
              (run) => run.userMessageId === `${claim.operationId}:message`,
            );
            if (run === undefined) return;
            const owner =
              yield* sql`SELECT admission_id FROM t3_workflow_v2_run_admissions WHERE project_id=${claim.binding.projectId} AND thread_id=${claim.binding.threadId} AND run_id=${run.id} AND binding_id=${claim.binding.recordId} AND fence=${claim.binding.leaseGeneration}`;
            if (owner.length !== 1) return;
            const reflected = yield* sql.withTransaction(
              Effect.gen(function* () {
                const state = yield* Repository.readCurrentState(sql, claim.binding.projectId);
                const at = DateTime.formatIso(yield* DateTime.now);
                const changes = yield* Effect.try({
                  try: () =>
                    planMailboxReflection(state, {
                      bindingId: claim.binding.recordId,
                      generation: claim.binding.generation,
                      operationId: claim.operationId,
                      commandId: claim.operationId,
                      threadId: claim.binding.threadId,
                      runId: run.id,
                      outcome: "delivered",
                      at,
                    }),
                  catch: () => rejected(),
                });
                if (changes.length > 0)
                  yield* Repository.appendAdmissionFoundationRecords(
                    sql,
                    claim.binding.projectId,
                    `${claim.operationId}:reflect`,
                    changes,
                    at,
                  );
                return changes.length > 0;
              }),
            );
            if (reflected) yield* publishRuntime(`${claim.operationId}:reflect`);
          }).pipe(Effect.ignore),
        { concurrency: 16, discard: true },
      );
      after = targets.at(-1)!.record_id;
    }
  }).pipe(
    Effect.mapError(
      (cause) => new Journal.ProjectTeamDispatchJournalError({ reason: "storage", cause }),
    ),
  );
  const recover = Effect.gen(function* () {
    let after = "";
    while (true) {
      const ids = yield* journal.recoverable(after);
      if (ids.length === 0) break;
      for (const id of ids) {
        const snapshot = yield* journal.read(id);
        if (Option.isSome(snapshot)) yield* resume(snapshot.value).pipe(Effect.ignore);
      }
      after = ids.at(-1)!;
    }
  });
  return ProjectTeamDispatch.of({
    dispatch,
    recover,
    reconcile: reconcileLock.withPermit(reconcile),
    mailbox: mailboxLock.withPermit(mailbox),
  });
});
export const layer = Layer.effect(ProjectTeamDispatch, make).pipe(
  Layer.provide(Journal.layer),
  Layer.provide(Receipts.layer),
);

export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const dispatch = yield* ProjectTeamDispatch;
    const threads = yield* Threads.ThreadManagementService;
    const bus = yield* Bus.ProjectWorkEventBus;
    const launch = yield* Launch.ThreadLaunchService;
    const wake = yield* bus.subscribe;
    // Stop/drain has its own fiber so a blocked launch/recovery cannot delay cancellation.
    yield* Stream.runForEach(wake, () => dispatch.reconcile.pipe(Effect.ignore)).pipe(
      Effect.forkScoped,
    );
    const lifecycleEvents = threads.streamStoredEvents.pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "run.updated" ||
          (event.type === "provider-turn.updated" &&
            !["pending", "running"].includes(event.payload.status)),
      ),
    );
    yield* Stream.runForEach(lifecycleEvents, () => dispatch.reconcile.pipe(Effect.ignore)).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(launch.preparationChanges, () =>
      dispatch.reconcile.pipe(Effect.ignore),
    ).pipe(Effect.forkScoped);
    yield* dispatch.reconcile.pipe(Effect.ignore, Effect.forkScoped);
    yield* dispatch.recover.pipe(Effect.ignore, Effect.forkScoped);
    const mailboxWake = yield* bus.subscribe;
    yield* Stream.runForEach(mailboxWake, () => dispatch.mailbox.pipe(Effect.ignore)).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(lifecycleEvents, () => dispatch.mailbox.pipe(Effect.ignore)).pipe(
      Effect.forkScoped,
    );
    yield* dispatch.mailbox.pipe(Effect.ignore, Effect.forkScoped);
  }),
);
