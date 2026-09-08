import {
  McpCatalogDefinition,
  McpCatalogDefinitionDraft,
  McpCatalogOverride,
  McpCatalogSessionId,
  McpCatalogSnapshot,
  McpCatalogOperationError,
  McpCatalogStaleRevisionError,
  McpCatalogStaleSessionError,
  McpDefinitionId,
  McpServerId,
  ProjectMcpTransport,
  ProviderInstanceId,
  type McpCatalogCreateInput,
  type McpCatalogMutationError,
  type McpCatalogOverrideInput,
  type McpCatalogRemoveInput,
  type McpCatalogSessionMutationInput,
  type McpCatalogUpdateInput,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  applyMcpCatalogOverrides,
  resolveProjectCatalog,
  resolveSessionCatalog,
} from "./McpCatalogResolver.ts";

type CatalogDefinition = McpCatalogDefinition;
type PersistedMcpCatalogOverrideInput = Omit<McpCatalogOverrideInput, "override"> & {
  readonly override: McpCatalogOverride;
};

interface SessionState {
  readonly snapshot: McpCatalogSnapshot;
  readonly projectId: string;
  readonly sessionDefinitions: ReadonlyArray<CatalogDefinition>;
  readonly sessionOverrides: ReadonlyArray<McpCatalogOverride>;
}

interface CatalogState {
  readonly hydrated: boolean;
  readonly globalRevision: number;
  readonly globalDefinitions: ReadonlyArray<CatalogDefinition>;
  readonly projectRevisions: ReadonlyMap<string, number>;
  readonly projectDefinitions: ReadonlyMap<string, ReadonlyArray<CatalogDefinition>>;
  readonly projectOverrides: ReadonlyMap<string, ReadonlyArray<McpCatalogOverride>>;
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly nextId: number;
}

export interface MaterializeSessionInput {
  readonly threadId: string;
  readonly projectId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly mcpCatalogSessionId?: McpCatalogSessionId;
}

type McpCatalogHydrationReadModel = {
  readonly mcpCatalog: OrchestrationReadModel["mcpCatalog"];
  readonly threads: ReadonlyArray<Pick<OrchestrationThread, "id" | "projectId">>;
};

export interface McpCatalogServiceShape {
  /** Refreshes the process-local read cache from the durable projection. */
  readonly hydrate: (readModel: McpCatalogHydrationReadModel) => Effect.Effect<void>;
  readonly listGlobal: () => Effect.Effect<ReadonlyArray<CatalogDefinition>>;
  readonly listProject: (
    projectId: string,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<
    ReadonlyArray<ReturnType<typeof resolveProjectCatalog>[number]>,
    McpCatalogMutationError
  >;
  readonly createGlobal: (
    input: McpCatalogCreateInput,
  ) => Effect.Effect<CatalogDefinition, McpCatalogMutationError>;
  readonly updateGlobal: (
    input: McpCatalogUpdateInput,
  ) => Effect.Effect<CatalogDefinition, McpCatalogMutationError>;
  readonly removeGlobal: (
    input: McpCatalogRemoveInput,
  ) => Effect.Effect<void, McpCatalogMutationError>;
  readonly createProject: (
    input: McpCatalogCreateInput,
  ) => Effect.Effect<CatalogDefinition, McpCatalogMutationError>;
  readonly updateProject: (
    input: McpCatalogUpdateInput,
  ) => Effect.Effect<CatalogDefinition, McpCatalogMutationError>;
  readonly removeProject: (
    input: McpCatalogRemoveInput,
  ) => Effect.Effect<void, McpCatalogMutationError>;
  readonly putProjectOverride: (
    input: PersistedMcpCatalogOverrideInput,
  ) => Effect.Effect<void, McpCatalogMutationError>;
  readonly removeProjectOverride: (input: {
    readonly scopeId: string;
    readonly expectedRevision: number;
    readonly overrideId: string;
  }) => Effect.Effect<void, McpCatalogMutationError>;
  readonly materializeSession: (
    input: MaterializeSessionInput,
  ) => Effect.Effect<McpCatalogSnapshot, McpCatalogMutationError>;
  readonly listSession: (
    sessionId: McpCatalogSessionId,
  ) => Effect.Effect<McpCatalogSnapshot, McpCatalogStaleSessionError>;
  readonly addSession: (
    input: McpCatalogCreateInput & McpCatalogSessionMutationInput,
  ) => Effect.Effect<McpCatalogSnapshot, McpCatalogMutationError>;
  readonly updateSession: (
    input: McpCatalogUpdateInput & McpCatalogSessionMutationInput,
  ) => Effect.Effect<McpCatalogSnapshot, McpCatalogMutationError>;
  readonly removeSession: (
    input: McpCatalogRemoveInput & McpCatalogSessionMutationInput,
  ) => Effect.Effect<McpCatalogSnapshot, McpCatalogMutationError>;
  readonly resetSession: (
    input: McpCatalogSessionMutationInput,
  ) => Effect.Effect<McpCatalogSnapshot, McpCatalogMutationError>;
  readonly disposeSession: (input: {
    readonly threadId: string;
    readonly mcpCatalogSessionId: McpCatalogSessionId;
  }) => Effect.Effect<void, McpCatalogStaleSessionError>;
}

export class McpCatalogService extends Context.Service<McpCatalogService, McpCatalogServiceShape>()(
  "t3/mcp/McpCatalogService",
) {}

const decodePersistedTransport = Schema.decodeUnknownEffect(ProjectMcpTransport);

const makeDefinition = (
  draft: McpCatalogDefinitionDraft,
  scope: CatalogDefinition["scope"],
  scopeId: string,
  logicalServerId: McpServerId,
  definitionId: McpDefinitionId,
  revision: number,
): Effect.Effect<CatalogDefinition, McpCatalogOperationError> =>
  decodePersistedTransport(draft.transport).pipe(
    Effect.mapError(
      () =>
        new McpCatalogOperationError({
          message:
            "MCP credential drafts must be prepared by the secret store before entering the catalog.",
        }),
    ),
    Effect.map((transport) => ({
      definitionId,
      logicalServerId,
      scope,
      scopeId,
      name: draft.name,
      transport,
      enabled: draft.enabled,
      providerInstanceIds: draft.providerInstanceIds,
      revision,
    })),
  );

const nextId = (state: CatalogState, prefix: string): [string, CatalogState] => [
  `${prefix}-${state.nextId}`,
  { ...state, nextId: state.nextId + 1 },
];

const withRevision = (
  state: CatalogState,
  scope: "global" | "project",
  scopeId: string,
  expectedRevision: number,
): Effect.Effect<number, McpCatalogStaleRevisionError, never> => {
  const actualRevision =
    scope === "global" ? state.globalRevision : (state.projectRevisions.get(scopeId) ?? 0);
  return actualRevision === expectedRevision
    ? Effect.succeed(actualRevision + 1)
    : Effect.fail(
        new McpCatalogStaleRevisionError({
          scope,
          scopeId,
          expectedRevision,
          actualRevision,
        }),
      );
};

const makeCatalogService = Effect.gen(function* () {
  const stateRef = yield* Ref.make<CatalogState>({
    hydrated: false,
    globalRevision: 0,
    globalDefinitions: [],
    projectRevisions: new Map(),
    projectDefinitions: new Map(),
    projectOverrides: new Map(),
    sessions: new Map(),
    nextId: 1,
  });

  const read = Ref.get(stateRef);
  const update = <A>(f: (state: CatalogState) => readonly [A, CatalogState]) =>
    Ref.modify(stateRef, f);

  const hydrate: McpCatalogServiceShape["hydrate"] = (readModel) =>
    update((state) => {
      const catalog = readModel.mcpCatalog ?? {
        environmentId: "unknown",
        globalRevision: 0,
        globalDefinitions: [],
        projectRevisions: [],
        projectDefinitions: [],
        projectOverrides: [],
        sessions: [],
      };
      const projectDefinitions = new Map<string, ReadonlyArray<CatalogDefinition>>();
      for (const entry of catalog.projectDefinitions) {
        projectDefinitions.set(entry.projectId, [
          ...(projectDefinitions.get(entry.projectId) ?? []),
          entry.definition,
        ]);
      }
      const projectOverrides = new Map<string, ReadonlyArray<McpCatalogOverride>>();
      for (const entry of catalog.projectOverrides) {
        projectOverrides.set(entry.projectId, [
          ...(projectOverrides.get(entry.projectId) ?? []),
          entry.override,
        ]);
      }
      const projectRevisions = new Map(
        catalog.projectRevisions.map((entry) => [String(entry.projectId), entry.revision] as const),
      );
      const projectIdByThread = new Map(
        readModel.threads.map((thread) => [String(thread.id), String(thread.projectId)] as const),
      );
      const sessions = new Map<string, SessionState>();
      for (const snapshot of catalog.sessions) {
        const projectId =
          projectIdByThread.get(String(snapshot.threadId)) ??
          snapshot.baseline.find((definition) => definition.scope === "project")?.scopeId ??
          "";
        sessions.set(String(snapshot.catalogSessionId), {
          snapshot,
          projectId,
          sessionDefinitions: snapshot.desired.filter(
            (definition) => definition.scope === "session",
          ),
          sessionOverrides: [],
        });
      }

      const ids = [
        ...catalog.globalDefinitions.map((definition) => String(definition.definitionId)),
        ...catalog.globalDefinitions.map((definition) => String(definition.logicalServerId)),
        ...catalog.projectDefinitions.flatMap(({ definition }) => [
          String(definition.definitionId),
          String(definition.logicalServerId),
        ]),
        ...catalog.sessions.flatMap((session) =>
          session.desired.flatMap((definition) => [
            String(definition.definitionId),
            String(definition.logicalServerId),
          ]),
        ),
      ];
      const nextId = ids.reduce((maximum, id) => {
        const suffix = /-(\d+)$/.exec(id)?.[1];
        return suffix === undefined ? maximum : Math.max(maximum, Number(suffix) + 1);
      }, 1);

      return [
        undefined,
        {
          hydrated: true,
          globalRevision: catalog.globalRevision,
          globalDefinitions: catalog.globalDefinitions,
          projectRevisions,
          projectDefinitions,
          projectOverrides,
          sessions,
          nextId,
        },
      ] as const;
    }).pipe(Effect.asVoid);
  const validateProject = (state: CatalogState, projectId: string, provider: ProviderInstanceId) =>
    resolveProjectCatalog({
      globalDefinitions: state.globalDefinitions,
      projectDefinitions: state.projectDefinitions.get(projectId) ?? [],
      projectOverrides: state.projectOverrides.get(projectId) ?? [],
      providerInstanceId: provider,
      providerCapability: "restart-required",
    });

  const listGlobal = () => read.pipe(Effect.map((state) => state.globalDefinitions));
  const listProject = (projectId: string, providerInstanceId: ProviderInstanceId) =>
    read.pipe(Effect.map((state) => validateProject(state, projectId, providerInstanceId)));

  const createGlobal: McpCatalogServiceShape["createGlobal"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      const revision = yield* withRevision(state, "global", input.scopeId, input.expectedRevision);
      const [logicalId, afterId] = nextId(state, "mcp-server");
      const [definitionId, afterDefinitionId] = nextId(afterId, "mcp-definition");
      const definition = yield* makeDefinition(
        input.definition,
        "global",
        input.scopeId,
        input.logicalServerId ?? McpServerId.make(logicalId),
        McpDefinitionId.make(definitionId),
        revision,
      );
      yield* update((current) => [
        definition,
        {
          ...afterDefinitionId,
          globalRevision: revision,
          globalDefinitions: [...current.globalDefinitions, definition],
        },
      ]);
      return definition;
    });

  const updateGlobal: McpCatalogServiceShape["updateGlobal"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      const revision = yield* withRevision(state, "global", input.scopeId, input.expectedRevision);
      const existing = state.globalDefinitions.find(
        (definition) => definition.logicalServerId === input.logicalServerId,
      );
      if (existing === undefined)
        return yield* Effect.die(new Error("Global MCP definition not found"));
      const [definitionId, afterId] = nextId(state, "mcp-definition");
      const definition = yield* makeDefinition(
        input.definition,
        "global",
        input.scopeId,
        existing.logicalServerId,
        McpDefinitionId.make(definitionId),
        revision,
      );
      yield* update((current) => [
        definition,
        {
          ...afterId,
          globalRevision: revision,
          globalDefinitions: current.globalDefinitions.map((item) =>
            item.logicalServerId === definition.logicalServerId ? definition : item,
          ),
        },
      ]);
      return definition;
    });

  const removeGlobal: McpCatalogServiceShape["removeGlobal"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      const revision = yield* withRevision(state, "global", input.scopeId, input.expectedRevision);
      yield* update((current) => [
        undefined,
        {
          ...current,
          globalRevision: revision,
          globalDefinitions: current.globalDefinitions.filter(
            (item) => item.logicalServerId !== input.logicalServerId,
          ),
        },
      ]);
    });

  const createProject: McpCatalogServiceShape["createProject"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      const revision = yield* withRevision(state, "project", input.scopeId, input.expectedRevision);
      const [logicalId, afterId] = nextId(state, "mcp-server");
      const [definitionId, afterDefinitionId] = nextId(afterId, "mcp-definition");
      const definition = yield* makeDefinition(
        input.definition,
        "project",
        input.scopeId,
        input.logicalServerId ?? McpServerId.make(logicalId),
        McpDefinitionId.make(definitionId),
        revision,
      );
      const definitions = [...(state.projectDefinitions.get(input.scopeId) ?? []), definition];
      yield* update((current) => [
        definition,
        {
          ...afterDefinitionId,
          projectRevisions: new Map(current.projectRevisions).set(input.scopeId, revision),
          projectDefinitions: new Map(current.projectDefinitions).set(input.scopeId, definitions),
        },
      ]);
      return definition;
    });

  const updateProject: McpCatalogServiceShape["updateProject"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      const revision = yield* withRevision(state, "project", input.scopeId, input.expectedRevision);
      const existing = (state.projectDefinitions.get(input.scopeId) ?? []).find(
        (definition) => definition.logicalServerId === input.logicalServerId,
      );
      if (existing === undefined)
        return yield* Effect.die(new Error("Project MCP definition not found"));
      const [definitionId, afterId] = nextId(state, "mcp-definition");
      const definition = yield* makeDefinition(
        input.definition,
        "project",
        input.scopeId,
        existing.logicalServerId,
        McpDefinitionId.make(definitionId),
        revision,
      );
      yield* update((current) => [
        definition,
        {
          ...afterId,
          projectRevisions: new Map(current.projectRevisions).set(input.scopeId, revision),
          projectDefinitions: new Map(current.projectDefinitions).set(
            input.scopeId,
            (current.projectDefinitions.get(input.scopeId) ?? []).map((item) =>
              item.logicalServerId === definition.logicalServerId ? definition : item,
            ),
          ),
        },
      ]);
      return definition;
    });

  const removeProject: McpCatalogServiceShape["removeProject"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      const revision = yield* withRevision(state, "project", input.scopeId, input.expectedRevision);
      yield* update((current) => [
        undefined,
        {
          ...current,
          projectRevisions: new Map(current.projectRevisions).set(input.scopeId, revision),
          projectDefinitions: new Map(current.projectDefinitions).set(
            input.scopeId,
            (current.projectDefinitions.get(input.scopeId) ?? []).filter(
              (item) => item.logicalServerId !== input.logicalServerId,
            ),
          ),
        },
      ]);
    });

  const putProjectOverride: McpCatalogServiceShape["putProjectOverride"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      const revision = yield* withRevision(state, "project", input.scopeId, input.expectedRevision);
      const overrides = [...(state.projectOverrides.get(input.scopeId) ?? [])].filter(
        (item) => item.targetId !== input.override.targetId,
      );
      yield* update((current) => [
        undefined,
        {
          ...current,
          projectRevisions: new Map(current.projectRevisions).set(input.scopeId, revision),
          projectOverrides: new Map(current.projectOverrides).set(input.scopeId, [
            ...overrides,
            input.override,
          ]),
        },
      ]);
    });

  const removeProjectOverride: McpCatalogServiceShape["removeProjectOverride"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      const revision = yield* withRevision(state, "project", input.scopeId, input.expectedRevision);
      yield* update((current) => [
        undefined,
        {
          ...current,
          projectRevisions: new Map(current.projectRevisions).set(input.scopeId, revision),
          projectOverrides: new Map(current.projectOverrides).set(
            input.scopeId,
            (current.projectOverrides.get(input.scopeId) ?? []).filter(
              (item) => item.id !== input.overrideId,
            ),
          ),
        },
      ]);
    });

  const materializeSession: McpCatalogServiceShape["materializeSession"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      const requestedSessionId = input.mcpCatalogSessionId;
      if (requestedSessionId !== undefined) {
        const existing = state.sessions.get(String(requestedSessionId));
        if (existing !== undefined) {
          if (
            existing.snapshot.threadId !== input.threadId ||
            existing.snapshot.disposedAt !== undefined
          ) {
            return yield* new McpCatalogStaleSessionError({
              threadId: input.threadId as never,
              requestedSessionId,
              activeSessionId: existing.snapshot.catalogSessionId,
            });
          }
          return existing.snapshot;
        }
      }
      const projectId = input.projectId;
      const baseline = [
        ...applyMcpCatalogOverrides(
          state.globalDefinitions,
          state.projectOverrides.get(projectId) ?? [],
        ),
        ...(state.projectDefinitions.get(projectId) ?? []),
      ];
      const sessionId =
        requestedSessionId ?? McpCatalogSessionId.make(`catalog-session-${state.nextId}`);
      const snapshot: McpCatalogSnapshot = {
        catalogSessionId: sessionId,
        threadId: input.threadId as never,
        providerInstanceId: input.providerInstanceId,
        baseline,
        desired: baseline,
        desiredRevision: 0,
        appliedRevision: 0,
      };
      yield* update((current) => [
        snapshot,
        {
          ...current,
          nextId: current.nextId + 1,
          sessions: new Map(current.sessions).set(String(sessionId), {
            snapshot,
            projectId,
            sessionDefinitions: [],
            sessionOverrides: [],
          }),
        },
      ]);
      return snapshot;
    });

  const sessionOrFail = (
    state: CatalogState,
    sessionId: McpCatalogSessionId,
    threadId?: string,
  ) => {
    const session = state.sessions.get(String(sessionId));
    if (
      session === undefined ||
      (threadId !== undefined && session.snapshot.threadId !== threadId) ||
      session?.snapshot.disposedAt !== undefined
    ) {
      return Effect.fail(
        new McpCatalogStaleSessionError({
          threadId: (threadId ?? session?.snapshot.threadId ?? "unknown") as never,
          requestedSessionId: sessionId,
          activeSessionId: session?.snapshot.catalogSessionId ?? sessionId,
        }),
      );
    }
    return Effect.succeed(session);
  };

  const listSession: McpCatalogServiceShape["listSession"] = (sessionId) =>
    read.pipe(
      Effect.flatMap((state) => sessionOrFail(state, sessionId)),
      Effect.map((s) => s.snapshot),
    );

  const mutateSession = (
    input: McpCatalogSessionMutationInput,
    mutate: (
      session: SessionState,
      state: CatalogState,
    ) => Effect.Effect<readonly [SessionState, CatalogState], McpCatalogOperationError>,
  ) =>
    Effect.gen(function* () {
      const state = yield* read;
      const session = yield* sessionOrFail(state, input.mcpCatalogSessionId, input.threadId);
      if (session.snapshot.desiredRevision !== input.expectedRevision)
        return yield* new McpCatalogStaleRevisionError({
          scope: "session",
          scopeId: String(input.mcpCatalogSessionId),
          expectedRevision: input.expectedRevision,
          actualRevision: session.snapshot.desiredRevision,
        });
      const [next, allocatedState] = yield* mutate(session, state);
      const nextSnapshot = {
        ...next.snapshot,
        desiredRevision: session.snapshot.desiredRevision + 1,
        application: undefined,
      };
      const nextSession = { ...next, snapshot: nextSnapshot };
      yield* update((current) => [
        nextSnapshot,
        {
          ...allocatedState,
          sessions: new Map(allocatedState.sessions).set(
            String(input.mcpCatalogSessionId),
            nextSession,
          ),
        },
      ]);
      return nextSnapshot;
    });

  const addSession: McpCatalogServiceShape["addSession"] = (input) =>
    mutateSession(input, (session, state) =>
      Effect.gen(function* () {
        const [logicalId, afterId] = nextId(state, "mcp-server");
        const [definitionId, allocatedState] = nextId(afterId, "mcp-definition");
        const definition = yield* makeDefinition(
          input.definition,
          "session",
          String(input.mcpCatalogSessionId),
          input.logicalServerId ?? McpServerId.make(logicalId),
          McpDefinitionId.make(definitionId),
          session.snapshot.desiredRevision + 1,
        );
        return [
          {
            ...session,
            sessionDefinitions: [...session.sessionDefinitions, definition],
            snapshot: { ...session.snapshot, desired: [...session.snapshot.desired, definition] },
          },
          allocatedState,
        ] as const;
      }),
    );

  const updateSession: McpCatalogServiceShape["updateSession"] = (input) =>
    mutateSession(input, (session, state) =>
      Effect.gen(function* () {
        const existing = session.snapshot.desired.find(
          (item) => item.logicalServerId === input.logicalServerId,
        );
        if (existing === undefined) return [session, state] as const;
        const definition = yield* makeDefinition(
          input.definition,
          existing.scope === "session" ? "session" : existing.scope,
          existing.scopeId,
          existing.logicalServerId,
          existing.definitionId,
          existing.revision + 1,
        );
        return [
          {
            ...session,
            snapshot: {
              ...session.snapshot,
              desired: session.snapshot.desired.map((item) =>
                item.logicalServerId === definition.logicalServerId ? definition : item,
              ),
            },
          },
          state,
        ] as const;
      }),
    );

  const removeSession: McpCatalogServiceShape["removeSession"] = (input) =>
    mutateSession(input, (session, state) =>
      Effect.succeed([
        {
          ...session,
          sessionDefinitions: session.sessionDefinitions.filter(
            (item) => item.logicalServerId !== input.logicalServerId,
          ),
          snapshot: {
            ...session.snapshot,
            desired: session.snapshot.desired.filter(
              (item) => item.logicalServerId !== input.logicalServerId,
            ),
          },
        },
        state,
      ] as const),
    );

  const resetSession: McpCatalogServiceShape["resetSession"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      const session = yield* sessionOrFail(state, input.mcpCatalogSessionId, input.threadId);
      if (session.snapshot.desiredRevision !== input.expectedRevision)
        return yield* new McpCatalogStaleRevisionError({
          scope: "session",
          scopeId: String(input.mcpCatalogSessionId),
          expectedRevision: input.expectedRevision,
          actualRevision: session.snapshot.desiredRevision,
        });
      const baseline = [
        ...applyMcpCatalogOverrides(
          state.globalDefinitions,
          state.projectOverrides.get(session.projectId) ?? [],
        ),
        ...(state.projectDefinitions.get(session.projectId) ?? []),
      ];
      const snapshot = {
        ...session.snapshot,
        desired: baseline,
        desiredRevision: input.expectedRevision + 1,
        application: undefined,
      };
      yield* update((current) => [
        snapshot,
        {
          ...current,
          sessions: new Map(current.sessions).set(String(input.mcpCatalogSessionId), {
            snapshot,
            projectId: session.projectId,
            sessionDefinitions: [],
            sessionOverrides: [],
          }),
        },
      ]);
      return snapshot;
    });

  const disposeSession: McpCatalogServiceShape["disposeSession"] = (input) =>
    Effect.gen(function* () {
      const state = yield* read;
      yield* sessionOrFail(state, input.mcpCatalogSessionId, input.threadId);
      yield* update((current) => {
        const session = current.sessions.get(String(input.mcpCatalogSessionId));
        if (session === undefined) return [undefined, current] as const;
        const snapshot = {
          ...session.snapshot,
          disposedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        };
        return [
          undefined,
          {
            ...current,
            sessions: new Map(current.sessions).set(String(input.mcpCatalogSessionId), {
              ...session,
              snapshot,
            }),
          },
        ] as const;
      });
    });

  return {
    hydrate,
    listGlobal,
    listProject,
    createGlobal,
    updateGlobal,
    removeGlobal,
    createProject,
    updateProject,
    removeProject,
    putProjectOverride,
    removeProjectOverride,
    materializeSession,
    listSession,
    addSession,
    updateSession,
    removeSession,
    resetSession,
    disposeSession,
  } satisfies McpCatalogServiceShape;
});

export const layer = Layer.effect(McpCatalogService, makeCatalogService);
