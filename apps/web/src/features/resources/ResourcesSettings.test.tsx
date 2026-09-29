import * as Schema from "effect/Schema";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scope: null as unknown,
  environments: [] as readonly unknown[],
  targets: [] as readonly unknown[],
  search: {} as Record<string, string>,
  queries: [] as Array<{ readonly kind: string; readonly input: unknown }>,
  changes: [] as string[],
  results: {} as Record<
    string,
    { readonly data?: unknown; readonly error?: string | null; readonly isPending?: boolean }
  >,
  forbidden: {
    skillContent: vi.fn(),
    skillHistory: vi.fn(),
    skillDeployment: vi.fn(),
    mcpOauth: vi.fn(),
    mcpCredentials: vi.fn(),
  },
  refresh: {
    skills: vi.fn(),
    text: vi.fn(),
    globalMcp: vi.fn(),
    projectMcp: vi.fn(),
  },
}));

function query(kind: string, input: unknown = {}) {
  return { kind, input };
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly kind?: string }) => {
    if (atom?.kind) state.changes.push(atom.kind);
    return null;
  },
}));
vi.mock("../../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: state.scope,
    environments: state.environments,
    targets: state.targets,
    search: state.search,
  }),
}));
vi.mock("../../state/skills", () => ({
  skillsEnvironment: {
    catalog: (input: unknown) => query("skills", input),
    changes: (input: unknown) => query("skills-changes", input),
    content: state.forbidden.skillContent,
    history: state.forbidden.skillHistory,
    deployment: state.forbidden.skillDeployment,
  },
}));
vi.mock("../../state/managedTextResources", () => ({
  managedTextResourcesEnvironment: {
    catalog: (input: unknown) => query("text", input),
    changes: (input: unknown) => query("text-changes", input),
    content: state.forbidden.skillContent,
  },
}));
vi.mock("../../state/projects", () => ({
  mcpCatalogEnvironment: {
    globalState: (input: unknown) => query("global-mcp", input),
    projectState: (input: unknown) => query("project-mcp", input),
    changes: (input: unknown) => query("mcp-changes", input),
    oauthBegin: state.forbidden.mcpOauth,
    credentials: state.forbidden.mcpCredentials,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { readonly kind: string; readonly input: unknown } | null) => {
    if (atom) state.queries.push(atom);
    const result = atom ? state.results[atom.kind] : undefined;
    const refresh = atom
      ? state.refresh[
          atom.kind === "skills"
            ? "skills"
            : atom.kind === "text"
              ? "text"
              : atom.kind === "global-mcp"
                ? "globalMcp"
                : "projectMcp"
        ]
      : vi.fn();
    return {
      data: result?.data ?? null,
      error: result?.error ?? null,
      isPending: result?.isPending ?? false,
      refresh,
    };
  },
}));
vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { readonly children: React.ReactNode }) => (
    <main>{children}</main>
  ),
  SettingsSection: ({
    children,
    headerAction,
    title,
  }: {
    readonly children: React.ReactNode;
    readonly headerAction?: React.ReactNode;
    readonly title: string;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
}));
vi.mock("../../components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ComponentProps<"button"> & { readonly size?: unknown; readonly variant?: unknown }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../../components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    search,
    hash,
    ...props
  }: React.ComponentProps<"a"> & {
    readonly to?: string;
    readonly search?: unknown;
    readonly hash?: string;
  }) => (
    <a data-to={to} data-search={JSON.stringify(search)} data-hash={hash} {...props}>
      {children}
    </a>
  ),
}));

import { EnvironmentId, ManagedTextResourceCatalogListResult } from "@t3tools/contracts";
import type { ResolvedSettingsScope } from "../../components/settings/settingsScope";
import { ResourcesSettings } from "./ResourcesSettings";

const environmentId = EnvironmentId.make("inventory-server");
const environmentScope = (): ResolvedSettingsScope => ({
  kind: "environment",
  environmentId,
  label: "Dev",
  members: [],
  environmentIds: [environmentId],
});

function configureEnvironment(
  options: {
    readonly phase?: string;
    readonly capabilities?: Record<string, boolean>;
  } = {},
) {
  state.scope = environmentScope();
  state.environments = [
    {
      environmentId,
      label: "Dev",
      connection: { phase: options.phase ?? "connected" },
      serverConfig:
        options.phase === "disconnected"
          ? null
          : { environment: { capabilities: options.capabilities ?? {} } },
    },
  ];
  state.targets = [{ environmentId, label: "Dev", projectId: null }];
  state.search = { machine: environmentId };
}

function resetState() {
  state.scope = {
    kind: "all",
    label: "All environments",
    members: [],
    environmentIds: [environmentId],
  };
  state.environments = [];
  state.targets = [];
  state.search = {};
  state.queries = [];
  state.changes = [];
  state.results = {};
  for (const refresh of Object.values(state.refresh)) refresh.mockReset();
  for (const forbidden of Object.values(state.forbidden)) forbidden.mockReset();
}

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    renderer = create(<ResourcesSettings />);
  });
  return renderer!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetState();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Resources settings", () => {
  it("does not construct catalog reads for ambiguous or disconnected selections", async () => {
    const ambiguous = await render();
    expect(
      ambiguous.root.findByProps({
        children: "Select one environment or project checkout to view its resources.",
      }),
    ).toBeDefined();
    expect(state.queries).toEqual([]);
    expect(state.changes).toEqual([]);

    await act(() => ambiguous.unmount());
    renderer = undefined;
    resetState();
    configureEnvironment({ phase: "disconnected" });
    const disconnected = await render();

    expect(
      disconnected.root.findByProps({ children: "Reconnect Dev to view its resources." }),
    ).toBeDefined();
    expect(state.queries).toEqual([]);
    expect(state.changes).toEqual([]);
  });

  it("keeps a failed catalog independent and retries it while showing other resources", async () => {
    configureEnvironment({ capabilities: { globalMcpCatalog: true } });
    state.results.skills = { error: "offline" };
    state.results.text = {
      data: Schema.decodeSync(ManagedTextResourceCatalogListResult)({
        catalogRevision: 1,
        entries: [
          {
            kind: "command",
            key: "review",
            scope: "environment",
            scopeId: environmentId,
            projectState: "inherit",
            environmentState: "active",
            revision: "r1",
            effective: true,
          },
        ],
      }),
    };
    state.refresh.skills.mockClear();
    const page = await render();

    expect(page.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(
      page.root.findAll((node) => node.type === "code" && node.children.includes("review")),
    ).toHaveLength(1);
    const retry = page.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Retry skills");
    expect(retry).toBeDefined();
    await act(() => retry!.props.onClick());
    expect(state.refresh.skills).toHaveBeenCalledTimes(1);
    expect(state.queries.map(({ kind }) => kind)).toEqual(["skills", "text", "global-mcp"]);
    expect(state.changes).toEqual(["skills-changes", "text-changes", "mcp-changes"]);
  });

  it("filters the combined rows and links each entry back to its exact editor target", async () => {
    configureEnvironment();
    state.results.text = {
      data: Schema.decodeSync(ManagedTextResourceCatalogListResult)({
        catalogRevision: 2,
        entries: [
          {
            kind: "command",
            key: "ship",
            name: "Ship change",
            scope: "environment",
            scopeId: environmentId,
            projectState: "inherit",
            environmentState: "active",
            revision: "r1",
            effective: true,
          },
          {
            kind: "snippet",
            key: "thanks",
            scope: "environment",
            scopeId: environmentId,
            projectState: "inherit",
            environmentState: "active",
            revision: "r2",
            effective: true,
          },
        ],
      }),
    };
    const page = await render();
    const rowKeys = () =>
      page.root.findAll((node) => node.type === "code").map((node) => node.children.join(""));

    expect(rowKeys()).toEqual(["ship", "thanks"]);
    const itemLink = page.root.findAllByType("a").find((link) => {
      const search = JSON.parse(link.props["data-search"] as string) as { resource?: string };
      return parseItemTarget(search.resource);
    });
    expect(itemLink?.props["data-to"]).toBe("/settings/commands");
    expect(JSON.parse(itemLink?.props["data-search"] as string)).toMatchObject({
      machine: environmentId,
    });
    expect(itemLink?.props["data-hash"]).toBeUndefined();

    const searchInput = page.root.findByProps({ "aria-label": "Search resources" });
    await act(() => searchInput.props.onChange({ currentTarget: { value: "ship" } }));
    expect(rowKeys()).toEqual(["ship"]);
    await act(() => searchInput.props.onChange({ currentTarget: { value: "" } }));
    const snippetFilter = page.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Snippets");
    await act(() => snippetFilter?.props.onClick());
    expect(rowKeys()).toEqual(["thanks"]);
  });

  it("gates scoped MCP reads on capability and links legacy servers to their editor", async () => {
    configureEnvironment();
    const unsupported = await render();
    expect(state.queries.map(({ kind }) => kind)).toEqual(["skills", "text"]);
    expect(state.changes).toEqual(["skills-changes", "text-changes"]);
    expect(
      unsupported.root.findAll(
        (node) =>
          node.type === "p" &&
          node.children.includes("MCP inventory is unavailable on this server."),
      ),
    ).toHaveLength(1);

    await act(() => unsupported.unmount());
    renderer = undefined;
    resetState();
    state.scope = {
      kind: "project",
      group: {},
      environmentId,
      label: "Project / Dev",
      members: [{ id: "project-1", environmentId }],
      environmentIds: [environmentId],
    };
    configureProjectEnvironment({ projectMcpCatalog: true });
    const legacy = await render();

    expect(state.queries.map(({ kind }) => kind)).toEqual(["skills", "text"]);
    expect(
      legacy.root.findAll(
        (node) =>
          node.type === "p" &&
          node.children.join("").includes("Scoped MCP inventory is unavailable"),
      ),
    ).toHaveLength(1);
    expect(
      legacy.root.findAll(
        (node) => node.type === "a" && node.children.join("").includes("Open project MCP settings"),
      ),
    ).toHaveLength(1);

    await act(() => legacy.unmount());
    renderer = undefined;
    resetState();
    state.scope = {
      kind: "project",
      group: {},
      environmentId,
      label: "Project / Dev",
      members: [{ id: "project-1", environmentId }],
      environmentIds: [environmentId],
    };
    configureProjectEnvironment({ projectMcpOverrides: true });
    await render();

    expect(state.queries.map(({ kind }) => kind)).toEqual(["skills", "text", "project-mcp"]);
    expect(state.changes).toEqual(["skills-changes", "text-changes", "mcp-changes"]);
  });

  it("subscribes to supported catalogs without reading bodies, histories, deployment, OAuth, or credentials", async () => {
    configureEnvironment({ capabilities: { globalMcpCatalog: true } });
    await render();

    expect(state.queries.map(({ kind }) => kind)).toEqual(["skills", "text", "global-mcp"]);
    expect(state.forbidden.skillContent).not.toHaveBeenCalled();
    expect(state.forbidden.skillHistory).not.toHaveBeenCalled();
    expect(state.forbidden.skillDeployment).not.toHaveBeenCalled();
    expect(state.forbidden.mcpOauth).not.toHaveBeenCalled();
    expect(state.forbidden.mcpCredentials).not.toHaveBeenCalled();
  });
});

function configureProjectEnvironment(capabilities: Record<string, boolean>) {
  state.environments = [
    {
      environmentId,
      label: "Dev",
      connection: { phase: "connected" },
      serverConfig: { environment: { capabilities } },
    },
  ];
  state.targets = [{ environmentId, label: "Dev", projectId: "project-1" }];
}

function parseItemTarget(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    const encoded = value.slice("t3-resource-v1:".length);
    const target = JSON.parse(decodeURIComponent(encoded)) as { readonly intent?: unknown };
    return target.intent === "item";
  } catch {
    return false;
  }
}
