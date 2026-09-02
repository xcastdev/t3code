import {
  EnvironmentId,
  McpServerId,
  ProjectId,
  ProjectMcpCatalog,
  ProjectMcpManagedServer,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  catalog: Symbol("catalog"),
  create: Symbol("create"),
  update: Symbol("update"),
  remove: Symbol("remove"),
}));

const commands = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const query = vi.hoisted(() => ({
  data: null as unknown,
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/projects", () => ({
  projectMcpEnvironment: {
    catalog: () => atoms.catalog,
    create: atoms.create,
    update: atoms.update,
    remove: atoms.remove,
  },
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => query,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.create) return commands.create;
    if (atom === atoms.update) return commands.update;
    return commands.remove;
  },
}));

import { applicationLabel, canEdit, ProjectMcpCatalogSettings } from "./ProjectMcpSettings";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const codexId = ProviderInstanceId.make("codex");
const removedProviderId = ProviderInstanceId.make("removed-provider");

const managedEntry = Schema.decodeUnknownSync(ProjectMcpManagedServer)({
  id: McpServerId.make("t3-code"),
  name: "t3-code",
  url: "http://127.0.0.1:8787/mcp",
  providerInstanceIds: [codexId],
});
const decodeProjectMcpCatalog = Schema.decodeUnknownSync(ProjectMcpCatalog);

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-02T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function externalServer(providerInstanceIds: ReadonlyArray<ProviderInstanceId> = [codexId]) {
  return decodeProjectMcpCatalog({
    external: [
      {
        id: McpServerId.make("external"),
        name: "External",
        url: "https://mcp.example.com/endpoint",
        enabled: true,
        providerInstanceIds,
      },
    ],
    managed: [managedEntry],
    applications: providerInstanceIds.map((providerInstanceId) => ({
      serverId: McpServerId.make("external"),
      providerInstanceId,
      mode: "next-session",
    })),
  }).external[0]!;
}

function catalog(providerInstanceIds: ReadonlyArray<ProviderInstanceId> = [codexId]) {
  const external = externalServer(providerInstanceIds);
  return decodeProjectMcpCatalog({
    external: [external],
    managed: [managedEntry],
    applications: [
      ...providerInstanceIds.map((providerInstanceId) => ({
        serverId: external.id,
        providerInstanceId,
        mode: "next-session",
      })),
      {
        serverId: managedEntry.id,
        providerInstanceId: codexId,
        mode: "active-session",
      },
    ],
  });
}

function renderPanel(canMutate = true): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ProjectMcpCatalogSettings({
    environmentId,
    projectId,
    providers: [provider()],
    canMutate,
  }) as ReactElement<Record<string, unknown>>;
}

function action(tree: unknown, label: string): ReactElement<Record<string, unknown>> {
  const found = visitElements(tree, (element) => element.props["aria-label"] === label);
  expect(found).not.toBeNull();
  return found!;
}

function button(tree: unknown, label: string): ReactElement<Record<string, unknown>> {
  const found = visitElements(tree, (element) => {
    const children = element.props.children;
    return children === label || (Array.isArray(children) && children.includes(label));
  });
  expect(found).not.toBeNull();
  return found!;
}

function submit(tree: unknown): void {
  const form = visitElements(tree, (element) => element.type === "form");
  expect(form).not.toBeNull();
  (form?.props.onSubmit as ((event: { preventDefault: () => void }) => void) | undefined)?.({
    preventDefault: vi.fn(),
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProjectMcpSettings", () => {
  beforeEach(() => {
    hooks.reset();
    query.data = catalog();
    query.error = null;
    query.isPending = false;
    query.refresh.mockReset();
    commands.create.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.update.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.remove.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("labels next-session support honestly", () => {
    expect(applicationLabel("next-session")).toBe("Applies to new sessions");
  });

  it("does not expose mutation controls for a managed entry", () => {
    const tree = renderPanel();
    expect(canEdit(managedEntry)).toBe(false);
    expect(
      visitElements(tree, (element) => element.props["aria-label"] === "Edit t3-code"),
    ).toBeNull();
    expect(
      visitElements(tree, (element) => element.props["aria-label"] === "Remove t3-code"),
    ).toBeNull();
  });

  it("keeps mutations disabled while operate access is unavailable", () => {
    const tree = renderPanel(false);
    expect(button(tree, "Add server").props.disabled).toBe(true);
    expect(action(tree, "Enable External").props.disabled).toBe(true);
    expect(action(tree, "Edit External").props.disabled).toBe(true);
    expect(action(tree, "Remove External").props.disabled).toBe(true);
  });

  it("saves a server without any selected providers", async () => {
    let tree = renderPanel();
    (button(tree, "Add server").props.onClick as (() => void) | undefined)?.();
    tree = renderPanel();
    (action(tree, "MCP server name").props.onChange as ((event: unknown) => void) | undefined)?.({
      target: { value: "Detached" },
    });
    tree = renderPanel();
    (action(tree, "MCP server URL").props.onChange as ((event: unknown) => void) | undefined)?.({
      target: { value: "https://detached.example.com/mcp" },
    });
    tree = renderPanel();
    submit(tree);
    await flushPromises();

    expect(commands.create).toHaveBeenCalledWith({
      environmentId,
      input: {
        projectId,
        name: "Detached",
        url: "https://detached.example.com/mcp",
        enabled: true,
        providerInstanceIds: [],
      },
    });
  });

  it("keeps a stale provider visible until the user removes it", async () => {
    query.data = catalog([removedProviderId]);
    let tree = renderPanel();
    (action(tree, "Edit External").props.onClick as (() => void) | undefined)?.();
    tree = renderPanel();
    const staleProvider = action(tree, "Select unavailable provider removed-provider");
    expect(staleProvider.props.checked).toBe(true);
    (staleProvider.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);
    tree = renderPanel();
    submit(tree);
    await flushPromises();

    expect(commands.update).toHaveBeenCalledWith({
      environmentId,
      input: {
        projectId,
        id: externalServer([removedProviderId]).id,
        name: "External",
        url: "https://mcp.example.com/endpoint",
        enabled: true,
        providerInstanceIds: [],
      },
    });
  });

  it("waits for confirmation before removing a server", async () => {
    let tree = renderPanel();
    (action(tree, "Remove External").props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(commands.remove).not.toHaveBeenCalled();

    tree = renderPanel();
    expect(button(tree, "Remove server")).not.toBeNull();
    (button(tree, "Remove server").props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(commands.remove).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, id: externalServer().id },
    });
  });

  it("marks blank name and URL fields invalid and clears each error when corrected", () => {
    let tree = renderPanel();
    (button(tree, "Add server").props.onClick as (() => void) | undefined)?.();
    tree = renderPanel();
    submit(tree);
    tree = renderPanel();

    const name = action(tree, "MCP server name");
    const url = action(tree, "MCP server URL");
    expect(name.props.required).toBe(true);
    expect(url.props.required).toBe(true);
    expect(name.props["aria-invalid"]).toBe(true);
    expect(url.props["aria-invalid"]).toBe(true);
    expect(name.props["aria-describedby"]).toBe("project-mcp-name-error");
    expect(url.props["aria-describedby"]).toBe("project-mcp-url-error");
    expect(visitElements(tree, (element) => element.props.role === "alert")).not.toBeNull();

    (name.props.onChange as ((event: unknown) => void) | undefined)?.({
      target: { value: "External" },
    });
    tree = renderPanel();
    expect(action(tree, "MCP server name").props["aria-invalid"]).toBe(false);
    expect(action(tree, "MCP server URL").props["aria-invalid"]).toBe(true);
  });
});
