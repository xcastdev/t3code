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
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as Materialization from "./SkillMaterializationService.ts";
import { hashSkillPackage } from "./SkillPackage.ts";
import {
  ProviderSkillAdapterError,
  type ProviderSkillPrepareRequest,
} from "./ProviderSkillAdapter.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

import type { SkillMaterializationServiceShape } from "./SkillMaterializationService.ts";
import {
  makeClaudeSkillAdapter,
  makeCodexSkillAdapter,
  makePiSkillAdapter,
  type PiManagedSkillAuthorization,
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

const piInstanceId = ProviderInstanceId.make("pi-team");
const piKey = ManagedSkillKey.make("review");
const PiTestLayer = Materialization.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-skill-adapter-" })),
  Layer.provideMerge(NodeServices.layer),
);

const writePiManifest = Effect.fn("ProviderSkillAdapters.test.writePiManifest")(function* (
  source: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hash = yield* hashSkillPackage(source);
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    schemaVersion: 1,
    kind: "managed-skill",
    id: "pi-review",
    key: "review",
    scope: "global",
    revision: { revision: 1, hash },
    origin: "created",
    ownership: "t3",
  });
  yield* fs.writeFileString(path.join(source, "t3-skill.json"), encoded);
});

const piFixture = Effect.fn("ProviderSkillAdapters.test.piFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.makeTempDirectoryScoped({ prefix: "pi-canonical-skill-" });
  yield* fs.writeFileString(
    path.join(source, "SKILL.md"),
    "---\nname: review\ndescription: Review\n---\nReview the assigned change.",
  );
  yield* writePiManifest(source);
  const request: ProviderSkillPrepareRequest = {
    runtime: {
      providerInstanceId: piInstanceId,
      sessionId: path.basename(source),
      threadId: "thread:pi/run-1",
      cwd: source,
    },
    desiredRevision: SkillCatalogRevision.make(2),
    skills: [{ key: piKey, packagePath: source }],
  };
  return {
    fs,
    path,
    source,
    request,
    materialization: yield* Materialization.SkillMaterializationService,
    config: yield* ServerConfig.ServerConfig,
  };
});

describe("Pi managed skill delivery", () => {
  it.layer(PiTestLayer)("enforces managed authorization", (it) => {
    it.effect("copies only selected managed packages even when native discovery collides", () =>
      Effect.gen(function* () {
        const fixture = yield* piFixture();
        yield* fixture.fs.makeDirectory(fixture.path.join(fixture.source, "references"));
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.source, "references", "guide.md"),
          "Retained managed reference.",
        );
        yield* writePiManifest(fixture.source);
        const adapter = makePiSkillAdapter({
          providerInstanceId: piInstanceId,
          materialization: fixture.materialization,
          authorizeManagedRequest: () => Effect.succeed(new Set([piKey])),
          discoverCandidates: () =>
            Effect.succeed([
              {
                nativeIdentity: "project-review",
                nativePath: "/rogue/project/review",
                key: "review",
                displayName: "Native review",
                source: "project",
                scopeSummary: "project",
              },
              {
                nativeIdentity: "global-rogue",
                nativePath: "/rogue/global/rogue",
                key: "rogue",
                displayName: "Rogue",
                source: "global",
                scopeSummary: "global",
              },
            ]),
        });
        const discovered = yield* adapter.discoverNative(fixture.request.runtime.cwd);
        assert.deepEqual(
          discovered.observations.map((item) => item.key),
          ["review", "rogue"],
        );
        const plan = yield* adapter.prepareSession(fixture.request);
        const expectedRoot = fixture.path.join(
          fixture.config.skillRuntimeDir,
          fixture.request.runtime.sessionId,
          "2",
          "pi-team",
        );
        assert.deepEqual(plan.payload, {
          kind: "pi-managed-skills",
          root: expectedRoot,
          skills: [{ key: "review", path: fixture.path.join(expectedRoot, "review", "SKILL.md") }],
        });
        assert.deepEqual(plan.skillKeys, [piKey]);
        assert.equal(plan.applicationMode, "new_session_required");
        assert.equal(adapter.applyLive, undefined);
        assert.equal(
          yield* fixture.fs.readFileString(
            fixture.path.join(expectedRoot, "review", "references", "guide.md"),
          ),
          "Retained managed reference.",
        );
        assert.isFalse(yield* fixture.fs.exists(fixture.path.join(expectedRoot, "rogue")));
        assert.include(
          yield* fixture.fs.readFileString(fixture.path.join(expectedRoot, ".t3-owned.json")),
          '"providerInstanceId":"pi-team"',
        );
        assert.equal(
          adapter.evaluateCompatibility(fixture.request.skills[0]!, fixture.request.runtime)
            .support,
          "supported_with_limitations",
        );
        assert.equal(
          adapter.evaluateCompatibility(fixture.request.skills[0]!, fixture.request.runtime)
            .reasons[0]?.code,
          "managed-team-runs-only",
        );
        yield* adapter.disposeSession(fixture.request.runtime);
        assert.isFalse(yield* fixture.fs.exists(expectedRoot));
        assert.include(
          yield* fixture.fs.readFileString(fixture.path.join(fixture.source, "SKILL.md")),
          "Review the assigned change.",
        );
      }),
    );

    it.effect(
      "materializes an explicit empty selection without falling back to native skills",
      () =>
        Effect.gen(function* () {
          const fixture = yield* piFixture();
          const adapter = makePiSkillAdapter({
            providerInstanceId: piInstanceId,
            materialization: fixture.materialization,
            discoverCandidates: () => Effect.fail({ _tag: "NativeMustNotLoad" }),
            authorizeManagedRequest: () => Effect.succeed(new Set([piKey])),
          });
          const plan = yield* adapter.prepareSession({ ...fixture.request, skills: [] });
          const root = fixture.path.join(
            fixture.config.skillRuntimeDir,
            fixture.request.runtime.sessionId,
            "2",
            "pi-team",
          );
          assert.deepEqual(plan.payload, { kind: "pi-managed-skills", root, skills: [] });
          assert.deepEqual(plan.skillKeys, []);
          assert.deepEqual(yield* fixture.fs.readDirectory(root), [".t3-owned.json"]);
          yield* adapter.disposeSession(fixture.request.runtime);
        }),
    );

    it.effect("cleans the copied generation when post-copy authorization is interrupted", () =>
      Effect.gen(function* () {
        const fixture = yield* piFixture();
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let copied = false;
        const materialization: SkillMaterializationServiceShape = {
          ...fixture.materialization,
          materialize: (input) =>
            fixture.materialization.materialize(input).pipe(
              Effect.map((result) => {
                copied = true;
                return result;
              }),
            ),
        };
        const authorizeManagedRequest: PiManagedSkillAuthorization = () =>
          copied
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as(new Set([piKey])),
              )
            : Effect.succeed(new Set([piKey]));
        const adapter = makePiSkillAdapter({
          providerInstanceId: piInstanceId,
          materialization,
          discoverCandidates: () => Effect.succeed([]),
          authorizeManagedRequest,
        });
        const fiber = yield* adapter.prepareSession(fixture.request).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const root = fixture.path.join(
          fixture.config.skillRuntimeDir,
          fixture.request.runtime.sessionId,
          "2",
          "pi-team",
        );
        assert.isTrue(yield* fixture.fs.exists(root));
        yield* Fiber.interrupt(fiber);
        assert.isFalse(yield* fixture.fs.exists(root));
        assert.include(
          yield* fixture.fs.readFileString(fixture.path.join(fixture.source, "SKILL.md")),
          "Review the assigned change.",
        );
      }),
    );

    it.effect(
      "rejects invalid identities, revisions and skill keys without creating session state",
      () =>
        Effect.gen(function* () {
          const fixture = yield* piFixture();
          const adapter = makePiSkillAdapter({
            providerInstanceId: piInstanceId,
            materialization: fixture.materialization,
            discoverCandidates: () => Effect.succeed([]),
            authorizeManagedRequest: () => Effect.succeed(new Set([piKey])),
          });
          const request = fixture.request;
          const invalidRequests: ReadonlyArray<ProviderSkillPrepareRequest> = [
            {
              ...request,
              runtime: {
                ...request.runtime,
                providerInstanceId: ProviderInstanceId.make("other-pi"),
              },
            },
            {
              ...request,
              runtime: { ...request.runtime, providerInstanceId: "../pi" as ProviderInstanceId },
            },
            { ...request, runtime: { ...request.runtime, sessionId: "../escape" } },
            { ...request, runtime: { ...request.runtime, sessionId: "" } },
            {
              ...request,
              runtime: {
                providerInstanceId: piInstanceId,
                sessionId: request.runtime.sessionId,
                cwd: request.runtime.cwd,
              },
            },
            { ...request, runtime: { ...request.runtime, threadId: "" } },
            { ...request, desiredRevision: -1 as SkillCatalogRevision },
            { ...request, desiredRevision: 1.5 as SkillCatalogRevision },
            {
              ...request,
              skills: [{ key: "../escape" as ManagedSkillKey, packagePath: fixture.source }],
            },
            { ...request, skills: [request.skills[0]!, request.skills[0]!] },
          ];
          for (const invalid of invalidRequests) {
            const result = yield* adapter.prepareSession(invalid).pipe(Effect.result);
            assert.equal(result._tag, "Failure");
          }
          assert.isFalse(
            yield* fixture.fs.exists(
              fixture.path.join(fixture.config.skillRuntimeDir, fixture.request.runtime.sessionId),
            ),
          );
          const mismatch = yield* adapter
            .disposeSession({
              ...request.runtime,
              providerInstanceId: ProviderInstanceId.make("other-pi"),
            })
            .pipe(Effect.result);
          assert.equal(mismatch._tag, "Failure");
        }),
    );

    it.effect("fails closed without a callback or when a frozen selection excludes the key", () =>
      Effect.gen(function* () {
        const fixture = yield* piFixture();
        const options = {
          providerInstanceId: piInstanceId,
          materialization: fixture.materialization,
          discoverCandidates: () => Effect.succeed([]),
        };
        // @ts-expect-error The callback is deliberately absent to prove the runtime boundary too.
        const missing = makePiSkillAdapter(options);
        const missingResult = yield* missing.prepareSession(fixture.request).pipe(Effect.result);
        assert.equal(missingResult._tag, "Failure");
        if (missingResult._tag === "Failure")
          assert.equal(missingResult.failure.code, "managed_authorization_required");
        for (const allowed of [
          new Set<ManagedSkillKey>(),
          new Set([ManagedSkillKey.make("deploy")]),
          new Set(["../escape" as ManagedSkillKey]),
        ]) {
          const adapter = makePiSkillAdapter({
            ...options,
            authorizeManagedRequest: () => Effect.succeed(allowed),
          });
          const result = yield* adapter.prepareSession(fixture.request).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
        }
        assert.isFalse(
          yield* fixture.fs.exists(
            fixture.path.join(fixture.config.skillRuntimeDir, fixture.request.runtime.sessionId),
          ),
        );
      }),
    );

    it.effect("keeps native discovery failures advisory for an authorized explicit selection", () =>
      Effect.gen(function* () {
        const fixture = yield* piFixture();
        const adapter = makePiSkillAdapter({
          providerInstanceId: piInstanceId,
          materialization: fixture.materialization,
          authorizeManagedRequest: () => Effect.succeed(new Set([piKey])),
          discoverCandidates: () => Effect.fail({ _tag: "NativeUnavailable" }),
        });
        assert.equal(
          (yield* adapter.discoverNative(fixture.request.runtime.cwd).pipe(Effect.result))._tag,
          "Failure",
        );
        const plan = yield* adapter.prepareSession(fixture.request);
        assert.deepEqual(plan.skillKeys, [piKey]);
        yield* adapter.disposeSession(fixture.request.runtime);
      }),
    );

    it.effect("freezes the authorized selection across caller mutations", () =>
      Effect.gen(function* () {
        const fixture = yield* piFixture();
        const skills = [...fixture.request.skills];
        const request = { ...fixture.request, runtime: { ...fixture.request.runtime }, skills };
        const authorizeManagedRequest: PiManagedSkillAuthorization = () =>
          Effect.sync(() => {
            skills.push({
              key: ManagedSkillKey.make("rogue"),
              packagePath: "/rogue/project/skill",
            });
            request.runtime.sessionId = "another-session";
            return new Set([piKey]);
          });
        const originalSession = request.runtime.sessionId;
        const adapter = makePiSkillAdapter({
          providerInstanceId: piInstanceId,
          materialization: fixture.materialization,
          discoverCandidates: () => Effect.succeed([]),
          authorizeManagedRequest,
        });
        const plan = yield* adapter.prepareSession(request);
        assert.deepEqual(plan.skillKeys, [piKey]);
        const root = fixture.path.join(
          fixture.config.skillRuntimeDir,
          originalSession,
          "2",
          "pi-team",
        );
        assert.isTrue(yield* fixture.fs.exists(fixture.path.join(root, "review", "SKILL.md")));
        assert.isFalse(
          yield* fixture.fs.exists(
            fixture.path.join(fixture.config.skillRuntimeDir, "another-session"),
          ),
        );
        yield* adapter.disposeSession({ ...request.runtime, sessionId: originalSession });
      }),
    );

    it.effect(
      "cleans only the copied generation when authority or selection is revoked during copying",
      () =>
        Effect.gen(function* () {
          const fixture = yield* piFixture();
          const identity = {
            sessionId: fixture.request.runtime.sessionId,
            providerInstanceId: piInstanceId,
          };
          const earlier = yield* fixture.materialization.materialize({
            ...identity,
            desiredRevision: 1,
            packages: [],
          });
          const otherInstance = yield* fixture.materialization.materialize({
            ...identity,
            providerInstanceId: ProviderInstanceId.make("other-pi"),
            desiredRevision: 2,
            packages: [],
          });
          const otherSession = yield* fixture.materialization.materialize({
            ...identity,
            sessionId: "unrelated-session",
            desiredRevision: 2,
            packages: [],
          });
          for (const revokedSelection of [false, true]) {
            let copied = false;
            const materialization: SkillMaterializationServiceShape = {
              ...fixture.materialization,
              materialize: (input) =>
                fixture.materialization.materialize(input).pipe(
                  Effect.map((result) => {
                    copied = true;
                    return result;
                  }),
                ),
            };
            const authorizeManagedRequest: PiManagedSkillAuthorization = () =>
              copied
                ? revokedSelection
                  ? Effect.succeed(new Set())
                  : Effect.fail(
                      new ProviderSkillAdapterError({
                        code: "managed_run_revoked",
                        detail: "Generation expired during copy.",
                      }),
                    )
                : Effect.succeed(new Set([piKey]));
            const adapter = makePiSkillAdapter({
              providerInstanceId: piInstanceId,
              materialization,
              discoverCandidates: () => Effect.succeed([]),
              authorizeManagedRequest,
            });
            const result = yield* adapter.prepareSession(fixture.request).pipe(Effect.result);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure")
              assert.equal(
                result.failure.code,
                revokedSelection ? "managed_skill_not_allowed" : "managed_run_revoked",
              );
            assert.isFalse(
              yield* fixture.fs.exists(
                fixture.path.join(
                  fixture.config.skillRuntimeDir,
                  identity.sessionId,
                  "2",
                  "pi-team",
                ),
              ),
            );
            for (const retained of [earlier.root, otherInstance.root, otherSession.root])
              assert.isTrue(yield* fixture.fs.exists(retained));
          }
          assert.deepEqual(
            (yield* fixture.fs.readDirectory(fixture.config.skillRuntimeDir)).filter((name) =>
              name.startsWith(".pending-"),
            ),
            [],
          );
          assert.include(
            yield* fixture.fs.readFileString(fixture.path.join(fixture.source, "SKILL.md")),
            "Review the assigned change.",
          );
        }),
    );

    it.effect(
      "rejects extra, missing and escaped materializer paths and disposes only its own generation",
      () =>
        Effect.gen(function* () {
          const fixture = yield* piFixture();
          const earlier = yield* fixture.materialization.materialize({
            sessionId: fixture.request.runtime.sessionId,
            providerInstanceId: piInstanceId,
            desiredRevision: 1,
            packages: [],
          });
          for (const corruption of ["extra", "missing", "escape", "relative-root"]) {
            const materialization: SkillMaterializationServiceShape = {
              ...fixture.materialization,
              materialize: (input) =>
                fixture.materialization.materialize(input).pipe(
                  Effect.map((result) => ({
                    root: corruption === "relative-root" ? "relative/root" : result.root,
                    skillPaths:
                      corruption === "extra"
                        ? new Map([
                            ...result.skillPaths,
                            [ManagedSkillKey.make("rogue"), "/rogue/native"],
                          ])
                        : corruption === "missing"
                          ? new Map()
                          : corruption === "escape"
                            ? new Map([[piKey, fixture.source]])
                            : result.skillPaths,
                  })),
                ),
            };
            const adapter = makePiSkillAdapter({
              providerInstanceId: piInstanceId,
              materialization,
              discoverCandidates: () => Effect.succeed([]),
              authorizeManagedRequest: () => Effect.succeed(new Set([piKey])),
            });
            const result = yield* adapter.prepareSession(fixture.request).pipe(Effect.result);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure")
              assert.equal(result.failure.code, "invalid_materialization");
            assert.isFalse(
              yield* fixture.fs.exists(
                fixture.path.join(
                  fixture.config.skillRuntimeDir,
                  fixture.request.runtime.sessionId,
                  "2",
                  "pi-team",
                ),
              ),
            );
            assert.isTrue(yield* fixture.fs.exists(earlier.root));
          }
          assert.include(
            yield* fixture.fs.readFileString(fixture.path.join(fixture.source, "SKILL.md")),
            "Review the assigned change.",
          );
        }),
    );

    it.effect(
      "preserves foreign destination ownership when materialization refuses a collision",
      () =>
        Effect.gen(function* () {
          const fixture = yield* piFixture();
          const root = fixture.path.join(
            fixture.config.skillRuntimeDir,
            fixture.request.runtime.sessionId,
            "2",
            "pi-team",
          );
          yield* fixture.fs.makeDirectory(root, { recursive: true });
          yield* fixture.fs.writeFileString(fixture.path.join(root, ".t3-owned.json"), "{}");
          yield* fixture.fs.writeFileString(
            fixture.path.join(root, "foreign.txt"),
            "Foreign destination.",
          );
          const adapter = makePiSkillAdapter({
            providerInstanceId: piInstanceId,
            materialization: fixture.materialization,
            discoverCandidates: () => Effect.succeed([]),
            authorizeManagedRequest: () => Effect.succeed(new Set([piKey])),
          });
          const result = yield* adapter.prepareSession(fixture.request).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(result.failure.code, "materialization_failed");
          assert.equal(
            yield* fixture.fs.readFileString(fixture.path.join(root, "foreign.txt")),
            "Foreign destination.",
          );
          yield* adapter.disposeSession(fixture.request.runtime);
          assert.isTrue(yield* fixture.fs.exists(root));
          assert.deepEqual(
            (yield* fixture.fs.readDirectory(fixture.config.skillRuntimeDir)).filter((name) =>
              name.startsWith(".pending-"),
            ),
            [],
          );
        }),
    );

    it.effect("rejects source and runtime symlinks without touching their targets", () =>
      Effect.gen(function* () {
        const fixture = yield* piFixture();
        const adapter = makePiSkillAdapter({
          providerInstanceId: piInstanceId,
          materialization: fixture.materialization,
          discoverCandidates: () => Effect.succeed([]),
          authorizeManagedRequest: () => Effect.succeed(new Set([piKey])),
        });
        const links = yield* fixture.fs.makeTempDirectoryScoped({ prefix: "pi-skill-links-" });
        const sourceLink = fixture.path.join(links, "source");
        yield* fixture.fs.symlink(fixture.source, sourceLink);
        const sourceResult = yield* adapter
          .prepareSession({ ...fixture.request, skills: [{ key: piKey, packagePath: sourceLink }] })
          .pipe(Effect.result);
        assert.equal(sourceResult._tag, "Failure");
        const external = fixture.path.join(links, "external");
        yield* fixture.fs.makeDirectory(external);
        yield* fixture.fs.writeFileString(
          fixture.path.join(external, "retained.txt"),
          "Keep the external directory.",
        );
        yield* fixture.fs.symlink(
          fixture.path.join(external, "retained.txt"),
          fixture.path.join(fixture.source, "escaped.txt"),
        );
        const assetResult = yield* adapter.prepareSession(fixture.request).pipe(Effect.result);
        assert.equal(assetResult._tag, "Failure");
        yield* fixture.fs.remove(fixture.path.join(fixture.source, "escaped.txt"));
        const sessionLink = fixture.path.join(fixture.config.skillRuntimeDir, "linked-session");
        yield* fixture.fs.symlink(external, sessionLink);
        const runtimeResult = yield* adapter
          .prepareSession({
            ...fixture.request,
            runtime: { ...fixture.request.runtime, sessionId: "linked-session" },
          })
          .pipe(Effect.result);
        assert.equal(runtimeResult._tag, "Failure");
        assert.deepEqual(yield* fixture.fs.readDirectory(external), ["retained.txt"]);
        assert.include(
          yield* fixture.fs.readFileString(fixture.path.join(fixture.source, "SKILL.md")),
          "Review the assigned change.",
        );
        assert.deepEqual(
          (yield* fixture.fs.readDirectory(fixture.config.skillRuntimeDir)).filter((name) =>
            name.startsWith(".pending-"),
          ),
          [],
        );
      }),
    );

    it.effect(
      "fresh disposal removes owned revisions while retaining other instances and sessions",
      () =>
        Effect.gen(function* () {
          const fixture = yield* piFixture();
          const options = {
            providerInstanceId: piInstanceId,
            materialization: fixture.materialization,
            discoverCandidates: () => Effect.succeed([]),
            authorizeManagedRequest: () => Effect.succeed(new Set([piKey])),
          };
          const adapter = makePiSkillAdapter(options);
          for (const revision of [2, 3])
            yield* adapter.prepareSession({
              ...fixture.request,
              desiredRevision: SkillCatalogRevision.make(revision),
            });
          const other = yield* fixture.materialization.materialize({
            sessionId: fixture.request.runtime.sessionId,
            providerInstanceId: ProviderInstanceId.make("other-pi"),
            desiredRevision: 2,
            packages: [],
          });
          const separate = yield* fixture.materialization.materialize({
            sessionId: "separate-session",
            providerInstanceId: piInstanceId,
            desiredRevision: 2,
            packages: [],
          });
          const fresh = makePiSkillAdapter({
            ...options,
            materialization: yield* Materialization.make,
          });
          const mismatch = yield* fresh
            .disposeSession({
              ...fixture.request.runtime,
              providerInstanceId: ProviderInstanceId.make("other-pi"),
            })
            .pipe(Effect.result);
          assert.equal(mismatch._tag, "Failure");
          for (const revision of [2, 3])
            assert.isTrue(
              yield* fixture.fs.exists(
                fixture.path.join(
                  fixture.config.skillRuntimeDir,
                  fixture.request.runtime.sessionId,
                  String(revision),
                  "pi-team",
                ),
              ),
            );
          yield* fresh.disposeSession(fixture.request.runtime);
          yield* fresh.disposeSession(fixture.request.runtime);
          for (const revision of [2, 3])
            assert.isFalse(
              yield* fixture.fs.exists(
                fixture.path.join(
                  fixture.config.skillRuntimeDir,
                  fixture.request.runtime.sessionId,
                  String(revision),
                  "pi-team",
                ),
              ),
            );
          assert.isTrue(yield* fixture.fs.exists(other.root));
          assert.isTrue(yield* fixture.fs.exists(separate.root));
          assert.include(
            yield* fixture.fs.readFileString(fixture.path.join(fixture.source, "SKILL.md")),
            "Review the assigned change.",
          );
        }),
    );

    it.effect("rejects revoked authority before creating any runtime package", () =>
      Effect.gen(function* () {
        const fixture = yield* piFixture();
        const options = {
          providerInstanceId: piInstanceId,
          discoverCandidates: () => Effect.succeed([]),
          materialization: fixture.materialization,
          authorizeManagedRequest: () =>
            Effect.fail(
              new ProviderSkillAdapterError({
                code: "managed_run_revoked",
                detail: "Run is no longer current.",
              }),
            ),
        };
        const result = yield* makePiSkillAdapter(options)
          .prepareSession(fixture.request)
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.isFalse(
          yield* fixture.fs.exists(
            fixture.path.join(fixture.config.skillRuntimeDir, fixture.request.runtime.sessionId),
          ),
        );
        assert.include(
          yield* fixture.fs.readFileString(fixture.path.join(fixture.source, "SKILL.md")),
          "Review the assigned change.",
        );
      }),
    );
  });
});
