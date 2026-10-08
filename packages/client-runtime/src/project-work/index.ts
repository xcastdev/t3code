import type {
  EnvironmentId,
  ProjectId,
  ProjectWorkAttentionRead,
  ProjectWorkBriefingRead,
  ProjectWorkBoundedReadEnvelope,
  ProjectWorkWriteIntent,
  ProjectTeamRecordRead,
  ProjectWorkKnowledgeRead,
  ProjectWorkReadIntent,
  ProjectWorkStreamInput,
  ProjectWorkStreamItem,
  ProjectWorkTaskRead,
  ProjectWorkTaskId,
  ProjectWorkTaskContext,
  ProjectWorkWriteResult,
  ProjectTeamBindingAccounting as BindingAccounting,
} from "@t3tools/contracts";
import {
  canonicalProjectWorkPayload,
  ProjectWorkVerificationJobRead,
  ProjectWorkReadIntent as ProjectWorkReadIntentSchema,
  ProjectTeamRecordPage,
  ProjectTeamRunBinding,
  ProjectTeamSupervisionSummary,
  ProjectTeamBindingAccounting,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { subscribe, type EnvironmentRpcStreamFailure } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  environmentRpcKey,
} from "../state/runtime.ts";

/** The first-release work views never ask the server for an unbounded collection. */
export const PROJECT_WORK_PAGE_SIZE = 50;
/** One extra row tells the client that the next page exists. It is never rendered. */
export const PROJECT_WORK_PAGE_REQUEST_SIZE = PROJECT_WORK_PAGE_SIZE + 1;
export const PROJECT_WORK_REFRESH_INTERVAL_MS = 15_000;

/** Capability-gated callers can switch from polling to this bounded cursor stream. */
export function projectWorkStreamAvailable(input: {
  readonly capability: boolean | undefined;
  readonly connectionPhase: string;
}): boolean {
  return input.capability === true && input.connectionPhase === "connected";
}

/** Shared web/desktop/mobile transport helper for cursor-resuming work deltas. */
export function subscribeProjectWork(
  input: ProjectWorkStreamInput,
): Stream.Stream<
  ProjectWorkStreamItem,
  EnvironmentRpcStreamFailure<typeof WS_METHODS.projectWorkSubscribe>,
  EnvironmentSupervisor
> {
  return subscribe(WS_METHODS.projectWorkSubscribe, input);
}

export type ProjectWorkReadTarget = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
};

export const PROJECT_WORK_PAGE_COLLECTIONS = [
  "tasks",
  "knowledge",
  "decisions",
  "attention",
] as const;
export type ProjectWorkPageCollection = (typeof PROJECT_WORK_PAGE_COLLECTIONS)[number];

export type ProjectWorkPageTarget = ProjectWorkReadTarget & {
  readonly collection: ProjectWorkPageCollection;
  readonly offset: number;
  /** Poll only when the connected server has no work-stream capability. */
  readonly poll?: boolean;
};

type ProjectWorkSearchTarget = ProjectWorkReadTarget & {
  readonly query: string;
  readonly recordKinds?: ReadonlyArray<string>;
  readonly offset?: number;
  /** Poll only when the connected server has no work-stream capability. */
  readonly poll?: boolean;
};

export interface ProjectWorkPage<T> {
  readonly records: ReadonlyArray<T>;
  readonly offset: number;
  readonly hasNext: boolean;
  readonly nextOffset: number | null;
  readonly revision: number | null;
}

export type ProjectWorkWriteTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: ProjectWorkWriteIntent;
};

export type ProjectWorkReadCollection =
  | ReadonlyArray<ProjectWorkTaskRead>
  | ReadonlyArray<ProjectWorkKnowledgeRead>
  | ReadonlyArray<ProjectWorkAttentionRead>;

function normalizeProjectWorkOffset(offset: number): number {
  return Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
}

/** Keep page identity stable across environments and collection offsets. */
export function projectWorkPageTargetKey(target: ProjectWorkPageTarget): string {
  return JSON.stringify([
    target.environmentId,
    target.projectId,
    target.collection,
    normalizeProjectWorkOffset(target.offset),
  ]);
}

export function projectWorkPageInput(target: ProjectWorkPageTarget): ProjectWorkReadIntent {
  return {
    projectId: target.projectId,
    operation: target.collection,
    limit: PROJECT_WORK_PAGE_REQUEST_SIZE,
    offset: normalizeProjectWorkOffset(target.offset),
    envelope: true,
  };
}

/** Keep an older client useful when a newer server returns an unexpected read envelope. */
export function asProjectWorkArray<T>(value: unknown): ReadonlyArray<T> {
  return Array.isArray(value) ? (value as ReadonlyArray<T>) : [];
}

/** Convert a bounded wire page into the visible rows and a next-page marker. */
export function asProjectWorkPage<T>(value: unknown, offset = 0): ProjectWorkPage<T> {
  const candidate = value as Partial<ProjectWorkBoundedReadEnvelope> | null;
  const records = Array.isArray(candidate?.items)
    ? (candidate.items as ReadonlyArray<T>)
    : asProjectWorkArray<T>(value);
  const normalizedOffset = normalizeProjectWorkOffset(offset);
  const hasNext = records.length > PROJECT_WORK_PAGE_SIZE || candidate?.hasMore === true;
  return {
    records: records.slice(0, PROJECT_WORK_PAGE_SIZE),
    offset: normalizedOffset,
    hasNext,
    nextOffset: hasNext ? normalizedOffset + PROJECT_WORK_PAGE_SIZE : null,
    revision: typeof candidate?.revision === "number" ? candidate.revision : null,
  };
}

export function asProjectWorkTaskContext(value: unknown): ProjectWorkTaskContext | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Partial<ProjectWorkTaskContext>;
  return typeof candidate.revision === "number" &&
    candidate.task !== undefined &&
    candidate.policy !== undefined
    ? (value as ProjectWorkTaskContext)
    : null;
}

export interface ProjectWorkVerificationJobTarget extends ProjectWorkReadTarget {
  readonly taskId: ProjectWorkTaskId;
  readonly verificationJobId: string;
}
const decodeVerificationJob = Schema.decodeUnknownOption(ProjectWorkVerificationJobRead, {
  onExcessProperty: "error",
});
const decodeVerificationRead = Schema.decodeUnknownSync(ProjectWorkReadIntentSchema);
/** A typed retained preview is still subject to the current gate and human authorization. */
export function asProjectWorkVerificationJob(
  value: unknown,
  target: ProjectWorkVerificationJobTarget,
): typeof ProjectWorkVerificationJobRead.Type | null {
  const decoded = decodeVerificationJob(value);
  if (
    Option.isNone(decoded) ||
    canonicalProjectWorkPayload(value) !== canonicalProjectWorkPayload(decoded.value)
  )
    return null;
  const { manifest } = decoded.value;
  return manifest.environmentId === target.environmentId &&
    manifest.projectId === target.projectId &&
    manifest.taskId === target.taskId &&
    manifest.jobId === target.verificationJobId
    ? decoded.value
    : null;
}

const decodeFoundationPage = Schema.decodeUnknownOption(ProjectTeamRecordPage);
const knownAccountingBinding = Schema.is(ProjectTeamRunBinding);
const decodeBindingAccounting = Schema.decodeUnknownOption(ProjectTeamBindingAccounting, {
  onExcessProperty: "error",
});
const decodeBindingAccountingPage = Schema.decodeUnknownOption(
  Schema.Array(ProjectTeamBindingAccounting).check(Schema.isMaxLength(128)),
);
type AccountingOwner = {
  readonly projectId: ProjectId;
  readonly recordId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly attemptId: string;
  readonly environmentId?: EnvironmentId;
};

/** Observations can change without changing the foundation's action revision. */
export function asProjectTeamBindingAccounting(
  value: unknown,
  owner: AccountingOwner,
): BindingAccounting | undefined {
  const decoded = decodeBindingAccounting(value);
  if (Option.isNone(decoded)) return undefined;
  const accounting = decoded.value;
  if (
    accounting.projectId !== owner.projectId ||
    accounting.bindingId !== owner.recordId ||
    accounting.generation !== owner.generation ||
    accounting.taskId !== owner.taskId ||
    accounting.attemptId !== owner.attemptId ||
    (owner.environmentId !== undefined && accounting.environmentId !== owner.environmentId)
  )
    return undefined;
  if (accounting.availability !== "available") return accounting;
  const coherent = (scope: typeof accounting.attempt) =>
    Number.isSafeInteger(scope.chargedTokens + scope.reservedTokens) &&
    scope.chargedTokens + scope.reservedTokens + scope.remainingTokens === scope.maximumTokens &&
    scope.unknownChargedTokens <= scope.chargedTokens;
  const { root, attempt, operation } = accounting;
  const within = (scope: typeof attempt, parent: typeof attempt) =>
    scope.maximumTokens <= parent.maximumTokens &&
    scope.deadlineAtMs <= parent.deadlineAtMs &&
    scope.chargedTokens <= parent.chargedTokens &&
    scope.reservedTokens <= parent.reservedTokens &&
    scope.unknownChargedTokens <= parent.unknownChargedTokens &&
    scope.heldCalls <= parent.heldCalls &&
    scope.quarantinedCalls <= parent.quarantinedCalls;
  if (
    !coherent(root) ||
    !coherent(attempt) ||
    !within(attempt, root) ||
    (operation !== undefined && (!coherent(operation) || !within(operation, attempt)))
  )
    return undefined;
  return accounting;
}

export function projectTeamAccountingCaptions(
  accounting: BindingAccounting | undefined,
): readonly string[] {
  if (accounting === undefined || accounting.availability === "unavailable")
    return ["Recorded token usage unavailable."];
  if (accounting.availability === "not-admitted")
    return ["No admitted execution or recorded token usage."];
  const caption = (label: string, scope: typeof accounting.attempt) => {
    const date = DateTime.make(scope.deadlineAtMs);
    const deadline = Option.isSome(date)
      ? DateTime.formatLocal(date.value, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "unavailable";
    return `${label}: ${scope.chargedTokens} charged${scope.unknownChargedTokens > 0 ? ` (${scope.unknownChargedTokens} unknown)` : ""}, ${scope.reservedTokens} held; ${scope.remainingTokens}/${scope.maximumTokens} tokens remaining. Original deadline ${deadline}.${scope.quarantinedCalls > 0 ? ` ${scope.quarantinedCalls} quarantined calls.` : ""}`;
  };
  return [
    caption("Shared root", accounting.root),
    caption("This attempt", accounting.attempt),
    ...(accounting.operation === undefined
      ? []
      : [caption("This operation", accounting.operation)]),
  ];
}
// The shared Text codec trims strings; pagination tokens must remain opaque.
const decodeFoundationCursor = Schema.decodeUnknownOption(
  Schema.Struct({
    nextCursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  }),
);

/** Validate every record before a foundation page can participate in a snapshot. */
export function asProjectWorkFoundationPage(
  value: unknown,
  projectId: ProjectId,
): typeof ProjectTeamRecordPage.Type | null {
  const separated =
    value !== null && typeof value === "object" && "accounting" in value
      ? (({ accounting, ...base }) => ({ base, accounting }))(value)
      : { base: value, accounting: undefined };
  const decoded = decodeFoundationPage(separated.base);
  if (Option.isNone(decoded)) return null;
  const page = decoded.value;
  if (
    page.projectId !== projectId ||
    !Number.isSafeInteger(page.revision) ||
    page.items.some(
      (record) =>
        record.projectId !== projectId ||
        !Number.isSafeInteger(record.revision) ||
        record.revision > page.revision,
    )
  ) {
    return null;
  }
  const cursor = decodeFoundationCursor(value);
  if (Option.isNone(cursor)) return null;
  const accountingPage = decodeBindingAccountingPage(separated.accounting);
  const accounting = Option.isNone(accountingPage)
    ? []
    : accountingPage.value.flatMap((observation) => {
        const owners = page.items.filter(
          (record) => record.kind === "run-binding" && record.recordId === observation.bindingId,
        );
        const owner = owners[0];
        if (owners.length !== 1 || !knownAccountingBinding(owner)) return [];
        const current = asProjectTeamBindingAccounting(observation, owner);
        return current === undefined ? [] : [current];
      });
  const unique = new Set(accounting.map((item) => item.bindingId)).size === accounting.length;
  return {
    ...page,
    ...cursor.value,
    ...(accounting.length === 0 || !unique ? {} : { accounting }),
  };
}

const decodeSupervisionSummary = Schema.decodeUnknownOption(ProjectTeamSupervisionSummary);

/** Decode bounded metadata only for the exact requested project and revision fence. */
export function asProjectTeamSupervisionSummary(
  value: unknown,
  projectId: ProjectId,
  environmentId?: EnvironmentId,
): ProjectTeamSupervisionSummary | null {
  if (
    value === null ||
    typeof value !== "object" ||
    !("projectId" in value) ||
    value.projectId !== projectId
  )
    return null;
  const observations = new Map<string, unknown>();
  const separated =
    "bindings" in value &&
    value.bindings !== null &&
    typeof value.bindings === "object" &&
    "items" in value.bindings &&
    Array.isArray(value.bindings.items) &&
    value.bindings.items.length <= 8
      ? {
          ...value,
          bindings: {
            ...value.bindings,
            items: value.bindings.items.map((item: unknown) => {
              if (item !== null && typeof item === "object" && "accounting" in item) {
                const { accounting, ...base } = item;
                if ("recordId" in item && typeof item.recordId === "string")
                  observations.set(item.recordId, accounting);
                return base;
              }
              return item;
            }),
          },
        }
      : value;
  const decoded = decodeSupervisionSummary(separated);
  if (Option.isNone(decoded)) return null;
  const summary = decoded.value;
  if (summary.availability !== "available") return summary;
  const { total, ...counts } = summary.taskCounts;
  const sum = Object.values(counts).reduce((count, next) => count + next, 0);
  if (!Number.isSafeInteger(sum) || sum !== total) return null;
  const coherent = (record: { readonly revision: number }) => record.revision <= summary.revision;
  for (const page of [summary.missions, summary.bindings, summary.blockers, summary.questions]) {
    const ids = new Set<string>();
    for (const record of page.items) {
      if (!coherent(record) || ids.has(record.recordId)) return null;
      ids.add(record.recordId);
    }
  }
  for (const record of [summary.coordinator, ...summary.bindings.items]) {
    if (record === undefined) continue;
    if (
      !coherent(record) ||
      ("profile" in record && record.profile !== undefined && !coherent(record.profile))
    )
      return null;
  }
  return {
    ...summary,
    bindings: {
      ...summary.bindings,
      items: summary.bindings.items.map((binding) => {
        if (
          !binding.supported ||
          !("taskId" in binding) ||
          !("attemptId" in binding) ||
          !("generation" in binding)
        )
          return binding;
        const accounting = asProjectTeamBindingAccounting(observations.get(binding.recordId), {
          projectId,
          recordId: binding.recordId,
          generation: binding.generation,
          taskId: binding.taskId,
          attemptId: binding.attemptId,
          ...(environmentId === undefined ? {} : { environmentId }),
        });
        return accounting === undefined ? binding : { ...binding, accounting };
      }),
    },
  };
}

/** Never probe an older server or start work reads for an unavailable environment. */
export function projectTeamSupervisionAvailable(input: {
  readonly enabled: boolean;
  readonly capability: boolean | undefined;
  readonly connectionPhase: string;
}): boolean {
  return input.enabled && input.capability === true && input.connectionPhase === "connected";
}

type ProjectWorkFoundationPageError =
  | "invalid-page"
  | "revision-changed"
  | "duplicate-record"
  | "invalid-cursor-chain"
  | "limit-exceeded";

export interface ProjectWorkFoundationSnapshot {
  readonly records: ReadonlyArray<ProjectTeamRecordRead>;
  readonly revision: number | null;
  readonly complete: boolean;
  readonly nextCursor: string | null;
  readonly error: ProjectWorkFoundationPageError | null;
  readonly accounting?: ReadonlyArray<BindingAccounting>;
}

/** Only a complete, coherent cursor chain is eligible for guided write decisions. */
export function combineProjectWorkFoundationPages(input: {
  readonly projectId: ProjectId;
  readonly pages: ReadonlyArray<{ readonly cursor?: string; readonly value: unknown }>;
}): ProjectWorkFoundationSnapshot {
  const fail = (error: ProjectWorkFoundationPageError): ProjectWorkFoundationSnapshot => ({
    records: [],
    revision: null,
    complete: false,
    nextCursor: null,
    error,
  });
  if (input.pages.length > 16) return fail("limit-exceeded");
  const records: ProjectTeamRecordRead[] = [];
  const accounting: BindingAccounting[] = [];
  const recordIds = new Set<string>();
  const cursors = new Set<string>();
  let revision: number | null = null;
  let nextCursor: string | null = null;
  for (const [index, requested] of input.pages.entries()) {
    if (
      index === 0
        ? requested.cursor !== undefined
        : nextCursor === null || requested.cursor !== nextCursor
    ) {
      return fail("invalid-cursor-chain");
    }
    const page = asProjectWorkFoundationPage(requested.value, input.projectId);
    if (page === null) return fail("invalid-page");
    if (revision !== null && revision !== page.revision) return fail("revision-changed");
    revision = page.revision;
    accounting.push(...(page.accounting ?? []));
    if (records.length + page.items.length > 2048) return fail("limit-exceeded");
    for (const record of page.items) {
      if (recordIds.has(record.recordId)) return fail("duplicate-record");
      recordIds.add(record.recordId);
      records.push(record);
    }
    nextCursor = page.nextCursor ?? null;
    if (nextCursor !== null) {
      if (cursors.has(nextCursor)) return fail("invalid-cursor-chain");
      cursors.add(nextCursor);
    }
  }
  return {
    records,
    revision,
    complete: revision !== null && nextCursor === null,
    nextCursor,
    error: null,
    ...(accounting.length === 0 ? {} : { accounting }),
  };
}

export interface ProjectWorkStreamState {
  readonly cursor: number;
  readonly healthy: boolean;
  readonly resyncRequired: boolean;
  readonly changedKinds: ReadonlyArray<string>;
}

export const initialProjectWorkStreamState = (cursor = 0): ProjectWorkStreamState => ({
  cursor,
  healthy: false,
  resyncRequired: false,
  changedKinds: [],
});

/** Pure cursor reducer used by clients to resume only after a synchronized marker. */
export function reduceProjectWorkStreamItem(
  state: ProjectWorkStreamState,
  item: ProjectWorkStreamItem,
): ProjectWorkStreamState {
  if (item.kind === "resync-required") {
    return { cursor: item.cursor, healthy: false, resyncRequired: true, changedKinds: [] };
  }
  if (item.kind === "synchronized") {
    return { ...state, cursor: item.cursor, healthy: true, resyncRequired: false };
  }
  return {
    ...state,
    cursor: Math.max(state.cursor, item.delta.cursor),
    changedKinds: state.changedKinds.includes(item.delta.kind)
      ? state.changedKinds
      : [...state.changedKinds, item.delta.kind],
  };
}

/** Fold a bounded stream batch without losing intermediate cursor or resync state. */
export function reduceProjectWorkStreamBatch(
  state: ProjectWorkStreamState,
  items: Iterable<ProjectWorkStreamItem>,
): ProjectWorkStreamState {
  let next = state;
  for (const item of items) next = reduceProjectWorkStreamItem(next, item);
  return next;
}

/** Read only the stable fields needed by the overview; newer fields remain opaque. */
export function asProjectWorkBriefing(value: unknown): ProjectWorkBriefingRead | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.text !== "string" ||
    typeof candidate.sourceRevision !== "number" ||
    !Array.isArray(candidate.includedTaskIds) ||
    !Array.isArray(candidate.includedKnowledgeIds) ||
    !Array.isArray(candidate.omittedReasons) ||
    (candidate.narrative !== undefined && typeof candidate.narrative !== "string")
  ) {
    return null;
  }
  return value as ProjectWorkBriefingRead;
}

/**
 * These SWR families remain the compatibility path for older servers without
 * the capability-negotiated work stream. They are deliberately capped and
 * refresh while mounted. New callers can use subscribeProjectWork after
 * projectWorkStreamAvailable returns true. The atom family key includes all page coordinates;
 * this prevents same-named projects in different environments from sharing a
 * stale page and lets disconnected clients retain each loaded page safely.
 */
export function createProjectWorkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const refreshSignal = Atom.family((key: string) =>
    Atom.make(0).pipe(Atom.withLabel(`project-work:refresh:${key}`)),
  );

  const refreshSignalFor = (target: ProjectWorkReadTarget) =>
    refreshSignal(JSON.stringify([target.environmentId, target.projectId]));

  const read = (label: string) =>
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label,
      tag: WS_METHODS.projectWorkRead,
      staleTimeMs: 10_000,
      idleTtlMs: 60_000,
      refreshTrigger: ({ environmentId, input: targetInput }) =>
        refreshSignalFor({ environmentId, projectId: targetInput.projectId }),
      // The wire success is intentionally Schema.Unknown for additive server
      // compatibility. Each family below narrows only its bounded operation.
    });

  const briefing = read("environment-data:project-work:briefing");
  const tasks = read("environment-data:project-work:tasks");
  const knowledge = read("environment-data:project-work:knowledge");
  const attention = read("environment-data:project-work:attention");
  const integrationSources = read("environment-data:project-work:integration-sources");
  const verificationJob = read("environment-data:project-work:verification-job");
  const verificationFamily = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, ProjectWorkReadIntent];
    const target = {
      environmentId,
      projectId: input.projectId,
      taskId: input.taskId!,
      verificationJobId: input.verificationJobId!,
    };
    return verificationJob({ environmentId, input }).pipe(
      Atom.map(AsyncResult.map((value) => asProjectWorkVerificationJob(value, target))),
    );
  });
  const exportJson = read("environment-data:project-work:export-json");
  const exportMarkdown = read("environment-data:project-work:export-markdown");

  const supervisionRead = read("environment-data:project-work:supervision");
  const unavailableSupervision = Atom.make(AsyncResult.initial<unknown>());
  const pollingSupervision = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, ProjectWorkReadIntent];
    return supervisionRead({ environmentId, input }).pipe(
      Atom.withRefresh(PROJECT_WORK_REFRESH_INTERVAL_MS),
    );
  });

  const foundationRead = read("environment-data:project-work:foundation-page");
  const foundationFamily = Atom.family((key: string) => {
    const [environmentId, projectId, cursor] = JSON.parse(key) as [
      EnvironmentId,
      ProjectId,
      string | null,
    ];
    return foundationRead({
      environmentId,
      input: {
        projectId,
        operation: "foundation-records",
        limit: 128,
        ...(cursor === null ? {} : { cursor }),
      },
    });
  });

  const pageRead = read("environment-data:project-work:page");
  const pageFamily = Atom.family((key: string) => {
    const [environmentId, projectId, collection, offset] = JSON.parse(key) as [
      EnvironmentId,
      ProjectId,
      ProjectWorkPageCollection,
      number,
    ];
    return pageRead({
      environmentId,
      input: projectWorkPageInput({ environmentId, projectId, collection, offset }),
    });
  });

  const taskContext = read("environment-data:project-work:task-context");
  const search = read("environment-data:project-work:search");

  const pollingView = <A>(atom: Atom.Atom<A>) =>
    atom.pipe(Atom.withRefresh(PROJECT_WORK_REFRESH_INTERVAL_MS));
  const pollingBriefing = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, ProjectWorkReadIntent];
    return pollingView(briefing({ environmentId, input }));
  });
  const pollingTaskContext = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, ProjectWorkReadIntent];
    return pollingView(taskContext({ environmentId, input }));
  });
  const pollingFoundation = Atom.family((key: string) => pollingView(foundationFamily(key)));
  const pollingPage = Atom.family((key: string) => pollingView(pageFamily(key)));
  const pollingSearch = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, ProjectWorkReadIntent];
    return pollingView(search({ environmentId, input }));
  });
  const stream = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:project-work:stream",
    subscribe: (input: ProjectWorkStreamInput) =>
      subscribeProjectWork(input).pipe(
        Stream.groupedWithin(64, Duration.millis(50)),
        Stream.mapAccum(
          () => initialProjectWorkStreamState(input.afterCursor ?? 0),
          (state, items) => {
            const next = reduceProjectWorkStreamBatch(state, items);
            return [next, [next]] as const;
          },
        ),
      ),
    onValue: (target, _value, registry) =>
      Effect.sync(() => {
        registry.update(
          refreshSignalFor({
            environmentId: target.environmentId,
            projectId: target.input.projectId,
          }),
          (revision) => revision + 1,
        );
      }),
  });

  const write = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:project-work:write",
    tag: WS_METHODS.projectWorkWrite,
    onSuccess: (target, registry) =>
      Effect.sync(() => {
        registry.update(
          refreshSignalFor({
            environmentId: target.environmentId,
            projectId: target.input.projectId,
          }),
          (revision) => revision + 1,
        );
      }),
  });

  return {
    supervision: (
      target: ProjectWorkReadTarget & {
        readonly enabled: boolean;
        readonly capability: boolean | undefined;
        readonly connectionPhase: string;
        readonly poll?: boolean;
      },
    ) => {
      if (!projectTeamSupervisionAvailable(target)) return unavailableSupervision;
      const rpcTarget = {
        environmentId: target.environmentId,
        input: { projectId: target.projectId, operation: "supervision" as const },
      };
      return target.poll === false
        ? supervisionRead(rpcTarget)
        : pollingSupervision(environmentRpcKey(rpcTarget));
    },
    briefing: (target: ProjectWorkReadTarget & { readonly poll?: boolean }) => {
      const input = { ...inputFor(target.projectId, "briefing"), kind: "standard" } as const;
      const rpcTarget = { environmentId: target.environmentId, input };
      return target.poll === false
        ? briefing(rpcTarget)
        : pollingBriefing(environmentRpcKey(rpcTarget));
    },
    tasks: (target: ProjectWorkReadTarget) =>
      tasks({ environmentId: target.environmentId, input: inputFor(target.projectId, "tasks") }),
    knowledge: (target: ProjectWorkReadTarget) =>
      knowledge({
        environmentId: target.environmentId,
        input: inputFor(target.projectId, "knowledge"),
      }),
    attention: (target: ProjectWorkReadTarget) =>
      attention({
        environmentId: target.environmentId,
        input: inputFor(target.projectId, "attention"),
      }),
    taskContext: (
      target: ProjectWorkReadTarget & {
        readonly taskId: ProjectWorkTaskRead["taskId"];
        readonly poll?: boolean;
      },
    ) =>
      (() => {
        const rpcTarget = {
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            operation: "task-context" as const,
            taskId: target.taskId,
          },
        };
        return target.poll === false
          ? taskContext(rpcTarget)
          : pollingTaskContext(environmentRpcKey(rpcTarget));
      })(),
    search: (target: ProjectWorkSearchTarget) => {
      const rpcTarget = {
        environmentId: target.environmentId,
        input: {
          projectId: target.projectId,
          operation: "search" as const,
          query: target.query,
          ...(target.recordKinds === undefined ? {} : { recordKinds: [...target.recordKinds] }),
          limit: PROJECT_WORK_PAGE_REQUEST_SIZE,
          offset: normalizeProjectWorkOffset(target.offset ?? 0),
          envelope: true as const,
        },
      };
      return target.poll === false
        ? search(rpcTarget)
        : pollingSearch(environmentRpcKey(rpcTarget));
    },
    stream: (target: ProjectWorkReadTarget & { readonly afterCursor?: number }) =>
      stream({
        environmentId: target.environmentId,
        input: {
          projectId: target.projectId,
          afterCursor: normalizeProjectWorkOffset(target.afterCursor ?? 0),
          limit: 1_000,
          requestCompletionMarker: true,
        },
      }),
    exportJson: (target: ProjectWorkReadTarget) =>
      exportJson({
        environmentId: target.environmentId,
        input: { ...inputFor(target.projectId, "export-json"), includeHistory: true },
      }),
    exportMarkdown: (target: ProjectWorkReadTarget) =>
      exportMarkdown({
        environmentId: target.environmentId,
        input: inputFor(target.projectId, "export-markdown"),
      }),
    foundationPage: (
      target: ProjectWorkReadTarget & { readonly cursor?: string; readonly poll?: boolean },
    ) => {
      const key = JSON.stringify([target.environmentId, target.projectId, target.cursor ?? null]);
      return target.poll === false ? foundationFamily(key) : pollingFoundation(key);
    },
    page: (target: ProjectWorkPageTarget) => {
      const key = projectWorkPageTargetKey(target);
      return target.poll === false ? pageFamily(key) : pollingPage(key);
    },
    integrationSources: (
      target: ProjectWorkReadTarget & {
        readonly taskId: ProjectWorkTaskId;
        readonly offset?: number;
      },
    ) =>
      integrationSources({
        environmentId: target.environmentId,
        input: {
          projectId: target.projectId,
          taskId: target.taskId,
          operation: "integration-sources",
          offset: target.offset ?? 0,
          limit: 50,
        },
      }),
    verificationJob: (target: ProjectWorkVerificationJobTarget) => {
      const input = decodeVerificationRead({
        projectId: target.projectId,
        taskId: target.taskId,
        verificationJobId: target.verificationJobId,
        operation: "verification-job",
      });
      return verificationFamily(environmentRpcKey({ environmentId: target.environmentId, input }));
    },
    write,
    pageSize: PROJECT_WORK_PAGE_SIZE,
    pageRequestSize: PROJECT_WORK_PAGE_REQUEST_SIZE,
  };
}

function inputFor(
  projectId: ProjectId,
  operation: ProjectWorkReadIntent["operation"],
): ProjectWorkReadIntent {
  switch (operation) {
    case "briefing":
      return { projectId, operation, kind: "standard" };
    case "tasks":
      return { projectId, operation, limit: PROJECT_WORK_PAGE_REQUEST_SIZE, offset: 0 };
    case "knowledge":
      return { projectId, operation, limit: PROJECT_WORK_PAGE_REQUEST_SIZE, offset: 0 };
    case "attention":
      return { projectId, operation, limit: PROJECT_WORK_PAGE_REQUEST_SIZE, offset: 0 };
    default:
      return { projectId, operation };
  }
}

export function projectWorkWritesAvailable(input: {
  readonly enabled: boolean;
  readonly connectionPhase: string;
}): boolean {
  return input.enabled && input.connectionPhase === "connected";
}

export function projectWorkWriteResultRevision(
  result: ProjectWorkWriteResult | null,
): number | null {
  return result?.revision ?? null;
}
