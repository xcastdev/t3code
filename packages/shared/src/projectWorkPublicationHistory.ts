import { sha256 } from "@noble/hashes/sha2";
import {
  canonicalProjectWorkPayload,
  ProjectWorkPublicationOutcome,
  ProjectWorkPublicationRequest,
  type ProjectTeamEffect,
} from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeRequest = Schema.decodeUnknownOption(ProjectWorkPublicationRequest);
const decodeOutcome = Schema.decodeUnknownOption(ProjectWorkPublicationOutcome);

/** Present retained PR history only when the receipt agrees with its frozen request. */
export function readProjectWorkPublicationHistory(effect: typeof ProjectTeamEffect.Type) {
  const summary = effect.payload.summary;
  const outcome = effect.outcome;
  if (
    effect.effectKind !== "publication" ||
    effect.status !== "succeeded" ||
    effect.recordId !== effect.effectId ||
    summary === undefined ||
    summary.length > 32_000 ||
    outcome === undefined ||
    outcome.length > 4_000 ||
    effect.claimGeneration === 0
  )
    return undefined;
  try {
    const requestOption = decodeRequest(JSON.parse(summary));
    const receiptOption = decodeOutcome(JSON.parse(outcome));
    if (Option.isNone(requestOption) || Option.isNone(receiptOption)) return undefined;
    const request = requestOption.value;
    const receipt = receiptOption.value;
    if (
      receipt.kind !== "confirmed" ||
      canonicalProjectWorkPayload(request) !== summary ||
      canonicalProjectWorkPayload(receipt) !== outcome ||
      request.operationId !== effect.effectId ||
      request.target.projectId !== effect.projectId ||
      request.target.taskId !== effect.taskId ||
      effect.targetId !== `${request.repository.host}/${request.repository.nameWithOwner}` ||
      effect.payload.expectedRevision !== request.expectedTaskRevision ||
      canonicalProjectWorkPayload(effect.payload.recordIds) !==
        canonicalProjectWorkPayload(request.authorizationRecordIds) ||
      receipt.operationId !== effect.effectId ||
      receipt.claimGeneration !== effect.claimGeneration ||
      receipt.marker !== request.marker ||
      canonicalProjectWorkPayload(receipt.repository) !==
        canonicalProjectWorkPayload(request.repository) ||
      receipt.requestHash !== Encoding.encodeHex(sha256(new TextEncoder().encode(summary))) ||
      receipt.pullRequest.baseSha !== request.target.baseSha ||
      receipt.pullRequest.headSha !== request.target.headSha ||
      receipt.pullRequest.baseRef !== request.target.baseRef ||
      receipt.pullRequest.headRef !== request.target.headRef ||
      receipt.pullRequest.headRepositoryNodeId !== request.target.headRepositoryNodeId ||
      receipt.pullRequest.url !==
        `https://${request.repository.host}/${request.repository.nameWithOwner}/pull/${receipt.pullRequest.number}`
    )
      return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}
