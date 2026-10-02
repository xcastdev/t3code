import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ManagedSkillKey,
  ProjectWorkBriefing,
  ProviderDriverKind,
  ProviderInstanceId,
  SkillCatalogRevision,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { ProviderSkillPrepareRequest } from "../../skills/ProviderSkillAdapter.ts";
import * as Materialization from "../../skills/SkillMaterializationService.ts";
import { hashSkillPackage } from "../../skills/SkillPackage.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderAdapterValidationError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderDriverCreateInput } from "../ProviderDriver.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  PiManagedRuntime,
  PiManagedRuntimeError,
  type PiDriverConfiguration,
  type PiManagedRuntimeInstance,
} from "../pi/PiManagedRuntime.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { makePiDriver } from "./PiDriver.ts";

// Existing provider settings and the separately implemented adapter use this canonical kind.
const DRIVER = ProviderDriverKind.make("piAgent");
const INSTANCE = ProviderInstanceId.make("pi-a");
const SECRET = "test-secret-must-not-leak";

// Explicit private-port and adapter fakes test driver mapping, never SQL or process authority.
const adapter: ProviderAdapterShape<ProviderAdapterError> = {
  provider: DRIVER,
  capabilities: {
    sessionModelSwitch: "unsupported",
    supportsConversationRollback: false,
    remoteHttpMcp: "unsupported",
    projectMcpProxy: "unsupported",
    sessionMcpCatalog: "unsupported",
    promptlessTurnContinuation: false,
    activeTurnSteer: false,
  },
  startSession: () => unsupportedAdapter(),
  sendTurn: () => unsupportedAdapter(),
  interruptTurn: () => unsupportedAdapter(),
  respondToRequest: () => unsupportedAdapter(),
  respondToUserInput: () => unsupportedAdapter(),
  stopSession: () => Effect.void,
  listSessions: () => Effect.succeed([]),
  hasSession: () => Effect.succeed(false),
  readThread: () => unsupportedAdapter(),
  rollbackThread: () => unsupportedAdapter(),
  stopAll: () => Effect.void,
  streamEvents: Stream.empty,
};

const unsupportedAdapter = () =>
  Effect.fail(
    new ProviderAdapterValidationError({
      provider: DRIVER,
      operation: "test fake",
      issue: "This driver test does not run sessions.",
    }),
  );

const draft = () =>
  buildServerProvider({
    presentation: { displayName: "Parent Pi metadata" },
    enabled: true,
    checkedAt: "2026-10-01T00:00:00.000Z",
    models: [
      {
        slug: "parent-selected",
        isCustom: false,
        name: "Parent selected",
        capabilities: { optionDescriptors: [] },
      },
    ],
    probe: {
      installed: true,
      version: "0.99.1",
      status: "ready",
      auth: { status: "authenticated" },
    },
  });

const runtimeFake = (
  overrides: Partial<PiManagedRuntimeInstance> = {},
): PiManagedRuntimeInstance => ({
  inspect: Effect.sync(draft),
  prepareOperation: () =>
    Effect.fail(
      new PiManagedRuntimeError({
        code: "unavailable",
        detail: "No producer in driver mapping fake.",
      }),
    ),
  readSession: () =>
    Effect.fail(
      new PiManagedRuntimeError({
        code: "unavailable",
        detail: "No reader in driver mapping fake.",
      }),
    ),
  readThread: () =>
    Effect.fail(
      new PiManagedRuntimeError({
        code: "unavailable",
        detail: "No reader in driver mapping fake.",
      }),
    ),
  requestStop: () => Effect.void,
  stopAll: Effect.void,
  authorizeSkills: (request) => Effect.succeed(request.skills.map((skill) => skill.key)),
  discoverNativeSkills: () => Effect.succeed([]),
  ...overrides,
});

const noMaterialization = Materialization.SkillMaterializationService.of({
  materialize: () => Effect.die("This case must not materialize skills."),
  dispose: () => Effect.void,
  disposeSession: () => Effect.void,
});

const createInput = (
  overrides: Partial<ProviderDriverCreateInput<PiDriverConfiguration>> = {},
): ProviderDriverCreateInput<PiDriverConfiguration> => ({
  instanceId: INSTANCE,
  displayName: "Pi A",
  accentColor: "#123456",
  enabled: true,
  environment: [],
  config: {},
  ...overrides,
});

const driver = makePiDriver({ makeAdapter: () => Effect.succeed(adapter) });
const decodeConfig = Schema.decodeUnknownSync(driver.configSchema);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeBriefing = Schema.decodeUnknownEffect(ProjectWorkBriefing);

it.effect(
  "uses canonical piAgent identity for the injected adapter, snapshots and continuation",
  () =>
    Effect.gen(function* () {
      expect(driver.driverKind).toBe("piAgent");
      expect(driver.metadata.displayName).toBe("Pi Agent");
      const instance = yield* driver.create(createInput({ displayName: undefined })).pipe(
        Effect.provideService(PiManagedRuntime, {
          forInstance: () => Effect.succeed(runtimeFake()),
        }),
        Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
      );
      expect(instance.driverKind).toBe("piAgent");
      expect(instance.adapter.provider).toBe("piAgent");
      expect(instance.adapter.provider).toBe(instance.driverKind);
      expect(instance.continuationIdentity).toEqual({
        driverKind: "piAgent",
        continuationKey: "piAgent:instance:pi-a",
      });
      for (const snapshot of [
        yield* instance.snapshot.getSnapshot,
        yield* instance.snapshot.refresh,
      ])
        expect(snapshot).toMatchObject({
          driver: "piAgent",
          displayName: "Pi Agent",
          continuation: { groupKey: "piAgent:instance:pi-a" },
        });
    }).pipe(Effect.scoped),
);

it.effect("rejects an injected adapter using the obsolete pi kind", () =>
  Effect.gen(function* () {
    let disposed = false;
    const mismatched = makePiDriver({
      makeAdapter: () =>
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            disposed = true;
          }),
        ).pipe(Effect.as({ ...adapter, provider: ProviderDriverKind.make("pi") })),
    });
    const rejected = yield* mismatched.create(createInput()).pipe(
      Effect.provideService(PiManagedRuntime, {
        forInstance: () => Effect.succeed(runtimeFake()),
      }),
      Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
      Effect.scoped,
      Effect.result,
    );
    expect(rejected._tag).toBe("Failure");
    expect(disposed).toBe(true);
    if (rejected._tag === "Failure")
      expect(rejected.failure).toMatchObject({
        _tag: "ProviderDriverError",
        driver: "piAgent",
        instanceId: INSTANCE,
        detail: "The injected Pi Agent adapter does not match the piAgent driver kind.",
      });
  }).pipe(Effect.scoped),
);

it("keeps the default config empty and decodes only the parent directory selection", () => {
  expect(driver.defaultConfig()).toEqual({});
  expect(decodeConfig({})).toEqual({});
  expect(decodeConfig({ agentDirectory: "/trusted/pi" })).toEqual({
    agentDirectory: "/trusted/pi",
  });
  for (const payload of [
    null,
    [],
    "pi",
    { agentDirectory: 7 },
    { agentDirectory: " " },
    { agentDirectory: " /pi" },
    { agentDirectory: "/pi " },
    { agentDirectory: "/pi\0other" },
    { agentDirectory: "x".repeat(4097) },
  ])
    expect(() => decodeConfig(payload)).toThrow();
  for (const field of [
    "apiKey",
    "credential",
    "endpoint",
    "model",
    "homePath",
    "role",
    "approved",
    "tools",
    "environment",
  ])
    expect(() => decodeConfig({ agentDirectory: "/trusted/pi", [field]: SECRET })).toThrow();
});

it.effect("rejects generic environment overrides before the parent or adapter acquires state", () =>
  Effect.gen(function* () {
    const denied = yield* driver
      .create(
        createInput({ environment: [{ name: "PI_API_KEY", value: SECRET, sensitive: true }] }),
      )
      .pipe(
        Effect.provideService(PiManagedRuntime, {
          forInstance: () => Effect.die("Must reject before runtime acquisition."),
        }),
        Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
        Effect.flip,
        Effect.scoped,
      );
    expect(denied._tag).toBe("ProviderDriverError");
    expect(denied.detail).toContain("environment");
    expect(yield* encodeManifest(denied)).not.toContain(SECRET);
    expect(denied.cause).toBeUndefined();
  }),
);

it.effect.each(["unavailable", "denied", "conflict", "uncertain"] as const)(
  "maps parent acquisition %s to a safe driver error",
  (code) =>
    Effect.gen(function* () {
      const denied = yield* driver.create(createInput()).pipe(
        Effect.provideService(PiManagedRuntime, {
          forInstance: () => Effect.fail(new PiManagedRuntimeError({ code, detail: SECRET })),
        }),
        Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
        Effect.flip,
        Effect.scoped,
      );
      expect(denied._tag).toBe("ProviderDriverError");
      expect(denied.detail).toContain(code);
      expect(denied.cause).toBeUndefined();
      expect(yield* encodeManifest(denied)).not.toContain(SECRET);
    }),
);

it.effect(
  "captures instance identity, enablement and configuration without choosing a model or credential",
  () =>
    Effect.gen(function* () {
      const configuration = { agentDirectory: "/trusted/pi" };
      const input = createInput({ config: configuration });
      const captured: Array<Parameters<PiManagedRuntime["Service"]["forInstance"]>[0]> = [];
      const instance = yield* driver.create(input).pipe(
        Effect.provideService(PiManagedRuntime, {
          forInstance: (value) =>
            Effect.sync(() => {
              captured.push(value);
              return runtimeFake();
            }),
        }),
        Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
      );
      const initial = yield* instance.snapshot.getSnapshot;
      configuration.agentDirectory = "/changed-after-create";
      expect(captured).toEqual([
        { instanceId: INSTANCE, enabled: true, configuration: { agentDirectory: "/trusted/pi" } },
      ]);
      expect(initial).toMatchObject({
        instanceId: INSTANCE,
        driver: "piAgent",
        displayName: "Pi A",
        accentColor: "#123456",
        enabled: true,
        installed: true,
        version: "0.99.1",
        supportsTextGeneration: false,
        supportsConversationRollback: false,
        setup: { canAuthenticate: false, canInstall: false },
      });
      expect(initial.models).toEqual(draft().models);
      expect(initial.continuation?.groupKey).toBe(instance.continuationIdentity.continuationKey);
      expect(instance.continuationIdentity).toEqual({
        driverKind: "piAgent",
        continuationKey: "piAgent:instance:pi-a",
      });
      expect(instance.auth).toBeUndefined();
      expect(yield* instance.snapshot.resolveMaintenance({ fresh: true })).toEqual({
        provider: "piAgent",
        packageName: null,
        update: null,
      });
    }).pipe(Effect.scoped),
);

it.effect.each(["Missing configuration", "Unsupported host", "Missing durable service"])(
  "reports inspection failure as honest unavailable metadata: %s",
  (reason) =>
    Effect.gen(function* () {
      const instance = yield* driver.create(createInput()).pipe(
        Effect.provideService(PiManagedRuntime, {
          forInstance: () =>
            Effect.succeed(
              runtimeFake({
                inspect: Effect.fail(
                  new PiManagedRuntimeError({
                    code: "unavailable",
                    detail: `${reason}: ${SECRET}`,
                  }),
                ),
              }),
            ),
        }),
        Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
      );
      for (const snapshot of [
        yield* instance.snapshot.getSnapshot,
        yield* instance.snapshot.refresh,
      ]) {
        expect(snapshot).toMatchObject({
          instanceId: INSTANCE,
          availability: "unavailable",
          status: "error",
          installed: false,
          auth: { status: "unknown" },
          models: [],
          supportsTextGeneration: false,
        });
        expect(snapshot.unavailableReason).toContain("unavailable");
        expect(yield* encodeManifest(snapshot)).not.toContain(SECRET);
      }
    }).pipe(Effect.scoped),
);

it.effect("does not turn a parent unavailable snapshot into an available provider", () =>
  Effect.gen(function* () {
    const instance = yield* driver.create(createInput()).pipe(
      Effect.provideService(PiManagedRuntime, {
        forInstance: () =>
          Effect.succeed(
            runtimeFake({
              inspect: Effect.succeed({
                ...draft(),
                availability: "unavailable",
                unavailableReason: "Parent durable producer is absent.",
                status: "error",
              }),
            }),
          ),
      }),
      Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
    );
    expect(yield* instance.snapshot.refresh).toMatchObject({
      availability: "unavailable",
      unavailableReason: "Parent durable producer is absent.",
      status: "error",
    });
  }).pipe(Effect.scoped),
);

it.effect("bounds metadata inspection without starting an operation", () =>
  Effect.gen(function* () {
    const inspecting = yield* Deferred.make<void>();
    const fiber = yield* driver.create(createInput()).pipe(
      Effect.provideService(PiManagedRuntime, {
        forInstance: () =>
          Effect.succeed(
            runtimeFake({
              inspect: Deferred.succeed(inspecting, undefined).pipe(Effect.andThen(Effect.never)),
              prepareOperation: () =>
                Effect.die("Metadata inspection must not start a managed operation."),
            }),
          ),
      }),
      Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
      Effect.forkChild,
    );
    yield* Deferred.await(inspecting);
    yield* TestClock.adjust("4 seconds");
    const instance = yield* Fiber.join(fiber);
    expect(yield* instance.snapshot.getSnapshot).toMatchObject({
      availability: "unavailable",
      status: "error",
      models: [],
      auth: { status: "unknown" },
    });
  }).pipe(Effect.scoped),
);

it.effect("retains only current snapshot metadata for a slow or late subscriber", () =>
  Effect.gen(function* () {
    let inspected = 0;
    const instance = yield* driver.create(createInput()).pipe(
      Effect.provideService(PiManagedRuntime, {
        forInstance: () =>
          Effect.succeed(
            runtimeFake({
              inspect: Effect.sync(() => ({ ...draft(), message: `inspect-${++inspected}` })),
            }),
          ),
      }),
      Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
    );
    const pull = yield* Stream.toPull(instance.snapshot.streamChanges);
    expect(yield* pull).toEqual([yield* instance.snapshot.getSnapshot]);
    yield* instance.snapshot.refresh;
    yield* instance.snapshot.refresh;
    const latest = yield* instance.snapshot.refresh;
    expect(yield* pull).toEqual([latest]);
    const late = yield* Stream.toPull(instance.snapshot.streamChanges);
    expect(yield* late).toEqual([latest]);
    expect(inspected).toBe(4);
  }).pipe(Effect.scoped),
);

it.effect(
  "keeps disabled status and limited capabilities even when inspection advertises readiness",
  () =>
    Effect.gen(function* () {
      const instance = yield* driver.create(createInput({ enabled: false })).pipe(
        Effect.provideService(PiManagedRuntime, {
          forInstance: ({ enabled }) => {
            expect(enabled).toBe(false);
            return Effect.succeed(
              runtimeFake({
                inspect: Effect.succeed({
                  ...draft(),
                  supportsTextGeneration: true,
                  supportsConversationRollback: true,
                  setup: { canAuthenticate: true, canInstall: true },
                  slashCommands: [{ name: "compact", description: "not enabled" }],
                }),
              }),
            );
          },
        }),
        Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
      );
      expect(yield* instance.snapshot.refresh).toMatchObject({
        enabled: false,
        status: "disabled",
        supportsTextGeneration: false,
        supportsConversationRollback: false,
        setup: { canAuthenticate: false, canInstall: false },
        slashCommands: [],
      });
      expect(instance.adapter.capabilities.sessionModelSwitch).toBe("unsupported");
      expect(instance.adapter.compaction).toBeUndefined();
    }).pipe(Effect.scoped),
);

it.effect("keeps refresh streams and scoped teardown independent across two instances", () =>
  Effect.gen(function* () {
    const stopped: Array<string> = [];
    const reads = new Map<string, number>();
    const runtime = PiManagedRuntime.of({
      forInstance: ({ instanceId }) =>
        Effect.succeed(
          runtimeFake({
            inspect: Effect.sync(() => {
              const count = (reads.get(instanceId) ?? 0) + 1;
              reads.set(instanceId, count);
              return { ...draft(), message: `${instanceId}:${count}` };
            }),
            stopAll: Effect.sync(() => {
              stopped.push(instanceId);
            }),
          }),
        ),
    });
    const scopeA = yield* Scope.make();
    const scopeB = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scopeB, Exit.void));
    yield* Effect.addFinalizer(() => Scope.close(scopeA, Exit.void));
    const scopedDriver = makePiDriver({
      makeAdapter: ({ runtime }) =>
        Effect.addFinalizer(() => runtime.stopAll.pipe(Effect.orDie)).pipe(Effect.as(adapter)),
    });
    const create = (instanceId: ProviderInstanceId, scope: Scope.Scope) =>
      scopedDriver
        .create(createInput({ instanceId }))
        .pipe(
          Effect.provideService(PiManagedRuntime, runtime),
          Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
          Effect.provideService(Scope.Scope, scope),
        );
    const a = yield* create(INSTANCE, scopeA);
    const bId = ProviderInstanceId.make("pi-b");
    const b = yield* create(bId, scopeB);
    const initialB = yield* b.snapshot.getSnapshot;
    const stream = yield* Stream.toPull(a.snapshot.streamChanges);
    const refreshed = yield* a.snapshot.refresh;
    expect(yield* stream).toEqual([refreshed]);
    expect(yield* b.snapshot.getSnapshot).toEqual(initialB);
    expect(a.continuationIdentity).not.toEqual(b.continuationIdentity);
    yield* Scope.close(scopeA, Exit.void);
    expect(stopped).toEqual(["pi-a"]);
    expect((yield* b.snapshot.refresh).message).toBe("pi-b:2");
    yield* Scope.close(scopeB, Exit.void);
    expect(stopped).toEqual(["pi-a", "pi-b"]);
  }).pipe(Effect.scoped),
);

it.effect("maps discovery errors without exposing private error details", () =>
  Effect.gen(function* () {
    const instance = yield* driver.create(createInput()).pipe(
      Effect.provideService(PiManagedRuntime, {
        forInstance: () =>
          Effect.succeed(
            runtimeFake({
              discoverNativeSkills: () =>
                Effect.fail(new PiManagedRuntimeError({ code: "denied", detail: SECRET })),
            }),
          ),
      }),
      Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
    );
    const discover = instance.discoverNativeSkills;
    const skillAdapter = instance.skillAdapter;
    expect(discover).toBeDefined();
    expect(skillAdapter).toBeDefined();
    if (!discover || !skillAdapter)
      return yield* Effect.die("Pi must expose authorized discovery and managed skills.");
    const direct = yield* Effect.flip(discover("/workspace"));
    const managed = yield* Effect.flip(skillAdapter.discoverNative("/workspace"));
    expect(direct._tag).toBe("ProviderDriverError");
    expect(yield* encodeManifest([direct, managed])).not.toContain(SECRET);
  }).pipe(Effect.scoped),
);

const modelSelection = { instanceId: INSTANCE, model: "ignored-model" };
const textInputs = {
  generateCommitMessage: {
    cwd: "/workspace",
    branch: null,
    stagedSummary: "summary",
    stagedPatch: "patch",
    modelSelection,
  },
  generatePrContent: {
    cwd: "/workspace",
    baseBranch: "main",
    headBranch: "work",
    commitSummary: "summary",
    diffSummary: "summary",
    diffPatch: "patch",
    modelSelection,
  },
  generateBranchName: { cwd: "/workspace", message: "branch", modelSelection },
  generateThreadTitle: { cwd: "/workspace", message: "title", modelSelection },
} satisfies {
  [
    K in keyof Pick<
      TextGeneration["Service"],
      "generateCommitMessage" | "generatePrContent" | "generateBranchName" | "generateThreadTitle"
    >
  ]: Parameters<TextGeneration["Service"][K]>[0];
};

it.effect(
  "rejects every text generation route with its typed operation, without a parent operation",
  () =>
    Effect.gen(function* () {
      const instance = yield* driver.create(createInput()).pipe(
        Effect.provideService(PiManagedRuntime, {
          forInstance: () =>
            Effect.succeed(
              runtimeFake({
                prepareOperation: () =>
                  Effect.die("Text generation must not dispatch a managed operation."),
              }),
            ),
        }),
        Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
      );
      const errors = [
        yield* Effect.flip(
          instance.textGeneration.generateCommitMessage(textInputs.generateCommitMessage),
        ),
        yield* Effect.flip(instance.textGeneration.generatePrContent(textInputs.generatePrContent)),
        yield* Effect.flip(
          instance.textGeneration.generateBranchName(textInputs.generateBranchName),
        ),
        yield* Effect.flip(
          instance.textGeneration.generateThreadTitle(textInputs.generateThreadTitle),
        ),
      ];
      expect(errors.map((error) => error.operation)).toEqual(Object.keys(textInputs));
      for (const error of errors) expect(error).toMatchObject({ _tag: "TextGenerationError" });
      const narrative = instance.textGeneration.generateProjectWorkNarrative;
      expect(narrative).toBeDefined();
      if (!narrative) return yield* Effect.die("Pi must explicitly reject narrative generation.");
      const briefing = yield* decodeBriefing({
        projectId: "project-pi",
        kind: "compact",
        generatedAt: "2026-10-01T00:00:00.000Z",
        sourceRevision: 1,
        text: "Mapping fixture",
        includedTaskIds: [],
        includedKnowledgeIds: [],
        omittedReasons: [],
      });
      expect(
        yield* Effect.flip(
          narrative({ cwd: "/workspace", briefing, citations: [], modelSelection }),
        ),
      ).toMatchObject({ _tag: "TextGenerationError", operation: "generateProjectWorkNarrative" });
    }).pipe(Effect.scoped),
);

const skillLayer = Materialization.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "t3-pi-driver-skills-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(skillLayer)("PiDriver managed skill mapping", (it) => {
  it.effect.each([false, true])(
    "rechecks current authority after materialization; revoked=%s",
    (revoke) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const source = yield* fs.makeTempDirectoryScoped({ prefix: "pi-driver-skill-source-" });
        yield* fs.writeFileString(
          path.join(source, "SKILL.md"),
          "---\nname: safe-skill\ndescription: Driver mapping fixture\n---\nUse scoped tools.\n",
        );
        const key = ManagedSkillKey.make("safe-skill");
        const hash = yield* hashSkillPackage(source);
        yield* fs.writeFileString(
          path.join(source, "t3-skill.json"),
          yield* encodeManifest({
            schemaVersion: 1,
            kind: "managed-skill",
            id: "pi-driver-test",
            key,
            scope: "global",
            revision: { revision: 1, hash },
            origin: "created",
            ownership: "t3",
          }),
        );
        let checks = 0;
        const requests: Array<ProviderSkillPrepareRequest> = [];
        const instance = yield* driver.create(createInput()).pipe(
          Effect.provideService(PiManagedRuntime, {
            forInstance: () =>
              Effect.succeed(
                runtimeFake({
                  authorizeSkills: (request) =>
                    Effect.suspend(() => {
                      requests.push(request);
                      checks++;
                      return revoke && checks === 2
                        ? Effect.fail(new PiManagedRuntimeError({ code: "denied", detail: SECRET }))
                        : Effect.succeed([key]);
                    }),
                }),
              ),
          }),
        );
        const skillAdapter = instance.skillAdapter;
        if (!skillAdapter) return yield* Effect.die("Pi must expose managed skill delivery.");
        const request: ProviderSkillPrepareRequest = {
          runtime: {
            providerInstanceId: INSTANCE,
            cwd: "/workspace",
            sessionId: "pi-session",
            threadId: "pi-thread",
          },
          desiredRevision: SkillCatalogRevision.make(1),
          skills: [{ key, packagePath: source }],
        };
        const result = yield* Effect.result(skillAdapter.prepareSession(request));
        expect(checks).toBe(2);
        expect(requests[0]).toEqual(requests[1]);
        if (result._tag === "Failure") {
          expect(revoke).toBe(true);
          expect(result.failure._tag).toBe("ProviderSkillAdapterError");
          expect(result.failure.code).toBe("managed_denied");
          expect(yield* encodeManifest(result.failure)).not.toContain(SECRET);
        } else {
          expect(revoke).toBe(false);
          expect(result.success).toMatchObject({
            providerInstanceId: INSTANCE,
            applicationMode: "new_session_required",
            skillKeys: [key],
          });
          yield* skillAdapter.disposeSession(request.runtime);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("denies skill copying before acquisition when current authority is absent", () =>
    Effect.gen(function* () {
      const instance = yield* driver.create(createInput()).pipe(
        Effect.provideService(PiManagedRuntime, {
          forInstance: () =>
            Effect.succeed(
              runtimeFake({
                authorizeSkills: () =>
                  Effect.fail(new PiManagedRuntimeError({ code: "unavailable", detail: SECRET })),
              }),
            ),
        }),
        Effect.provideService(Materialization.SkillMaterializationService, noMaterialization),
      );
      const skillAdapter = instance.skillAdapter;
      if (!skillAdapter) return yield* Effect.die("Pi must expose managed skills.");
      const error = yield* Effect.flip(
        skillAdapter.prepareSession({
          runtime: {
            providerInstanceId: INSTANCE,
            cwd: "/workspace",
            sessionId: "pi-session",
            threadId: "pi-thread",
          },
          desiredRevision: SkillCatalogRevision.make(1),
          skills: [{ key: ManagedSkillKey.make("safe-skill"), packagePath: "/missing-source" }],
        }),
      );
      expect(error.code).toBe("managed_unavailable");
      expect(yield* encodeManifest(error)).not.toContain(SECRET);
    }).pipe(Effect.scoped),
  );
});
