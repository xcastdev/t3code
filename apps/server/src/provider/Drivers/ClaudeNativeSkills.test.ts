import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { discoverClaudeNativeSkills } from "./ClaudeSkills.ts";

const makeFixture = Effect.fn("ClaudeNativeSkills.test.makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-native-" });
  const configDir = path.join(root, "config");
  const project = path.join(root, "project");
  yield* fs.makeDirectory(configDir, { recursive: true });
  yield* fs.makeDirectory(project, { recursive: true });
  const writeSkill = Effect.fn("ClaudeNativeSkills.test.writeSkill")(function* (
    directory: string,
    name: string,
  ) {
    const skillRoot = path.join(directory, name);
    yield* fs.makeDirectory(skillRoot, { recursive: true });
    const skillPath = path.join(skillRoot, "SKILL.md");
    yield* fs.writeFileString(
      skillPath,
      "---\nname: ignored-frontmatter-name\ndescription: Native skill\n---\nInstructions",
    );
    return skillPath;
  });
  return { fs, path, root, configDir, project, writeSkill };
});

it.layer(NodeServices.layer)("Claude native skill discovery", (it) => {
  it.effect("preserves bare-name collisions from cwd through repository ancestors", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const { fs, path, configDir, project, root, writeSkill } = fixture;
      const cwd = path.join(project, "packages", "web");
      yield* fs.makeDirectory(path.join(project, ".git"));
      const expected = [];
      expected.push(yield* writeSkill(path.join(configDir, "skills"), "deploy"));
      for (const directory of [cwd, path.dirname(cwd), project]) {
        expected.push(yield* writeSkill(path.join(directory, ".claude", "skills"), "deploy"));
      }
      yield* writeSkill(path.join(root, ".claude", "skills"), "outside-repository");
      const skills = yield* discoverClaudeNativeSkills({ homePath: configDir }, cwd, {});
      assert.deepStrictEqual(
        skills.map((skill) => skill.path),
        expected,
      );
      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        ["deploy", "deploy", "deploy", "deploy"],
      );
    }),
  );

  it.effect("does not invent ancestor project sources outside a repository", () =>
    Effect.gen(function* () {
      const { path, configDir, project, root, writeSkill } = yield* makeFixture();
      yield* writeSkill(path.join(root, ".claude", "skills"), "outside-project");
      assert.deepStrictEqual(
        yield* discoverClaudeNativeSkills({ homePath: configDir }, project, {}),
        [],
      );
    }),
  );

  for (const contents of ["{broken", '{"skillOverrides":{"deploy":false}}']) {
    it.effect(`fails malformed native settings: ${contents}`, () =>
      Effect.gen(function* () {
        const { fs, path, configDir, project, writeSkill } = yield* makeFixture();
        yield* writeSkill(path.join(configDir, "skills"), "deploy");
        yield* fs.writeFileString(path.join(configDir, "settings.json"), contents);
        const error = yield* discoverClaudeNativeSkills({ homePath: configDir }, project, {}).pipe(
          Effect.flip,
        );
        assert.equal(error._tag, "SchemaError");
      }),
    );
  }

  it.effect("does not claim a successful empty catalog for malformed skill frontmatter", () =>
    Effect.gen(function* () {
      const { fs, path, configDir, project, writeSkill } = yield* makeFixture();
      const skill = yield* writeSkill(path.join(configDir, "skills"), "deploy");
      yield* fs.writeFileString(skill, "---\ndescription: [unterminated\n---\nInstructions");
      const error = yield* discoverClaudeNativeSkills({ homePath: configDir }, project, {}).pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "ClaudeSkillDiscoveryError");
    }),
  );

  for (const target of ["settings", "root", "skill"] as const) {
    it.effect(`propagates unreadable ${target} instead of claiming fresh discovery`, () =>
      Effect.gen(function* () {
        const { fs, path, configDir, project, writeSkill } = yield* makeFixture();
        const skillPath = yield* writeSkill(path.join(configDir, "skills"), "deploy");
        const deniedPath =
          target === "settings"
            ? path.join(configDir, "settings.json")
            : target === "root"
              ? path.join(configDir, "skills")
              : skillPath;
        const denied = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "read",
          pathOrDescriptor: deniedPath,
        });
        const error = yield* discoverClaudeNativeSkills({ homePath: configDir }, project, {}).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, ...args) =>
              file === deniedPath ? Effect.fail(denied) : fs.readFileString(file, ...args),
            readDirectory: (directory, ...args) =>
              directory === deniedPath ? Effect.fail(denied) : fs.readDirectory(directory, ...args),
          }),
          Effect.flip,
        );
        assert.strictEqual(error, denied);
      }),
    );
  }
});
