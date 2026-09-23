import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  externalOpenCodeInstallTargets,
  skillInstallTargets,
  verifyExternalOpenCodeInstallTargets,
} from "./SkillInstallTargets.ts";

const projectRoot = "/tmp/example";
const environment = { HOME: "/tmp/person" };
const targets = (provider: string, externalOpenCodeUrl?: string) =>
  skillInstallTargets({
    driverKind: ProviderDriverKind.make(provider),
    environment,
    projectRoot,
    ...(externalOpenCodeUrl ? { externalOpenCodeUrl } : {}),
  });

describe("skill install locations", () => {
  it.effect("excludes user roots when only the external server's checkout is shared", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-roots-" });
      const project = path.join(root, "project");
      const user = path.join(root, "user");
      yield* fileSystem.makeDirectory(project);
      yield* fileSystem.makeDirectory(user);
      const candidates = skillInstallTargets({
        driverKind: ProviderDriverKind.make("opencode"),
        environment: { HOME: user },
        projectRoot: project,
      });
      const remoteReads: Array<{ probe: string; directory: string }> = [];
      const verified = yield* verifyExternalOpenCodeInstallTargets({
        targets: candidates,
        fileSystem,
        path,
        readFile: async (probe, directory) => {
          remoteReads.push({ probe, directory });
          return path.relative(project, probe).startsWith("..")
            ? undefined
            : { type: "text", content: await Effect.runPromise(fileSystem.readFileString(probe)) };
        },
      });
      expect(verified.map((target) => target.id)).toEqual(["provider-project", "agents-project"]);
      expect(remoteReads).toHaveLength(4);
      expect(remoteReads.every(({ probe, directory }) => directory === path.dirname(probe))).toBe(
        true,
      );
      expect(
        (yield* fileSystem.readDirectory(project)).filter((name) =>
          name.startsWith(".t3-skill-probe"),
        ),
      ).toEqual([]);
      expect(
        (yield* fileSystem.readDirectory(user)).filter((name) =>
          name.startsWith(".t3-skill-probe"),
        ),
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it("shows the actual readers of shared .agents locations", () => {
    const project = targets("codex").find((target) => target.id === "agents-project");
    const user = targets("codex").find((target) => target.id === "agents-user");
    expect(project?.root).toBe("/tmp/example/.agents/skills");
    expect(project?.readers).toEqual(["codex", "opencode", "cursor", "antigravity"]);
    expect(user?.root).toBe("/tmp/person/.agents/skills");
    expect(user?.readers).toEqual(["codex", "opencode", "cursor", "grok"]);
    expect(project?.readers).not.toContain("claudeAgent");
    expect(user?.readers).not.toContain("claudeAgent");
    expect(targets("claudeAgent").some((target) => target.id.startsWith("agents-"))).toBe(false);
    expect(targets("antigravity").some((target) => target.id === "agents-user")).toBe(false);
    expect(targets("grok").some((target) => target.id === "agents-project")).toBe(false);
  });

  it("provides native project and user installs for every provider with native directories", () => {
    expect(
      targets("claudeAgent")
        .filter((target) => target.id.startsWith("provider-"))
        .map((target) => target.root),
    ).toEqual(["/tmp/example/.claude/skills", "/tmp/person/.claude/skills"]);
    expect(
      targets("opencode")
        .filter((target) => target.id.startsWith("provider-"))
        .map((target) => target.root),
    ).toEqual(["/tmp/example/.opencode/skills", "/tmp/person/.config/opencode/skills"]);
    expect(
      targets("cursor")
        .filter((target) => target.id.startsWith("provider-"))
        .map((target) => target.root),
    ).toEqual(["/tmp/example/.cursor/skills", "/tmp/person/.cursor/skills"]);
    expect(
      targets("grok")
        .filter((target) => target.id.startsWith("provider-"))
        .map((target) => target.root),
    ).toEqual(["/tmp/example/.grok/skills", "/tmp/person/.grok/skills"]);
    expect(
      targets("antigravity")
        .filter((target) => target.id.startsWith("provider-"))
        .map((target) => target.root),
    ).toEqual(["/tmp/person/.gemini/config/skills"]);
    expect(targets("antigravity").find((target) => target.id === "agents-project")?.root).toBe(
      "/tmp/example/.agents/skills",
    );
  });

  it("only offers external OpenCode filesystem installs over a loopback URL", () => {
    expect(targets("opencode", "http://127.0.0.1:4096")).toHaveLength(4);
    expect(targets("opencode", "https://remote.example:4096")).toEqual([]);
  });

  it("uses the external OpenCode server's config path and refuses a different checkout", () => {
    const native = targets("opencode", "http://localhost:4096");
    const resolved = externalOpenCodeInstallTargets({
      targets: native,
      configPath: "/tmp/remote-user/.config/opencode",
      directory: projectRoot,
      projectRoot,
    });
    expect(resolved.find((target) => target.id === "provider-user")?.root).toBe(
      "/tmp/remote-user/.config/opencode/skills",
    );
    expect(resolved.find((target) => target.id === "agents-user")?.root).toBe(
      "/tmp/remote-user/.agents/skills",
    );
    expect(
      externalOpenCodeInstallTargets({
        targets: native,
        configPath: "/tmp/remote-user/.config/opencode",
        directory: "/other",
        projectRoot,
      }),
    ).toEqual([]);
    const customConfig = externalOpenCodeInstallTargets({
      targets: native,
      configPath: "/tmp/remote-user/custom/opencode",
      homePath: "/tmp/remote-user",
      directory: projectRoot,
      projectRoot,
    });
    expect(customConfig.find((target) => target.id === "agents-user")?.root).toBe(
      "/tmp/remote-user/.agents/skills",
    );
  });

  it("does not advertise install locations for unknown provider drivers", () => {
    expect(targets("customProvider")).toEqual([]);
  });
});
