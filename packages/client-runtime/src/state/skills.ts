import {
  WS_METHODS,
  type EnvironmentId,
  type SkillCatalogChanged,
  type SkillCatalogListInput,
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

type SkillQueryTag =
  | typeof WS_METHODS.skillsCatalogList
  | typeof WS_METHODS.skillsContentGet
  | typeof WS_METHODS.skillsHistoryList
  | typeof WS_METHODS.skillsNativeContentGet
  | typeof WS_METHODS.skillsApplicationGet
  | typeof WS_METHODS.skillsDeploymentList;

/** Scoped signals are shared by real query atoms and deduplicate overlapping subscriptions. */
export function makeSkillInvalidationSignals() {
  const revisions = Atom.family((_key: string) => Atom.make("").pipe(Atom.keepAlive));
  const signal = (environmentId: EnvironmentId, scope: string, scopeId = "") =>
    revisions(`${environmentId}\0${scope}\0${scopeId}`);
  const refresh = (
    tag: SkillQueryTag,
    target: { readonly environmentId: EnvironmentId; readonly input: object },
  ) => {
    const input = target.input;
    const projectId =
      "projectId" in input && typeof input.projectId === "string" ? input.projectId : undefined;
    const threadId =
      "threadId" in input && typeof input.threadId === "string" ? input.threadId : undefined;
    const providerId =
      "providerInstanceId" in input && typeof input.providerInstanceId === "string"
        ? input.providerInstanceId
        : undefined;
    const watched: Atom.Atom<string>[] = [];
    const watch = (scope: string, scopeId?: string) =>
      watched.push(signal(target.environmentId, scope, scopeId));
    if (
      tag === WS_METHODS.skillsCatalogList ||
      tag === WS_METHODS.skillsContentGet ||
      tag === WS_METHODS.skillsHistoryList ||
      tag === WS_METHODS.skillsDeploymentList
    )
      watch("global");
    if (
      tag === WS_METHODS.skillsCatalogList ||
      tag === WS_METHODS.skillsContentGet ||
      tag === WS_METHODS.skillsDeploymentList
    ) {
      if (projectId) watch("project", projectId);
      if (threadId) watch("thread-project", threadId);
    }
    if (tag === WS_METHODS.skillsCatalogList || tag === WS_METHODS.skillsApplicationGet) {
      if (threadId) watch("session", threadId);
      else if (tag === WS_METHODS.skillsApplicationGet) watch("sessions");
      watch(providerId ? "provider" : "providers", providerId);
    }
    if (tag === WS_METHODS.skillsNativeContentGet || tag === WS_METHODS.skillsDeploymentList)
      watch("providers");
    return Atom.make((get) => watched.map((value) => get(value)).join(":"));
  };
  const publish = (
    target: { readonly environmentId: EnvironmentId; readonly input: SkillCatalogListInput },
    change: SkillCatalogChanged,
    registry: AtomRegistry.AtomRegistry,
  ) => {
    const update = (scope: string, scopeId?: string) =>
      registry.set(
        signal(target.environmentId, scope, scopeId),
        `${change.catalogRevision}:${change.eventId ?? ""}`,
      );
    update(change.scope, change.scope === "global" ? undefined : change.scopeId);
    if (change.scope === "provider") update("providers");
    if (change.scope === "session") update("sessions");
    // The server has already checked this thread's authoritative project before
    // delivering a project notification to its scoped subscription.
    if (change.scope === "project" && target.input.threadId)
      update("thread-project", target.input.threadId);
  };
  return { refresh, publish };
}

export function createSkillsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const invalidation = makeSkillInvalidationSignals();
  const query = <
    M extends
      | typeof WS_METHODS.skillsCatalogList
      | typeof WS_METHODS.skillsContentGet
      | typeof WS_METHODS.skillsHistoryList
      | typeof WS_METHODS.skillsNativeContentGet
      | typeof WS_METHODS.skillsApplicationGet
      | typeof WS_METHODS.skillsDeploymentList,
  >(
    label: string,
    tag: M,
  ) =>
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label,
      tag,
      refreshTrigger: (target) => invalidation.refresh(tag, target),
    });
  const command = <
    M extends
      | typeof WS_METHODS.skillsGlobalCreate
      | typeof WS_METHODS.skillsGlobalUpdate
      | typeof WS_METHODS.skillsGlobalDelete
      | typeof WS_METHODS.skillsGlobalRename
      | typeof WS_METHODS.skillsGlobalRollback
      | typeof WS_METHODS.skillsProjectSetOverride
      | typeof WS_METHODS.skillsProjectSetDisabled
      | typeof WS_METHODS.skillsProjectDeleteState
      | typeof WS_METHODS.skillsProjectRename
      | typeof WS_METHODS.skillsSessionSetEnabled
      | typeof WS_METHODS.skillsSessionReset
      | typeof WS_METHODS.skillsNativeImport
      | typeof WS_METHODS.skillsDeploymentChange,
  >(
    label: string,
    tag: M,
  ) => createEnvironmentRpcCommand(runtime, { label, tag });

  return {
    catalog: query("environment-data:skills:catalog", WS_METHODS.skillsCatalogList),
    content: query("environment-data:skills:content", WS_METHODS.skillsContentGet),
    history: query("environment-data:skills:history", WS_METHODS.skillsHistoryList),
    nativeContent: query(
      "environment-data:skills:native-content",
      WS_METHODS.skillsNativeContentGet,
    ),
    application: query("environment-data:skills:application", WS_METHODS.skillsApplicationGet),
    deployment: query("environment-data:skills:deployment", WS_METHODS.skillsDeploymentList),
    globalCreate: command(
      "environment-command:skills:global-create",
      WS_METHODS.skillsGlobalCreate,
    ),
    globalUpdate: command(
      "environment-command:skills:global-update",
      WS_METHODS.skillsGlobalUpdate,
    ),
    globalDelete: command(
      "environment-command:skills:global-delete",
      WS_METHODS.skillsGlobalDelete,
    ),
    globalRename: command(
      "environment-command:skills:global-rename",
      WS_METHODS.skillsGlobalRename,
    ),
    globalRollback: command(
      "environment-command:skills:global-rollback",
      WS_METHODS.skillsGlobalRollback,
    ),
    projectSetOverride: command(
      "environment-command:skills:project-override",
      WS_METHODS.skillsProjectSetOverride,
    ),
    projectSetDisabled: command(
      "environment-command:skills:project-disable",
      WS_METHODS.skillsProjectSetDisabled,
    ),
    projectDeleteState: command(
      "environment-command:skills:project-reset",
      WS_METHODS.skillsProjectDeleteState,
    ),
    projectRename: command(
      "environment-command:skills:project-rename",
      WS_METHODS.skillsProjectRename,
    ),
    sessionSetEnabled: command(
      "environment-command:skills:session-enable",
      WS_METHODS.skillsSessionSetEnabled,
    ),
    sessionReset: command(
      "environment-command:skills:session-reset",
      WS_METHODS.skillsSessionReset,
    ),
    nativeImport: command(
      "environment-command:skills:native-import",
      WS_METHODS.skillsNativeImport,
    ),
    deploymentChange: command(
      "environment-command:skills:deployment",
      WS_METHODS.skillsDeploymentChange,
    ),
    changes: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:skills:changes",
      idleTtlMs: 5 * 60_000,
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.skillsCatalogSubscribe>) =>
        subscribe(WS_METHODS.skillsCatalogSubscribe, input),
      onValue: (target, value, registry) =>
        Effect.sync(() => {
          invalidation.publish(target, value, registry);
        }),
    }),
  };
}
