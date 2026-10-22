// @effect-diagnostics-next-line nodeBuiltinImport:off -- Source fingerprints are synchronous pure adapter values.
import * as NodeCrypto from "node:crypto";
import type { EnvironmentId, MemoryOwner, ProjectMemorySource } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface MemoryScope {
  readonly environmentId: EnvironmentId;
  readonly owner: MemoryOwner;
  readonly ownerRevision: number;
}
export interface MemorySourceTuple extends MemoryScope {
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly generation: number;
  readonly contentHash: string;
}
export interface MemorySourceRow {
  readonly payload_json: string;
  readonly work_kind: "comment" | "evidence" | "decision";
  readonly work_id: string;
  readonly work_revision: number;
  readonly task_id: string;
}
export class ProjectMemoryError extends Schema.TaggedError<ProjectMemoryError>()(
  "ProjectMemoryError",
  {
    reason: Schema.Literals(["stale", "forbidden", "unavailable", "invalid", "forgotten"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Memory operation ${this.reason}.`;
  }
}
export const ownerId = (owner: MemoryOwner) =>
  owner.kind === "project" ? owner.projectId : owner.assistantId;
export const memoryHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");
export const sourceTuple = (
  scope: MemoryScope,
  source: ProjectMemorySource,
): MemorySourceTuple => ({
  ...scope,
  sourceId: source.sourceId,
  sourceRevision: source.sourceRevision,
  generation: source.generation,
  contentHash: source.contentHash,
});
