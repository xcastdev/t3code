import type { OrchestrationV2InstructionSnapshot } from "@t3tools/contracts";

/** Selected IDs describe requested resources; they do not grant native tool access. */
export function instructionSnapshotText(snapshot: OrchestrationV2InstructionSnapshot): string {
  return snapshot.roleInstructions;
}

export function sameInstructionSnapshot(
  left: OrchestrationV2InstructionSnapshot | undefined,
  right: OrchestrationV2InstructionSnapshot | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.configurationHash === right.configurationHash &&
    left.resourceRevision === right.resourceRevision &&
    left.memoryEpoch === right.memoryEpoch &&
    left.roleInstructions === right.roleInstructions &&
    left.toolIds.length === right.toolIds.length &&
    left.toolIds.every((id, index) => id === right.toolIds[index]) &&
    left.skillIds.length === right.skillIds.length &&
    left.skillIds.every((id, index) => id === right.skillIds[index])
  );
}

export function freezeInstructionSnapshot(
  snapshot: OrchestrationV2InstructionSnapshot,
): OrchestrationV2InstructionSnapshot {
  return Object.freeze({
    ...snapshot,
    toolIds: Object.freeze([...snapshot.toolIds]),
    skillIds: Object.freeze([...snapshot.skillIds]),
  });
}
