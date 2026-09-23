// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

export type SkillInstallTargetId =
  | "provider-project"
  | "provider-user"
  | "agents-project"
  | "agents-user";

export interface SkillInstallTarget {
  readonly id: SkillInstallTargetId;
  readonly root: string;
  readonly readers: ReadonlyArray<ProviderDriverKind>;
}

/** Check each destination's nearest existing ancestor through the external server. */
export function verifyExternalOpenCodeInstallTargets(input: {
  readonly targets: ReadonlyArray<SkillInstallTarget>;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly readFile: (
    path: string,
    directory: string,
  ) => Promise<{ readonly type: string; readonly content: string } | undefined>;
}) {
  const verify = (root: string) =>
    Effect.gen(function* () {
      let ancestor = root;
      while (!(yield* input.fileSystem.exists(ancestor))) {
        const parent = input.path.dirname(ancestor);
        if (parent === ancestor) return false;
        ancestor = parent;
      }
      const probePath = input.path.join(ancestor, `.t3-skill-probe-${NodeCrypto.randomUUID()}.txt`);
      const probeContent = NodeCrypto.randomUUID();
      yield* input.fileSystem.writeFileString(probePath, probeContent);
      return yield* Effect.tryPromise(() => input.readFile(probePath, ancestor)).pipe(
        Effect.map((read) => read?.type === "text" && read.content.trim() === probeContent),
        Effect.orElseSucceed(() => false),
        Effect.ensuring(input.fileSystem.remove(probePath, { force: true }).pipe(Effect.ignore)),
      );
    }).pipe(Effect.orElseSucceed(() => false));
  return Effect.forEach(input.targets, (target) =>
    verify(target.root).pipe(Effect.map((visible) => (visible ? target : undefined))),
  ).pipe(Effect.map((targets) => targets.filter((target) => target !== undefined)));
}

/** Use the running external OpenCode server's config path, not T3's guessed home. */
export function externalOpenCodeInstallTargets(input: {
  readonly targets: ReadonlyArray<SkillInstallTarget>;
  readonly configPath: string;
  readonly homePath?: string;
  readonly directory: string;
  readonly projectRoot?: string;
}): ReadonlyArray<SkillInstallTarget> {
  if (
    !NodePath.isAbsolute(input.configPath) ||
    (input.projectRoot && NodePath.resolve(input.directory) !== NodePath.resolve(input.projectRoot))
  )
    return [];
  const config = NodePath.resolve(input.configPath);
  const defaultHome =
    input.homePath && NodePath.isAbsolute(input.homePath)
      ? input.homePath
      : NodePath.basename(config) === "opencode" &&
          NodePath.basename(NodePath.dirname(config)) === ".config"
        ? NodePath.dirname(NodePath.dirname(config))
        : undefined;
  return input.targets.flatMap((target) => {
    if (target.id === "provider-user")
      return [{ ...target, root: NodePath.join(config, "skills") }];
    if (target.id === "agents-user")
      return defaultHome
        ? [{ ...target, root: NodePath.join(defaultHome, ".agents", "skills") }]
        : [];
    return [target];
  });
}

const kind = (value: string) => value as ProviderDriverKind;
const PROJECT_AGENTS_READERS = [
  kind("codex"),
  kind("opencode"),
  kind("cursor"),
  kind("antigravity"),
];
const USER_AGENTS_READERS = [kind("codex"), kind("opencode"), kind("cursor"), kind("grok")];

function homeFor(environment: NodeJS.ProcessEnv): string {
  return environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
}

function isLocalOpenCodeUrl(serverUrl: string): boolean {
  try {
    const hostname = new URL(serverUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Exact native roots, with the providers that discover each root. */
export function skillInstallTargets(input: {
  readonly driverKind: ProviderDriverKind;
  readonly environment: NodeJS.ProcessEnv;
  readonly projectRoot?: string;
  readonly externalOpenCodeUrl?: string;
  readonly nativeUserRoot?: string;
}): ReadonlyArray<SkillInstallTarget> {
  const provider = String(input.driverKind);
  if (
    provider === "opencode" &&
    input.externalOpenCodeUrl &&
    !isLocalOpenCodeUrl(input.externalOpenCodeUrl)
  ) {
    return [];
  }
  const home = homeFor(input.environment);
  const openCodeConfigDir = input.environment.OPENCODE_CONFIG_DIR?.trim();
  if (!["claudeAgent", "codex", "cursor", "grok", "opencode", "antigravity"].includes(provider))
    return [];
  const native = (() => {
    switch (provider) {
      case "claudeAgent":
        return {
          project: ".claude",
          user:
            input.nativeUserRoot ||
            input.environment.CLAUDE_CONFIG_DIR?.trim() ||
            NodePath.join(home, ".claude"),
          readers:
            input.nativeUserRoot || input.environment.CLAUDE_CONFIG_DIR?.trim()
              ? [kind("claudeAgent")]
              : [kind("claudeAgent"), kind("opencode"), kind("cursor"), kind("grok")],
        };
      case "opencode":
        return {
          project: ".opencode",
          user: openCodeConfigDir
            ? NodePath.isAbsolute(openCodeConfigDir)
              ? openCodeConfigDir
              : ""
            : NodePath.join(
                input.environment.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config"),
                "opencode",
              ),
          readers: [kind("opencode")],
        };
      case "cursor":
        return {
          project: ".cursor",
          user: NodePath.join(home, ".cursor"),
          readers: [kind("cursor")],
        };
      case "grok":
        return { project: ".grok", user: NodePath.join(home, ".grok"), readers: [kind("grok")] };
      case "antigravity":
        return {
          project: ".agents",
          user: NodePath.join(home, ".gemini", "config"),
          readers: [kind("antigravity")],
        };
      default:
        return undefined;
    }
  })();
  const targets: SkillInstallTarget[] = [];
  if (input.projectRoot) {
    if (native && provider !== "antigravity")
      targets.push({
        id: "provider-project",
        root: NodePath.join(input.projectRoot, native.project, "skills"),
        readers:
          provider === "claudeAgent"
            ? [kind("claudeAgent"), kind("opencode"), kind("cursor"), kind("grok")]
            : native.readers,
      });
    if (PROJECT_AGENTS_READERS.some((reader) => reader === input.driverKind))
      targets.push({
        id: "agents-project",
        root: NodePath.join(input.projectRoot, ".agents", "skills"),
        readers: PROJECT_AGENTS_READERS,
      });
  }
  if (native?.user)
    targets.push({
      id: "provider-user",
      root: NodePath.join(native.user, "skills"),
      readers: native.readers,
    });
  if (USER_AGENTS_READERS.some((reader) => reader === input.driverKind))
    targets.push({
      id: "agents-user",
      root: NodePath.join(home, ".agents", "skills"),
      readers: USER_AGENTS_READERS,
    });
  return targets;
}
