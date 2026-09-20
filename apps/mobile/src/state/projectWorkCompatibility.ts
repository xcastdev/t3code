import { OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Mobile keeps the orchestration shell as its compatibility boundary. Newer
 * servers may add project-work metadata to shell payloads, but mobile does
 * not expose project-work management controls, so the additive fields are
 * intentionally ignored while the existing thread shell remains usable.
 */
export const MobileOrchestrationShellSnapshot = Schema.Struct({
  ...OrchestrationShellSnapshot.fields,
});

export type MobileOrchestrationShellSnapshot = typeof MobileOrchestrationShellSnapshot.Type;
