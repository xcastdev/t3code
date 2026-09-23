import { assert, describe, it } from "@effect/vitest";
import {
  ManagedSkillKey,
  ProviderDriverKind,
  ProviderInstanceId,
  SkillCatalogRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import type { SkillMaterializationServiceShape } from "./SkillMaterializationService.ts";
import {
  makeClaudeSkillAdapter,
  makeCodexSkillAdapter,
  makeDiscoveryOnlySkillAdapter,
  makeOpenCodeSkillAdapter,
} from "./ProviderSkillAdapters.ts";
import { CODEX_MATERIALIZED_EXTENSION_PATH } from "../provider/Drivers/CodexSkillMaterializer.ts";

const instanceId = ProviderInstanceId.make("codex");

describe("ProviderSkillAdapters", () => {
  it.effect("disables every managed Claude key when discovery omits native sources", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-adapter-" });
      const materialization: SkillMaterializationServiceShape = {
        materialize: () => Effect.succeed({ root, skillPaths: new Map() }),
        dispose: () => Effect.void,
        disposeSession: () => Effect.void,
      };
      const adapter = makeClaudeSkillAdapter({
        providerInstanceId: ProviderInstanceId.make("claude"),
        discoverCandidates: () => Effect.succeed([]),
        materialization,
        fileSystem: fs,
        path,
      });
      const plan = yield* adapter.prepareSession({
        runtime: {
          providerInstanceId: ProviderInstanceId.make("claude"),
          cwd: "/repo",
          sessionId: "session-1",
        },
        desiredRevision: SkillCatalogRevision.make(2),
        skills: [
          { key: ManagedSkillKey.make("deploy"), packagePath: "/canonical/deploy" },
          { key: ManagedSkillKey.make("review"), packagePath: "/canonical/review" },
        ],
      });
      assert.deepEqual(
        (plan.payload as { readonly collidingNativeKeys: string[] }).collidingNativeKeys,
        ["deploy", "review"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prepares an opaque Codex plan from owned materializations", () =>
    Effect.gen(function* () {
      const materialization: SkillMaterializationServiceShape = {
        materialize: (input) =>
          Effect.succeed({
            root: "/runtime/codex",
            skillPaths: new Map(
              input.packages.map((item) => [item.key, `/runtime/codex/${item.key}`]),
            ),
          }),
        dispose: () => Effect.void,
        disposeSession: () => Effect.void,
      };
      const adapter = makeCodexSkillAdapter({
        providerInstanceId: instanceId,
        discoverCandidates: () => Effect.succeed([]),
        materialization,
      });
      const key = ManagedSkillKey.make("review");
      const plan = yield* adapter.prepareSession({
        runtime: { providerInstanceId: instanceId, cwd: "/repo", sessionId: "session-1" },
        desiredRevision: SkillCatalogRevision.make(2),
        skills: [{ key, packagePath: "/canonical/review" }],
      });
      assert.deepEqual(plan.skillKeys, [key]);
      assert.deepEqual(plan.payload, {
        kind: "codex-managed-skills",
        extraRoot: "/runtime/codex",
        skills: [{ key, path: "/runtime/codex/review/SKILL.md" }],
      });
    }),
  );

  it.effect("maps a canonical Codex extension before returning the provider plan", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-adapter-extension-" });
      const skillPath = path.join(root, "review");
      yield* fs.makeDirectory(path.join(skillPath, "providers", "codex"), { recursive: true });
      yield* fs.writeFileString(
        path.join(skillPath, "providers", "codex", "openai.yaml"),
        "interface:\n  display_name: Review\n",
      );
      const materialization: SkillMaterializationServiceShape = {
        materialize: () =>
          Effect.succeed({
            root,
            skillPaths: new Map([[ManagedSkillKey.make("review"), skillPath]]),
          }),
        dispose: () => Effect.void,
        disposeSession: () => Effect.void,
      };
      const adapter = makeCodexSkillAdapter({
        providerInstanceId: instanceId,
        discoverCandidates: () => Effect.succeed([]),
        materialization,
      });
      const plan = yield* adapter.prepareSession({
        runtime: { providerInstanceId: instanceId, cwd: "/repo", sessionId: "session-1" },
        desiredRevision: SkillCatalogRevision.make(2),
        skills: [{ key: ManagedSkillKey.make("review"), packagePath: "/canonical/review" }],
      });
      assert.equal(
        yield* fs.readFileString(path.join(skillPath, CODEX_MATERIALIZED_EXTENSION_PATH)),
        "interface:\n  display_name: Review\n",
      );
      assert.equal((plan.payload as { readonly kind: string }).kind, "codex-managed-skills");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("reports structured discovery-only limitations for unisolated providers", () => {
    const adapter = makeDiscoveryOnlySkillAdapter({
      providerInstanceId: ProviderInstanceId.make("cursor"),
      driverKind: ProviderDriverKind.make("cursor"),
      discoverCandidates: () => Effect.succeed([]),
    });
    const compatibility = adapter.evaluateCompatibility(
      { key: ManagedSkillKey.make("review"), packagePath: "/canonical/review" },
      {
        providerInstanceId: ProviderInstanceId.make("cursor"),
        cwd: "/repo",
        sessionId: "session-1",
      },
    );
    assert.equal(compatibility.support, "unsupported");
    assert.equal(compatibility.applicationMode, "unsupported");
    assert.equal(compatibility.reasons[0]?.code, "session_isolation_unavailable");
  });

  it.effect("prepares isolated OpenCode skill sources and gates external servers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-managed-" });
      const materialization: SkillMaterializationServiceShape = {
        materialize: (input) =>
          Effect.gen(function* () {
            const skillPaths = new Map(
              input.packages.map((item) => [item.key, path.join(root, item.key)]),
            );
            for (const packagePath of skillPaths.values()) {
              yield* fs.makeDirectory(packagePath).pipe(Effect.orDie);
              yield* fs
                .writeFileString(
                  path.join(packagePath, "SKILL.md"),
                  "---\nname: review\ndescription: Review\n---\nReview",
                )
                .pipe(Effect.orDie);
            }
            return { root, skillPaths };
          }),
        dispose: () => Effect.void,
        disposeSession: () => Effect.void,
      };
      const key = ManagedSkillKey.make("review");
      const request = {
        runtime: {
          providerInstanceId: ProviderInstanceId.make("opencode"),
          cwd: "/repo",
          sessionId: "session-1",
        },
        desiredRevision: SkillCatalogRevision.make(2),
        skills: [{ key, packagePath: "/canonical/review" }],
      };
      const local = makeOpenCodeSkillAdapter({
        providerInstanceId: request.runtime.providerInstanceId,
        discoverCandidates: () => Effect.succeed([]),
        materialization,
        fileSystem: fs,
        path,
        external: false,
        customConfigDir: false,
      });
      assert.equal(
        local.evaluateCompatibility(request.skills[0]!, request.runtime).support,
        "supported",
      );
      const plan = yield* local.prepareSession(request);
      assert.deepEqual(plan.payload, {
        kind: "opencode-managed-skills",
        root: path.join(root, ".opencode-config", "skills"),
        configDir: path.join(root, ".opencode-config"),
        skillKeys: ["review"],
      });
      assert.equal(
        yield* fs.readFileString(
          path.join(root, ".opencode-config", "skills", "review", "SKILL.md"),
        ),
        "---\nname: review\ndescription: Review\n---\nReview",
      );
      const external = makeOpenCodeSkillAdapter({
        providerInstanceId: request.runtime.providerInstanceId,
        discoverCandidates: () => Effect.succeed([]),
        materialization,
        fileSystem: fs,
        path,
        external: true,
        customConfigDir: false,
      });
      assert.equal(
        external.evaluateCompatibility(request.skills[0]!, request.runtime).support,
        "unsupported",
      );
      assert.equal(
        external.evaluateCompatibility(request.skills[0]!, request.runtime).reasons[0]?.code,
        "external_skill_delivery_unavailable",
      );
      const custom = makeOpenCodeSkillAdapter({
        providerInstanceId: request.runtime.providerInstanceId,
        discoverCandidates: () => Effect.succeed([]),
        materialization,
        fileSystem: fs,
        path,
        external: false,
        customConfigDir: true,
      });
      assert.equal(
        custom.evaluateCompatibility(request.skills[0]!, request.runtime).support,
        "unsupported",
      );
      assert.equal(
        custom.evaluateCompatibility(request.skills[0]!, request.runtime).reasons[0]?.code,
        "custom_config_directory_conflict",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
