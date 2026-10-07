import {
  CommandId,
  ProjectId,
  ProjectTeamGate,
  ProjectWorkEvidence,
  ProjectWorkEvidenceId,
  PullRequestActionInput,
  canonicalProjectWorkPayload,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkPublicationAuthorization } from "./ProjectWorkPublicationAuthorization.ts";
import { ProjectWorkPullRequestActionGuard } from "./ProjectWorkPullRequestActionGuard.ts";
import { ProjectWorkHumanMergeRequest } from "./ProjectWorkHumanMergeRequest.ts";
import {
  ManagedMergeDecision,
  ManagedMergeError,
  ManagedMergeConfirmation,
  ManagedMergeReceipt,
  makeProjectWorkManagedMergeJournal,
  mergeHash,
} from "./ProjectWorkManagedMergeJournal.ts";
import type { ProviderExactHeadMergeConfirmation } from "../pullRequest/PullRequestProvider.ts";
const strict = { onExcessProperty: "error" } as const;
const decodeInput = Schema.decodeUnknownSync(PullRequestActionInput, strict);
const decodeGate = Schema.decodeUnknownEffect(ProjectTeamGate, strict);
const decodeEvidence = Schema.decodeUnknownEffect(ProjectWorkEvidence, strict);
const decodeConfirmation = Schema.decodeUnknownEffect(ManagedMergeConfirmation, strict);
const denied = () => new ManagedMergeError({ reason: "authorization-denied" });
const isMergeError = Schema.is(ManagedMergeError);
const error = (cause: unknown) =>
  isMergeError(cause) ? cause : new ManagedMergeError({ reason: "persistence", cause });
export interface ManagedMergePorts {
  readonly mergeExactHead: (
    decision: ManagedMergeDecision,
  ) => Effect.Effect<ProviderExactHeadMergeConfirmation, ManagedMergeError>;
  readonly reconcileExactHead: (
    decision: ManagedMergeDecision,
  ) => Effect.Effect<
    { readonly state: string; readonly headSha: string | undefined; readonly baseRef: string },
    ManagedMergeError
  >;
}
export class ProjectWorkManagedMerge extends Context.Service<
  ProjectWorkManagedMerge,
  {
    readonly run: (
      input: PullRequestActionInput,
      target: { readonly projectId: ProjectId; readonly host: string; readonly repository: string },
      permission: ProjectWorkHumanMergeRequest["Service"],
      ports: ManagedMergePorts,
    ) => Effect.Effect<ManagedMergeReceipt, ManagedMergeError>;
    readonly resume: (
      operationId: string,
      ports: ManagedMergePorts,
    ) => Effect.Effect<ManagedMergeReceipt, ManagedMergeError>;
    readonly pending: (
      afterOperationId?: string,
    ) => Effect.Effect<
      readonly { readonly operationId: string; readonly input: PullRequestActionInput }[],
      ManagedMergeError
    >;
  }
>()("t3/projectWork/ProjectWorkManagedMerge") {}

export const makeProjectWorkManagedMerge = (options: { readonly environmentId: string }) => {
  const capturedOptions = { ...options };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const authorization = yield* ProjectWorkPublicationAuthorization;
    const guard = yield* ProjectWorkPullRequestActionGuard;
    const journal = yield* makeProjectWorkManagedMergeJournal(capturedOptions);
    const serial = yield* Semaphore.make(1);
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ProjectWorkRepository, repository),
      );
    const affinity = Effect.gen(function* () {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      const owner = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        (Option.isSome(client) && client.value !== sql) ||
        (Option.isSome(owner) && owner.value !== repository)
      )
        return yield* denied();
    });
    const current = Effect.fn("ManagedMerge.current")(function* (decision: ManagedMergeDecision) {
      yield* authorization.assertCurrent(decision.publication, "dispatch");
      const state = yield* readCurrentState(sql, decision.publication.target.projectId);
      const gates =
        state.foundationRecords?.filter(
          (record) => record.kind === "gate" && record.recordId === decision.gate.recordId,
        ) ?? [];
      if (
        gates.length !== 1 ||
        canonicalProjectWorkPayload(gates[0]) !== canonicalProjectWorkPayload(decision.gate)
      )
        return yield* denied();
    });
    const dispatch = Effect.fn("ManagedMerge.dispatch")(function* (
      operationId: string,
      ports: ManagedMergePorts,
    ) {
      yield* affinity;
      const original = yield* provide(sql.withTransaction(journal.readInTransaction(operationId)));
      if (!original) return yield* denied();
      if (original.receipt) return original.receipt;
      // A claimed write may already have reached GitHub. Its observation can establish
      // attention, never retroactively establish that this process caused a merge.
      if (original.status !== "pending") {
        const remote = yield* ports.reconcileExactHead(original.decision);
        yield* provide(
          sql.withTransaction(
            journal.attentionInTransaction(operationId, original.claimGeneration, {
              version: 1,
              operationId,
              decisionSha256: mergeHash(original.decision),
              reason: "reconciled",
              observedAt: DateTime.formatIso(yield* DateTime.now),
              state: remote.state,
              ...(remote.headSha === undefined ? {} : { headSha: remote.headSha }),
              baseRef: remote.baseRef,
            }),
          ),
        );
        return yield* new ManagedMergeError({ reason: "uncertain" });
      }
      const claimed = yield* provide(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* current(original.decision);
            return yield* journal.claimInTransaction(operationId);
          }),
        ),
      );
      if (!claimed.owned || !claimed.row || claimed.row.status !== "claimed")
        return yield* new ManagedMergeError({ reason: "uncertain" });
      const owned = claimed.row;
      const remote = yield* ports.mergeExactHead(owned.decision).pipe(Effect.result);
      if (remote._tag === "Failure") {
        yield* provide(
          sql.withTransaction(
            journal.attentionInTransaction(operationId, owned.claimGeneration, {
              version: 1,
              operationId,
              decisionSha256: mergeHash(owned.decision),
              reason: "write-unconfirmed",
              observedAt: DateTime.formatIso(yield* DateTime.now),
            }),
          ),
        );
        return yield* remote.failure;
      }
      const confirmationResult = yield* decodeConfirmation(remote.success).pipe(Effect.result);
      const decision = owned.decision;
      const confirmation =
        confirmationResult._tag === "Success" ? confirmationResult.success : undefined;
      const target = decision.publication.target;
      const published = decision.publicationOutcome;
      if (
        !confirmation ||
        canonicalProjectWorkPayload(confirmation) !== canonicalProjectWorkPayload(remote.success) ||
        confirmation.host !== decision.publication.repository.host ||
        confirmation.repository !== decision.publication.repository.nameWithOwner ||
        published.kind !== "confirmed" ||
        confirmation.number !== published.pullRequest.number ||
        confirmation.authorizedHeadSha !== target.headSha ||
        confirmation.baseRef !== target.baseRef ||
        !Number.isFinite(Date.parse(confirmation.mergedAt)) ||
        !Number.isFinite(Date.parse(confirmation.observedAt)) ||
        !confirmation.mergedBy.trim()
      ) {
        yield* provide(
          sql.withTransaction(
            journal.attentionInTransaction(operationId, owned.claimGeneration, {
              version: 1,
              operationId,
              decisionSha256: mergeHash(owned.decision),
              reason: "write-unconfirmed",
              observedAt: DateTime.formatIso(yield* DateTime.now),
            }),
          ),
        );
        return yield* new ManagedMergeError({ reason: "uncertain" });
      }
      let receipt: ManagedMergeReceipt | undefined;
      yield* repository.executeAtomic(
        provide(
          Effect.gen(function* () {
            yield* current(decision);
            const row = yield* journal.readInTransaction(operationId);
            if (!row || row.status !== "claimed" || row.claimGeneration !== owned.claimGeneration)
              return yield* denied();
            const state = yield* readCurrentState(sql, target.projectId);
            const attribution = {
              actor: { kind: "system" as const, id: "project-work-managed-merge" },
              source: { kind: "system" as const, id: "project-work-managed-merge" },
              recordedAt: confirmation.observedAt,
            };
            const evidence = yield* decodeEvidence({
              evidenceId: ProjectWorkEvidenceId.make(`managed-merge-delivery:${operationId}`),
              taskId: target.taskId,
              kind: "observation",
              summary: "Reviewed work was merged",
              detail: canonicalProjectWorkPayload({
                version: 1,
                kind: "project-work.managed-merge-delivery",
                operationId,
                decisionSha256: mergeHash(decision),
                gateSha256: mergeHash(decision.gate),
                confirmation,
              }),
              uri: published.pullRequest.url,
              recordedAt: confirmation.observedAt,
              revision: 0,
              attribution,
            });
            const command: ProjectWorkCommand = {
              type: "project-work.evidence.add",
              commandId: CommandId.make(`managed-merge-delivery:${operationId}`),
              projectId: target.projectId,
              expectedRevision: state.revision,
              attribution,
              evidence,
              addedAt: evidence.recordedAt,
            };
            receipt = {
              version: 1,
              operationId,
              decisionSha256: mergeHash(decision),
              claimGeneration: owned.claimGeneration,
              confirmation,
              evidence,
              command,
            };
            yield* journal.completeInTransaction(receipt);
            return [command];
          }),
        ),
        provide(
          Effect.gen(function* () {
            yield* current(decision);
            const stored = yield* journal.readInTransaction(operationId);
            if (
              !receipt ||
              !stored?.receipt ||
              canonicalProjectWorkPayload(stored.receipt) !== canonicalProjectWorkPayload(receipt)
            )
              return yield* denied();
          }),
        ),
      );
      if (!receipt) return yield* denied();
      return receipt;
    });
    const enqueue = Effect.fn("ManagedMerge.enqueue")(function* (
      input: PullRequestActionInput | undefined,
      target: { readonly projectId: ProjectId; readonly host: string; readonly repository: string },
      permission: ProjectWorkHumanMergeRequest["Service"],
    ) {
      yield* affinity;
      const projectId = target.projectId;
      const inspect = guard.inspect;
      if (
        !input ||
        input.projectId !== projectId ||
        input.repository.trim().toLowerCase() !== target.repository.toLowerCase() ||
        (input.host !== undefined && input.host.toLowerCase() !== target.host.toLowerCase()) ||
        input.action !== "merge" ||
        input.stackNumber !== undefined ||
        input.expectedStackHeads !== undefined ||
        !inspect
      )
        return yield* denied();
      let decision: ManagedMergeDecision | undefined;
      yield* repository.executeAtomic(
        provide(
          Effect.gen(function* () {
            const human = yield* permission.assertCurrent(projectId, input);
            const found = yield* inspect({
              projectId,
              host: target.host,
              repository: target.repository,
              number: input.number,
              action: "merge",
            });
            if (!found.managed || !found.publication) return yield* denied();
            const { request: publication, outcome: publicationOutcome } = found.publication;
            if (publication.target.projectId !== projectId) return yield* denied();
            yield* authorization.assertCurrent(publication, "dispatch");
            const state = yield* readCurrentState(sql, projectId);
            const method = input.mergeMethod ?? "merge";
            const contentHash = mergeHash({ publication, publicationOutcome, method });
            const compatible = (state.foundationRecords ?? []).filter(
              (record) =>
                record.kind === "gate" &&
                record.gate === "merge" &&
                record.status === "approved" &&
                record.taskId === publication.target.taskId &&
                record.specRevision === publication.target.specRevision &&
                record.planRevision === publication.target.planRevision &&
                record.repository ===
                  `${publication.repository.host}/${publication.repository.nameWithOwner}` &&
                record.pullRequestNumber === input.number &&
                record.headSha === publication.target.headSha &&
                record.targetBranch === publication.target.baseRef &&
                record.mergeMethod === method &&
                record.attribution.actor.kind === "human",
            );
            if (compatible.length > 1) return yield* denied();
            const existingGate = compatible[0];
            const gate = yield* decodeGate(
              existingGate ?? {
                kind: "gate",
                recordId: `managed-merge-gate:${contentHash}`,
                projectId,
                revision: 0,
                generation: 0,
                updatedAt: human.recordedAt,
                status: "approved",
                taskId: publication.target.taskId,
                gate: "merge",
                specRevision: publication.target.specRevision,
                planRevision: publication.target.planRevision,
                contentHash,
                attribution: human,
                repository: `${publication.repository.host}/${publication.repository.nameWithOwner}`,
                pullRequestNumber: input.number,
                headSha: publication.target.headSha,
                targetBranch: publication.target.baseRef,
                mergeMethod: method,
                evidenceIds: publication.authorizationRecordIds,
              },
            );
            const operationHash = mergeHash({
              gateId: gate.recordId,
              gateRevision: gate.revision,
              gateSha256: mergeHash(gate),
            });
            const operationId = `managed-merge:${operationHash}`;
            const retained = yield* journal.readInTransaction(operationId);
            if (retained) {
              const priorHuman = retained.decision.commands.at(-1)?.attribution;
              if (
                !priorHuman ||
                canonicalProjectWorkPayload(priorHuman.actor) !==
                  canonicalProjectWorkPayload(human.actor) ||
                canonicalProjectWorkPayload(priorHuman.source) !==
                  canonicalProjectWorkPayload(human.source) ||
                canonicalProjectWorkPayload(retained.decision.input) !==
                  canonicalProjectWorkPayload(input)
              )
                return yield* denied();
              decision = retained.decision;
              return [];
            }
            const gateApproval =
              existingGate === undefined
                ? undefined
                : yield* journal.gateApprovalInTransaction(gate);
            const gateCommand: ProjectWorkCommand = {
              type: "project-work.foundation.commit",
              commandId: CommandId.make(`managed-merge-approve:${operationHash}`),
              projectId,
              expectedRevision: state.revision,
              attribution: human,
              committedAt: human.recordedAt,
              records: [gate],
            };
            const evidence = yield* decodeEvidence({
              evidenceId: ProjectWorkEvidenceId.make(`managed-merge-permission:${operationHash}`),
              taskId: publication.target.taskId,
              kind: "observation",
              summary: "Human approved the exact reviewed pull request merge",
              detail: canonicalProjectWorkPayload({
                version: 1,
                kind: "project-work.human-merge",
                operationId,
                publicationSha256: mergeHash(publication),
                publicationOutcomeSha256: mergeHash(publicationOutcome),
                gateSha256: mergeHash(gate),
                input,
              }),
              recordedAt: human.recordedAt,
              revision: 0,
              attribution: human,
            });
            const command: ProjectWorkCommand = {
              type: "project-work.evidence.add",
              commandId: CommandId.make(`managed-merge-permission:${operationHash}`),
              projectId,
              expectedRevision: state.revision + (existingGate === undefined ? 1 : 0),
              attribution: human,
              evidence,
              addedAt: human.recordedAt,
            };
            decision = {
              version: 1,
              environmentId: journal.environmentId,
              input,
              operationId,
              publication,
              publicationOutcome,
              gate,
              ...(gateApproval === undefined ? {} : { gateApproval }),
              commands: existingGate === undefined ? [gateCommand, command] : [command],
            };
            yield* journal.insertInTransaction(decision);
            return decision.commands;
          }),
        ),
        provide(
          Effect.gen(function* () {
            if (!decision) return yield* denied();
            yield* permission.assertCurrent(projectId, input);
            yield* current(decision);
            const stored = yield* journal.readInTransaction(decision.operationId);
            if (
              !stored ||
              canonicalProjectWorkPayload(stored.decision) !== canonicalProjectWorkPayload(decision)
            )
              return yield* denied();
          }),
        ),
      );
      if (!decision) return yield* denied();
      return decision;
    });
    return ProjectWorkManagedMerge.of({
      run(raw, target, permission, ports) {
        const resolved = { ...target };
        const capturedPorts = { ...ports };
        let input: PullRequestActionInput | undefined;
        try {
          input = decodeInput(structuredClone(raw));
          if (canonicalProjectWorkPayload(input) !== canonicalProjectWorkPayload(raw))
            input = undefined;
        } catch {}
        return serial
          .withPermits(1)(
            Effect.gen(function* () {
              const decision = yield* enqueue(input, resolved, permission);
              return yield* dispatch(decision.operationId, capturedPorts);
            }),
          )
          .pipe(Effect.mapError(error));
      },
      resume(operationId, ports) {
        const capturedPorts = { ...ports };
        return serial
          .withPermits(1)(dispatch(operationId, capturedPorts))
          .pipe(Effect.mapError(error));
      },
      pending(afterOperationId) {
        return affinity.pipe(
          Effect.andThen(
            provide(
              sql.withTransaction(
                Effect.gen(function* () {
                  const rows = yield* journal.pendingInTransaction(afterOperationId);
                  return yield* Effect.forEach(rows, ({ operationId }) =>
                    Effect.gen(function* () {
                      const row = yield* journal.readInTransaction(operationId);
                      if (!row || row.decision.publicationOutcome.kind !== "confirmed")
                        return yield* denied();
                      return { operationId, input: row.decision.input };
                    }),
                  );
                }),
              ),
            ),
          ),
          Effect.mapError(error),
        );
      },
    });
  });
};
