import {
  CommandId,
  McpCatalogNameConflictError,
  McpCatalogProviderLimitExceededError,
  McpCatalogOperationError,
  McpCatalogOverrideId,
  McpDefinitionId,
  McpServerId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type McpCatalogDefinition,
  type McpCatalogOverride,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const globalServerId = McpServerId.make("global-server");
const globalDefinition: McpCatalogDefinition = {
  definitionId: McpDefinitionId.make("global-definition"),
  logicalServerId: globalServerId,
  scope: "global",
  scopeId: "environment-1",
  name: "Global server",
  transport: {
    type: "streamable-http",
    url: "https://global.example.test/mcp",
    headers: [],
    authorization: { type: "none" },
  },
  enabled: true,
  providerInstanceIds: [ProviderInstanceId.make("codex")],
  revision: 1,
};

const makeOverride = (overrides: Partial<McpCatalogOverride> = {}): McpCatalogOverride => ({
  id: McpCatalogOverrideId.make("override-1"),
  scope: "project",
  scopeId: projectId,
  targetId: globalServerId,
  ...overrides,
});

const makeReadModel = (
  overrides: {
    readonly globalDefinitions?: ReadonlyArray<McpCatalogDefinition>;
    readonly projectOverrides?: ReadonlyArray<{
      projectId: ProjectId;
      override: McpCatalogOverride;
    }>;
    readonly projectDefinitions?: ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly definition: McpCatalogDefinition;
    }>;
  } = {},
): OrchestrationReadModel => ({
  ...createEmptyReadModel("2026-01-01T00:00:00.000Z"),
  projects: [
    { id: projectId, deletedAt: null },
    { id: otherProjectId, deletedAt: null },
  ] as never,
  mcpCatalog: {
    environmentId: EnvironmentId.make("environment-1"),
    globalRevision: 1,
    globalDefinitions: overrides.globalDefinitions ?? [globalDefinition],
    projectRevisions: [],
    projectDefinitions: overrides.projectDefinitions ?? [],
    projectOverrides: overrides.projectOverrides ?? [],
    sessions: [],
  },
});

const decide = (command: OrchestrationCommand, readModel = makeReadModel()) =>
  decideOrchestrationCommand({ command, readModel });

const expectCatalogError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    expect(error).toMatchObject({
      cause: expect.objectContaining({ _tag: "McpCatalogOperationError" }),
    });
    return error;
  });

it.layer(NodeServices.layer)("MCP catalog decider invariants", (it) => {
  it.effect("rejects a global conflict hidden by every current project's override", () =>
    Effect.gen(function* () {
      const secondGlobal: McpCatalogDefinition = {
        ...globalDefinition,
        definitionId: McpDefinitionId.make("global-definition-2"),
        logicalServerId: McpServerId.make("global-server-2"),
        name: "Second global server",
      };
      const readModel = makeReadModel({
        globalDefinitions: [globalDefinition, secondGlobal],
        projectOverrides: [
          {
            projectId,
            override: makeOverride({
              id: McpCatalogOverrideId.make("mask-project-1"),
              scopeId: projectId,
              targetId: secondGlobal.logicalServerId,
              enabled: false,
            }),
          },
          {
            projectId: otherProjectId,
            override: makeOverride({
              id: McpCatalogOverrideId.make("mask-project-2"),
              scopeId: otherProjectId,
              targetId: secondGlobal.logicalServerId,
              enabled: false,
            }),
          },
        ],
      });

      const error = yield* Effect.flip(
        decide(
          {
            type: "environment.mcp-definition.update",
            commandId: CommandId.make("masked-global-conflict"),
            environmentId: EnvironmentId.make("environment-1"),
            definition: { ...secondGlobal, name: globalDefinition.name },
            expectedRevision: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          readModel,
        ),
      );
      expect(error.cause).toBeInstanceOf(McpCatalogNameConflictError);
    }),
  );

  it.effect("rejects a masked global catalog that already exceeds the provider limit", () =>
    Effect.gen(function* () {
      const globals = Array.from({ length: 51 }, (_, index) => ({
        ...globalDefinition,
        definitionId: McpDefinitionId.make(`over-limit-global-definition-${index}`),
        logicalServerId: McpServerId.make(`over-limit-global-server-${index}`),
        name: `Global ${index}`,
      }));
      const masked = globals.slice(-2);
      const projectOverrides = [projectId, otherProjectId].flatMap((scopeId, projectIndex) =>
        masked.map((definition, index) => ({
          projectId: scopeId,
          override: makeOverride({
            id: McpCatalogOverrideId.make(`over-limit-mask-${projectIndex}-${index}`),
            scopeId,
            targetId: definition.logicalServerId,
            enabled: false,
          }),
        })),
      );
      const error = yield* Effect.flip(
        decide(
          {
            type: "environment.mcp-definition.create",
            commandId: CommandId.make("masked-global-limit"),
            environmentId: EnvironmentId.make("environment-1"),
            definition: {
              ...globals[0]!,
              definitionId: McpDefinitionId.make("over-limit-new-definition"),
              logicalServerId: McpServerId.make("over-limit-new-server"),
              name: "New global",
            },
            expectedRevision: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          makeReadModel({ globalDefinitions: globals, projectOverrides }),
        ),
      );
      expect(error.cause).toBeInstanceOf(McpCatalogProviderLimitExceededError);
    }),
  );

  it.effect("rejects persistent mutations that create invalid effective catalogs", () =>
    Effect.gen(function* () {
      const duplicateDefinition: McpCatalogDefinition = {
        ...globalDefinition,
        definitionId: McpDefinitionId.make("duplicate-definition"),
        logicalServerId: McpServerId.make("duplicate-server"),
        scope: "project",
        scopeId: projectId,
        revision: 1,
      };
      const duplicateFailure = yield* Effect.flip(
        decide(
          {
            type: "project.mcp-definition.create",
            commandId: CommandId.make("invalid-duplicate"),
            projectId,
            definition: duplicateDefinition,
            expectedRevision: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          makeReadModel(),
        ),
      );
      expect(duplicateFailure.cause).toBeInstanceOf(McpCatalogNameConflictError);

      const tooMany = Array.from({ length: 50 }, (_, index) => ({
        ...globalDefinition,
        definitionId: McpDefinitionId.make(`limit-definition-${index}`),
        logicalServerId: McpServerId.make(`limit-server-${index}`),
        scope: "project" as const,
        scopeId: projectId,
        name: `Limit ${index}`,
        revision: 1,
      }));
      const limitFailure = yield* Effect.flip(
        decide(
          {
            type: "project.mcp-definition.create",
            commandId: CommandId.make("invalid-limit"),
            projectId,
            definition: {
              ...duplicateDefinition,
              definitionId: McpDefinitionId.make("limit-definition-50"),
              logicalServerId: McpServerId.make("limit-server-50"),
              name: "Limit 50",
            },
            expectedRevision: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          makeReadModel({
            projectDefinitions: tooMany.map((definition) => ({ projectId, definition })),
          }),
        ),
      );
      expect(limitFailure.cause).toBeInstanceOf(McpCatalogProviderLimitExceededError);
    }),
  );

  it.effect("rejects missing definition and override removals without emitting events", () =>
    Effect.gen(function* () {
      const globalError = yield* expectCatalogError(
        decide({
          type: "environment.mcp-definition.remove",
          commandId: CommandId.make("remove-global-missing"),
          environmentId: EnvironmentId.make("environment-1"),
          logicalServerId: McpServerId.make("missing-global"),
          expectedRevision: 1,
          removedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const projectError = yield* expectCatalogError(
        decide({
          type: "project.mcp-definition.remove",
          commandId: CommandId.make("remove-project-missing"),
          projectId,
          logicalServerId: McpServerId.make("missing-project"),
          expectedRevision: 0,
          removedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const overrideError = yield* expectCatalogError(
        decide({
          type: "project.mcp-override.remove",
          commandId: CommandId.make("remove-override-missing"),
          projectId,
          overrideId: McpCatalogOverrideId.make("missing-override"),
          expectedRevision: 0,
          removedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      expect((globalError.cause as McpCatalogOperationError).message).toContain("not found");
      expect((projectError.cause as McpCatalogOperationError).message).toContain("not found");
      expect((overrideError.cause as McpCatalogOperationError).message).toContain("not found");
    }),
  );

  it.effect("rejects ineffective, out-of-scope, and colliding project overrides", () =>
    Effect.gen(function* () {
      const projectDefinition: McpCatalogDefinition = {
        ...globalDefinition,
        definitionId: McpDefinitionId.make("project-definition"),
        logicalServerId: McpServerId.make("project-server"),
        scope: "project",
        scopeId: projectId,
      };
      const cases: ReadonlyArray<[string, McpCatalogOverride, OrchestrationReadModel]> = [
        [
          "missing target",
          makeOverride({ targetId: McpServerId.make("missing-target") }),
          makeReadModel(),
        ],
        [
          "project-local target",
          makeOverride({ targetId: projectDefinition.logicalServerId }),
          makeReadModel({ projectDefinitions: [{ projectId, definition: projectDefinition }] }),
        ],
        ["scope mismatch", makeOverride({ scopeId: otherProjectId }), makeReadModel()],
        [
          "cross-project override id",
          makeOverride(),
          makeReadModel({
            projectOverrides: [{ projectId: otherProjectId, override: makeOverride() }],
          }),
        ],
      ];

      for (const [label, override, readModel] of cases) {
        const error = yield* Effect.flip(
          decide(
            {
              type: "project.mcp-override.upsert",
              commandId: CommandId.make(`override-${label.replaceAll(" ", "-")}`),
              projectId,
              override,
              expectedRevision: 0,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            readModel,
          ),
        );
        expect(error.cause).toBeInstanceOf(McpCatalogOperationError);
      }
    }),
  );

  it.effect("accepts a project override for an inherited global definition", () =>
    Effect.gen(function* () {
      const event = yield* decide({
        type: "project.mcp-override.upsert",
        commandId: CommandId.make("override-global"),
        projectId,
        override: makeOverride({
          id: McpCatalogOverrideId.make("override-global"),
          targetId: globalServerId,
        }),
        expectedRevision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(event).toMatchObject({
        type: "project.mcp-override.upserted",
        payload: { projectId, revision: 1 },
      });
    }),
  );
});
