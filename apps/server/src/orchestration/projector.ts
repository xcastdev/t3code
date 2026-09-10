import type {
  McpCatalogDefinition,
  McpCatalogSnapshot,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  getProjectMcpTransport,
  McpDefinitionId,
  McpServerId,
  type ProjectMcpServer,
  EnvironmentId,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMcpServerCreatedPayload,
  ProjectMcpServerRemovedPayload,
  ProjectMcpServerUpdatedPayload,
  ProjectMetaUpdatedPayload,
  EnvironmentMcpDefinitionCreatedPayload,
  EnvironmentMcpDefinitionUpdatedPayload,
  EnvironmentMcpDefinitionRemovedPayload,
  ProjectMcpDefinitionCreatedPayload,
  ProjectMcpDefinitionUpdatedPayload,
  ProjectMcpDefinitionRemovedPayload,
  ProjectMcpOverrideUpsertedPayload,
  ProjectMcpOverrideRemovedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSettledPayload,
  ThreadPinnedPayload,
  ThreadPinReorderedPayload,
  ThreadSnoozedPayload,
  ThreadUnpinnedPayload,
  ThreadUnarchivedPayload,
  ThreadUnsettledPayload,
  ThreadUnsnoozedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadMcpCatalogInitializedPayload,
  ThreadMcpCatalogUpdatedPayload,
  ThreadMcpCatalogResetPayload,
  ThreadMcpCatalogDisposedPayload,
  ThreadMcpCatalogAppliedPayload,
  ThreadMcpCatalogApplyFailedPayload,
} from "./Schemas.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function decodeForEvent<A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:${field}`)),
  );
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

type McpCatalogReadModel = NonNullable<OrchestrationReadModel["mcpCatalog"]>;

function ensureMcpCatalog(
  model: OrchestrationReadModel,
  environmentId: McpCatalogReadModel["environmentId"],
): McpCatalogReadModel {
  return (
    model.mcpCatalog ?? {
      environmentId,
      globalRevision: 0,
      globalDefinitions: [],
      projectRevisions: [],
      projectDefinitions: [],
      projectOverrides: [],
      sessions: [],
    }
  );
}

function replaceCatalogSession(
  sessions: ReadonlyArray<McpCatalogSnapshot>,
  snapshot: McpCatalogSnapshot,
): McpCatalogSnapshot[] {
  return [
    ...sessions.filter((entry) => entry.catalogSessionId !== snapshot.catalogSessionId),
    snapshot,
  ];
}

function withProjectCatalogRevision(
  catalog: McpCatalogReadModel,
  projectId: string,
  revision: number,
): McpCatalogReadModel {
  return {
    ...catalog,
    projectRevisions: [
      ...catalog.projectRevisions.filter((entry) => entry.projectId !== projectId),
      { projectId: projectId as ProjectId, revision },
    ],
  };
}

function upsertProjectCatalogDefinition(
  model: OrchestrationReadModel,
  projectId: string,
  definition: McpCatalogDefinition,
  revision: number,
): OrchestrationReadModel {
  const catalog = withProjectCatalogRevision(
    ensureMcpCatalog(model, model.mcpCatalog?.environmentId ?? EnvironmentId.make("unknown")),
    projectId,
    revision,
  );
  const server: ProjectMcpServer = {
    id: definition.logicalServerId,
    name: definition.name,
    transport: definition.transport,
    enabled: definition.enabled,
    providerInstanceIds: definition.providerInstanceIds,
  };
  return {
    ...model,
    projectMcpServers: [
      ...(model.projectMcpServers ?? []).filter(
        (entry) =>
          !(entry.projectId === projectId && entry.server.id === definition.logicalServerId),
      ),
      { projectId: projectId as ProjectId, server },
    ],
    mcpCatalog: {
      ...catalog,
      projectDefinitions: [
        ...catalog.projectDefinitions.filter(
          (entry) =>
            !(
              entry.projectId === projectId &&
              entry.definition.logicalServerId === definition.logicalServerId
            ),
        ),
        { projectId: projectId as ProjectId, definition },
      ],
    },
  };
}

function removeProjectCatalogDefinition(
  model: OrchestrationReadModel,
  projectId: string,
  logicalServerId: McpServerId,
  revision: number,
): OrchestrationReadModel {
  const catalog = withProjectCatalogRevision(
    ensureMcpCatalog(model, model.mcpCatalog?.environmentId ?? EnvironmentId.make("unknown")),
    projectId,
    revision,
  );
  return {
    ...model,
    projectMcpServers: (model.projectMcpServers ?? []).filter(
      (entry) => !(entry.projectId === projectId && entry.server.id === logicalServerId),
    ),
    mcpCatalog: {
      ...catalog,
      projectDefinitions: catalog.projectDefinitions.filter(
        (entry) =>
          !(entry.projectId === projectId && entry.definition.logicalServerId === logicalServerId),
      ),
    },
  };
}

function legacyCatalogDefinition(
  server: ProjectMcpServer,
  projectId: string,
  revision: number,
): McpCatalogDefinition {
  return {
    definitionId: McpDefinitionId.make(`legacy-project-mcp-${server.id}`),
    logicalServerId: server.id,
    scope: "project",
    scopeId: projectId,
    name: server.name as never,
    transport: getProjectMcpTransport(server),
    enabled: server.enabled,
    providerInstanceIds: server.providerInstanceIds,
    revision,
  };
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    projectMcpServers: [],
    threads: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            defaultThreadEnvMode: null,
            faviconPath: payload.faviconPath ?? null,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.defaultThreadEnvMode !== undefined
                    ? { defaultThreadEnvMode: payload.defaultThreadEnvMode }
                    : {}),
                  ...(payload.faviconPath !== undefined
                    ? { faviconPath: payload.faviconPath }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const catalog = nextBase.mcpCatalog;
          return {
            ...nextBase,
            projects: nextBase.projects.map((project) =>
              project.id === payload.projectId
                ? {
                    ...project,
                    deletedAt: payload.deletedAt,
                    updatedAt: payload.deletedAt,
                  }
                : project,
            ),
            projectMcpServers: (nextBase.projectMcpServers ?? []).filter(
              (entry) => entry.projectId !== payload.projectId,
            ),
            ...(catalog === undefined
              ? {}
              : {
                  mcpCatalog: {
                    ...catalog,
                    projectDefinitions: catalog.projectDefinitions.filter(
                      (entry) => entry.projectId !== payload.projectId,
                    ),
                    projectOverrides: catalog.projectOverrides.filter(
                      (entry) => entry.projectId !== payload.projectId,
                    ),
                  },
                }),
          };
        }),
      );

    case "project.mcp-server.created":
      return decodeForEvent(
        ProjectMcpServerCreatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const base = {
            ...nextBase,
            projectMcpServers: [
              ...(nextBase.projectMcpServers ?? []).filter(
                (entry) => entry.server.id !== payload.server.id,
              ),
              { projectId: payload.projectId, server: payload.server },
            ],
          };
          const currentRevision =
            base.mcpCatalog?.projectRevisions.find((entry) => entry.projectId === payload.projectId)
              ?.revision ?? 0;
          return upsertProjectCatalogDefinition(
            base,
            payload.projectId,
            legacyCatalogDefinition(payload.server, payload.projectId, currentRevision + 1),
            currentRevision + 1,
          );
        }),
      );

    case "project.mcp-server.updated":
      return decodeForEvent(
        ProjectMcpServerUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const base = {
            ...nextBase,
            projectMcpServers: (nextBase.projectMcpServers ?? []).map((entry) =>
              entry.projectId === payload.projectId && entry.server.id === payload.server.id
                ? { projectId: payload.projectId, server: payload.server }
                : entry,
            ),
          };
          const currentRevision =
            base.mcpCatalog?.projectRevisions.find((entry) => entry.projectId === payload.projectId)
              ?.revision ?? 0;
          return upsertProjectCatalogDefinition(
            base,
            payload.projectId,
            legacyCatalogDefinition(payload.server, payload.projectId, currentRevision + 1),
            currentRevision + 1,
          );
        }),
      );

    case "project.mcp-server.removed":
      return decodeForEvent(
        ProjectMcpServerRemovedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const base = {
            ...nextBase,
            projectMcpServers: (nextBase.projectMcpServers ?? []).filter(
              (entry) => !(entry.projectId === payload.projectId && entry.server.id === payload.id),
            ),
          };
          const currentRevision =
            base.mcpCatalog?.projectRevisions.find((entry) => entry.projectId === payload.projectId)
              ?.revision ?? 0;
          return removeProjectCatalogDefinition(
            base,
            payload.projectId,
            payload.id,
            currentRevision + 1,
          );
        }),
      );

    case "environment.mcp-definition.created":
      return decodeForEvent(
        EnvironmentMcpDefinitionCreatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const catalog = ensureMcpCatalog(nextBase, payload.environmentId);
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              environmentId: payload.environmentId,
              globalRevision: payload.revision,
              globalDefinitions: [
                ...catalog.globalDefinitions.filter(
                  (entry) => entry.logicalServerId !== payload.definition.logicalServerId,
                ),
                payload.definition,
              ],
            },
          };
        }),
      );

    case "environment.mcp-definition.updated":
      return decodeForEvent(
        EnvironmentMcpDefinitionUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const catalog = ensureMcpCatalog(nextBase, payload.environmentId);
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              environmentId: payload.environmentId,
              globalRevision: payload.revision,
              globalDefinitions: [
                ...catalog.globalDefinitions.filter(
                  (entry) => entry.logicalServerId !== payload.definition.logicalServerId,
                ),
                payload.definition,
              ],
            },
          };
        }),
      );

    case "environment.mcp-definition.removed":
      return decodeForEvent(
        EnvironmentMcpDefinitionRemovedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const catalog = ensureMcpCatalog(nextBase, payload.environmentId);
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              environmentId: payload.environmentId,
              globalRevision: payload.revision,
              globalDefinitions: catalog.globalDefinitions.filter(
                (entry) => entry.logicalServerId !== payload.logicalServerId,
              ),
              // Overrides can only target global definitions, so a removed
              // definition takes its overrides with it instead of leaving
              // rows that nothing can resolve or delete.
              projectOverrides: catalog.projectOverrides.filter(
                (entry) => entry.override.targetId !== payload.logicalServerId,
              ),
            },
          };
        }),
      );

    case "project.mcp-definition.created":
      return decodeForEvent(
        ProjectMcpDefinitionCreatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          upsertProjectCatalogDefinition(
            nextBase,
            payload.projectId,
            payload.definition,
            payload.revision,
          ),
        ),
      );

    case "project.mcp-definition.updated":
      return decodeForEvent(
        ProjectMcpDefinitionUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          upsertProjectCatalogDefinition(
            nextBase,
            payload.projectId,
            payload.definition,
            payload.revision,
          ),
        ),
      );

    case "project.mcp-definition.removed":
      return decodeForEvent(
        ProjectMcpDefinitionRemovedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          removeProjectCatalogDefinition(
            nextBase,
            payload.projectId,
            payload.logicalServerId,
            payload.revision,
          ),
        ),
      );

    case "project.mcp-override.upserted":
      return decodeForEvent(
        ProjectMcpOverrideUpsertedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          if (
            payload.override.scope !== "project" ||
            String(payload.override.scopeId) !== String(payload.projectId)
          ) {
            return nextBase;
          }
          const catalog = ensureMcpCatalog(
            nextBase,
            nextBase.mcpCatalog?.environmentId ?? EnvironmentId.make("unknown"),
          );
          const ownedByAnotherProject = catalog.projectOverrides.some(
            (entry) =>
              entry.override.id === payload.override.id && entry.projectId !== payload.projectId,
          );
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              projectRevisions: [
                ...catalog.projectRevisions.filter(
                  (entry) => entry.projectId !== payload.projectId,
                ),
                { projectId: payload.projectId, revision: payload.revision },
              ],
              projectOverrides: [
                ...catalog.projectOverrides.filter(
                  (entry) =>
                    !(
                      entry.projectId === payload.projectId &&
                      entry.override.id === payload.override.id
                    ),
                ),
                ...(ownedByAnotherProject
                  ? []
                  : [{ projectId: payload.projectId, override: payload.override }]),
              ],
            },
          };
        }),
      );

    case "project.mcp-override.removed":
      return decodeForEvent(
        ProjectMcpOverrideRemovedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const catalog = ensureMcpCatalog(
            nextBase,
            nextBase.mcpCatalog?.environmentId ?? EnvironmentId.make("unknown"),
          );
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              projectRevisions: [
                ...catalog.projectRevisions.filter(
                  (entry) => entry.projectId !== payload.projectId,
                ),
                { projectId: payload.projectId, revision: payload.revision },
              ],
              projectOverrides: catalog.projectOverrides.filter(
                (entry) =>
                  !(
                    entry.projectId === payload.projectId &&
                    entry.override.id === payload.overrideId
                  ),
              ),
            },
          };
        }),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            titleRegeneration: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.settled":
      return decodeForEvent(ThreadSettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "settled",
            settledAt: payload.settledAt,
            unsettledAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsettled":
      return decodeForEvent(ThreadUnsettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.threads.find((thread) => thread.id === payload.threadId);
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              settledOverride: payload.reason === "user" ? "active" : null,
              settledAt: null,
              // Re-entry stamp for active-list ordering. A thread already
              // pinned active keeps its stamp: the activity reset that clears
              // the pin is not a re-entry and must not reorder the list.
              unsettledAt:
                existing?.settledOverride === "active"
                  ? (existing.unsettledAt ?? null)
                  : payload.updatedAt,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.snoozed":
      return decodeForEvent(ThreadSnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: payload.snoozedUntil,
            snoozedAt: payload.snoozedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsnoozed":
      return decodeForEvent(ThreadUnsnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pinned":
      return decodeForEvent(ThreadPinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: payload.pinnedAt,
            ...(payload.pinOrderKey !== undefined ? { pinOrderKey: payload.pinOrderKey } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unpinned":
      return decodeForEvent(ThreadUnpinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: null,
            // Unpin clears the slot: re-pinning is "pin again", not "restore
            // an ancient position".
            pinOrderKey: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pin-reordered":
      return decodeForEvent(ThreadPinReorderedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinOrderKey: payload.orderKey,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.titleRegeneration !== undefined
              ? { titleRegeneration: payload.titleRegeneration }
              : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            ...(payload.linkedPullRequest !== undefined
              ? { linkedPullRequest: payload.linkedPullRequest }
              : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        // Leaving the "running" session status is the turn-end signal: settle
        // a still-running latest turn so its duration reflects the whole turn.
        const settledTurnState = settledTurnStateForSessionStatus(session.status);
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : thread.latestTurn !== null &&
                    thread.latestTurn.state === "running" &&
                    settledTurnState !== null
                  ? {
                      ...thread.latestTurn,
                      state: settledTurnState,
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: session.updatedAt,
                    }
                  : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.mcp-catalog.initialized":
      return decodeForEvent(
        ThreadMcpCatalogInitializedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const catalog = ensureMcpCatalog(
            nextBase,
            nextBase.mcpCatalog?.environmentId ?? EnvironmentId.make("unknown"),
          );
          if (
            catalog.sessions.some(
              (entry) => entry.catalogSessionId === payload.snapshot.catalogSessionId,
            )
          ) {
            return nextBase;
          }
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              sessions: replaceCatalogSession(catalog.sessions, payload.snapshot),
            },
          };
        }),
      );

    case "thread.mcp-catalog.updated":
      return decodeForEvent(
        ThreadMcpCatalogUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const catalog = ensureMcpCatalog(
            nextBase,
            nextBase.mcpCatalog?.environmentId ?? EnvironmentId.make("unknown"),
          );
          const existing = catalog.sessions.find(
            (entry) => entry.catalogSessionId === payload.mcpCatalogSessionId,
          );
          if (
            existing === undefined ||
            existing.disposedAt !== undefined ||
            payload.desiredRevision <= existing.desiredRevision
          )
            return nextBase;
          const snapshot: McpCatalogSnapshot = {
            ...existing,
            desired: payload.desiredCatalog,
            desiredRevision: payload.desiredRevision,
            application: undefined,
          };
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              sessions: replaceCatalogSession(catalog.sessions, snapshot),
            },
          };
        }),
      );

    case "thread.mcp-catalog.reset":
      return decodeForEvent(
        ThreadMcpCatalogResetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const catalog = ensureMcpCatalog(
            nextBase,
            nextBase.mcpCatalog?.environmentId ?? EnvironmentId.make("unknown"),
          );
          const existing = catalog.sessions.find(
            (entry) => entry.catalogSessionId === payload.mcpCatalogSessionId,
          );
          if (
            existing === undefined ||
            existing.disposedAt !== undefined ||
            payload.desiredRevision <= existing.desiredRevision
          )
            return nextBase;
          const snapshot: McpCatalogSnapshot = {
            ...existing,
            baseline: payload.baseline,
            desired: payload.baseline,
            desiredRevision: payload.desiredRevision,
            application: undefined,
          };
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              sessions: replaceCatalogSession(catalog.sessions, snapshot),
            },
          };
        }),
      );

    case "thread.mcp-catalog.disposed":
      return decodeForEvent(
        ThreadMcpCatalogDisposedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const catalog = ensureMcpCatalog(
            nextBase,
            nextBase.mcpCatalog?.environmentId ?? EnvironmentId.make("unknown"),
          );
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              sessions: catalog.sessions.map((entry) =>
                entry.catalogSessionId === payload.mcpCatalogSessionId
                  ? entry.disposedAt === undefined && payload.revision >= entry.desiredRevision
                    ? { ...entry, disposedAt: payload.disposedAt }
                    : entry
                  : entry,
              ),
            },
          };
        }),
      );

    case "thread.mcp-catalog.applied":
      return decodeForEvent(
        ThreadMcpCatalogAppliedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const catalog = ensureMcpCatalog(
            nextBase,
            nextBase.mcpCatalog?.environmentId ?? EnvironmentId.make("unknown"),
          );
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              sessions: catalog.sessions.map((entry) =>
                entry.catalogSessionId === payload.mcpCatalogSessionId
                  ? {
                      ...entry,
                      ...(entry.disposedAt === undefined &&
                      payload.revision <= entry.desiredRevision &&
                      (payload.revision > entry.appliedRevision ||
                        (payload.revision === 0 && entry.application === undefined))
                        ? {
                            appliedRevision: payload.revision,
                            applied: payload.appliedCatalog ?? entry.desired,
                            application: {
                              status: "applied" as const,
                              revision: payload.revision,
                              appliedAt: payload.appliedAt,
                            },
                          }
                        : {}),
                    }
                  : entry,
              ),
            },
          };
        }),
      );

    case "thread.mcp-catalog.apply-failed":
      return decodeForEvent(
        ThreadMcpCatalogApplyFailedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const catalog = ensureMcpCatalog(
            nextBase,
            nextBase.mcpCatalog?.environmentId ?? EnvironmentId.make("unknown"),
          );
          return {
            ...nextBase,
            mcpCatalog: {
              ...catalog,
              sessions: catalog.sessions.map((entry) =>
                entry.catalogSessionId === payload.mcpCatalogSessionId
                  ? {
                      ...entry,
                      ...(entry.disposedAt === undefined &&
                      payload.revision <= entry.desiredRevision &&
                      (payload.revision > entry.appliedRevision ||
                        (payload.revision === 0 && entry.application === undefined))
                        ? {
                            application: {
                              status: "failed" as const,
                              revision: payload.revision,
                              failedAt: payload.failedAt,
                              reason: payload.reason,
                            },
                          }
                        : {}),
                    }
                  : entry,
              ),
            },
          };
        }),
      );

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        // Mid-turn diff updates produce placeholder checkpoints; record the
        // checkpoint, but don't settle a turn its session is still running.
        const turnStillRunning =
          thread.session?.status === "running" && thread.session.activeTurnId === payload.turnId;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: turnStillRunning
              ? thread.latestTurn
              : {
                  turnId: payload.turnId,
                  state: checkpointStatusToLatestTurnState(payload.status),
                  requestedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? thread.latestTurn.requestedAt
                      : payload.completedAt,
                  startedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? (thread.latestTurn.startedAt ?? payload.completedAt)
                      : payload.completedAt,
                  completedAt: payload.completedAt,
                  assistantMessageId: payload.assistantMessageId,
                },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
