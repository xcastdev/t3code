// @effect-diagnostics nodeBuiltinImport:off -- Fresh ephemeral credentials never leave the fixture manifest.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Cause from "effect/Cause";
import * as HttpClient from "effect/http/HttpClient";
import * as OwnerDeadline from "../orchestration-v2/OwnerDeadlineControl.ts";
import * as AssistantRepository from "../assistants/AssistantRepository.ts";
import * as RoutineRepository from "../assistants/AssistantRoutineRepository.ts";
import * as AssistantBus from "../assistants/AssistantEventBus.ts";
import { layerControlledRoutineIsolation } from "./controlledRoutineIsolation.ts";
import { layerControlledRoutines } from "./controlledRoutines.ts";
import {
  layerControlledNotificationPorts,
  layerControlledNotifications,
  layerControlledNotificationRuntime,
} from "./controlledNotifications.ts";
import * as Cleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WorktreeSetup from "../project/WorktreeSetupTracker.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as OrchestrationHttp from "../orchestration-v2/http.ts";
import { layerControlledTerminal } from "./upgradeControlledTerminal.ts";
import { assertControlledUpgradeDomainEmpty } from "./controlledUpgradeDomainBaseline.ts";
import * as AssistantMemoryRuntime from "../assistants/AssistantMemoryRuntime.ts";
import { AssistantMemory } from "../assistants/AssistantMemory.ts";
import { layerControlledBusiness } from "./upgradeControlledBusiness.ts";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as NetAddress from "effect/net/NetAddress";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServer from "effect/http/HttpServer";
import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import { layerFixtureFilesystem } from "./upgradeFixtureFilesystem.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Analytics from "../telemetry/AnalyticsService.ts";
import * as ServerStartup from "../serverRuntimeStartup.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as RemoteOpenTargets from "../environment/RemoteOpenTargets.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as Keybindings from "../keybindings.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as OrchestrationEvents from "../persistence/OrchestrationEventStore.ts";
import {
  makeClientApplicationRoutes,
  layerClientWebSocketRoutes,
  serveClientApplication,
  layerApplicationHttpServer,
  HTTP_ROUTER_CONFIG,
} from "../server.ts";
import {
  assertDisposablePath,
  assertPreparedUpgradeSnapshot,
  type UpgradeSnapshot,
} from "./prepareUpgradeSnapshot.ts";
import { upgradeValidationBaseRuntime } from "./upgradeValidationRuntime.ts";
import { layerControlledFixtureBoundaries } from "./controlledFixtureBoundaries.ts";
import { buildPairingUrl } from "../startupAccess.ts";
import type { ControlledUpgradeApplication } from "./controlledUpgradeFixture.ts";

class ControlledClientHttpApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.auth,
  EnvironmentHttpApi.groups.metadata,
  EnvironmentHttpApi.groups.orchestration,
) {}

export const layerControlledFreshSecrets = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const secrets = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        secrets.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        if (secrets.has(name)) throw new Error("Fixture secret already exists");
        secrets.set(name, value);
      }),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = secrets.get(name) ?? NodeCrypto.randomBytes(bytes);
        secrets.set(name, value);
        return value;
      }),
    remove: (name) =>
      Effect.sync(() => {
        secrets.delete(name);
      }),
  });
});

export function controlledUpgradeApplicationLayer(
  snapshot: UpgradeSnapshot,
  options: {
    readonly staticDir?: string;
    readonly onMemoryProcessed?: (operationKey: string) => Effect.Effect<void>;
  } = {},
) {
  assertPreparedUpgradeSnapshot(snapshot);
  const environmentId = EnvironmentId.make(`fixture-${NodeCrypto.randomUUID()}`);
  const environment = Layer.mergeAll(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.succeed({
        environmentId,
        label: "Controlled upgrade fixture",
        platform: { os: "linux" as const, arch: "x64" as const },
        serverVersion: "0.0.0",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: false },
      }),
    }),
  );
  const persistence = upgradeValidationBaseRuntime(snapshot).pipe(Layer.provide(environment));
  const checked = Layer.effectDiscard(assertControlledUpgradeDomainEmpty()).pipe(
    Layer.provideMerge(persistence),
  );
  const isolated = layerControlledRoutineIsolation.pipe(Layer.provideMerge(checked));
  const assistantRepository = AssistantRepository.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(isolated, environment)),
  );
  const base = Layer.mergeAll(RoutineRepository.layer, AssistantBus.layer).pipe(
    Layer.provideMerge(assistantRepository),
  );
  const config = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const staticDir =
        options.staticDir === undefined
          ? undefined
          : assertDisposablePath(snapshot.fixtureRoot, options.staticDir);
      return { ...config, host: "127.0.0.1", port: 0, staticDir, noBrowser: true };
    }),
  ).pipe(Layer.provide(base));
  // Auth gets its own new database: copied pairing grants and sessions never authenticate here.
  const auth = EnvironmentAuth.layer.pipe(
    Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provide(layerControlledFreshSecrets),
    Layer.provide(environment),
    Layer.provide(config),
    Layer.provide(NodeServices.layer),
  );
  const localReadServices = Layer.mergeAll(
    Layer.mock(Analytics.AnalyticsService)({
      record: () => Effect.void,
      recordOwners: () => Effect.void,
    }),
    Layer.succeed(ServerStartup.ServerRuntimeStartup, {
      awaitCommandReady: Effect.void,
      markHttpListening: Effect.void,
      enqueueCommand: (effect) => effect,
    }),
    ServerLifecycleEvents.layer,
    Layer.mock(ExternalLauncher.ExternalLauncher)({
      resolveAvailableEditors: () => Effect.succeed([]),
      resolveFileManagerRevealKind: () => Effect.succeed(undefined),
    }),
    Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({ resolveTargets: () => Effect.succeed([]) }),
    Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
    Layer.mock(ManagedFolders.ManagedProjectFolders)({
      scratchRoot: Effect.succeedNone,
      namedProjectsRoot: NodePath.join(snapshot.fixtureRoot, "projects"),
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(UsageLimitSources.UsageLimitSources)({
      current: Effect.succeed([]),
      streamChanges: Stream.make([]),
    }),
    Layer.mock(Keybindings.Keybindings)({
      loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
      subscribeChanges: Effect.succeed(Stream.never),
    }),
    // No copied theme directories are watched; an empty fixture set is replayed to subscribers.
    Layer.succeed(EnvironmentTheme.EnvironmentThemeService, {
      current: Effect.succeed([]),
      streamChanges: Stream.concat(Stream.make([]), Stream.never),
    }),
    Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
    Layer.mock(ServerBrowser.ServerBrowser)({}),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() =>
        Effect.die(new Error("External HTTP is disabled in the controlled fixture")),
      ),
    ),
    Layer.mock(OwnerDeadline.OwnerDeadlineControl)({}),
    Layer.mock(Cleanup.ResourceCleanupService)({}),
    WorkspacePaths.layer,
    WorktreeSetup.layer,
    OrchestrationEvents.layer,
  ).pipe(Layer.provide(base));
  const safeServices = Layer.mergeAll(
    layerControlledFixtureBoundaries,
    localReadServices,
    environment,
    layerControlledFreshSecrets,
    base,
    auth,
    config,
    layerControlledNotificationPorts.pipe(Layer.provide(layerControlledFreshSecrets)),
  );
  const terminals = layerControlledTerminal(snapshot).pipe(Layer.provideMerge(safeServices));
  const business = layerControlledBusiness(snapshot).pipe(Layer.provideMerge(terminals));
  const routines = layerControlledRoutines.pipe(Layer.provideMerge(business));
  const notifications = layerControlledNotifications.pipe(Layer.provideMerge(routines));
  const notificationRuntime = layerControlledNotificationRuntime.pipe(
    Layer.provideMerge(notifications),
  );
  const worker = EffectWorker.layer.pipe(Layer.provideMerge(notificationRuntime));
  const observeMemory = options.onMemoryProcessed;
  const observedMemory =
    observeMemory === undefined
      ? worker
      : Layer.effect(
          AssistantMemory,
          Effect.gen(function* () {
            const actual = yield* AssistantMemory;
            return AssistantMemory.of({
              ...actual,
              process: (key) => actual.process(key).pipe(Effect.tap(() => observeMemory(key))),
            });
          }),
        ).pipe(Layer.provideMerge(worker));
  const memoryWorker = AssistantMemoryRuntime.workerLayer.pipe(Layer.provideMerge(observedMemory));
  const consuming = Layer.effectDiscard(EffectWorker.runDaemon.pipe(Effect.forkScoped)).pipe(
    Layer.provideMerge(memoryWorker),
  );
  const api = HttpApiBuilder.layer(ControlledClientHttpApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
    Layer.provide(OrchestrationHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
  );
  const diagnostics = HttpRouter.middleware(
    (effect) =>
      effect.pipe(
        Effect.tapCause((cause) => {
          const missing = Cause.pretty(cause).match(/Service not found: [A-Za-z0-9_/@.-]+/g);
          return missing
            ? Effect.logError("Controlled fixture is missing services", missing)
            : Effect.void;
        }),
      ),
    { global: true },
  );
  const staticFilesystem = layerFixtureFilesystem(
    snapshot,
    "controlled-fixture",
    options.staticDir === undefined ? {} : { ownedStateRoots: [options.staticDir] },
  ).pipe(Layer.provide(NodeServices.layer));
  const staticFilesystemMiddleware = Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return HttpRouter.middleware<{ provides: FileSystem.FileSystem }>()((effect) =>
        Effect.provideService(effect, FileSystem.FileSystem, fs),
      ).layer;
    }),
  ).pipe(Layer.provide(staticFilesystem));
  const staticRoutes = ServerHttp.layerStaticAndDevRoute.pipe(
    Layer.provide(staticFilesystemMiddleware),
    Layer.provide(staticFilesystem),
  );
  const serving = serveClientApplication(
    makeClientApplicationRoutes(api, staticRoutes, layerClientWebSocketRoutes).pipe(
      Layer.provide(diagnostics),
    ),
    { disableLogger: true, routerConfig: HTTP_ROUTER_CONFIG },
  ).pipe(
    ServerHttp.withUntracedRequests,
    Layer.provideMerge(consuming),
    Layer.provideMerge(layerApplicationHttpServer.pipe(Layer.provide(config))),
    Layer.provideMerge(NodeServices.layer),
  );
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const config = yield* ServerConfig.ServerConfig;
      const environment = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
      // Controlled startup has no cwd auto-bootstrap or copied recovery phase to await.
      yield* lifecycle.publish({
        version: 1,
        type: "welcome",
        payload: {
          environment,
          cwd: config.cwd,
          projectName: "Controlled fixture",
          bootstrapStatus: "complete",
          bootstrapProjectCreated: false,
          bootstrapThreadCreated: false,
        },
      });
      yield* lifecycle.publish({
        version: 1,
        type: "ready",
        payload: { environment, at: DateTime.formatIso(yield* DateTime.now) },
      });
    }),
  ).pipe(Layer.provideMerge(serving));
}

export async function buildControlledUpgradeApplication(
  snapshot: UpgradeSnapshot,
  options: {
    readonly staticDir?: string;
  } = {},
): Promise<ControlledUpgradeApplication> {
  const runtime = ManagedRuntime.make(controlledUpgradeApplicationLayer(snapshot, options));
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (
          !NetAddress.isInetAddressV4(server.address) ||
          NetAddress.formatIp(server.address.address) !== "127.0.0.1"
        )
          throw new Error("Controlled fixture did not bind loopback");
        const origin = `http://127.0.0.1:${server.address.port}`;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const credential = yield* auth.issuePairingCredential({ scopes: AuthStandardClientScopes });
        return {
          origin,
          pairingUrl: buildPairingUrl(origin, credential.credential),
          close: () => runtime.dispose(),
          issuePairingUrl: () =>
            runtime.runPromise(
              auth
                .issuePairingCredential({ scopes: AuthStandardClientScopes })
                .pipe(Effect.map((issued) => buildPairingUrl(origin, issued.credential))),
            ),
        };
      }),
    );
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
