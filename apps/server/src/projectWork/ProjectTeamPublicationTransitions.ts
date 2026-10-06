import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkPublicationRequest,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProjectWorkEvent, ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { validateProjectTeamRecord } from "./ProjectTeamFoundationRecords.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";

type Command = Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
type Draft<T = ProjectWorkEvent> = T extends ProjectWorkEvent
  ? Omit<T, "eventId" | "projectId" | "revision">
  : never;
const decode = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand, {
  onExcessProperty: "error",
});
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectWorkPublicationRequest),
  { onExcessProperty: "error" },
);
const reject = (message: string): never => {
  throw new ProjectWorkPolicyError("authority-required", message);
};
const increment = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER)
    return reject("Publication revision budget exhausted");
  return value + 1;
};

/** Records host-observed publication only. A PR receipt grants no review or merge authority. */
export const decideProjectTeamPublicationTransition = (
  initial: ProjectWorkReducerState,
  raw: Command,
  event: (draft: Draft, index: number) => ProjectWorkEvent,
): ReadonlyArray<ProjectWorkEvent> => {
  const command = decode(raw);
  const transition = command.transition;
  if (
    (transition?.kind !== "publication.claim" && transition?.kind !== "publication.reflect") ||
    command.guided !== undefined ||
    command.claim !== undefined ||
    command.records.length !== 0 ||
    command.projectId !== initial.projectId ||
    command.expectedRevision !== initial.revision ||
    command.attribution.actor.kind !== "system" ||
    command.attribution.actor.id !== "project-work-github-outbox" ||
    command.attribution.source.kind !== "system" ||
    command.attribution.source.id !== "project-work-github-outbox"
  )
    return reject("Publication requires its unmixed private system transition");
  const matches = (initial.foundationRecords ?? []).filter(
    (record) => record.recordId === transition.effectId,
  );
  const effect = matches[0];
  if (
    matches.length !== 1 ||
    effect?.kind !== "effect" ||
    effect.effectKind !== "publication" ||
    effect.effectId !== transition.effectId ||
    effect.projectId !== initial.projectId ||
    effect.revision !== transition.expectedEffectRevision ||
    effect.payload.summary === undefined ||
    effect.payload.summary.length > 32_000
  )
    return reject("Publication transition requires its retained immutable effect");
  const request = decodeRequest(effect.payload.summary);
  if (
    canonicalProjectWorkPayload(request) !== effect.payload.summary ||
    request.operationId !== effect.effectId ||
    request.target.projectId !== initial.projectId ||
    request.target.taskId !== effect.taskId ||
    effect.targetId !== `${request.repository.host}/${request.repository.nameWithOwner}` ||
    effect.payload.expectedRevision !== request.expectedTaskRevision ||
    canonicalProjectWorkPayload(effect.payload.recordIds) !==
      canonicalProjectWorkPayload(request.authorizationRecordIds)
  )
    return reject("Publication envelope identity does not match retained effect");
  increment(initial.revision);
  const revision = increment(effect.revision);
  if (transition.kind === "publication.claim") {
    if (
      effect.status !== "pending" ||
      effect.claimGeneration !== transition.expectedClaimGeneration ||
      effect.outcome !== undefined
    )
      return reject("Only an unsent pending publication can be claimed");
    const record = {
      ...effect,
      status: "claimed" as const,
      claimGeneration: increment(effect.claimGeneration),
      revision,
      updatedAt: command.committedAt,
    };
    return [
      event(
        {
          type: "project-work.foundation.recorded",
          record: validateProjectTeamRecord(
            initial,
            record,
            command.attribution,
            undefined,
            undefined,
            undefined,
            transition,
          ),
          occurredAt: command.committedAt,
        },
        0,
      ),
    ];
  }
  const receipt = transition.receipt;
  if (
    (effect.status !== "claimed" && effect.status !== "uncertain") ||
    transition.claimGeneration === 0 ||
    effect.claimGeneration !== transition.claimGeneration ||
    receipt.operationId !== effect.effectId ||
    receipt.claimGeneration !== effect.claimGeneration ||
    receipt.requestHash !==
      NodeCrypto.createHash("sha256").update(effect.payload.summary).digest("hex")
  )
    return reject("Publication receipt does not match its original claim");
  if (receipt.kind === "confirmed") {
    const target = request.target;
    const pr = receipt.pullRequest;
    if (
      receipt.marker !== request.marker ||
      canonicalProjectWorkPayload(receipt.repository) !==
        canonicalProjectWorkPayload(request.repository) ||
      pr.baseSha !== target.baseSha ||
      pr.headSha !== target.headSha ||
      pr.baseRef !== target.baseRef ||
      pr.headRef !== target.headRef ||
      pr.headRepositoryNodeId !== target.headRepositoryNodeId ||
      pr.url !==
        `https://${request.repository.host}/${request.repository.nameWithOwner}/pull/${pr.number}`
    )
      return reject("Publication receipt does not match the exact repository and revision");
  }
  const outcome = canonicalProjectWorkPayload(receipt);
  if (outcome.length > 4_000) return reject("Publication outcome exceeds its retained limit");
  const record = {
    ...effect,
    status: receipt.kind === "confirmed" ? ("succeeded" as const) : ("uncertain" as const),
    revision,
    outcome,
    updatedAt: command.committedAt,
  };
  return [
    event(
      {
        type: "project-work.foundation.recorded",
        record: validateProjectTeamRecord(
          initial,
          record,
          command.attribution,
          undefined,
          undefined,
          undefined,
          transition,
        ),
        occurredAt: command.committedAt,
      },
      0,
    ),
  ];
};
