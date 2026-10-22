import {
  ORCHESTRATION_V2_WS_METHODS,
  AssistantRoutineDetail,
  WS_METHODS,
  memoryOwnerEquals,
  type MemoryOwner,
  type OrchestrationV2Command,
  type AssistantActivityListInput,
  type AssistantConfiguration,
  type AssistantConfigurationRevision,
  type AssistantDetail,
  type AssistantResolveThreadInput,
  type AssistantThreadOwner,
  type AssistantGetInput,
  type AssistantHomeBinding,
  type AssistantLifecycleInput,
  type AssistantListInput,
  type AssistantMemoryReadInput,
  type AssistantMemoryReadResult,
  type AssistantMemoryWriteInput,
  type AssistantRoutineReadInput,
  type AssistantRoutineReadResult,
  type AssistantRoutineWriteInput,
  type AssistantRunSummary,
  type AssistantSummary,
  type AssistantUpdateConfigurationInput,
  type CommandId,
  type EnvironmentId,
  type MemoryGrant,
  type ProjectMemorySourceRead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import {
  request,
  requestGuarded,
  subscribe,
  EnvironmentRpcUnavailableError,
} from "../rpc/client.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { ManagedResourceTarget } from "./managedResources.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  followStreamInEnvironment,
} from "./runtime.ts";

export const assistantScopeKey = (target: AssistantGetInput): string =>
  JSON.stringify([target.environmentId, target.assistantId]);

const boundedLimit = (limit: number | undefined, maximum: number) =>
  Number.isFinite(limit) ? Math.max(1, Math.min(maximum, Math.trunc(limit!))) : maximum;

export function normalizeAssistantList(input: AssistantListInput): AssistantListInput {
  return {
    environmentId: input.environmentId,
    includeArchived: input.includeArchived,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit: boundedLimit(input.limit, 100),
  };
}

export function normalizeAssistantActivity(
  input: AssistantActivityListInput,
): AssistantActivityListInput {
  return {
    environmentId: input.environmentId,
    assistantId: input.assistantId,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit: boundedLimit(input.limit, 100),
  };
}

export function normalizeAssistantMemoryRead(
  input: AssistantMemoryReadInput,
): AssistantMemoryReadInput {
  if (input.operation === "recipient")
    return {
      environmentId: input.environmentId,
      assistantId: input.assistantId,
      operation: "recipient",
      recipient: input.recipient,
    };
  return {
    environmentId: input.environmentId,
    assistantId: input.assistantId,
    operation: input.operation,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit: boundedLimit(input.limit, 32),
  };
}

export function normalizeAssistantRoutineRead(
  input: AssistantRoutineReadInput,
): AssistantRoutineReadInput {
  if (input.operation === "webhook")
    return {
      environmentId: input.environmentId,
      assistantId: input.assistantId,
      operation: "webhook",
      taskId: input.taskId,
    };
  return {
    environmentId: input.environmentId,
    assistantId: input.assistantId,
    operation: input.operation,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.operation === "fires" && input.taskId !== undefined ? { taskId: input.taskId } : {}),
    limit: boundedLimit(input.limit, 32),
  };
}

export type AssistantRoutineRecord = Extract<
  AssistantRoutineReadResult,
  { operation: "list" }
>["routines"][number];
const sameRoutine = Schema.toEquivalence(AssistantRoutineDetail);

export interface AssistantThreadOwnerSnapshot extends AssistantResolveThreadInput {
  readonly owner: AssistantThreadOwner | null;
  readonly connectionEpoch: string;
}

export function assistantThreadOwnerState(input: {
  readonly target: AssistantResolveThreadInput;
  readonly snapshot: AssistantThreadOwnerSnapshot | null;
  readonly connectionEpoch: string | null;
}) {
  if (input.connectionEpoch === null) return { kind: "offline" as const };
  if (
    input.snapshot === null ||
    input.snapshot.connectionEpoch !== input.connectionEpoch ||
    input.snapshot.environmentId !== input.target.environmentId ||
    input.snapshot.threadId !== input.target.threadId
  )
    return { kind: "unknown" as const };
  const owner = input.snapshot.owner;
  if (owner === null) return { kind: "ordinary" as const };
  if (
    owner.environmentId !== input.target.environmentId ||
    owner.threadId !== input.target.threadId ||
    owner.isCanonicalHome !== (owner.canonicalThreadId === input.target.threadId)
  )
    return { kind: "unknown" as const };
  return {
    kind: owner.isCanonicalHome ? ("canonical" as const) : ("child" as const),
    owner,
    selected: {
      environmentId: owner.environmentId,
      assistantId: owner.assistantId,
      backingProjectId: owner.backingProjectId,
      canonicalThreadId: owner.canonicalThreadId,
      configurationRevision: owner.configurationRevision,
      connectionEpoch: input.connectionEpoch,
    } satisfies AssistantSelection,
  };
}

export function assistantMemoryRecipient(
  result: Extract<AssistantMemoryReadResult, { operation: "recipient" }>,
) {
  return {
    environmentId: result.environmentId,
    owner: result.owner,
    revision: result.ownerRevision,
  };
}

/** A connection replacement invalidates a reviewed form even if its numeric revision is unchanged. */
export interface AssistantSelection extends AssistantHomeBinding {
  readonly configurationRevision: AssistantConfigurationRevision;
  readonly connectionEpoch: string;
}

export function captureAssistantSelection(
  summary: AssistantSummary,
  connectionEpoch: string,
): AssistantSelection {
  return {
    ...summary.binding,
    configurationRevision: summary.configurationRevision,
    connectionEpoch,
  };
}

export function assistantSelectionIsCurrent(
  selected: AssistantSelection,
  current: AssistantSelection,
): boolean {
  return (
    assistantScopeKey(selected) === assistantScopeKey(current) &&
    selected.backingProjectId === current.backingProjectId &&
    selected.canonicalThreadId === current.canonicalThreadId &&
    selected.configurationRevision === current.configurationRevision &&
    selected.connectionEpoch === current.connectionEpoch
  );
}

export function assistantHomeTarget(binding: AssistantHomeBinding) {
  return {
    environmentId: binding.environmentId,
    projectId: binding.backingProjectId,
    threadId: binding.canonicalThreadId,
  };
}

export function assistantResourceTarget(binding: AssistantHomeBinding): ManagedResourceTarget {
  return assistantHomeTarget(binding);
}

export interface AssistantConfigurationDraft {
  readonly selected: AssistantSelection;
  readonly configuration: AssistantConfiguration;
}

export function captureAssistantConfigurationDraft(
  detail: AssistantDetail,
  connectionEpoch: string,
): AssistantConfigurationDraft {
  return {
    selected: captureAssistantSelection(detail.summary, connectionEpoch),
    configuration: structuredClone(detail.configuration.configuration),
  };
}

export function prepareAssistantConfigurationMutation(input: {
  readonly draft: AssistantConfigurationDraft;
  readonly current: AssistantSelection;
  readonly commandId: CommandId;
}): AssistantUpdateConfigurationInput | null {
  if (!assistantSelectionIsCurrent(input.draft.selected, input.current)) return null;
  return {
    environmentId: input.draft.selected.environmentId,
    assistantId: input.draft.selected.assistantId,
    expectedRevision: input.draft.selected.configurationRevision,
    commandId: input.commandId,
    configuration: input.draft.configuration,
  };
}

export function prepareAssistantLifecycleMutation(input: {
  readonly selected: AssistantSelection;
  readonly current: AssistantSelection;
  readonly commandId: CommandId;
  readonly action: AssistantLifecycleInput["action"];
}): AssistantLifecycleInput | null {
  if (!assistantSelectionIsCurrent(input.selected, input.current)) return null;
  return {
    environmentId: input.selected.environmentId,
    assistantId: input.selected.assistantId,
    expectedRevision: input.selected.configurationRevision,
    commandId: input.commandId,
    action: input.action,
  };
}

export function prepareAssistantStop(input: {
  readonly selected: AssistantSelection;
  readonly current: AssistantSelection;
  readonly commandId: CommandId;
}) {
  if (!assistantSelectionIsCurrent(input.selected, input.current)) return null;
  return {
    environmentId: input.selected.environmentId,
    input: {
      type: "thread.stop" as const,
      threadId: input.selected.canonicalThreadId,
      commandId: input.commandId,
    },
  };
}

type SourceSelector = Extract<AssistantMemoryWriteInput, { operation: "edit" }>["source"];

export function assistantMemorySourceSelector(source: ProjectMemorySourceRead): SourceSelector {
  return {
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    generation: source.generation,
    contentHash: source.contentHash,
  };
}

export function assistantMemorySourceKey(
  target: AssistantGetInput,
  source: SourceSelector,
): string {
  return JSON.stringify([
    target.environmentId,
    target.assistantId,
    source.sourceId,
    source.sourceRevision,
    source.generation,
    source.contentHash,
  ]);
}

/** Revisions here identify the source tuple, not the assistant's mutable configuration. */
export function prepareAssistantMemoryMutation(input: {
  readonly selected: AssistantSelection;
  readonly current: AssistantSelection;
  readonly intent: AssistantMemoryWriteInput;
  readonly currentSource?: ProjectMemorySourceRead;
  readonly currentGrant?: MemoryGrant;
  readonly recipient?: {
    readonly environmentId: EnvironmentId;
    readonly owner: MemoryOwner;
    readonly revision: number;
  };
  readonly configurationRevision?: number;
}): AssistantMemoryWriteInput | null {
  const { selected, current, intent } = input;
  if (
    !assistantSelectionIsCurrent(selected, current) ||
    assistantScopeKey(intent) !== assistantScopeKey(selected)
  )
    return null;
  if (intent.operation === "configure") {
    return intent.expectedRevision === input.configurationRevision ? intent : null;
  }
  if (!("source" in intent)) return intent;
  const source = input.currentSource;
  if (
    !source ||
    source.owner.kind !== "assistant" ||
    source.owner.assistantId !== selected.assistantId ||
    source.status !== "current" ||
    assistantMemorySourceKey(selected, intent.source) !==
      assistantMemorySourceKey(current, assistantMemorySourceSelector(source))
  )
    return null;
  if (intent.operation === "grant" || intent.operation === "revoke") {
    const recipient = input.recipient;
    if (
      !recipient ||
      recipient.environmentId !== selected.environmentId ||
      recipient.revision !== intent.recipientRevision ||
      !memoryOwnerEquals(recipient.owner, intent.recipient)
    )
      return null;
  }
  if (intent.operation !== "revoke") return intent;
  const grant = input.currentGrant;
  if (
    !grant ||
    grant.revokedAt !== null ||
    grant.id !== intent.grantId ||
    grant.environmentId !== selected.environmentId ||
    grant.source.owner.kind !== "assistant" ||
    grant.source.owner.assistantId !== selected.assistantId ||
    grant.source.sourceId !== intent.source.sourceId ||
    grant.source.sourceRevision !== intent.source.sourceRevision ||
    grant.ownerRevision !== source.ownerRevision ||
    grant.recipientRevision !== intent.recipientRevision ||
    !memoryOwnerEquals(grant.recipient, intent.recipient)
  )
    return null;
  return intent;
}

type OptionalRoutineRevision<Input> = Input extends { readonly expectedRevision: number }
  ? Omit<Input, "expectedRevision"> & { readonly expectedRevision?: number }
  : Input;

export type AssistantRoutineMutationIntent = OptionalRoutineRevision<AssistantRoutineWriteInput>;

export function prepareAssistantRoutineMutation(input: {
  readonly selected: AssistantSelection;
  readonly current: AssistantSelection;
  readonly intent: AssistantRoutineMutationIntent;
  readonly reviewedRoutine?: AssistantRoutineRecord;
  readonly currentRoutine?: AssistantRoutineRecord;
}): AssistantRoutineWriteInput | null {
  if (
    !assistantSelectionIsCurrent(input.selected, input.current) ||
    assistantScopeKey(input.intent) !== assistantScopeKey(input.selected)
  )
    return null;
  if (input.intent.operation === "upsert" && input.intent.taskId === undefined)
    return input.intent.expectedRevision === undefined ? input.intent : null;
  const { reviewedRoutine, currentRoutine } = input;
  if (
    !reviewedRoutine ||
    !currentRoutine ||
    currentRoutine.deleted ||
    currentRoutine.taskId !== input.intent.taskId ||
    !sameRoutine(reviewedRoutine, currentRoutine)
  )
    return null;
  if (input.intent.operation === "run-now") return input.intent;
  if (
    input.intent.expectedRevision !== undefined &&
    input.intent.expectedRevision !== reviewedRoutine.revision
  )
    return null;
  return { ...input.intent, expectedRevision: reviewedRoutine.revision };
}

export function assistantMemoryStatus(
  result: Extract<AssistantMemoryReadResult, { operation: "status" }>,
) {
  return {
    jobs: result.jobs,
    pendingCleanup: result.unresolvedForgottenSources,
    requiresUserConfirmation: result.requiresUserConfirmation,
  };
}

/** Dispatch receipts never become completed runs, and disconnect never rewrites execution history. */
export function assistantActivityState(input: {
  readonly connected: boolean;
  readonly summary: AssistantSummary;
  readonly lastRun?: AssistantRunSummary | null;
}) {
  const run = input.lastRun;
  return {
    environment: input.connected ? ("connected" as const) : ("offline" as const),
    lifecycle: input.summary.lifecycle,
    provisioning: input.summary.provisioningState,
    attention: input.summary.attention,
    activity: run
      ? {
          phase: run.phase,
          status: run.status,
          runId: run.runId,
          updatedAt: run.updatedAt,
        }
      : null,
  };
}

export function makeAssistantInvalidationSignals() {
  const revisions = Atom.family((_key: string) => Atom.make(0));
  return {
    refresh: (environmentId: EnvironmentId) => revisions(environmentId),
    publish: (environmentId: EnvironmentId, registry: AtomRegistry.AtomRegistry) =>
      registry.update(revisions(environmentId), (revision) => revision + 1),
  };
}

export function createAssistantsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const epochs = new WeakMap<object, string>();
  let nextEpoch = 0;
  const sessionEpoch = (session: object) => {
    let epoch = epochs.get(session);
    if (epoch === undefined) {
      epoch = String(++nextEpoch);
      epochs.set(session, epoch);
    }
    return epoch;
  };
  const connection = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          Effect.map(EnvironmentSupervisor, (supervisor) =>
            SubscriptionRef.changes(supervisor.state).pipe(
              Stream.zipLatest(SubscriptionRef.changes(supervisor.session)),
              Stream.map(([state, session]) => {
                if (state.phase !== "connected" || Option.isNone(session))
                  return { connected: false, epoch: null };
                return { connected: true, epoch: sessionEpoch(session.value) };
              }),
            ),
          ),
        ),
      ),
    ),
  );
  const invalidation = makeAssistantInvalidationSignals();
  const refreshTrigger = (target: { readonly environmentId: EnvironmentId }) =>
    invalidation.refresh(target.environmentId);
  const onSettled = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => invalidation.publish(target.environmentId, registry));
  const owner = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:assistants:thread-owner",
    refreshTrigger,
    execute: Effect.fn("Assistants.resolveThread")(function* (input: AssistantResolveThreadInput) {
      const supervisor = yield* EnvironmentSupervisor;
      const session = yield* SubscriptionRef.get(supervisor.session);
      if (Option.isNone(session))
        return yield* new EnvironmentRpcUnavailableError({
          environmentId: input.environmentId,
          message: "The environment is offline.",
        });
      const owner = yield* request(WS_METHODS.assistantsResolveThread, input);
      return {
        environmentId: input.environmentId,
        threadId: input.threadId,
        owner,
        connectionEpoch: sessionEpoch(session.value),
      } satisfies AssistantThreadOwnerSnapshot;
    }),
  });
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:assistants:list",
    tag: WS_METHODS.assistantsList,
    refreshTrigger,
  });
  const roster = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:assistants:roster",
    subscribe: (input: AssistantListInput) =>
      subscribe(WS_METHODS.assistantsSubscribeRoster, input),
    onValue: (target, _page, registry) =>
      Effect.sync(() => invalidation.publish(target.environmentId, registry)),
    idleTtlMs: 0,
  });
  const activity = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:assistants:activity",
    tag: WS_METHODS.assistantsActivity,
    refreshTrigger,
  });
  const routines = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:assistants:routines",
    execute: (input: Exclude<AssistantRoutineReadInput, { operation: "webhook" }>) =>
      requestGuarded(WS_METHODS.assistantsRoutineRead, input),
    refreshTrigger,
  });
  const routineWebhook = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:assistants:routine-webhook",
    tag: WS_METHODS.assistantsRoutineRead,
    execute: (input: Extract<AssistantRoutineReadInput, { operation: "webhook" }>) =>
      requestGuarded(WS_METHODS.assistantsRoutineRead, input),
  });
  const memory = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:assistants:memory",
    tag: WS_METHODS.assistantsMemoryRead,
    refreshTrigger,
  });
  const stop = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:assistants:stop",
    tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    execute: (input: Extract<OrchestrationV2Command, { type: "thread.stop" }>) =>
      requestGuarded(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, input),
    onSettled,
  });
  return {
    connection,
    owner: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: AssistantResolveThreadInput;
    }) =>
      owner({
        environmentId: target.environmentId,
        input: { environmentId: target.input.environmentId, threadId: target.input.threadId },
      }),
    roster: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: AssistantListInput;
    }) => roster({ ...target, input: normalizeAssistantList(target.input) }),
    activity: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: AssistantActivityListInput;
    }) => activity({ ...target, input: normalizeAssistantActivity(target.input) }),
    list: (target: { readonly environmentId: EnvironmentId; readonly input: AssistantListInput }) =>
      list({ ...target, input: normalizeAssistantList(target.input) }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:assistants:detail",
      tag: WS_METHODS.assistantsGet,
      refreshTrigger,
    }),
    routines: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: Exclude<AssistantRoutineReadInput, { operation: "webhook" }>;
    }) =>
      routines({
        ...target,
        input: { ...target.input, limit: boundedLimit(target.input.limit, 32) },
      }),
    routineWebhook: {
      ...routineWebhook,
      permissionAtom: (environmentId: EnvironmentId | null) =>
        routineWebhook.permissionAtom(environmentId, { operation: "webhook" }),
      requiredScopes: () => routineWebhook.requiredScopes({ operation: "webhook" }),
    },
    routineWrite: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:assistants:routines",
      tag: WS_METHODS.assistantsRoutineWrite,
      onSettled,
    }),
    memory: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: AssistantMemoryReadInput;
    }) => memory({ ...target, input: normalizeAssistantMemoryRead(target.input) }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:assistants:create",
      tag: WS_METHODS.assistantsCreate,
      onSettled,
    }),
    updateConfiguration: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:assistants:configuration",
      tag: WS_METHODS.assistantsUpdateConfiguration,
      onSettled,
    }),
    lifecycle: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:assistants:lifecycle",
      tag: WS_METHODS.assistantsLifecycle,
      onSettled,
    }),
    memoryWrite: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:assistants:memory",
      tag: WS_METHODS.assistantsMemoryWrite,
      onSettled,
    }),
    stop: {
      ...stop,
      permissionAtom: (environmentId: EnvironmentId | null) =>
        stop.permissionAtom(environmentId, { type: "thread.stop" }),
      requiredScopes: () => stop.requiredScopes({ type: "thread.stop" }),
    },
    refresh: invalidation.publish,
  };
}
