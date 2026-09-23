import {
  WS_METHODS,
  type EnvironmentId,
  type ManagedTextResourceCatalogListInput,
  type ManagedTextResourceChanged,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export function makeManagedTextResourceInvalidationSignals() {
  const revisions = Atom.family((_key: string) => Atom.make("").pipe(Atom.keepAlive));
  const signal = (environmentId: EnvironmentId, scope: string, scopeId = "") =>
    revisions(`${environmentId}\0${scope}\0${scopeId}`);
  const refresh = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: ManagedTextResourceCatalogListInput;
  }) => {
    const { environmentId, input } = target;
    const watched = [signal(environmentId, "environment")];
    if (input.projectId) watched.push(signal(environmentId, "project", input.projectId));
    if (input.threadId) {
      watched.push(signal(environmentId, "thread", input.threadId));
      watched.push(signal(environmentId, "thread-project", input.threadId));
    }
    return Atom.make((get) => watched.map((value) => get(value)).join(":"));
  };
  const publish = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: ManagedTextResourceCatalogListInput;
    },
    change: ManagedTextResourceChanged,
    registry: AtomRegistry.AtomRegistry,
  ) => {
    registry.set(
      signal(
        target.environmentId,
        change.scope,
        change.scope === "environment" ? "" : change.scopeId,
      ),
      String(change.catalogRevision),
    );
    if (change.scope === "project" && target.input.threadId) {
      registry.set(
        signal(target.environmentId, "thread-project", target.input.threadId),
        String(change.catalogRevision),
      );
    }
  };
  return { refresh, publish };
}

export function createManagedTextResourcesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const invalidation = makeManagedTextResourceInvalidationSignals();
  const command = <
    M extends
      | typeof WS_METHODS.managedTextResourcesEnvironmentCreate
      | typeof WS_METHODS.managedTextResourcesEnvironmentUpdate
      | typeof WS_METHODS.managedTextResourcesEnvironmentDelete
      | typeof WS_METHODS.managedTextResourcesEnvironmentSetEnabled
      | typeof WS_METHODS.managedTextResourcesProjectSetOverride
      | typeof WS_METHODS.managedTextResourcesProjectSetDisabled
      | typeof WS_METHODS.managedTextResourcesProjectDeleteState
      | typeof WS_METHODS.managedTextResourcesThreadSetEnabled
      | typeof WS_METHODS.managedTextResourcesThreadReset,
  >(
    label: string,
    tag: M,
  ) => createEnvironmentRpcCommand(runtime, { label, tag });

  return {
    catalog: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:managed-text-resources:catalog",
      tag: WS_METHODS.managedTextResourcesCatalogList,
      refreshTrigger: (target) => invalidation.refresh(target),
    }),
    content: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:managed-text-resources:content",
      tag: WS_METHODS.managedTextResourcesContentGet,
      refreshTrigger: (target) => invalidation.refresh(target),
    }),
    environmentCreate: command(
      "environment-command:managed-text-resources:environment-create",
      WS_METHODS.managedTextResourcesEnvironmentCreate,
    ),
    environmentUpdate: command(
      "environment-command:managed-text-resources:environment-update",
      WS_METHODS.managedTextResourcesEnvironmentUpdate,
    ),
    environmentDelete: command(
      "environment-command:managed-text-resources:environment-delete",
      WS_METHODS.managedTextResourcesEnvironmentDelete,
    ),
    environmentSetEnabled: command(
      "environment-command:managed-text-resources:environment-set-enabled",
      WS_METHODS.managedTextResourcesEnvironmentSetEnabled,
    ),
    projectSetOverride: command(
      "environment-command:managed-text-resources:project-override",
      WS_METHODS.managedTextResourcesProjectSetOverride,
    ),
    projectSetDisabled: command(
      "environment-command:managed-text-resources:project-disable",
      WS_METHODS.managedTextResourcesProjectSetDisabled,
    ),
    projectDeleteState: command(
      "environment-command:managed-text-resources:project-reset",
      WS_METHODS.managedTextResourcesProjectDeleteState,
    ),
    threadSetEnabled: command(
      "environment-command:managed-text-resources:thread-enable",
      WS_METHODS.managedTextResourcesThreadSetEnabled,
    ),
    threadReset: command(
      "environment-command:managed-text-resources:thread-reset",
      WS_METHODS.managedTextResourcesThreadReset,
    ),
    changes: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:managed-text-resources:changes",
      idleTtlMs: 5 * 60_000,
      subscribe: (
        input: EnvironmentRpcInput<typeof WS_METHODS.managedTextResourcesCatalogSubscribe>,
      ) => subscribe(WS_METHODS.managedTextResourcesCatalogSubscribe, input),
      onValue: (target, value, registry) =>
        Effect.sync(() => {
          invalidation.publish(target, value, registry);
        }),
    }),
  };
}
