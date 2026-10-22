import {
  ProjectWorkBoundedReadEnvelope,
  ProjectWorkRpcError,
  ProjectWorkReadRecord,
  ProjectTeamRecordRead,
  type ProjectWorkWriteIntent,
  type ProjectWorkDeliveryRequest,
  WS_METHODS,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkCommand,
  type ProjectWorkDelta,
  type ProjectWorkReadIntent,
  type ProjectWorkStreamInput,
  type ProjectWorkStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";
import { isProjectWorkHumanCommand, decodeProjectWorkSpecialRead } from "../projectWork.ts";
import { requestGuarded } from "../rpc/client.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  followStreamInEnvironment,
} from "./runtime.ts";

const PAGE_LIMIT = 128;
const projectKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  JSON.stringify([environmentId, projectId]);
const SUPPORTED_COLLECTIONS = [
  "foundation-records",
  "tasks",
  "criteria",
  "evidence",
  "relationships",
  "blockers",
  "attention",
  "activities",
  "checkpoints",
  "knowledge",
  "decisions",
  "comments",
] as const;
export type ProjectWorkCollection = (typeof SUPPORTED_COLLECTIONS)[number];
export type ProjectWorkClientRead = Omit<ProjectWorkReadIntent, "operation"> & {
  readonly operation:
    | ProjectWorkCollection
    | "task"
    | "task-context"
    | "search"
    | "briefing"
    | "export-json"
    | "export-markdown"
    | "supervision"
    | "verification-job"
    | "integration-sources"
    | "memory-sources"
    | "memory-shared-sources"
    | "memory-current"
    | "memory-recall"
    | "memory-configuration"
    | "memory-observations"
    | "delivery-recovery";
};
export type ProjectWorkHumanCommand =
  | Extract<
      ProjectWorkCommand,
      {
        readonly type:
          | "project-work.issue.refine"
          | "project-work.task.create"
          | "project-work.task.specify"
          | "project-work.task.revise-protected-specification"
          | "project-work.task.approve"
          | "project-work.task.protect-specification"
          | "project-work.task.ready"
          | "project-work.task.block"
          | "project-work.task.resolve-blocker"
          | "project-work.task.reopen"
          | "project-work.task.cancel"
          | "project-work.task.duplicate"
          | "project-work.task.watch"
          | "project-work.task.unwatch"
          | "project-work.criterion.upsert"
          | "project-work.criterion.waive"
          | "project-work.criterion.revoke-waiver"
          | "project-work.evidence.add"
          | "project-work.relationship.link"
          | "project-work.relationship.unlink"
          | "project-work.knowledge.promote"
          | "project-work.decision.propose"
          | "project-work.decision.accept"
          | "project-work.decision.reject"
          | "project-work.decision.supersede"
          | "project-work.comment.add"
          | "project-work.attention.seen";
      }
    >
  | Extract<
      ProjectWorkWriteIntent,
      {
        type:
          | "project-team.configure"
          | "project-team.gate.respond"
          | "project-team.specification.propose"
          | "project-team.criterion.waiver"
          | "project-team.plan.propose"
          | "project-team.task.control"
          | "project-team.investigation.start"
          | "project-team.assignment.start"
          | "project-team.execution.start"
          | "project-team.dispatch"
          | "project-team.message.send"
          | "project-team.message.attention"
          | "project-team.question.request"
          | "project-team.question.answer"
          | "project-team.verification.propose"
          | "project-team.review.finding.record"
          | "project-team.memory.process"
          | "project-team.memory.query"
          | "project-team.memory.promote"
          | "project-team.memory.retract"
          | "project-team.memory.shares.replace"
          | "project-team.memory.configure";
      }
    >;

export function normalizeProjectWorkRead(input: ProjectWorkClientRead): ProjectWorkClientRead {
  const memory = input.operation.startsWith("memory-");
  const keyset = memory || input.operation === "delivery-recovery";
  const maximum = keyset ? 32 : input.operation === "integration-sources" ? 64 : PAGE_LIMIT;
  const { ownSourceCursor, ...baseInput } = input;
  const { offset, ...withoutOffset } = baseInput;
  return {
    ...(keyset ? withoutOffset : baseInput),
    ...(input.operation === "integration-sources" &&
    typeof ownSourceCursor === "string" &&
    ownSourceCursor.length > 0 &&
    ownSourceCursor.length <= 4000
      ? { ownSourceCursor }
      : {}),
    limit: Math.max(1, Math.min(maximum, Math.trunc(input.limit ?? maximum) || maximum)),
    ...(keyset
      ? {}
      : {
          offset: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(offset ?? 0) || 0)),
        }),
    ...(SUPPORTED_COLLECTIONS.some((operation) => operation === input.operation)
      ? { envelope: true }
      : {}),
  };
}

/** Object insertion order must not create a second cache for the same filtered page. */
export function projectWorkResourceKey(target: {
  readonly environmentId: EnvironmentId;
  readonly input: ProjectWorkClientRead;
}): string {
  const input = normalizeProjectWorkRead(target.input);
  return JSON.stringify([
    target.environmentId,
    Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

export interface ProjectWorkStreamState {
  readonly projectId: ProjectId;
  readonly cursor: number;
  readonly synchronized: boolean;
  readonly resyncCursor: number | null;
  readonly changes: readonly ProjectWorkDelta[];
}
export const emptyProjectWorkStreamState = (projectId: ProjectId): ProjectWorkStreamState => ({
  projectId,
  cursor: 0,
  synchronized: false,
  resyncCursor: null,
  changes: [],
});

export function reduceProjectWorkStream(
  state: ProjectWorkStreamState,
  item: ProjectWorkStreamItem,
): ProjectWorkStreamState {
  const projectId = item.kind === "delta" ? item.delta.projectId : item.projectId;
  if (state.projectId !== projectId) return state;
  if (item.kind === "resync-required") {
    return {
      ...state,
      cursor: item.cursor,
      synchronized: false,
      resyncCursor: item.cursor,
      changes: [],
    };
  }
  if (item.kind === "synchronized") {
    if (item.cursor < state.cursor || (state.synchronized && item.cursor === state.cursor))
      return state;
    return { ...state, cursor: item.cursor, synchronized: true };
  }
  if (item.delta.cursor <= state.cursor) return state;
  return {
    ...state,
    cursor: item.delta.cursor,
    changes: [...state.changes.slice(-(PAGE_LIMIT - 1)), item.delta],
  };
}

export function resumeProjectWorkInput(
  input: ProjectWorkStreamInput,
  item: ProjectWorkStreamItem,
): ProjectWorkStreamInput {
  const projectId = item.kind === "delta" ? item.delta.projectId : item.projectId;
  if (projectId !== input.projectId) return input;
  const cursor = item.kind === "delta" ? item.delta.cursor : item.cursor;
  return {
    ...input,
    afterCursor:
      item.kind === "resync-required" ? cursor : Math.max(input.afterCursor ?? 0, cursor),
  };
}

export function projectWorkDeltaAffectsRead(
  input: ProjectWorkClientRead,
  delta: ProjectWorkDelta,
): boolean {
  // A delta names one record, but its event can also change task, attention and
  // relationship projections. Without the event subtype, refresh bounded reads
  // in that project rather than infer which other projections stayed unchanged.
  return input.projectId === delta.projectId;
}

export interface ProjectWorkPageRecord {
  readonly value: unknown;
  readonly known: boolean;
  readonly label: "record" | "Unknown work record";
}
const decodeEnvelope = Schema.decodeUnknownOption(ProjectWorkBoundedReadEnvelope);
const isKnownRecord = Schema.is(Schema.Union([ProjectWorkReadRecord, ProjectTeamRecordRead]));
export function normalizeProjectWorkPage(input: ProjectWorkClientRead, value: unknown) {
  const envelope = decodeEnvelope(value);
  if (Option.isNone(envelope) || envelope.value.projectId !== input.projectId) return null;
  const page = envelope.value;
  return {
    ...page,
    items: page.items.map((record): ProjectWorkPageRecord => {
      const known = isKnownRecord(record);
      return {
        value: record,
        known,
        label: known ? "record" : "Unknown work record",
      };
    }),
    nextOffset: page.hasMore ? page.offset + page.items.length : null,
  };
}

export function createProjectWorkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const mutation = Atom.family((_key: string) => Atom.make(0));
  const stream = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:project-work:stream",
    tag: WS_METHODS.projectWorkSubscribe,
    idleTtlMs: 0,
    resumeInput: resumeProjectWorkInput,
    transform: (source) =>
      source.pipe(
        Stream.scan(
          () => Option.none<ProjectWorkStreamState>(),
          (previous, item) => {
            const projectId = item.kind === "delta" ? item.delta.projectId : item.projectId;
            const state = Option.getOrElse(previous, () => emptyProjectWorkStreamState(projectId));
            const next = reduceProjectWorkStream(state, item);
            return next === state ? previous : Option.some(next);
          },
        ),
        Stream.changes,
      ),
  });
  const projectStream = (environmentId: EnvironmentId, projectId: ProjectId) =>
    stream({
      environmentId,
      input: { projectId, requestCompletionMarker: true, limit: PAGE_LIMIT },
    });
  const subscriptionFailed = Atom.family((key: string) => {
    const [environmentId, projectId] = JSON.parse(key) as [EnvironmentId, ProjectId];
    const source = projectStream(environmentId, projectId);
    // Reading only health avoids repainting read consumers on every delta.
    return Atom.make((get) => get(source)._tag === "Failure").pipe(Atom.setIdleTTL(0));
  });
  const connection = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        followStreamInEnvironment(
          environmentId,
          Stream.unwrap(
            EnvironmentSupervisor.EnvironmentSupervisor.pipe(
              Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
            ),
          ),
        ),
      )
      .pipe(Atom.setIdleTTL(0)),
  );
  const signal = Atom.family((key: string) => {
    const [environmentId, entries] = JSON.parse(key) as [EnvironmentId, [string, unknown][]];
    const input = Object.fromEntries(entries) as ProjectWorkClientRead;
    return Atom.make((get) => {
      const changes = Option.flatMap(
        AsyncResult.value(get(projectStream(environmentId, input.projectId))),
        (value) => value,
      );
      const state = Option.getOrNull(changes);
      const cursor =
        state?.changes.reduce(
          (last, delta) =>
            projectWorkDeltaAffectsRead(input, delta) ? Math.max(last, delta.cursor) : last,
          0,
        ) ?? 0;
      return JSON.stringify([
        state?.resyncCursor,
        cursor,
        get(mutation(projectKey(environmentId, input.projectId))),
      ]);
    }).pipe(Atom.setIdleTTL(0));
  });
  const query = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:project-work:read",
    tag: WS_METHODS.projectWorkRead,
    idleTtlMs: 0,
    staleTimeMs: 0,
    refreshTrigger: (target) =>
      signal(
        projectWorkResourceKey({
          ...target,
          input: target.input as ProjectWorkClientRead,
        }),
      ),
  });
  const readFamily = Atom.family((key: string) => {
    const [environmentId, entries] = JSON.parse(key) as [EnvironmentId, [string, unknown][]];
    const input = Object.fromEntries(entries) as ProjectWorkClientRead;
    const source = query({ environmentId, input });
    return Atom.readable(
      (get) => {
        const result = get(source);
        const value = Option.getOrNull(AsyncResult.value(result));
        const page = normalizeProjectWorkPage(input, value);
        const state = Option.getOrNull(AsyncResult.value(get(connection(environmentId))));
        const disconnected = state !== null && state.phase !== "connected";
        const status = disconnected
          ? "disconnected"
          : result._tag === "Initial"
            ? "loading"
            : result._tag === "Failure" ||
                result.waiting ||
                get(subscriptionFailed(projectKey(environmentId, input.projectId)))
              ? "stale"
              : "ready";
        return {
          result,
          value,
          page,
          special: decodeProjectWorkSpecialRead(input, value, environmentId),
          status,
          label: disconnected ? "Disconnected" : status === "stale" ? "Work may be stale" : null,
        } as const;
      },
      (refresh) => refresh(source),
    ).pipe(Atom.setIdleTTL(0));
  });
  const write = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:project-work:write",
    tag: WS_METHODS.projectWorkWrite,
    execute: (input) =>
      isProjectWorkHumanCommand(input)
        ? requestGuarded(WS_METHODS.projectWorkWrite, input)
        : Effect.fail(
            new ProjectWorkRpcError({
              operation: "write",
              reason: "unavailable",
            }),
          ),
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => projectKey(environmentId, input.projectId),
    },
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() =>
        registry.update(
          mutation(projectKey(environmentId, input.projectId)),
          (revision) => revision + 1,
        ),
      ),
  });
  const delivery = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:project-work:delivery",
    tag: WS_METHODS.projectWorkDelivery,
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  });
  const issue = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:project-work:issue",
    tag: WS_METHODS.projectWorkIssue,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => projectKey(environmentId, input.input.projectId),
    },
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() =>
        registry.update(
          mutation(projectKey(environmentId, input.input.projectId)),
          (revision) => revision + 1,
        ),
      ),
  });
  return {
    issue,
    delivery: {
      ...delivery,
      run: async (
        registry: Parameters<typeof delivery.run>[0],
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: {
            readonly projectId: ProjectId;
            readonly request: ProjectWorkDeliveryRequest;
          };
        },
      ) => {
        const result = await delivery.run(registry, {
          environmentId: target.environmentId,
          input: target.input.request,
        });
        // A failed external write may have been accepted; refetch retained authority either way.
        registry.update(
          mutation(projectKey(target.environmentId, target.input.projectId)),
          (revision) => revision + 1,
        );
        return result;
      },
    },
    read: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: ProjectWorkClientRead;
    }) => readFamily(projectWorkResourceKey(target)),
    stream: projectStream,
    write: {
      ...write,
      run: (
        registry: Parameters<typeof write.run>[0],
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: ProjectWorkHumanCommand;
        },
      ) => write.run(registry, target),
    },
    permissionAtom: write.permissionAtom,
  };
}
