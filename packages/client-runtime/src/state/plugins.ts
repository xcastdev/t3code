import {
  WS_METHODS,
  type EnvironmentId,
  type PluginSubscribeInput,
  type PluginSubscriptionEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { followStreamInEnvironment } from "./environmentStreams.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  /**
   * Delivers every event of one panel subscription in order; atoms would keep only the last
   * value of a chunk. A snapshot after a reconnect is preceded by `resync`, as the panel expects.
   * It stops after `closed` or a failure, so a dead subscription never revives on reconnect.
   * The returned stop is idempotent.
   */
  const events = (
    registry: AtomRegistry.AtomRegistry,
    target: { readonly environmentId: EnvironmentId; readonly input: PluginSubscribeInput },
    onEvent: (event: PluginSubscriptionEvent) => void,
    onFailure: (error: unknown) => void,
  ): (() => void) => {
    let previous: PluginSubscriptionEvent["type"] | null = null;
    const deliver = (event: PluginSubscriptionEvent) => {
      if (event.type === "snapshot" && previous !== null && previous !== "resync") {
        onEvent({ type: "resync" });
      }
      previous = event.type;
      onEvent(event);
    };
    const atom = runtime.atom(
      followStreamInEnvironment(
        target.environmentId,
        subscribe(WS_METHODS.pluginsSubscribe, target.input),
      ).pipe(
        Stream.takeUntil((event) => event.type === "closed"),
        Stream.runForEach((event) => Effect.sync(() => deliver(event))),
      ),
    );
    let stopped = false;
    let unsubscribe: (() => void) | null = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
    };
    unsubscribe = registry.subscribe(
      atom,
      (result) => {
        if (stopped || result._tag === "Initial" || result.waiting) return;
        if (result._tag === "Failure") onFailure(Cause.squash(result.cause));
        stop();
      },
      { immediate: true },
    );
    if (stopped) unsubscribe();
    return stop;
  };

  return {
    events,
    /** Installed plugins with live backend status. */
    registry: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:registry",
      tag: WS_METHODS.pluginsSubscribeRegistry,
    }),
    /** A panel's backend topic; the panel host keys it by panel and topic. */
    subscription: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:subscription",
      tag: WS_METHODS.pluginsSubscribe,
      idleTtlMs: 0,
    }),
    install: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:install",
      tag: WS_METHODS.pluginsInstall,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:update",
      tag: WS_METHODS.pluginsUpdate,
    }),
    uninstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:uninstall",
      tag: WS_METHODS.pluginsUninstall,
    }),
    deleteData: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:delete-data",
      tag: WS_METHODS.pluginsDeleteData,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:set-enabled",
      tag: WS_METHODS.pluginsSetEnabled,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:start",
      tag: WS_METHODS.pluginsStart,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:stop",
      tag: WS_METHODS.pluginsStop,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:restart",
      tag: WS_METHODS.pluginsRestart,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:configure",
      tag: WS_METHODS.pluginsConfigure,
    }),
    readConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:read-config",
      tag: WS_METHODS.pluginsReadConfig,
    }),
    logs: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:logs",
      tag: WS_METHODS.pluginsLogs,
    }),
    query: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:query",
      tag: WS_METHODS.pluginsQuery,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:mutate",
      tag: WS_METHODS.pluginsMutate,
    }),
    resolveReference: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:resolve-reference",
      tag: WS_METHODS.pluginsResolveReference,
    }),
  };
}
