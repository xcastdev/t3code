// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ManagedSkillKey } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readNativeSkillForImport } from "./NativeSkillImport.ts";

const digest = async (path: string) =>
  NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(path))
    .digest("hex");

it.layer(NodeServices.layer)("native skill import", (it) => {
  it.effect("copies bounded regular files without modifying the source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-import-" });
      yield* fs.makeDirectory(path.join(root, "scripts"), { recursive: true });
      const skillPath = path.join(root, "SKILL.md");
      yield* fs.writeFileString(
        skillPath,
        "---\nname: native-deploy\ndescription: Native deploy\nlicense: MIT\ndisable-model-invocation: true\nallowed-tools:\n  - Bash\n---\nRun the deployment.",
      );
      yield* fs.writeFileString(path.join(root, "scripts", "deploy.sh"), "echo deploy\n");
      const before = yield* Effect.promise(() => digest(skillPath));

      const imported = yield* readNativeSkillForImport({
        nativePath: skillPath,
        key: ManagedSkillKey.make("deploy"),
      });

      assert.strictEqual(imported.content.name, "Native deploy");
      assert.strictEqual(imported.content.body, "Run the deployment.");
      assert.deepStrictEqual(imported.content.frontmatter, {
        license: "MIT",
        "disable-model-invocation": true,
        "allowed-tools": ["Bash"],
      });
      assert.deepStrictEqual(imported.content.assetPaths, ["scripts/deploy.sh"]);
      assert.strictEqual(new TextDecoder().decode(imported.files[0]?.bytes), "echo deploy\n");
      assert.strictEqual(yield* Effect.promise(() => digest(skillPath)), before);
    }),
  );

  it.effect("rejects symbolic links", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-import-link-" });
      yield* fs.writeFileString(
        path.join(root, "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy\n---\nBody",
      );
      yield* fs.symlink("SKILL.md", path.join(root, "alias.md"));
      const error = yield* readNativeSkillForImport({
        nativePath: path.join(root, "SKILL.md"),
        key: ManagedSkillKey.make("deploy"),
      }).pipe(Effect.flip);
      assert.strictEqual(error.code, "unsafe_native_package");
    }),
  );

  it.effect("rejects wrong known frontmatter types during import", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-import-frontmatter-" });
      const skillPath = path.join(root, "SKILL.md");
      yield* fs.writeFileString(
        skillPath,
        "---\nname: deploy\ndescription: Deploy\ndisable-model-invocation: 'true'\nallowed-tools: 42\n---\nBody",
      );
      const error = yield* readNativeSkillForImport({
        nativePath: skillPath,
        key: ManagedSkillKey.make("deploy"),
      }).pipe(Effect.flip);
      assert.strictEqual(error.code, "invalid_native_skill");
    }),
  );
});
