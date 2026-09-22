import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ManagedSkillContent, ManagedSkillKey, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ManagedSkillRepository from "../../skills/ManagedSkillRepository.ts";
import * as SkillMaterializationService from "../../skills/SkillMaterializationService.ts";
import { hashSkillPackage } from "../../skills/SkillPackage.ts";
import { materializeClaudeManagedPlugin } from "./ClaudeSkillMaterializer.ts";

const TestLayer = SkillMaterializationService.layer.pipe(
  Layer.provideMerge(ManagedSkillRepository.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-skill-materializer-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("ClaudeSkillMaterializer", () => {
  it.layer(TestLayer)("creates an owned local plugin from managed packages", (it) => {
    it.effect("writes the plugin manifest and portable skill tree", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const content: ManagedSkillContent = {
          key: "deploy" as ManagedSkillKey,
          name: "Deploy",
          body: "Ship it.",
          frontmatter: {
            license: "MIT",
            "disable-model-invocation": true,
            "allowed-tools": ["Bash"],
          },
        };
        const created = yield* repository.createGlobal({ expectedRevision: 0, content });
        const plan = yield* materializeClaudeManagedPlugin({
          sessionId: "session-claude",
          providerInstanceId: "claudeAgent" as ProviderInstanceId,
          desiredRevision: 1,
          packages: [{ key: content.key, sourcePath: created.packagePath }],
          collidingNativeKeys: [content.key],
        });

        assert.deepEqual(plan, {
          kind: "claude-managed-skills",
          pluginPath: plan.pluginPath,
          collidingNativeKeys: ["deploy"],
          skillKeys: ["deploy"],
        });
        assert.include(
          yield* fs.readFileString(path.join(plan.pluginPath, ".claude-plugin", "plugin.json")),
          '"name":"t3-managed"',
        );
        assert.include(
          yield* fs.readFileString(path.join(plan.pluginPath, "skills", "deploy", "SKILL.md")),
          "Ship it.",
        );
        assert.include(
          yield* fs.readFileString(path.join(plan.pluginPath, "skills", "deploy", "SKILL.md")),
          "disable-model-invocation: true",
        );
      }),
    );

    it.effect("keeps a managed key named plugin separate from Claude scaffolding", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const service = yield* SkillMaterializationService.SkillMaterializationService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pluginContent: ManagedSkillContent = {
          key: "plugin" as ManagedSkillKey,
          name: "Plugin",
          body: "The managed plugin skill.",
        };
        const deployContent: ManagedSkillContent = {
          key: "another" as ManagedSkillKey,
          name: "Another",
          body: "The managed another skill.",
        };
        const pluginPackage = yield* repository.createGlobal({
          expectedRevision: 0,
          content: pluginContent,
        });
        const deployPackage = yield* repository.createGlobal({
          expectedRevision: 0,
          content: deployContent,
        });
        const pluginHash = yield* hashSkillPackage(pluginPackage.packagePath);
        const deployHash = yield* hashSkillPackage(deployPackage.packagePath);

        const plan = yield* materializeClaudeManagedPlugin({
          sessionId: "session-claude-collision",
          providerInstanceId: "claudeAgent" as ProviderInstanceId,
          desiredRevision: 1,
          packages: [
            { key: pluginContent.key, sourcePath: pluginPackage.packagePath },
            { key: deployContent.key, sourcePath: deployPackage.packagePath },
          ],
          collidingNativeKeys: [pluginContent.key],
        });

        assert.equal(path.basename(plan.pluginPath), ".t3-claude-plugin");
        assert.isTrue(
          yield* fs.exists(path.join(plan.pluginPath, ".claude-plugin", "plugin.json")),
        );
        assert.include(
          yield* fs.readFileString(path.join(plan.pluginPath, "skills", "plugin", "SKILL.md")),
          "The managed plugin skill.",
        );
        assert.include(
          yield* fs.readFileString(path.join(plan.pluginPath, "skills", "another", "SKILL.md")),
          "The managed another skill.",
        );
        assert.isTrue(yield* fs.exists(path.join(pluginPackage.packagePath, "SKILL.md")));
        assert.equal(yield* hashSkillPackage(pluginPackage.packagePath), pluginHash);
        assert.equal(yield* hashSkillPackage(deployPackage.packagePath), deployHash);

        yield* service.dispose({
          sessionId: "session-claude-collision",
          providerInstanceId: "claudeAgent" as ProviderInstanceId,
          desiredRevision: 1,
        });
        assert.isFalse(yield* fs.exists(path.dirname(plan.pluginPath)));
        assert.equal(yield* hashSkillPackage(pluginPackage.packagePath), pluginHash);
        assert.equal(yield* hashSkillPackage(deployPackage.packagePath), deployHash);
      }),
    );
  });
});
