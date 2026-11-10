import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import type { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
} from "@t3tools/provider-core/server/adapterDriver";
import { OmpSettings } from "../settings.ts";
import { makeOmpAdapterV2, OMP_DRIVER } from "./adapter.ts";
export type OmpAdapterV2DriverEnv =
  | ProviderHost
  | IdAllocatorV2
  | McpProviderSessions
  | ChildProcessSpawner.ChildProcessSpawner;
const decodeSettings = Schema.decodeSync(OmpSettings);
export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> = {
  driverKind: OMP_DRIVER,
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input) {
      return yield* makeOmpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(
          input.environment,
          yield* HostProcess.Environment,
        ),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_DRIVER,
              instanceId: input.instanceId,
              detail: "Guarded OMP adapter could not be created",
              cause,
            }),
        ),
      ),
  ),
};

import type { ServerProvider } from "@t3tools/contracts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { defaultProviderContinuationIdentity } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { ProviderHost as Host } from "@t3tools/provider-core/server/ProviderHost";
import { makeOmpTextGeneration } from "./textGeneration.ts";
import { discoverOmpWorkspace, projectOmpDiscovery } from "./status.ts";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import { resolveInstalledOmp } from "./launch.ts";
import { ompUsageReader, type OmpUsageReaderEnv } from "./usage.ts";
export const OmpDriver: ProviderDriver<OmpSettings, OmpAdapterV2DriverEnv, OmpUsageReaderEnv> = {
  usage: ompUsageReader,
  driverKind: OMP_DRIVER,
  metadata: { displayName: "OMP", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("OmpDriver.create")(
    function* (input) {
      const host = yield* Host;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const config = { ...input.config, enabled: input.enabled };
      const environment = yield* mergeProviderInstanceEnvironment(
        input.environment,
        yield* HostProcess.Environment,
      );
      const identity = defaultProviderContinuationIdentity({
        driverKind: OMP_DRIVER,
        instanceId: input.instanceId,
      });
      const base = Effect.fn("OmpDriver.base")(function* () {
        return {
          instanceId: input.instanceId,
          driver: OMP_DRIVER,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.accentColor ? { accentColor: input.accentColor } : {}),
          continuation: { groupKey: identity.continuationKey },
          enabled: config.enabled,
          installed: false,
          version: null,
          status: config.enabled ? "warning" : "disabled",
          auth: { status: "unknown" },
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          models: [],
          slashCommands: [],
          skills: [],
          supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
          supportsConversationRollback: true,
          supportsTextGeneration: true,
          reportsContextWindow: true,
        } satisfies ServerProvider;
      });
      const check = Effect.fn("OmpDriver.check")(function* (cwd: string) {
        const initial = yield* base();
        if (!config.enabled) return initial;
        const installed = yield* Effect.try({
          try: () => {
            resolveInstalledOmp(config.binaryPath, environment);
            return true;
          },
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false));
        return yield* discoverOmpWorkspace(
          config,
          environment,
          cwd,
          host.paths.providerStatusCacheDir,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.match({
            onSuccess: (discovery) => ({
              ...initial,
              ...projectOmpDiscovery(discovery),
              installed: true,
              version: "18.16.0",
              status: discovery.models.length ? ("ready" as const) : ("warning" as const),
              auth: {
                status: discovery.models.length
                  ? ("authenticated" as const)
                  : ("unauthenticated" as const),
              },
              ...(discovery.models.length
                ? {}
                : { message: "OMP has no available credentialed model." }),
            }),
            onFailure: () => ({
              ...initial,
              installed,
              status: "error" as const,
              message:
                "Guarded OMP is unavailable: check the pinned runtime, policy compatibility and native configuration.",
            }),
          }),
        );
      });
      const snapshot = yield* makeManagedServerProvider({
        getSettings: Effect.succeed(config),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () => base(),
        checkProvider: check(host.paths.cwd),
        refreshOnInterval: false,
        resolveMaintenance: () =>
          Effect.succeed({
            provider: OMP_DRIVER,
            packageName: "@oh-my-pi/pi-coding-agent",
            update: null,
          }),
      });
      return {
        instanceId: input.instanceId,
        driverKind: OMP_DRIVER,
        continuationIdentity: identity,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: config.enabled,
        nativeSkillContentAccess: "external" as const,
        snapshot,
        snapshotForCwd: (cwd: string) =>
          check(cwd).pipe(Effect.map((value) => ({ ...value, slashCommandsPending: false }))),
        orchestrationAdapter: yield* OmpAdapterV2Driver.create(input),
        textGeneration: yield* makeOmpTextGeneration(config, environment),
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: OMP_DRIVER,
              instanceId: input.instanceId,
              detail: "OMP provider creation failed",
              cause,
            }),
        ),
      ),
  ),
};
