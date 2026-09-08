import {
  EventId,
  type CommandId,
  type McpCatalogDefinition,
  type McpCatalogSessionId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadId,
  type ProjectMcpMutationError,
  ProjectMcpNameConflictError,
  ProjectMcpServerLimitExceededError,
  ProjectMcpServerNotFoundError,
  McpCatalogStaleRevisionError,
  McpCatalogStaleSessionError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireActiveProjectWorkspaceRootAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

// Session adoption takes seconds; a user message still unadopted after this
// window is a failed/stale start, not pending work. Mirrors the client's
// QUEUED_TURN_START_GRACE_MS in client-runtime threadSettled.ts.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
const PROJECT_MCP_SERVER_LIMIT = 50;

const foldProjectMcpName = (name: string): string => name.toLocaleLowerCase();

const projectMcpInvariantError = (
  commandType: string,
  cause: ProjectMcpMutationError,
): OrchestrationCommandInvariantError =>
  new OrchestrationCommandInvariantError({ commandType, detail: cause.message, cause });

const catalogLogicalIdOwner = (
  readModel: OrchestrationReadModel,
  logicalServerId: string,
  except?: { readonly scope: "global" | "project"; readonly scopeId: string },
): string | undefined => {
  const catalog = readModel.mcpCatalog;
  if (
    catalog?.globalDefinitions.some(
      (definition) =>
        String(definition.logicalServerId) === logicalServerId &&
        !(except?.scope === "global" && except.scopeId === String(definition.scopeId)),
    )
  )
    return "global";
  const projectDefinition = catalog?.projectDefinitions.find(
    (entry) =>
      String(entry.definition.logicalServerId) === logicalServerId &&
      !(except?.scope === "project" && except.scopeId === String(entry.projectId)),
  );
  if (projectDefinition !== undefined) return String(projectDefinition.projectId);
  const legacyEntry = readModel.projectMcpServers?.find(
    (entry) =>
      String(entry.server.id) === logicalServerId &&
      !(except?.scope === "project" && except.scopeId === String(entry.projectId)),
  );
  return legacyEntry === undefined ? undefined : String(legacyEntry.projectId);
};

const rejectCatalogLogicalIdOwner = (
  readModel: OrchestrationReadModel,
  commandType: string,
  logicalServerId: string,
  except?: { readonly scope: "global" | "project"; readonly scopeId: string },
) => {
  const owner = catalogLogicalIdOwner(readModel, logicalServerId, except);
  return owner === undefined
    ? Effect.void
    : Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType,
          detail: `MCP logical server ID '${logicalServerId}' is already owned by '${owner}'.`,
        }),
      );
};

const catalogDefinitionsEqual = (
  left: ReadonlyArray<McpCatalogDefinition>,
  right: ReadonlyArray<McpCatalogDefinition>,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const validateCatalogDefinitions = (
  readModel: OrchestrationReadModel,
  commandType: string,
  sessionId: string,
  definitions: ReadonlyArray<McpCatalogDefinition>,
) => {
  const seen = new Set<string>();
  for (const definition of definitions) {
    const logicalServerId = String(definition.logicalServerId);
    if (seen.has(logicalServerId)) {
      return Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType,
          detail: `MCP logical server ID '${logicalServerId}' occurs more than once in the session catalog.`,
        }),
      );
    }
    seen.add(logicalServerId);
    if (definition.scope === "session" && String(definition.scopeId) !== sessionId) {
      return Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType,
          detail: "MCP session definition scope does not match the catalog session.",
        }),
      );
    }
    if (
      definition.scope === "session" &&
      catalogLogicalIdOwner(readModel, logicalServerId) !== undefined
    ) {
      return Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType,
          detail: `MCP logical server ID '${logicalServerId}' is already owned by a global or project catalog definition.`,
        }),
      );
    }
  }
  return Effect.void;
};

const catalogRevisionInvariantError = (
  commandType: string,
  scope: "global" | "project" | "session",
  scopeId: string,
  expectedRevision: number,
  actualRevision: number,
): OrchestrationCommandInvariantError => {
  const cause = new McpCatalogStaleRevisionError({
    scope,
    scopeId,
    expectedRevision,
    actualRevision,
  });
  return new OrchestrationCommandInvariantError({
    commandType,
    detail: cause.message,
    cause,
  });
};

/**
 * Blocked-on-you work derived from the thread's retained activities: an
 * approval or user-input request with no later resolution for the same
 * requestId. The server-side twin of the shell's hasPendingApprovals /
 * hasPendingUserInput flags, which the decider read model does not carry.
 * The clearing rules MUST match ProjectionPipeline's pending accounting —
 * resolved activities always clear, respond.failed clears only when the
 * failure detail marks the request stale/unknown — or settle would be
 * rejected on threads whose shell flags read as clear.
 */
function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

// Scans the read model's activities, which the projector caps at the most
// recent 500. That bound is safe here: an OPEN approval/user-input request
// blocks its turn, so the thread cannot accumulate hundreds of later
// activities while one is outstanding — a request that has scrolled out of
// the window is one whose turn kept running, i.e. it was resolved or went
// stale. (The projection pipeline's pendingApprovalCount reads the same
// capped stream and stays consistent with this view.)
function hasOpenBlockingRequest(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

/**
 * A queued turn start — a user message no turn has picked up yet — is work
 * in flight even though session is still null (turn.start emits
 * message-sent + turn-start-requested; the session arrives later). Detection
 * mirrors the client's hasQueuedTurnStart: the newest user message is
 * strictly newer than every latestTurn timestamp (adoption stamps the new
 * turn's requestedAt with the message time, clearing this), and only within
 * the adoption grace window — historical threads whose last user message
 * postdates their turn timestamps (older-server data, mid-turn messages)
 * must not be blocked forever. A failed session start (status "error")
 * clears the block immediately.
 *
 * The age check is bounded on BOTH sides: message timestamps are
 * client-supplied, so a client clock ahead of the server yields a negative
 * age. Without the lower bound that negative age satisfies `<= grace` for
 * as long as the skew lasts, extending the block far past the intended two
 * minutes.
 */
function threadHasQueuedTurnStart(
  thread: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
    readonly latestTurn: {
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    } | null;
    readonly session: { readonly status: string } | null;
  },
  occurredAt: string,
): boolean {
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  );
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        );
  const queuedAgeMs = Date.parse(occurredAt) - latestUserMessageAtMs;
  return (
    thread.session?.status !== "error" &&
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

const makeCatalogSessionLinkEvent = (
  thread: OrchestrationReadModel["threads"][number],
  command: Extract<OrchestrationCommand, { type: "thread.mcp-catalog.initialize" }>,
) =>
  Effect.gen(function* () {
    const session =
      thread.session === null
        ? {
            threadId: thread.id,
            status: "stopped" as const,
            providerName: null,
            providerInstanceId: command.snapshot.providerInstanceId,
            runtimeMode: thread.runtimeMode,
            activeTurnId: null,
            mcpCatalogSessionId: command.snapshot.catalogSessionId,
            lastError: null,
            updatedAt: command.createdAt,
          }
        : {
            ...thread.session,
            mcpCatalogSessionId: command.snapshot.catalogSessionId,
            updatedAt: command.createdAt,
          };
    return {
      ...(yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      })),
      type: "thread.session-set" as const,
      payload: { threadId: command.threadId, session },
    } satisfies PlannedOrchestrationEvent;
  });

const makeCatalogSessionDisposeEvent = (input: {
  readonly threadId: ThreadId;
  readonly mcpCatalogSessionId: McpCatalogSessionId;
  readonly revision: number;
  readonly disposedAt: string;
  readonly commandId: CommandId;
}) =>
  Effect.gen(function* () {
    return {
      ...(yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: input.threadId,
        occurredAt: input.disposedAt,
        commandId: input.commandId,
      })),
      type: "thread.mcp-catalog.disposed" as const,
      payload: {
        threadId: input.threadId,
        mcpCatalogSessionId: input.mcpCatalogSessionId,
        revision: input.revision,
        disposedAt: input.disposedAt,
      },
    } satisfies PlannedOrchestrationEvent;
  });

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "environment.mcp-definition.create":
    case "environment.mcp-definition.update": {
      yield* rejectCatalogLogicalIdOwner(
        readModel,
        command.type,
        String(command.definition.logicalServerId),
        command.type === "environment.mcp-definition.update"
          ? { scope: "global", scopeId: String(command.environmentId) }
          : undefined,
      );
      const actualRevision = readModel.mcpCatalog?.globalRevision ?? 0;
      if (command.expectedRevision !== actualRevision) {
        return yield* catalogRevisionInvariantError(
          command.type,
          "global",
          command.environmentId,
          command.expectedRevision,
          actualRevision,
        );
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "environment",
          aggregateId: command.environmentId,
          occurredAt: "createdAt" in command ? command.createdAt : command.updatedAt,
          commandId: command.commandId,
        })),
        type:
          command.type === "environment.mcp-definition.create"
            ? "environment.mcp-definition.created"
            : "environment.mcp-definition.updated",
        payload: {
          environmentId: command.environmentId,
          definition: command.definition,
          revision: actualRevision + 1,
          ...("createdAt" in command
            ? { createdAt: command.createdAt }
            : { updatedAt: command.updatedAt }),
        },
      } as PlannedOrchestrationEvent;
    }

    case "environment.mcp-definition.remove": {
      const actualRevision = readModel.mcpCatalog?.globalRevision ?? 0;
      if (command.expectedRevision !== actualRevision) {
        return yield* catalogRevisionInvariantError(
          command.type,
          "global",
          command.environmentId,
          command.expectedRevision,
          actualRevision,
        );
      }
      const definitionId = readModel.mcpCatalog?.globalDefinitions.find(
        (definition) => definition.logicalServerId === command.logicalServerId,
      )?.definitionId;
      return {
        ...(yield* withEventBase({
          aggregateKind: "environment",
          aggregateId: command.environmentId,
          occurredAt: command.removedAt,
          commandId: command.commandId,
        })),
        type: "environment.mcp-definition.removed",
        payload: {
          environmentId: command.environmentId,
          logicalServerId: command.logicalServerId,
          ...(definitionId === undefined ? {} : { definitionId }),
          revision: actualRevision + 1,
          removedAt: command.removedAt,
        },
      };
    }

    case "project.mcp-definition.create":
    case "project.mcp-definition.update": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      yield* rejectCatalogLogicalIdOwner(
        readModel,
        command.type,
        String(command.definition.logicalServerId),
        command.type === "project.mcp-definition.update"
          ? { scope: "project", scopeId: String(command.projectId) }
          : undefined,
      );
      const actualRevision =
        readModel.mcpCatalog?.projectRevisions.find(
          (entry) => entry.projectId === command.projectId,
        )?.revision ?? 0;
      if (command.expectedRevision !== actualRevision) {
        return yield* catalogRevisionInvariantError(
          command.type,
          "project",
          command.projectId,
          command.expectedRevision,
          actualRevision,
        );
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: "createdAt" in command ? command.createdAt : command.updatedAt,
          commandId: command.commandId,
        })),
        type:
          command.type === "project.mcp-definition.create"
            ? "project.mcp-definition.created"
            : "project.mcp-definition.updated",
        payload: {
          projectId: command.projectId,
          definition: command.definition,
          revision: actualRevision + 1,
          ...("createdAt" in command
            ? { createdAt: command.createdAt }
            : { updatedAt: command.updatedAt }),
        },
      } as PlannedOrchestrationEvent;
    }

    case "project.mcp-definition.remove": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      const actualRevision =
        readModel.mcpCatalog?.projectRevisions.find(
          (entry) => entry.projectId === command.projectId,
        )?.revision ?? 0;
      if (command.expectedRevision !== actualRevision) {
        return yield* catalogRevisionInvariantError(
          command.type,
          "project",
          command.projectId,
          command.expectedRevision,
          actualRevision,
        );
      }
      const definitionId = readModel.mcpCatalog?.projectDefinitions.find(
        (entry) =>
          entry.projectId === command.projectId &&
          entry.definition.logicalServerId === command.logicalServerId,
      )?.definition.definitionId;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.removedAt,
          commandId: command.commandId,
        })),
        type: "project.mcp-definition.removed",
        payload: {
          projectId: command.projectId,
          logicalServerId: command.logicalServerId,
          ...(definitionId === undefined ? {} : { definitionId }),
          revision: actualRevision + 1,
          removedAt: command.removedAt,
        },
      };
    }

    case "project.mcp-override.upsert": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      const actualRevision =
        readModel.mcpCatalog?.projectRevisions.find(
          (entry) => entry.projectId === command.projectId,
        )?.revision ?? 0;
      if (command.expectedRevision !== actualRevision) {
        return yield* catalogRevisionInvariantError(
          command.type,
          "project",
          command.projectId,
          command.expectedRevision,
          actualRevision,
        );
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        })),
        type: "project.mcp-override.upserted",
        payload: {
          projectId: command.projectId,
          override: command.override,
          revision: actualRevision + 1,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "project.mcp-override.remove": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      const actualRevision =
        readModel.mcpCatalog?.projectRevisions.find(
          (entry) => entry.projectId === command.projectId,
        )?.revision ?? 0;
      if (command.expectedRevision !== actualRevision) {
        return yield* catalogRevisionInvariantError(
          command.type,
          "project",
          command.projectId,
          command.expectedRevision,
          actualRevision,
        );
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.removedAt,
          commandId: command.commandId,
        })),
        type: "project.mcp-override.removed",
        payload: {
          projectId: command.projectId,
          overrideId: command.overrideId,
          revision: actualRevision + 1,
          removedAt: command.removedAt,
        },
      };
    }

    case "thread.mcp-catalog.initialize": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (command.snapshot.threadId !== command.threadId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "MCP catalog snapshot thread does not match the command thread.",
        });
      }
      const existing = readModel.mcpCatalog?.sessions.find(
        (snapshot) => snapshot.catalogSessionId === command.snapshot.catalogSessionId,
      );
      const linkedSnapshot =
        thread.session?.mcpCatalogSessionId === undefined
          ? undefined
          : readModel.mcpCatalog?.sessions.find(
              (snapshot) => snapshot.catalogSessionId === thread.session?.mcpCatalogSessionId,
            );
      yield* validateCatalogDefinitions(
        readModel,
        command.type,
        String(command.snapshot.catalogSessionId),
        command.snapshot.desired,
      );
      yield* validateCatalogDefinitions(
        readModel,
        command.type,
        String(command.snapshot.catalogSessionId),
        command.snapshot.baseline,
      );
      if (
        command.snapshot.desiredRevision === 0 &&
        !catalogDefinitionsEqual(command.snapshot.baseline, command.snapshot.desired)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Revision-zero MCP catalog initialization must have no first-create mutation.",
        });
      }
      if (command.snapshot.desiredRevision !== 0 && command.snapshot.desiredRevision !== 1) {
        return yield* catalogRevisionInvariantError(
          command.type,
          "session",
          String(command.snapshot.catalogSessionId),
          command.snapshot.desiredRevision,
          0,
        );
      }
      if (
        linkedSnapshot !== undefined &&
        linkedSnapshot.catalogSessionId !== command.snapshot.catalogSessionId &&
        linkedSnapshot.disposedAt === undefined
      ) {
        const cause = new McpCatalogStaleSessionError({
          threadId: command.threadId,
          requestedSessionId: command.snapshot.catalogSessionId,
          activeSessionId: linkedSnapshot.catalogSessionId,
        });
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: cause.message,
          cause,
        });
      }
      if (
        thread.session?.providerInstanceId !== undefined &&
        thread.session.providerInstanceId !== command.snapshot.providerInstanceId &&
        linkedSnapshot?.disposedAt === undefined
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "MCP catalog provider does not match the thread session provider.",
        });
      }
      if (
        command.snapshot.baseline.some(
          (definition) => definition.scope === "project" && definition.scopeId !== thread.projectId,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "MCP catalog project definitions do not match the thread project.",
        });
      }
      if (existing !== undefined) {
        if (existing.disposedAt !== undefined) {
          const cause = new McpCatalogStaleSessionError({
            threadId: command.threadId,
            requestedSessionId: command.snapshot.catalogSessionId,
            activeSessionId:
              thread.session?.mcpCatalogSessionId ?? command.snapshot.catalogSessionId,
          });
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: cause.message,
            cause,
          });
        }
        if (existing.threadId !== command.threadId) {
          const cause = new McpCatalogStaleSessionError({
            threadId: command.threadId,
            requestedSessionId: command.snapshot.catalogSessionId,
            activeSessionId: existing.catalogSessionId,
          });
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: cause.message,
            cause,
          });
        }
        if (
          existing.providerInstanceId !== command.snapshot.providerInstanceId ||
          existing.desiredRevision !== command.snapshot.desiredRevision ||
          !catalogDefinitionsEqual(existing.baseline, command.snapshot.baseline) ||
          !catalogDefinitionsEqual(existing.desired, command.snapshot.desired)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              "MCP catalog initialization conflicts with the durable session already using this ID.",
          });
        }
        const initializedEvent = {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.mcp-catalog.initialized" as const,
          payload: { threadId: command.threadId, snapshot: existing },
        } satisfies PlannedOrchestrationEvent;
        return thread.session?.mcpCatalogSessionId === existing.catalogSessionId
          ? initializedEvent
          : [initializedEvent, yield* makeCatalogSessionLinkEvent(thread, command)];
      }
      const initializedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.mcp-catalog.initialized" as const,
        payload: { threadId: command.threadId, snapshot: command.snapshot },
      } satisfies PlannedOrchestrationEvent;
      const linkEvent = yield* makeCatalogSessionLinkEvent(thread, command);
      return [
        initializedEvent,
        ...(thread.session?.mcpCatalogSessionId === command.snapshot.catalogSessionId
          ? []
          : [linkEvent]),
      ];
    }

    case "thread.mcp-catalog.update":
    case "thread.mcp-catalog.reset": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const requestedCatalog =
        command.type === "thread.mcp-catalog.update" ? command.desiredCatalog : command.baseline;
      yield* validateCatalogDefinitions(
        readModel,
        command.type,
        String(command.mcpCatalogSessionId),
        requestedCatalog,
      );
      if (
        requestedCatalog.some(
          (definition) => definition.scope === "project" && definition.scopeId !== thread.projectId,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "MCP catalog project definitions do not match the thread project.",
        });
      }
      const activeSessionId = thread.session?.mcpCatalogSessionId;
      if (activeSessionId !== command.mcpCatalogSessionId) {
        const cause = new McpCatalogStaleSessionError({
          threadId: command.threadId,
          requestedSessionId: command.mcpCatalogSessionId,
          activeSessionId: activeSessionId ?? command.mcpCatalogSessionId,
        });
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: cause.message,
          cause,
        });
      }
      const snapshot = readModel.mcpCatalog?.sessions.find(
        (entry) => entry.catalogSessionId === command.mcpCatalogSessionId,
      );
      if (snapshot === undefined || snapshot.disposedAt !== undefined) {
        const cause = new McpCatalogStaleSessionError({
          threadId: command.threadId,
          requestedSessionId: command.mcpCatalogSessionId,
          activeSessionId: command.mcpCatalogSessionId,
        });
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: cause.message,
          cause,
        });
      }
      const actualRevision = snapshot.desiredRevision;
      if (command.expectedRevision !== actualRevision) {
        return yield* catalogRevisionInvariantError(
          command.type,
          "session",
          command.mcpCatalogSessionId,
          command.expectedRevision,
          actualRevision,
        );
      }
      const isUpdate = command.type === "thread.mcp-catalog.update";
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        })),
        type: isUpdate ? "thread.mcp-catalog.updated" : "thread.mcp-catalog.reset",
        payload: isUpdate
          ? {
              threadId: command.threadId,
              mcpCatalogSessionId: command.mcpCatalogSessionId,
              desiredCatalog: command.desiredCatalog,
              desiredRevision: actualRevision + 1,
            }
          : {
              threadId: command.threadId,
              mcpCatalogSessionId: command.mcpCatalogSessionId,
              baseline: command.baseline,
              desiredRevision: actualRevision + 1,
            },
      } as PlannedOrchestrationEvent;
    }

    case "thread.mcp-catalog.dispose":
    case "thread.mcp-catalog.applied":
    case "thread.mcp-catalog.apply-failed": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const snapshot = readModel.mcpCatalog?.sessions.find(
        (entry) => entry.catalogSessionId === command.mcpCatalogSessionId,
      );
      if (command.type === "thread.mcp-catalog.dispose" && snapshot?.disposedAt !== undefined) {
        return yield* makeCatalogSessionDisposeEvent({
          threadId: command.threadId,
          mcpCatalogSessionId: command.mcpCatalogSessionId,
          revision: snapshot.desiredRevision,
          disposedAt: snapshot.disposedAt,
          commandId: command.commandId,
        });
      }
      const activeSessionId = thread.session?.mcpCatalogSessionId;
      if (activeSessionId !== command.mcpCatalogSessionId) {
        const cause = new McpCatalogStaleSessionError({
          threadId: command.threadId,
          requestedSessionId: command.mcpCatalogSessionId,
          activeSessionId: activeSessionId ?? command.mcpCatalogSessionId,
        });
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: cause.message,
          cause,
        });
      }
      if (snapshot === undefined || snapshot.disposedAt !== undefined) {
        const cause = new McpCatalogStaleSessionError({
          threadId: command.threadId,
          requestedSessionId: command.mcpCatalogSessionId,
          activeSessionId: command.mcpCatalogSessionId,
        });
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: cause.message,
          cause,
        });
      }
      const isInitialApplicationReceipt =
        command.revision === 0 &&
        snapshot.appliedRevision === 0 &&
        snapshot.application === undefined;
      if (
        command.type !== "thread.mcp-catalog.dispose" &&
        (command.revision > snapshot.desiredRevision ||
          (command.revision <= snapshot.appliedRevision && !isInitialApplicationReceipt))
      ) {
        return yield* catalogRevisionInvariantError(
          command.type,
          "session",
          command.mcpCatalogSessionId,
          command.revision,
          command.revision > snapshot.desiredRevision
            ? snapshot.desiredRevision
            : snapshot.appliedRevision,
        );
      }
      const eventType =
        command.type === "thread.mcp-catalog.dispose"
          ? "thread.mcp-catalog.disposed"
          : command.type === "thread.mcp-catalog.applied"
            ? "thread.mcp-catalog.applied"
            : "thread.mcp-catalog.apply-failed";
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt:
            command.type === "thread.mcp-catalog.dispose"
              ? command.disposedAt
              : command.type === "thread.mcp-catalog.applied"
                ? command.appliedAt
                : command.failedAt,
          commandId: command.commandId,
        })),
        type: eventType,
        payload:
          command.type === "thread.mcp-catalog.dispose"
            ? {
                threadId: command.threadId,
                mcpCatalogSessionId: command.mcpCatalogSessionId,
                revision: command.revision,
                disposedAt: command.disposedAt,
              }
            : command.type === "thread.mcp-catalog.applied"
              ? {
                  threadId: command.threadId,
                  mcpCatalogSessionId: command.mcpCatalogSessionId,
                  revision: command.revision,
                  appliedAt: command.appliedAt,
                }
              : {
                  threadId: command.threadId,
                  mcpCatalogSessionId: command.mcpCatalogSessionId,
                  revision: command.revision,
                  reason: command.reason,
                  failedAt: command.failedAt,
                },
      } as PlannedOrchestrationEvent;
    }

    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          faviconPath: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workspaceRoot !== undefined) {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: command.defaultThreadEnvMode }
            : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "project.mcp-server.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const existingEntries = (readModel.projectMcpServers ?? []).filter(
        (entry) => entry.projectId === command.projectId,
      );
      if (
        (readModel.projectMcpServers ?? []).some((entry) => entry.server.id === command.server.id)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `MCP server ID '${command.server.id}' is already in use.`,
        });
      }
      yield* rejectCatalogLogicalIdOwner(readModel, command.type, String(command.server.id));
      if (existingEntries.length >= PROJECT_MCP_SERVER_LIMIT) {
        const cause = new ProjectMcpServerLimitExceededError({
          limit: PROJECT_MCP_SERVER_LIMIT,
        });
        return yield* projectMcpInvariantError(command.type, cause);
      }
      if (
        existingEntries.some(
          (entry) =>
            foldProjectMcpName(entry.server.name) === foldProjectMcpName(command.server.name),
        )
      ) {
        const cause = new ProjectMcpNameConflictError({
          name: command.server.name,
          message: `Project already contains an MCP server named '${command.server.name}'.`,
        });
        return yield* projectMcpInvariantError(command.type, cause);
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.mcp-server.created",
        payload: {
          projectId: command.projectId,
          server: command.server,
          createdAt: command.createdAt,
        },
      };
    }

    case "project.mcp-server.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* rejectCatalogLogicalIdOwner(readModel, command.type, String(command.server.id), {
        scope: "project",
        scopeId: String(command.projectId),
      });
      const existingEntries = (readModel.projectMcpServers ?? []).filter(
        (entry) => entry.projectId === command.projectId,
      );
      if (!existingEntries.some((entry) => entry.server.id === command.server.id)) {
        const cause = new ProjectMcpServerNotFoundError({ id: command.server.id });
        return yield* projectMcpInvariantError(command.type, cause);
      }
      if (
        existingEntries.some(
          (entry) =>
            entry.server.id !== command.server.id &&
            foldProjectMcpName(entry.server.name) === foldProjectMcpName(command.server.name),
        )
      ) {
        const cause = new ProjectMcpNameConflictError({
          name: command.server.name,
          message: `Project already contains an MCP server named '${command.server.name}'.`,
        });
        return yield* projectMcpInvariantError(command.type, cause);
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        })),
        type: "project.mcp-server.updated",
        payload: {
          projectId: command.projectId,
          server: command.server,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "project.mcp-server.remove": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (
        !(readModel.projectMcpServers ?? []).some(
          (entry) => entry.projectId === command.projectId && entry.server.id === command.id,
        )
      ) {
        const cause = new ProjectMcpServerNotFoundError({ id: command.id });
        return yield* projectMcpInvariantError(command.type, cause);
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.removedAt,
          commandId: command.commandId,
        })),
        type: "project.mcp-server.removed",
        payload: {
          projectId: command.projectId,
          id: command.id,
          removedAt: command.removedAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const deletedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      } satisfies PlannedOrchestrationEvent;
      const sessionId = thread.session?.mcpCatalogSessionId;
      const snapshot =
        sessionId === undefined
          ? undefined
          : readModel.mcpCatalog?.sessions.find((entry) => entry.catalogSessionId === sessionId);
      if (snapshot !== undefined && snapshot.disposedAt === undefined) {
        return [
          yield* makeCatalogSessionDisposeEvent({
            threadId: command.threadId,
            mcpCatalogSessionId: snapshot.catalogSessionId,
            revision: snapshot.desiredRevision,
            disposedAt: occurredAt,
            commandId: command.commandId,
          }),
          deletedEvent,
        ];
      }
      return deletedEvent;
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Server-side twin of the client's canSettle session check: a stale
      // or raced client must not settle a thread whose session is coming
      // alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has an active session and cannot be settled`,
          }),
        );
      }
      // Pending approval / user-input requests are blocked-on-you work: a
      // raced or stale client must not park them behind a settled override
      // that would surface only after the request resolves.
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be settled`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be settled`,
          }),
        );
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled" as const,
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled ? thread.settledAt : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": clear states that would keep the
      // row pinned or snoozed instead of showing the new settled state.
      const companionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.pinnedAt != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned" as const,
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return companionEvents.length > 0 ? [settledEvent, ...companionEvents] : settledEvent;
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        );
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
          }),
        );
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        );
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.displayText ?? command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          providerText: command.message.text,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-cleanup stops are conditional: between the settle landing and
      // this command, another client may have re-engaged the thread (a turn
      // start unsettles it and brings the session alive). Commands are
      // decided serially against this read model, so checking here — not in
      // the dispatcher's pre-settle snapshot — closes that race.
      if (command.onlyIfSettled === true) {
        const sessionComingAlive =
          thread.session?.status === "starting" || thread.session?.status === "running";
        if (
          thread.settledOverride !== "settled" ||
          sessionComingAlive ||
          threadHasQueuedTurnStart(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      // Only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
