import {
  EventId,
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  MessageId,
  ThreadLinkedPullRequest,
  UserInputRequestedPayload,
  isImportedAgentSessionMessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadPullRequestKey,
  type ThreadPullRequestLink,
  type OrchestrationThreadActivity,
  type CommandId,
  type McpCatalogDefinition,
  type McpCatalogSessionId,
  type ThreadId,
  type ProjectMcpMutationError,
  ProjectMcpNameConflictError,
  ProjectMcpServerLimitExceededError,
  ProjectMcpServerNotFoundError,
  McpCatalogOperationError,
  McpCatalogStaleRevisionError,
  McpCatalogStaleSessionError,
} from "@t3tools/contracts";
import {
  legacyLinkedPullRequestOf,
  legacyThreadPullRequestKey,
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as PlatformError from "effect/PlatformError";

import {
  OrchestrationCommandInvariantError,
  OrchestrationThreadSettleBlockedError,
  type OrchestrationCommandRejection,
} from "./Errors.ts";
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
import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";
import { catalogBaselineForProject, validateEffectiveCatalog } from "../mcp/McpCatalogResolver.ts";

const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const decodeUserInputRequestedPayload = Schema.decodeUnknownOption(UserInputRequestedPayload);
const threadPullRequestLinksEqual = Schema.toEquivalence(Schema.NullOr(ThreadLinkedPullRequest));

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

const validateEffectiveCatalogInvariant = (
  commandType: string,
  definitions: ReadonlyArray<McpCatalogDefinition>,
  providerInstanceIds?: ReadonlyArray<McpCatalogDefinition["providerInstanceIds"][number]>,
) =>
  Effect.try({
    try: () =>
      providerInstanceIds === undefined
        ? validateEffectiveCatalog({ definitions })
        : validateEffectiveCatalog({ definitions, providerInstanceIds }),
    catch: (cause) =>
      new OrchestrationCommandInvariantError({
        commandType,
        detail: cause instanceof Error ? cause.message : "Invalid MCP catalog topology.",
        cause,
      }),
  });

const validatePersistentCatalogInvariant = (
  readModel: OrchestrationReadModel,
  commandType: string,
  input: {
    readonly globalDefinitions: ReadonlyArray<McpCatalogDefinition>;
    readonly projectDefinitions: ReadonlyArray<{
      readonly projectId: OrchestrationReadModel["projects"][number]["id"];
      readonly definition: McpCatalogDefinition;
    }>;
    readonly projectOverrides: ReadonlyArray<{
      readonly projectId: OrchestrationReadModel["projects"][number]["id"];
      readonly override: NonNullable<
        OrchestrationReadModel["mcpCatalog"]
      >["projectOverrides"][number]["override"];
    }>;
    readonly projectId?: OrchestrationReadModel["projects"][number]["id"];
  },
) => {
  const projectIds = new Set<string>();
  if (input.projectId !== undefined) projectIds.add(String(input.projectId));
  else {
    for (const project of readModel.projects) {
      if (project.deletedAt === null) projectIds.add(String(project.id));
    }
    for (const entry of input.projectDefinitions) projectIds.add(String(entry.projectId));
    for (const entry of input.projectOverrides) projectIds.add(String(entry.projectId));
  }

  return Effect.gen(function* () {
    yield* validateEffectiveCatalogInvariant(commandType, input.globalDefinitions);
    yield* Effect.forEach(
      projectIds,
      (projectId) =>
        validateEffectiveCatalogInvariant(
          commandType,
          catalogBaselineForProject({
            globalDefinitions: input.globalDefinitions,
            projectDefinitions: input.projectDefinitions.map((entry) => entry.definition),
            projectOverrides: input.projectOverrides.map((entry) => entry.override),
            projectId,
          }),
        ),
      { discard: true },
    );
  });
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

const catalogOperationInvariantError = (
  commandType: string,
  message: string,
): OrchestrationCommandInvariantError => {
  const cause = new McpCatalogOperationError({ message });
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
// recent 500 plus pending async questions. Async questions remain actionable
// while the agent works, so they must not expire with the activity window.
function openRequests(thread: Pick<OrchestrationThread, "activities">) {
  const requests = new Map<string, OrchestrationThreadActivity>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      requests.set(requestId, activity);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      requests.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      requests.delete(requestId);
    }
  }
  return requests;
}

/** Apply the shared shell-level rule to the detailed command read model. */
function hasQueuedTurnStartForThread(
  thread: Pick<OrchestrationThread, "messages" | "latestTurn" | "session">,
  now: string,
): boolean {
  let latestUserMessageAt: string | null = null;
  let latestUserMessageAtMs = Number.NEGATIVE_INFINITY;
  for (const message of thread.messages) {
    if (message.role !== "user" || isImportedAgentSessionMessageId(message.id)) continue;
    const messageAtMs = Date.parse(message.createdAt);
    latestUserMessageAtMs = Math.max(latestUserMessageAtMs, messageAtMs);
    if (messageAtMs === latestUserMessageAtMs) {
      latestUserMessageAt = message.createdAt;
    }
  }
  return threadHasQueuedTurnStart(
    {
      latestUserMessageAt: Number.isFinite(latestUserMessageAtMs) ? latestUserMessageAt : null,
      latestTurn: thread.latestTurn,
      session: thread.session,
    },
    now,
  );
}

function findPullRequestLink(
  thread: Pick<OrchestrationThread, "pullRequests">,
  key: ThreadPullRequestKey,
): ThreadPullRequestLink | undefined {
  return thread.pullRequests.find((link) => threadPullRequestKeysEqual(link, key));
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
  OrchestrationCommandRejection | PlatformError.PlatformError,
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
  userInputActivity,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly userInputActivity?: OrchestrationThreadActivity;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandRejection | PlatformError.PlatformError,
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
      const globalDefinitions =
        command.type === "environment.mcp-definition.create"
          ? [...(readModel.mcpCatalog?.globalDefinitions ?? []), command.definition]
          : (readModel.mcpCatalog?.globalDefinitions ?? []).map((definition) =>
              definition.logicalServerId === command.definition.logicalServerId
                ? command.definition
                : definition,
            );
      yield* validatePersistentCatalogInvariant(readModel, command.type, {
        globalDefinitions,
        projectDefinitions: readModel.mcpCatalog?.projectDefinitions ?? [],
        projectOverrides: readModel.mcpCatalog?.projectOverrides ?? [],
      });
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
      if (definitionId === undefined) {
        return yield* catalogOperationInvariantError(
          command.type,
          "Global MCP definition was not found.",
        );
      }
      yield* validatePersistentCatalogInvariant(readModel, command.type, {
        globalDefinitions: (readModel.mcpCatalog?.globalDefinitions ?? []).filter(
          (definition) => definition.logicalServerId !== command.logicalServerId,
        ),
        projectDefinitions: readModel.mcpCatalog?.projectDefinitions ?? [],
        projectOverrides: (readModel.mcpCatalog?.projectOverrides ?? []).filter(
          (entry) => entry.override.targetId !== command.logicalServerId,
        ),
      });
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
      const projectDefinitions = readModel.mcpCatalog?.projectDefinitions ?? [];
      const nextDefinition =
        command.type === "project.mcp-definition.create"
          ? [
              ...projectDefinitions,
              { projectId: command.projectId, definition: command.definition },
            ]
          : projectDefinitions.map((entry) =>
              entry.projectId === command.projectId &&
              entry.definition.logicalServerId === command.definition.logicalServerId
                ? { projectId: command.projectId, definition: command.definition }
                : entry,
            );
      yield* validatePersistentCatalogInvariant(readModel, command.type, {
        globalDefinitions: readModel.mcpCatalog?.globalDefinitions ?? [],
        projectDefinitions: nextDefinition,
        projectOverrides: readModel.mcpCatalog?.projectOverrides ?? [],
        projectId: command.projectId,
      });
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
      if (definitionId === undefined) {
        return yield* catalogOperationInvariantError(
          command.type,
          "Project MCP definition was not found.",
        );
      }
      yield* validatePersistentCatalogInvariant(readModel, command.type, {
        globalDefinitions: readModel.mcpCatalog?.globalDefinitions ?? [],
        projectDefinitions: (readModel.mcpCatalog?.projectDefinitions ?? []).filter(
          (entry) =>
            !(
              entry.projectId === command.projectId &&
              entry.definition.logicalServerId === command.logicalServerId
            ),
        ),
        projectOverrides: readModel.mcpCatalog?.projectOverrides ?? [],
        projectId: command.projectId,
      });
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
      if (
        command.override.scope !== "project" ||
        String(command.override.scopeId) !== String(command.projectId)
      ) {
        return yield* catalogOperationInvariantError(
          command.type,
          "MCP project override scope does not match the command project.",
        );
      }
      if (
        !readModel.mcpCatalog?.globalDefinitions.some(
          (definition) => definition.logicalServerId === command.override.targetId,
        )
      ) {
        return yield* catalogOperationInvariantError(
          command.type,
          "MCP project override target was not found in the inherited global catalog.",
        );
      }
      if (
        readModel.mcpCatalog?.projectOverrides.some(
          (entry) =>
            entry.override.id === command.override.id && entry.projectId !== command.projectId,
        )
      ) {
        return yield* catalogOperationInvariantError(
          command.type,
          "MCP project override ID is already owned by another project.",
        );
      }
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
      yield* validatePersistentCatalogInvariant(readModel, command.type, {
        globalDefinitions: readModel.mcpCatalog?.globalDefinitions ?? [],
        projectDefinitions: readModel.mcpCatalog?.projectDefinitions ?? [],
        projectOverrides: [
          ...(readModel.mcpCatalog?.projectOverrides ?? []).filter(
            (entry) =>
              !(entry.projectId === command.projectId && entry.override.id === command.override.id),
          ),
          { projectId: command.projectId, override: command.override },
        ],
        projectId: command.projectId,
      });
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
      if (
        !readModel.mcpCatalog?.projectOverrides.some(
          (entry) =>
            entry.projectId === command.projectId && entry.override.id === command.overrideId,
        )
      ) {
        return yield* catalogOperationInvariantError(
          command.type,
          "MCP project override was not found.",
        );
      }
      yield* validatePersistentCatalogInvariant(readModel, command.type, {
        globalDefinitions: readModel.mcpCatalog?.globalDefinitions ?? [],
        projectDefinitions: readModel.mcpCatalog?.projectDefinitions ?? [],
        projectOverrides: (readModel.mcpCatalog?.projectOverrides ?? []).filter(
          (entry) =>
            !(entry.projectId === command.projectId && entry.override.id === command.overrideId),
        ),
        projectId: command.projectId,
      });
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
      yield* validateEffectiveCatalogInvariant(command.type, command.snapshot.baseline, [
        command.snapshot.providerInstanceId,
      ]);
      yield* validateEffectiveCatalogInvariant(command.type, command.snapshot.desired, [
        command.snapshot.providerInstanceId,
      ]);
      yield* validateCatalogDefinitions(
        readModel,
        command.type,
        String(command.snapshot.catalogSessionId),
        command.snapshot.applied,
      );
      yield* validateEffectiveCatalogInvariant(command.type, command.snapshot.applied, [
        command.snapshot.providerInstanceId,
      ]);
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
      yield* validateEffectiveCatalogInvariant(command.type, requestedCatalog, [
        snapshot.providerInstanceId,
      ]);
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
      if (command.type === "thread.mcp-catalog.applied") {
        const appliedCatalog = command.appliedCatalog ?? snapshot.desired;
        yield* validateCatalogDefinitions(
          readModel,
          command.type,
          String(command.mcpCatalogSessionId),
          appliedCatalog,
        );
        yield* validateEffectiveCatalogInvariant(command.type, appliedCatalog, [
          snapshot.providerInstanceId,
        ]);
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
                  ...(command.appliedCatalog === undefined
                    ? {}
                    : { appliedCatalog: command.appliedCatalog }),
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
          // Project creation has no user model choice. Older clients sent an
          // automatic seed here, but only a metadata update records an
          // explicit project default.
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.scripts !== undefined) {
        // Persisted IDs predate shortcut validation. Let users edit or remove them
        // without allowing another invalid ID to enter the project.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Script ID '${script.id}' must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit.`,
            });
          }
        }
      }
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
          ...(command.autoPull !== undefined ? { autoPull: command.autoPull } : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.projectIcon !== undefined ? { projectIcon: command.projectIcon } : {}),
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
          ...(command.historyImport === true ? { metadata: { historyImport: true } } : {}),
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

    case "thread.settle":
    case "thread.auto-settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.type === "thread.auto-settle" && thread.settledOverride !== null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} changed before automatic settlement`,
          }),
        );
      }
      // The server owns settle eligibility. A stale command must not settle
      // a thread whose session is coming alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      const pendingRequests = openRequests(thread);
      // Manual settlement dismisses async questions without answering them.
      // Native callbacks and approvals still need a response or interruption.
      if (
        Array.from(pendingRequests.values()).some(
          (activity) =>
            command.type === "thread.auto-settle" ||
            activity.kind !== "user-input.requested" ||
            !Predicate.isObject(activity.payload) ||
            activity.payload.responseMode !== "message",
        )
      ) {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (hasQueuedTurnStartForThread(thread, occurredAt)) {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
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
          settledAt: alreadySettled
            ? thread.settledAt
            : command.type === "thread.auto-settle"
              ? command.settledAt
              : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": clear states that would keep the
      // row pinned or snoozed instead of showing the new settled state.
      const companionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      for (const [requestId, request] of pendingRequests) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.activity-appended",
          payload: {
            threadId: command.threadId,
            activity: {
              id: EventId.make(`settle:${command.commandId}:${requestId}`),
              kind: "user-input.resolved",
              summary: "User input dismissed",
              tone: "info",
              turnId: request.turnId,
              createdAt: occurredAt,
              payload: { requestId, responseMode: "message" },
            },
          },
        });
      }
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
      if (openRequests(thread).size > 0) {
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
      if (hasQueuedTurnStartForThread(thread, occurredAt)) {
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

    case "thread.active.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Snooze retains this slot. Changing it cannot wake the thread, and
      // accepting it handles races with snooze and retained wake timestamps.
      if (
        thread.deletedAt !== null ||
        thread.pinnedAt != null ||
        thread.settledOverride === "settled"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} is not active and cannot be reordered`,
        });
      }
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
          activeOrderKey: command.orderKey,
          // Arranging the list is not thread activity or a lifecycle transition.
          updatedAt: thread.updatedAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Old clients only see the derived single link. Unlink that request through
      // the same command path as modern clients, including stack dismissal, while
      // retaining other links they cannot see. Historical metadata events still replay unchanged.
      const legacy = legacyLinkedPullRequestOf(
        thread.pullRequests,
        thread.projectId,
        readModel.projects.find((project) => project.id === thread.projectId)?.repositoryIdentity,
      );
      const currentPullRequest =
        legacy === null
          ? null
          : (thread.pullRequests.find(
              (link) => link.url === legacy.url && link.number === legacy.number,
            ) ?? null);
      if (command.linkedPullRequest != null) {
        const { linkedPullRequest: linked, ...metadata } = command;
        const project = readModel.projects.find((project) => project.id === thread.projectId);
        let host = project?.repositoryIdentity?.canonicalKey.split("/")[0] ?? "unknown";
        try {
          host = new URL(linked.url).hostname;
        } catch {
          // Historical clients can send links without a parseable URL.
        }
        const hasMetadata = Object.entries(metadata).some(
          ([key, value]) => !["type", "commandId", "threadId"].includes(key) && value !== undefined,
        );
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...(hasMetadata ? [metadata] : []),
            ...(currentPullRequest?.source === "manual"
              ? [
                  {
                    type: "thread.pull-request.unlink" as const,
                    commandId: command.commandId,
                    threadId: command.threadId,
                    host: currentPullRequest.host,
                    repository: currentPullRequest.repository,
                    number: currentPullRequest.number,
                  },
                ]
              : []),
            {
              type: "thread.pull-request.link",
              commandId: command.commandId,
              threadId: command.threadId,
              ...legacyThreadPullRequestKey(linked, host),
              url: linked.url,
              source: "manual",
            },
          ],
        });
      }

      if (command.linkedPullRequest === null && currentPullRequest !== null) {
        const { linkedPullRequest: _linkedPullRequest, ...metadata } = command;
        const hasMetadata = Object.entries(metadata).some(
          ([key, value]) => !["type", "commandId", "threadId"].includes(key) && value !== undefined,
        );
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...(hasMetadata ? [metadata] : []),
            {
              type: "thread.pull-request.unlink",
              commandId: command.commandId,
              threadId: command.threadId,
              host: currentPullRequest.host,
              repository: currentPullRequest.repository,
              number: currentPullRequest.number,
            },
          ],
        });
      }
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
          ...(command.title !== undefined
            ? {
                title: command.title,
                titleState: {
                  source: "manual" as const,
                  version: command.commandId,
                  needsRefinement: false,
                },
              }
            : {}),
          ...(command.regenerateTitle === true
            ? {
                titleState: {
                  source: "generated" as const,
                  version: command.commandId,
                  needsRefinement: false,
                },
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

    case "thread.pull-request.link": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const key = normalizeThreadPullRequestKey(command);
      const existing = findPullRequestLink(thread, key);
      // An explicit link on a dismissed stack member un-dismisses it; any
      // other duplicate is a no-op the engine would reject as zero-event.
      const undismisses =
        existing?.source === "stack-dismissed" &&
        (command.source === "manual" || command.source === "agent" || command.source === "created");
      if (existing !== undefined && !undismisses) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `pull request ${key.host}/${key.repository}#${key.number} is already linked to thread ${command.threadId}`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pull-request-linked",
        payload: {
          threadId: command.threadId,
          link:
            existing !== undefined
              ? { ...existing, url: command.url, source: command.source }
              : {
                  ...key,
                  url: command.url,
                  source: command.source,
                  linkedAt: occurredAt,
                  snapshot: null,
                  stack: null,
                },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request.unlink": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const key = normalizeThreadPullRequestKey(command);
      const existing = findPullRequestLink(thread, key);
      if (existing === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `pull request ${key.host}/${key.repository}#${key.number} is not linked to thread ${command.threadId}`,
        });
      }
      const occurredAt = yield* nowIso;
      const eventBase = yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt,
        commandId: command.commandId,
      });
      // Any known native-stack member needs a tombstone, regardless of who linked it.
      // A sibling can rediscover it even before this link has its own stack snapshot.
      const belongsToStack =
        existing.source === "stack" ||
        existing.stack !== null ||
        thread.pullRequests.some(
          (link) =>
            link.host.toLowerCase() === key.host &&
            link.repository.toLowerCase() === key.repository &&
            link.stack?.layers.some((layer) => layer.number === key.number),
        );
      if (belongsToStack) {
        return {
          ...eventBase,
          type: "thread.pull-request-linked",
          payload: {
            threadId: command.threadId,
            link: { ...existing, source: "stack-dismissed" },
            updatedAt: occurredAt,
          },
        };
      }
      return {
        ...eventBase,
        type: "thread.pull-request-unlinked",
        payload: {
          threadId: command.threadId,
          ...key,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request-link.sync": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const key = normalizeThreadPullRequestKey(command);
      if (findPullRequestLink(thread, key) === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `pull request ${key.host}/${key.repository}#${key.number} is not linked to thread ${command.threadId}`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pull-request-synced",
        payload: {
          threadId: command.threadId,
          ...key,
          snapshot: command.snapshot,
          stack: command.stack,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request.sync": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} was deleted before pull request discovery`,
        });
      }
      if (
        thread.projectId !== command.projectId ||
        thread.branch !== command.expected.branch ||
        thread.worktreePath !== command.expected.worktreePath ||
        !threadPullRequestLinksEqual(
          thread.linkedPullRequest ?? null,
          command.expected.linkedPullRequest,
        ) ||
        !threadPullRequestLinksEqual(
          thread.branchPullRequest ?? null,
          command.expected.branchPullRequest,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} changed before pull request discovery`,
        });
      }
      const project = yield* requireProject({ readModel, command, projectId: command.projectId });
      if (project.deletedAt !== null || project.workspaceRoot !== command.expected.workspaceRoot) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `project ${command.projectId} changed before pull request discovery`,
        });
      }
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
          branchPullRequest: command.branchPullRequest,
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: thread.updatedAt,
        },
      };
    }

    case "thread.title.generate.complete": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current =
        thread.deletedAt === null &&
        thread.titleState?.source !== "manual" &&
        thread.title === command.expectedTitle &&
        (thread.titleState?.version ?? null) === command.expectedVersion &&
        thread.titleRegeneration == null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: yield* nowIso,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(current
            ? {
                title: command.title,
                titleState: {
                  source: "generated" as const,
                  version: command.commandId,
                  needsRefinement: command.needsRefinement,
                },
              }
            : {}),
          updatedAt: thread.updatedAt,
        },
      };
    }

    case "thread.title.refine": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current =
        thread.deletedAt === null &&
        thread.latestTurn?.state === "completed" &&
        thread.session?.status === "ready" &&
        thread.titleState?.source === "generated" &&
        thread.titleState.version === command.expectedVersion &&
        thread.titleState.needsRefinement &&
        thread.titleRegeneration == null;
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
          ...(current
            ? {
                titleState: {
                  source: "generated" as const,
                  version: command.commandId,
                  needsRefinement: false,
                },
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: { requestId: command.commandId, startedAt: occurredAt },
              }
            : {}),
          updatedAt: thread.updatedAt,
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
      if (isImportedAgentSessionMessageId(command.message.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.message.messageId}' uses the reserved imported-session namespace.`,
        });
      }
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
          ...(command.message.context !== undefined ? { context: command.message.context } : {}),
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
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const request = userInputActivity;
      const attachments = Object.values(command.attachmentsByQuestionId ?? {}).flat();
      let questionTextById: Record<string, string> = {};
      if (attachments.length > 0) {
        const payload =
          request?.kind === "user-input.requested"
            ? decodeUserInputRequestedPayload(request.payload)
            : Option.none();
        if (Option.isNone(payload)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              request?.kind === "user-input.resolved"
                ? "This question has already been answered."
                : "This question is no longer pending.",
          });
        }
        questionTextById = Object.fromEntries(
          payload.value.questions.map((question) => [question.id, question.question]),
        );
        for (const questionId of Object.keys(command.attachmentsByQuestionId ?? {})) {
          const question = payload.value.questions.find((question) => question.id === questionId);
          if (!question || question.allowCustomAnswer === false) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "This question does not accept file references.",
            });
          }
        }
      }
      if (
        request &&
        Predicate.isObject(request.payload) &&
        request.payload.responseMode === "message"
      ) {
        const payload = decodeUserInputRequestedPayload(request.payload);
        if (request.kind !== "user-input.requested" || Option.isNone(payload)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "This question has already been answered.",
          });
        }
        const replies: string[] = [];
        for (const question of payload.value.questions) {
          const answer = command.answers[question.id];
          if (
            typeof answer !== "string" ||
            (answer.trim().length === 0 && !command.attachmentsByQuestionId?.[question.id]?.length)
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Answer each question before sending.",
            });
          }
          const questionAttachments = command.attachmentsByQuestionId?.[question.id] ?? [];
          const attachmentLabels = questionAttachments
            .map((attachment) => `Attached file: ${attachment.name} (${attachment.id})`)
            .join("\n");
          replies.push(
            [`${question.question}\n${answer.trim()}`, attachmentLabels].filter(Boolean).join("\n"),
          );
        }
        // Commit the answer and its message together. The normal turn path
        // steers a running agent or resumes an idle session.
        return yield* decideCommandSequence({
          readModel,
          commands: [
            {
              type: "thread.activity.append",
              commandId: command.commandId,
              threadId: command.threadId,
              createdAt: command.createdAt,
              activity: {
                id: EventId.make(`async-answer:${command.requestId}`),
                kind: "user-input.resolved",
                summary: "User input submitted",
                tone: "info",
                turnId: request.turnId,
                createdAt: command.createdAt,
                payload: {
                  requestId: command.requestId,
                  responseMode: "message",
                  answers: command.answers,
                  ...(command.attachmentsByQuestionId
                    ? { attachmentsByQuestionId: command.attachmentsByQuestionId }
                    : {}),
                },
              },
            },
            {
              type: "thread.turn.start",
              commandId: command.commandId,
              threadId: command.threadId,
              createdAt: command.createdAt,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              message: {
                messageId: MessageId.make(`async-answer:${command.requestId}`),
                role: "user",
                text: replies.join("\n\n"),
                attachments,
              },
            },
          ],
        });
      }
      const responseEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: { requestId: command.requestId },
        })),
        type: "thread.user-input-response-requested" as const,
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          ...(command.attachmentsByQuestionId
            ? { attachmentsByQuestionId: command.attachmentsByQuestionId }
            : {}),
          createdAt: command.createdAt,
        },
      };
      if (attachments.length === 0) return responseEvent;
      const historyEvent = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.activity.append",
          commandId: command.commandId,
          threadId: command.threadId,
          createdAt: command.createdAt,
          activity: {
            id: EventId.make(`question-answer:${command.commandId}`),
            kind: "user-input.answer-submitted",
            summary: "Question answer submitted",
            tone: "info",
            turnId: request?.turnId ?? null,
            createdAt: command.createdAt,
            payload: {
              requestId: command.requestId,
              answers: command.answers,
              questionTextById,
              attachmentsByQuestionId: command.attachmentsByQuestionId,
              detail: attachments.map((attachment) => attachment.name).join("\n"),
            },
          },
        },
      });
      return [...(Array.isArray(historyEvent) ? historyEvent : [historyEvent]), responseEvent];
    }

    case "thread.user-input.dismiss": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const request = userInputActivity;
      if (request === undefined || request.kind !== "user-input.requested") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question has already been answered.",
        });
      }
      // Only async questions can be dropped silently. A native callback
      // question leaves the provider blocked until it gets a reply, so it
      // still needs an answer or an interrupted turn.
      if (!Predicate.isObject(request.payload) || request.payload.responseMode !== "message") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question needs an answer. Answer it or stop the turn.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: {
            id: EventId.make(`async-dismiss:${command.requestId}`),
            kind: "user-input.resolved",
            summary: "User input dismissed",
            tone: "info",
            turnId: request.turnId,
            createdAt: command.createdAt,
            payload: { requestId: command.requestId, responseMode: "message" },
          },
        },
      };
    }

    case "thread.conversation.revert":
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
          ...(command.type === "thread.conversation.revert" ? { restoreFiles: false } : {}),
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
          hasQueuedTurnStartForThread(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      const stopEvent = {
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
          ...(command.onlyIfSettled === undefined ? {} : { onlyIfSettled: command.onlyIfSettled }),
        },
      } satisfies PlannedOrchestrationEvent;
      if (command.onlyIfSettled === true) return stopEvent;

      const catalogSessionId = thread.session?.mcpCatalogSessionId;
      const catalogSnapshot =
        catalogSessionId === undefined
          ? undefined
          : readModel.mcpCatalog?.sessions.find(
              (snapshot) => snapshot.catalogSessionId === catalogSessionId,
            );
      if (catalogSessionId === undefined || catalogSnapshot?.disposedAt !== undefined) {
        return stopEvent;
      }
      if (catalogSnapshot === undefined) return stopEvent;
      const disposeEvent = yield* makeCatalogSessionDisposeEvent({
        threadId: command.threadId,
        mcpCatalogSessionId: catalogSessionId,
        revision: catalogSnapshot.desiredRevision,
        disposedAt: command.createdAt,
        commandId: command.commandId,
      });
      return [stopEvent, disposeEvent];
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
          // Provider runtime events only describe native-session state. They
          // do not know the durable catalog identity, so retain it until a
          // catalog command explicitly replaces or disposes it.
          session:
            command.session.mcpCatalogSessionId === undefined &&
            thread.session?.mcpCatalogSessionId !== undefined
              ? {
                  ...command.session,
                  mcpCatalogSessionId: thread.session.mcpCatalogSessionId,
                }
              : command.session,
          ...(command.turnProvenance === undefined
            ? {}
            : { turnProvenance: command.turnProvenance }),
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
      if (isImportedAgentSessionMessageId(command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.messageId}' uses the reserved imported-session namespace.`,
        });
      }
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
      if (isImportedAgentSessionMessageId(command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.messageId}' uses the reserved imported-session namespace.`,
        });
      }
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

    case "thread.history.import": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.messages.length > 0 ||
        thread.latestTurn !== null ||
        thread.session !== null ||
        openRequests(thread).size > 0
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' must be active and empty before history can be imported.`,
        });
      }
      const firstMessage = command.messages[0];
      if (firstMessage === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Thread history imports require at least one message.",
        });
      }

      const events: Array<PlannedOrchestrationEvent> = [];
      for (const message of command.messages) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: message.createdAt,
            commandId: command.commandId,
            metadata: { historyImport: true },
          })),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            turnId: null,
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
          },
        });
      }
      const settledAt = command.messages.reduce(
        (latest, message) =>
          compareDateTimeStrings(message.createdAt, latest) > 0 ? message.createdAt : latest,
        firstMessage.createdAt,
      );
      events.push({
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: settledAt,
          commandId: command.commandId,
          metadata: { historyImport: true },
        })),
        type: "thread.settled",
        payload: {
          threadId: command.threadId,
          settledAt,
          updatedAt: settledAt,
        },
      });
      return events;
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
