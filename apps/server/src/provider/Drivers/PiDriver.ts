import {
  ProviderDriverKind,
  TextGenerationError,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ProviderSkillAdapterError } from "../../skills/ProviderSkillAdapter.ts";
import { makePiSkillAdapter } from "../../skills/ProviderSkillAdapters.ts";
import { SkillMaterializationService } from "../../skills/SkillMaterializationService.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError, type ProviderAdapterError } from "../Errors.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import {
  PiDriverConfiguration,
  PiManagedRuntime,
  PiManagedRuntimeError,
  type PiManagedRuntimeInstance,
} from "../pi/PiManagedRuntime.ts";
import {
  createProviderVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER = ProviderDriverKind.make("piAgent");

const unavailableDetail = (error: PiManagedRuntimeError) =>
  `Pi managed configuration, host, or durable service is ${error.code}.`;

const unsupportedText = (operation: TextGenerationError["operation"]) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "Pi text generation is unsupported. Managed team operations require durable authorization and accounting.",
    }),
  );

const makeUnsupportedTextGeneration = (): TextGeneration["Service"] => ({
  generateCommitMessage: () => unsupportedText("generateCommitMessage"),
  generatePrContent: () => unsupportedText("generatePrContent"),
  generateBranchName: () => unsupportedText("generateBranchName"),
  generateThreadTitle: () => unsupportedText("generateThreadTitle"),
  generateProjectWorkNarrative: () => unsupportedText("generateProjectWorkNarrative"),
});

/** The injected adapter owns its sessions and stop finalizer; the parent owns authority. */
export function makePiDriver(input: {
  readonly makeAdapter: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly runtime: PiManagedRuntimeInstance;
  }) => Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never, Scope.Scope>;
}): ProviderDriver<PiDriverConfiguration, PiManagedRuntime | SkillMaterializationService> {
  return {
    driverKind: DRIVER,
    metadata: { displayName: "Pi Agent", supportsMultipleInstances: true },
    configSchema: PiDriverConfiguration,
    defaultConfig: () => ({}),
    create: Effect.fn("PiDriver.create")(function* ({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }) {
      // Generic overrides must never reach native auth or the worker's environment.
      if (environment.length > 0) {
        return yield* new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail:
            "Pi does not support provider environment overrides. Select a parent-owned Pi configuration instead.",
        });
      }

      const parent = yield* PiManagedRuntime;
      const materialization = yield* SkillMaterializationService;
      const configuration = Object.freeze({ ...config });
      const toDriverError = (error: PiManagedRuntimeError) =>
        new ProviderDriverError({ driver: DRIVER, instanceId, detail: unavailableDetail(error) });
      const runtime = yield* parent
        .forInstance({ instanceId, enabled, configuration })
        .pipe(Effect.mapError(toDriverError));
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName: displayName ?? "Pi Agent",
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER,
        packageName: null,
      });

      const inspect = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const draft = yield* runtime.inspect.pipe(
          Effect.timeoutOrElse({
            duration: DEFAULT_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new PiManagedRuntimeError({
                  code: "unavailable",
                  detail: "Metadata inspection timed out.",
                }),
              ),
          }),
          Effect.catch((error) =>
            Effect.succeed({
              ...buildServerProvider({
                presentation: { displayName: "Pi Agent" },
                enabled,
                checkedAt,
                models: [],
                probe: {
                  installed: false,
                  version: null,
                  status: "error",
                  auth: { status: "unknown" },
                  message: unavailableDetail(error),
                },
              }),
              availability: "unavailable",
              unavailableReason: unavailableDetail(error),
            } satisfies ServerProviderDraft),
          ),
        );
        return stampIdentity({
          ...draft,
          enabled,
          status: enabled ? draft.status : "disabled",
          checkedAt,
          supportsTextGeneration: false,
          supportsConversationRollback: false,
          requiresNewThreadForModelChange: true,
          setup: { canAuthenticate: false, canInstall: false },
          slashCommands: [],
          versionAdvisory: createProviderVersionAdvisory({
            driver: DRIVER,
            currentVersion: draft.version,
            checkedAt,
            maintenanceCapabilities: maintenance,
          }),
        });
      });

      // Status is a latest-value stream: slow clients cannot retain an unbounded catalog queue.
      const changes = yield* Effect.acquireRelease(
        PubSub.sliding<ServerProvider>({ capacity: 1, replay: 1 }),
        PubSub.shutdown,
      );
      const initial = yield* inspect;
      const current = yield* Ref.make(initial);
      yield* PubSub.publish(changes, initial);
      const refreshLock = yield* Semaphore.make(1);
      const refresh = refreshLock.withPermits(1)(
        Effect.gen(function* () {
          const next = yield* inspect;
          yield* Ref.set(current, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      );
      const snapshot: ServerProviderShape = {
        getSnapshot: Ref.get(current),
        refresh,
        resolveMaintenance: () => Effect.succeed(maintenance),
        streamChanges: Stream.fromPubSub(changes),
        // Managed accounting is parent-owned; ordinary provider limit hints grant no budget.
        applyUsageLimits: () => Effect.void,
      };
      const discoverNativeSkills = (cwd: string) =>
        runtime.discoverNativeSkills(cwd).pipe(Effect.mapError(toDriverError));
      const skillAdapter = makePiSkillAdapter({
        providerInstanceId: instanceId,
        materialization,
        discoverCandidates: discoverNativeSkills,
        authorizeManagedRequest: (request) =>
          runtime.authorizeSkills(request).pipe(
            Effect.map((keys) => new Set(keys)),
            Effect.mapError(
              (error) =>
                new ProviderSkillAdapterError({
                  code: `managed_${error.code}`,
                  detail: unavailableDetail(error),
                }),
            ),
          ),
      });
      const adapter = yield* input.makeAdapter({ instanceId, runtime });
      if (adapter.provider !== DRIVER) {
        return yield* new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "The injected Pi Agent adapter does not match the piAgent driver kind.",
        });
      }
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        discoverNativeSkills,
        skillAdapter,
        adapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
  };
}
