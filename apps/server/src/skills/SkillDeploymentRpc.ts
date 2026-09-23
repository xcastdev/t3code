import type {
  ManagedSkillKey,
  SkillContentHash,
  SkillDeploymentChangeInput,
} from "@t3tools/contracts";
import { SkillRpcError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { SkillInstallTarget } from "./SkillInstallTargets.ts";

export function selectSkillDeploymentChange(
  input: SkillDeploymentChangeInput,
  source:
    | {
        readonly key: ManagedSkillKey;
        readonly hash: SkillContentHash;
        readonly packagePath: string;
      }
    | undefined,
  targets: ReadonlyArray<SkillInstallTarget>,
) {
  return Effect.gen(function* () {
    if (input.operation === "install" && (!source || source.hash !== input.expectedHash))
      return yield* new SkillRpcError({
        code: "revision_conflict",
        message: "The skill changed since it was selected.",
      });
    const target = targets.find((candidate) => candidate.id === input.target);
    if (!target)
      return yield* new SkillRpcError({
        code: "install_unavailable",
        message: "That install location is unavailable for this provider and project.",
      });
    const key = source?.key ?? input.key;
    if (!key)
      return yield* new SkillRpcError({
        code: "invalid_request",
        message: "A managed skill source or installed key is required.",
      });
    return { key, target, sourcePath: source?.packagePath ?? "" };
  });
}
