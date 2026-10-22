import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createExternalNotificationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:external-notifications:update-settings",
      tag: WS_METHODS.serverUpdateSettings,
    }),
    test: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:external-notifications:test",
      tag: WS_METHODS.serverTestExternalNotification,
    }),
  };
}
