import { createSourceControlEnvironmentAtoms } from "@t3tools/client-runtime/state/source-control";
import { createSourceControlWorkspaceEnvironmentAtoms } from "@t3tools/client-runtime/state/sourceControlWorkspace";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import type { EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import type { EnvironmentId, ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const sourceControlEnvironment = createSourceControlEnvironmentAtoms(connectionAtomRuntime);
export function createSourceControlWorkspaceWebAdapter<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
  configValueAtom: (environmentId: EnvironmentId) => Atom.Atom<
    | {
        readonly environment: {
          readonly capabilities: Pick<ExecutionEnvironmentCapabilities, "sourceControlWorkspace">;
        };
      }
    | null
    | undefined
  >,
) {
  return createSourceControlWorkspaceEnvironmentAtoms(runtime, {
    capabilities: (registry, environmentId) =>
      registry.get(configValueAtom(environmentId))?.environment.capabilities,
  });
}

export const sourceControlWorkspaceEnvironment = createSourceControlWorkspaceWebAdapter(
  connectionAtomRuntime,
  serverEnvironment.configValueAtom,
);
