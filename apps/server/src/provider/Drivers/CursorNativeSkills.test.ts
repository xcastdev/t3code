import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { probeCursorSkills } from "./CursorSkills.ts";

it.layer(NodeServices.layer)("Cursor native skill discovery", (it) => {
  for (const oversized of [false, true]) {
    it.effect(
      `reports ${oversized ? "oversized" : "unreadable"} skill metadata as failed discovery`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-native-" });
          const cwd = path.join(root, "project");
          const home = path.join(root, "home");
          const directory = path.join(cwd, ".cursor", "skills", "review");
          yield* fs.makeDirectory(directory, { recursive: true });
          const skillPath = path.join(directory, "SKILL.md");
          yield* fs.writeFileString(
            skillPath,
            oversized ? "x".repeat(1_000_001) : "---\nuser-invocable: false\n---\n",
          );
          const denied = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
          });
          const error = yield* probeCursorSkills(cwd, { HOME: home }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file, ...args) =>
                !oversized && file === skillPath
                  ? Effect.fail(denied)
                  : fs.readFileString(file, ...args),
            }),
            Effect.flip,
          );
          assert.equal(error.reason, oversized ? "scan-budget-exhausted" : "filesystem-error");
        }),
    );
  }
});
