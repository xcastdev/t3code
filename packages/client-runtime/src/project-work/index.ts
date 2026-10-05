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
  ProjectWorkTaskContext,
  ProjectWorkWriteResult,
} from "@t3tools/contracts";
import {
  ProjectTeamRecordPage,
  ProjectTeamSupervisionSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

const decodeFoundationPage = Schema.decodeUnknownOption(ProjectTeamRecordPage);
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
  const decoded = decodeFoundationPage(value);
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
  return { ...page, ...cursor.value };
}

const decodeSupervisionSummary = Schema.decodeUnknownOption(ProjectTeamSupervisionSummary);

/** Decode bounded metadata only for the exact requested project and revision fence. */
export function asProjectTeamSupervisionSummary(
  value: unknown,
  projectId: ProjectId,
): ProjectTeamSupervisionSummary | null {
  if (
    value === null ||
    typeof value !== "object" ||
    !("projectId" in value) ||
    value.projectId !== projectId
  )
    return null;
  const decoded = decodeSupervisionSummary(value);
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
  return summary;
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
