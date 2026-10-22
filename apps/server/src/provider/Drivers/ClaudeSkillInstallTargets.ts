import type { ClaudeSettings } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { skillInstallTargets } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { resolveClaudeConfigDirPath } from "./ClaudeSkills.ts";

export const resolveClaudeSkillInstallTargets = Effect.fn(
  "ClaudeDriver.resolveSkillInstallTargets",
)(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  projectRoot?: string,
) {
  const path = yield* Path.Path;
  const configuredDirectory = environment.CLAUDE_CONFIG_DIR?.trim();
  const relativeProfile =
    !config.homePath.trim() && configuredDirectory && !path.isAbsolute(configuredDirectory);
  const nativeUserRoot = yield* resolveClaudeConfigDirPath(config, environment, projectRoot);
  const targets = skillInstallTargets({
    driverKind: ProviderDriverKind.make("claudeAgent"),
    environment,
    ...(projectRoot ? { projectRoot } : {}),
    nativeUserRoot,
  });
  // A relative native profile has no environment-wide user destination without a workspace cwd.
  return relativeProfile && !projectRoot
    ? targets.filter((target) => target.id !== "provider-user")
    : targets;
});
