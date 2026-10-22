import {
  ProjectMemorySource as ProjectMemorySourceSchema,
  ProjectMemorySource,
  ProjectTeamMemorySelection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProjectWorkReducerState } from "../ProjectWorkDecider.ts";
import { memoryHash, ProjectMemoryError } from "./ProjectMemoryRepository.ts";

const decodeSource = Schema.decodeUnknownSync(ProjectMemorySourceSchema);

export interface WorkMemoryReference {
  readonly taskId: string;
  readonly kind: "comment" | "evidence" | "decision";
  readonly retainedId: string;
  readonly retainedRevision: number;
}
export const memoryWorkKey = (ref: Pick<WorkMemoryReference, "kind" | "retainedId">) =>
  `${ref.kind}:${memoryHash(ref.retainedId)}`;

export function authorizedWorkSource(state: ProjectWorkReducerState, ref: WorkMemoryReference) {
  const task = state.tasks.find((entry) => entry.taskId === ref.taskId);
  if (task === undefined) throw new ProjectMemoryError({ reason: "forbidden" });
  if (ref.kind === "comment") {
    const record = state.comments?.find((entry) => entry.commentId === ref.retainedId);
    if (
      record?.taskId !== ref.taskId ||
      record.revision !== ref.retainedRevision ||
      record.attribution === undefined
    )
      throw new ProjectMemoryError({ reason: "stale" });
    return {
      content: record.body,
      attribution: record.attribution,
      sourceKind: "finding" as const,
    };
  }
  if (ref.kind === "evidence") {
    const record = state.evidence.find((entry) => entry.evidenceId === ref.retainedId);
    if (
      record?.taskId !== ref.taskId ||
      record.revision !== ref.retainedRevision ||
      record.attribution === undefined
    )
      throw new ProjectMemoryError({ reason: "stale" });
    return {
      content: record.detail ?? record.summary,
      attribution: record.attribution,
      sourceKind: "result" as const,
    };
  }
  const record = state.decisions?.find((entry) => entry.decisionId === ref.retainedId);
  if (
    record === undefined ||
    record.projectId !== state.projectId ||
    record.revision !== ref.retainedRevision ||
    record.state !== "accepted" ||
    record.attribution === undefined
  )
    throw new ProjectMemoryError({ reason: "stale" });
  return { content: record.body, attribution: record.attribution, sourceKind: "decision" as const };
}
export function captureWorkSource(
  state: ProjectWorkReducerState,
  ref: WorkMemoryReference,
  selection: ProjectTeamMemorySelection,
  now: string,
): ProjectMemorySource {
  const source = authorizedWorkSource(state, ref);
  if (
    selection.owner.kind !== "project" ||
    selection.owner.projectId !== state.projectId ||
    memoryHash(source.content) !== selection.contentHash
  )
    throw new ProjectMemoryError({ reason: "stale" });
  if (
    selection.kind !== ref.kind ||
    selection.retainedId !== ref.retainedId ||
    selection.retainedRevision !== ref.retainedRevision ||
    selection.sourceRevision !== ref.retainedRevision
  )
    throw new ProjectMemoryError({ reason: "stale" });
  return decodeSource({
    kind: "memory-source",
    recordId: selection.sourceRecordId,
    owner: selection.owner,
    ownerRevision: selection.ownerRevision,
    revision: selection.expectedSourceRecordRevision,
    generation: selection.sourceGeneration,
    updatedAt: now,
    status: "current",
    sourceKind: source.sourceKind,
    sourceId: memoryWorkKey(ref),
    sourceRevision: selection.sourceRevision,
    content: source.content,
    contentHash: memoryHash(source.content),
    contentRevision: ref.retainedRevision,
    conversationSpans: [],
    attribution: source.attribution,
  });
}
