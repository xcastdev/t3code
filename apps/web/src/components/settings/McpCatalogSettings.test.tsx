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
  changes: Symbol("changes"),
  create: Symbol("create"),
  update: Symbol("update"),
  remove: Symbol("remove"),
  override: Symbol("override"),
  deleteOverride: Symbol("deleteOverride"),
  oauthBegin: Symbol("oauthBegin"),
  oauthContinue: Symbol("oauthContinue"),
  oauthDisconnect: Symbol("oauthDisconnect"),
}));

const query = vi.hoisted(() => ({
  data: {
    globalDefinitions: [],
    projectDefinitions: [],
    projectOverrides: [],
    projectRevision: 0,
  },
  isPending: false,
}));

const commands = vi.hoisted(() => ({
  command: vi.fn().mockResolvedValue({ _tag: "Success" }),
}));

vi.mock("../../state/projects", () => ({
  mcpCatalogEnvironment: {
    projectState: () => atoms.projectState,
    changes: () => atoms.changes,
    projectCreate: atoms.create,
    projectUpdate: atoms.update,
    projectRemove: atoms.remove,
    projectOverride: atoms.override,
    projectDeleteOverride: atoms.deleteOverride,
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

import { McpCatalogProjectSettings } from "./McpCatalogSettings";

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
});
