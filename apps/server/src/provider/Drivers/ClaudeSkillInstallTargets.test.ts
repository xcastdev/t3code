import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";
import { resolveClaudeSkillInstallTargets } from "./ClaudeSkillInstallTargets.ts";

it.effect.each(["relative", "absolute", "unset", "configured"] as const)(
  "Claude %s profile install targets match native discovery in each workspace",
  (profile) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-install-profile-" });
      const home = path.join(root, "home");
      const workspaces = [path.join(root, "first"), path.join(root, "second")];
      const absoluteProfile = path.join(root, "absolute-profile");
      const environment = {
        HOME: home,
        ...(profile === "relative"
          ? { CLAUDE_CONFIG_DIR: "relative-config" }
          : profile === "absolute"
            ? { CLAUDE_CONFIG_DIR: absoluteProfile }
            : {}),
      };
      const config = {
        homePath: profile === "configured" ? path.join(root, "configured-profile") : "",
      };
      for (const workspace of workspaces) {
        const expectedRoot = path.join(
          profile === "relative"
            ? path.join(workspace, "relative-config")
            : profile === "absolute"
              ? absoluteProfile
              : profile === "configured"
                ? config.homePath
                : path.join(home, ".claude"),
          "skills",
        );
        yield* fs.makeDirectory(path.join(expectedRoot, "review"), { recursive: true });
        yield* fs.writeFileString(
          path.join(expectedRoot, "review", "SKILL.md"),
          "---\nname: review\ndescription: Review changes\n---\nReview.",
        );
        const targets = yield* resolveClaudeSkillInstallTargets(
          config,
          environment,
          workspace,
        ).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
        const discovered = yield* discoverClaudeSkills(config, workspace, environment).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
        expect(targets.find((target) => target.id === "provider-user")?.root).toBe(expectedRoot);
        expect(discovered.find((skill) => skill.name === "review")?.path).toBe(
          path.join(expectedRoot, "review", "SKILL.md"),
        );
      }
      if (profile === "relative") {
        expect(
          (yield* resolveClaudeSkillInstallTargets(config, environment).pipe(
            Effect.provideService(HostProcess.HomeDirectory, home),
          )).some((target) => target.id === "provider-user"),
        ).toBe(false);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
