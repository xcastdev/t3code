import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  preserveMcpCatalogDraft,
  resolveUnmanagedExternalOpenCodeInstances,
} from "./McpCatalogSettings";

const opencodeId = ProviderInstanceId.make("opencode");

const provider = (instanceId: ProviderInstanceId = opencodeId): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("opencode"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const settings = (config: Record<string, unknown>) => ({
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, ...config },
  },
  providerInstances: {},
});

const atoms = vi.hoisted(() => ({
  projectState: Symbol("projectState"),
  globalState: Symbol("globalState"),
  changes: Symbol("changes"),
  create: Symbol("create"),
  update: Symbol("update"),
  remove: Symbol("remove"),
  globalCreate: Symbol("globalCreate"),
  globalUpdate: Symbol("globalUpdate"),
  globalRemove: Symbol("globalRemove"),
  override: Symbol("override"),
  deleteOverride: Symbol("deleteOverride"),
  oauthBegin: Symbol("oauthBegin"),
  oauthContinue: Symbol("oauthContinue"),
  oauthDisconnect: Symbol("oauthDisconnect"),
}));

const query = vi.hoisted(() => ({
  data: null as unknown,
  isPending: false,
}));

const commands = vi.hoisted(() => ({
  command: vi.fn().mockResolvedValue({ _tag: "Success" }),
}));

vi.mock("../../state/projects", () => ({
  mcpCatalogEnvironment: {
    projectState: () => atoms.projectState,
    globalState: () => atoms.globalState,
    changes: () => atoms.changes,
    projectCreate: atoms.create,
    projectUpdate: atoms.update,
    projectRemove: atoms.remove,
    projectOverride: atoms.override,
    projectDeleteOverride: atoms.deleteOverride,
    globalCreate: atoms.globalCreate,
    globalUpdate: atoms.globalUpdate,
    globalRemove: atoms.globalRemove,
    oauthBegin: atoms.oauthBegin,
    oauthContinue: atoms.oauthContinue,
    oauthDisconnect: atoms.oauthDisconnect,
  },
}));

vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => query }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => commands.command,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => undefined }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.ComponentProps<"a"> & { search?: unknown }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ComponentProps<"button"> & { size?: unknown; variant?: unknown }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    children,
    title,
    description,
    ...props
  }: {
    children?: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
  }) => (
    <section {...props}>
      <h3>{title}</h3>
      {description}
      {children}
    </section>
  ),
  SettingsSection: ({
    children,
    title,
    ...props
  }: {
    children: React.ReactNode;
    title: string;
  }) => (
    <section {...props}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

import { McpCatalogProjectSettings, McpCatalogSettings } from "./McpCatalogSettings";

describe("scoped MCP editor draft handling", () => {
  it("keeps local edits when a subscription refresh arrives", () => {
    expect(preserveMcpCatalogDraft("local", "server", true)).toBe("local");
    expect(preserveMcpCatalogDraft("local", "server", false)).toBe("server");
  });
});

describe("scoped OpenCode MCP warning", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    query.data = {
      globalDefinitions: [],
      projectDefinitions: [],
      projectOverrides: [],
      projectRevision: 0,
    };
    query.isPending = false;
    commands.command.mockClear().mockResolvedValue({ _tag: "Success" });
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = undefined;
  });

  it("only returns an external OpenCode instance that is not T3-managed", () => {
    expect(
      resolveUnmanagedExternalOpenCodeInstances(
        [provider()],
        settings({ serverUrl: "http://127.0.0.1:4096", manageExternalMcp: false }),
      ).map((entry) => entry.instanceId),
    ).toEqual([opencodeId]);

    expect(
      resolveUnmanagedExternalOpenCodeInstances(
        [provider()],
        settings({ serverUrl: "http://127.0.0.1:4096", manageExternalMcp: true }),
      ),
    ).toEqual([]);
  });

  it("uses the selected instance config instead of another OpenCode instance", () => {
    const managedId = ProviderInstanceId.make("opencode-managed");
    expect(
      resolveUnmanagedExternalOpenCodeInstances([provider(), provider(managedId)], {
        ...settings({ serverUrl: "http://127.0.0.1:4096", manageExternalMcp: false }),
        providerInstances: {
          [managedId]: {
            driver: ProviderDriverKind.make("opencode"),
            config: { serverUrl: "http://127.0.0.1:4096", manageExternalMcp: true },
          },
        },
      }).map((entry) => entry.instanceId),
    ).toEqual([opencodeId]);
  });

  it("links the warning to the selected OpenCode instance switch", async () => {
    await act(() => {
      renderer = create(
        <McpCatalogProjectSettings
          environmentId={EnvironmentId.make("environment")}
          projectId={ProjectId.make("project")}
          providers={[provider()]}
          settings={settings({ serverUrl: "http://127.0.0.1:4096" })}
        />,
      );
    });

    const link = renderer!.root.findByType("a");
    expect(link.props.to).toBe("/settings/providers");
    expect(link.props.search).toEqual({
      environmentId: expect.any(String),
      instanceId: opencodeId,
    });
    expect(link.props.hash).toBe("provider-instance-opencode-manageExternalMcp");
  });

  it("opens a global MCP definition target in the selected environment editor", async () => {
    const environmentId = EnvironmentId.make("environment");
    const definition = {
      definitionId: "global-definition",
      logicalServerId: "weather-server",
      scope: "global",
      scopeId: environmentId,
      name: "Weather service",
      transport: {
        type: "streamable-http",
        url: "https://weather.example/mcp",
        headers: [],
        authorization: { type: "none" },
      },
      enabled: true,
      providerInstanceIds: [],
      revision: 1,
    };
    query.data = { definitions: [definition], globalRevision: 1 };
    await act(() => {
      renderer = create(
        <McpCatalogSettings
          environmentId={environmentId}
          providers={[]}
          resourceTarget={{
            namespace: "t3-resource",
            version: 1,
            kind: "mcp",
            scope: "environment",
            scopeId: environmentId,
            intent: "item",
            identity: "definition",
            id: definition.definitionId,
          }}
        />,
      );
    });

    expect(renderer!.root.findByProps({ "aria-label": "MCP server name" }).props.value).toBe(
      "Weather service",
    );
    expect(
      renderer!.root.findAllByType("button").some((button) => button.children.join("") === "Save"),
    ).toBe(true);
  });

  it("opens inherited and project override MCP targets in the matching project form", async () => {
    const environmentId = EnvironmentId.make("environment");
    const projectId = ProjectId.make("project");
    const inherited = {
      definitionId: "inherited-definition",
      logicalServerId: "weather-server",
      scope: "global",
      scopeId: environmentId,
      name: "Weather service",
      transport: {
        type: "streamable-http",
        url: "https://weather.example/mcp",
        headers: [],
        authorization: { type: "none" },
      },
      enabled: true,
      providerInstanceIds: [],
      revision: 1,
    };
    const local = {
      ...inherited,
      definitionId: "local-definition",
      logicalServerId: "local-server",
      scope: "project",
      scopeId: projectId,
      name: "Local server",
    };
    const override = {
      id: "weather-override",
      scope: "project",
      scopeId: projectId,
      targetId: "weather-server",
      enabled: false,
      name: "Project weather",
    };
    const renderProjectTarget = async (
      resourceTarget: React.ComponentProps<typeof McpCatalogProjectSettings>["resourceTarget"],
    ) => {
      await act(() => {
        renderer = create(
          <McpCatalogProjectSettings
            environmentId={environmentId}
            projectId={projectId}
            providers={[]}
            {...(resourceTarget === undefined ? {} : { resourceTarget })}
          />,
        );
      });
      return renderer!;
    };

    query.data = {
      globalDefinitions: [inherited],
      projectDefinitions: [local],
      projectOverrides: [],
      projectRevision: 1,
    };
    const localPage = await renderProjectTarget({
      namespace: "t3-resource",
      version: 1,
      kind: "mcp",
      scope: "project",
      scopeId: projectId,
      intent: "item",
      identity: "definition",
      id: local.definitionId,
    });
    expect(
      localPage.root.findByProps({ "aria-label": "Project MCP server name" }).props.value,
    ).toBe("Local server");
    expect(
      localPage.root
        .findAllByType("button")
        .some((button) => button.children.join("") === "Save local"),
    ).toBe(true);
    await act(() => localPage.unmount());
    renderer = undefined;

    query.data = {
      globalDefinitions: [inherited],
      projectDefinitions: [],
      projectOverrides: [],
      projectRevision: 1,
    };
    const inheritedPage = await renderProjectTarget({
      namespace: "t3-resource",
      version: 1,
      kind: "mcp",
      scope: "project",
      scopeId: projectId,
      intent: "item",
      identity: "definition",
      id: inherited.definitionId,
    });
    expect(
      inheritedPage.root.findByProps({ "aria-label": "Project MCP server name" }).props.value,
    ).toBe("Weather service");
    expect(
      inheritedPage.root
        .findAllByType("button")
        .some((button) => button.children.join("") === "Save override"),
    ).toBe(true);
    await act(() => inheritedPage.unmount());
    renderer = undefined;

    query.data = {
      globalDefinitions: [inherited],
      projectDefinitions: [],
      projectOverrides: [override],
      projectRevision: 2,
    };
    const overridePage = await renderProjectTarget({
      namespace: "t3-resource",
      version: 1,
      kind: "mcp",
      scope: "project",
      scopeId: projectId,
      intent: "item",
      identity: "override",
      id: override.id,
    });
    expect(
      overridePage.root.findByProps({ "aria-label": "Project MCP server name" }).props.value,
    ).toBe("Project weather");
    expect(
      overridePage.root
        .findAllByType("button")
        .some((button) => button.children.join("") === "Save override"),
    ).toBe(true);
  });

  it("shows orphan and stale MCP targets only as recovery or missing states", async () => {
    const environmentId = EnvironmentId.make("environment");
    const projectId = ProjectId.make("project");
    const orphan = {
      id: "orphan-override",
      scope: "project",
      scopeId: projectId,
      targetId: "removed-server",
      name: "Removed server",
    };
    query.data = {
      globalDefinitions: [],
      projectDefinitions: [],
      projectOverrides: [orphan],
      projectRevision: 2,
    };
    await act(() => {
      renderer = create(
        <McpCatalogProjectSettings
          environmentId={environmentId}
          projectId={projectId}
          providers={[]}
          resourceTarget={{
            namespace: "t3-resource",
            version: 1,
            kind: "mcp",
            scope: "project",
            scopeId: projectId,
            intent: "item",
            identity: "orphan-override",
            id: orphan.id,
          }}
        />,
      );
    });

    expect(renderer!.root.findAllByProps({ "aria-label": "Project MCP server name" })).toHaveLength(
      0,
    );
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.children.join("") === "Edit override"),
    ).toBe(false);
    expect(
      renderer!.root.findAll(
        (node) => node.type === "p" && node.children.join("").includes("removed"),
      ),
    ).not.toHaveLength(0);
    await act(() => renderer!.unmount());
    renderer = undefined;

    query.data = {
      globalDefinitions: [],
      projectDefinitions: [],
      projectOverrides: [],
      projectRevision: 2,
    };
    await act(() => {
      renderer = create(
        <McpCatalogProjectSettings
          environmentId={environmentId}
          projectId={projectId}
          providers={[]}
          resourceTarget={{
            namespace: "t3-resource",
            version: 1,
            kind: "mcp",
            scope: "project",
            scopeId: projectId,
            intent: "item",
            identity: "definition",
            id: "deleted-definition",
          }}
        />,
      );
    });
    expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
      "no longer available",
    );
    expect(renderer!.root.findAllByProps({ "aria-label": "Project MCP server name" })).toHaveLength(
      0,
    );
  });
});
