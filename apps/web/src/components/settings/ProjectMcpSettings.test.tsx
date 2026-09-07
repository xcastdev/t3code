/* @vitest-environment happy-dom */

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
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const atoms = vi.hoisted(() => ({
  catalog: Symbol("catalog"),
  create: Symbol("create"),
  update: Symbol("update"),
  remove: Symbol("remove"),
  oauthBegin: Symbol("oauthBegin"),
  oauthContinue: Symbol("oauthContinue"),
  oauthDisconnect: Symbol("oauthDisconnect"),
}));

const commands = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  oauthBegin: vi.fn(),
  oauthContinue: vi.fn(),
  oauthDisconnect: vi.fn(),
}));

const query = vi.hoisted(() => ({
  data: null as unknown,
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
}));

vi.mock("../../state/projects", () => ({
  projectMcpEnvironment: {
    catalog: () => atoms.catalog,
    create: atoms.create,
    update: atoms.update,
    remove: atoms.remove,
    oauthBegin: atoms.oauthBegin,
    oauthContinue: atoms.oauthContinue,
    oauthDisconnect: atoms.oauthDisconnect,
  },
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => query,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.create) return commands.create;
    if (atom === atoms.update) return commands.update;
    if (atom === atoms.oauthBegin) return commands.oauthBegin;
    if (atom === atoms.oauthContinue) return commands.oauthContinue;
    if (atom === atoms.oauthDisconnect) return commands.oauthDisconnect;
    return commands.remove;
  },
}));

vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogClose: ({ render }: { render: React.ReactNode }) => render,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("../ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    render: _render,
    ...props
  }: React.ComponentProps<"button"> & { size?: unknown; variant?: unknown; render?: unknown }) => (
    <button {...props} />
  ),
}));

vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: React.ComponentProps<"input"> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      {...props}
      checked={checked}
      type="checkbox"
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogClose: ({ render }: { render: React.ReactNode }) => render,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("../ui/input", async () => {
  const React = await import("react");
  return {
    Input: React.forwardRef<
      HTMLInputElement,
      React.ComponentProps<"input"> & { nativeInput?: boolean; size?: unknown; unstyled?: boolean }
    >(({ nativeInput: _nativeInput, size: _size, unstyled: _unstyled, ...props }, ref) => (
      <input ref={ref} {...props} />
    )),
  };
});

vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: React.ComponentProps<"button"> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      {...props}
      aria-checked={checked}
      role="switch"
      type="button"
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

vi.mock("../ui/toast", () => ({
  stackedThreadToast: vi.fn(),
  toastManager: { add: vi.fn() },
}));

vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
  }: {
    title: string;
    description?: string;
    status?: string;
    control?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {status ? <p>{status}</p> : null}
      {control}
      {children}
    </section>
  ),
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
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

const roots: Root[] = [];

async function renderPanel(
  canMutate = true,
  scope: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } = {
    environmentId,
    projectId,
  },
): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <ProjectMcpCatalogSettings
        canMutate={canMutate}
        environmentId={scope.environmentId}
        projectId={scope.projectId}
        providers={[provider()]}
      />,
    );
  });
  return root;
}

async function rerenderPanel(
  root: Root,
  scope: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): Promise<void> {
  await act(async () => {
    root.render(
      <ProjectMcpCatalogSettings
        canMutate
        environmentId={scope.environmentId}
        projectId={scope.projectId}
        providers={[provider()]}
      />,
    );
  });
}

function labelled<T extends Element>(label: string): T {
  const element = document.querySelector(`[aria-label="${label}"]`);
  expect(element).not.toBeNull();
  return element as T;
}

function button(label: string, occurrence = 0): HTMLButtonElement {
  const buttons = [...document.querySelectorAll("button")].filter(
    (element) => element.textContent === label,
  );
  expect(buttons[occurrence]).toBeDefined();
  return buttons[occurrence]!;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

async function input(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(element, value);
  await act(async () => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ProjectMcpSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    query.data = catalog();
    query.error = null;
    query.isPending = false;
    query.refresh.mockReset();
    commands.create.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.update.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.remove.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.oauthBegin.mockReset().mockResolvedValue({
      _tag: "Success",
      value: {
        authorizationUrl: "https://auth.example.com",
        expiresAt: "2026-09-02T00:00:00.000Z",
      },
    });
    commands.oauthContinue.mockReset().mockResolvedValue({
      _tag: "Success",
      value: {
        authorizationUrl: "https://auth.example.com/step-up",
        expiresAt: "2026-09-02T00:00:00.000Z",
      },
    });
    commands.oauthDisconnect.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("labels next-session support honestly", () => {
    expect(applicationLabel("next-session")).toBe("Applies to new sessions");
  });

  it("renders managed entries without mutation controls and disables mutations without operate access", async () => {
    await renderPanel(false);

    expect(canEdit(managedEntry)).toBe(false);
    expect(document.body.textContent).toContain("Managed by T3");
    expect(document.querySelector('[aria-label="Edit t3-code"]')).toBeNull();
    expect(document.querySelector('[aria-label="Remove t3-code"]')).toBeNull();
    expect(button("Add server").disabled).toBe(true);
    expect(labelled<HTMLButtonElement>("Enable External").disabled).toBe(true);
    expect(labelled<HTMLButtonElement>("Edit External").disabled).toBe(true);
    expect(labelled<HTMLButtonElement>("Remove External").disabled).toBe(true);
  });

  it("submits accessible blank-field validation instead of native constraint validation", async () => {
    await renderPanel();
    await click(button("Add server"));

    expect(document.querySelector("form")).not.toBeNull();
    expect(labelled<HTMLInputElement>("MCP server name").required).toBe(true);
    expect(labelled<HTMLInputElement>("MCP server URL").required).toBe(true);

    await click(button("Add server", 1));

    const name = labelled<HTMLInputElement>("MCP server name");
    const url = labelled<HTMLInputElement>("MCP server URL");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("project-mcp-name-error");
    expect(url.getAttribute("aria-describedby")).toBe("project-mcp-url-error");
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(document.activeElement).toBe(name);

    await input(name, "External");
    expect(name.getAttribute("aria-invalid")).toBe("false");
    expect(url.getAttribute("aria-invalid")).toBe("true");
  });

  it("saves a server with an empty provider selection", async () => {
    await renderPanel();
    await click(button("Add server"));
    await input(labelled<HTMLInputElement>("MCP server name"), "Detached");
    await input(labelled<HTMLInputElement>("MCP server URL"), "https://detached.example.com/mcp");
    await click(button("Add server", 1));
    await settle();

    expect(commands.create).toHaveBeenCalledWith({
      environmentId,
      input: {
        projectId,
        name: "Detached",
        transport: {
          type: "streamable-http",
          url: "https://detached.example.com/mcp",
          headers: [],
          authorization: { type: "none" },
        },
        enabled: true,
        providerInstanceIds: [],
      },
    });
  });

  it("selects streamable HTTP and saves named credentials without rendering their values", async () => {
    await renderPanel();
    await click(button("Add server"));
    await input(labelled<HTMLInputElement>("MCP server name"), "Secure");
    const transport = document.querySelector<HTMLSelectElement>('[aria-label="MCP transport"]')!;
    transport.value = "streamable-http";
    transport.dispatchEvent(new Event("change", { bubbles: true }));
    await input(labelled<HTMLInputElement>("MCP server URL"), "https://secure.example.com/mcp");
    await input(labelled<HTMLInputElement>("HTTP header name 1"), "X-API-Key");
    await input(labelled<HTMLInputElement>("HTTP header value 1"), "secret-value");
    await click(button("Add server", 1));
    await settle();

    expect(commands.create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          transport: expect.objectContaining({
            type: "streamable-http",
            headers: [
              { name: "X-API-Key", credential: { name: "X-API-Key", value: "secret-value" } },
            ],
          }),
        }),
      }),
    );
    expect(document.body.textContent).not.toContain("secret-value");
  });

  it("normalizes a legacy URL entry to streamable HTTP when adding authentication", async () => {
    await renderPanel();
    await click(labelled<HTMLButtonElement>("Edit External"));
    await input(labelled<HTMLInputElement>("HTTP header name 1"), "X-API-Key");
    await input(labelled<HTMLInputElement>("HTTP header value 1"), "secret-value");
    await click(button("Save changes"));
    await settle();

    expect(commands.update).toHaveBeenCalledWith({
      environmentId,
      input: {
        projectId,
        id: McpServerId.make("external"),
        name: "External",
        transport: {
          type: "streamable-http",
          url: "https://mcp.example.com/endpoint",
          headers: [
            { name: "X-API-Key", credential: { name: "X-API-Key", value: "secret-value" } },
          ],
          authorization: { type: "none" },
        },
        enabled: true,
        providerInstanceIds: [codexId],
      },
    });
  });

  it("offers OAuth connect and disconnect actions", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    query.data = decodeProjectMcpCatalog({
      external: [
        {
          ...externalServer(),
          transport: {
            type: "streamable-http",
            url: "https://mcp.example.com/endpoint",
            headers: [],
            authorization: { type: "oauth", registration: { type: "automatic" } },
          },
          url: undefined,
          oauthStatus: "not-connected",
        },
      ],
      managed: [managedEntry],
      applications: [],
    });
    await renderPanel();
    await click(labelled<HTMLButtonElement>("Edit External"));
    expect(document.body.textContent).toContain("OAuth");
    await click(button("Connect OAuth"));
    await settle();
    expect(commands.oauthBegin).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, id: McpServerId.make("external") },
    });
    expect(open).toHaveBeenCalledWith("https://auth.example.com", "_blank", "noopener,noreferrer");
    expect(query.refresh).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it("refreshes OAuth status on focus and uses the current catalog entry in an open edit form", async () => {
    query.data = decodeProjectMcpCatalog({
      external: [
        {
          ...externalServer(),
          transport: {
            type: "streamable-http",
            url: "https://mcp.example.com/endpoint",
            headers: [],
            authorization: { type: "oauth", registration: { type: "automatic" } },
          },
          url: undefined,
          oauthStatus: "connected",
        },
      ],
      managed: [managedEntry],
      applications: [],
    });
    const root = await renderPanel();
    await click(labelled<HTMLButtonElement>("Edit External"));
    expect(document.body.textContent).toContain("Reconnect OAuth");
    expect(document.body.textContent).toContain("Disconnect OAuth");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(query.refresh).toHaveBeenCalledTimes(1);

    query.data = decodeProjectMcpCatalog({
      external: [
        {
          ...externalServer(),
          transport: {
            type: "streamable-http",
            url: "https://mcp.example.com/endpoint",
            headers: [],
            authorization: { type: "oauth", registration: { type: "automatic" } },
          },
          url: undefined,
          oauthStatus: "not-connected",
        },
      ],
      managed: [managedEntry],
      applications: [],
    });
    await rerenderPanel(root, { environmentId, projectId });

    expect(document.body.textContent).toContain("Connect OAuth");
    expect(document.body.textContent).not.toContain("Disconnect OAuth");
  });

  it("offers an authorization continuation while OAuth is pending", async () => {
    query.data = decodeProjectMcpCatalog({
      external: [
        {
          ...externalServer(),
          transport: {
            type: "streamable-http",
            url: "https://mcp.example.com/endpoint",
            headers: [],
            authorization: { type: "oauth", registration: { type: "automatic" } },
          },
          url: undefined,
          oauthStatus: "authorization-pending",
        },
      ],
      managed: [managedEntry],
      applications: [],
    });
    await renderPanel();
    await click(labelled<HTMLButtonElement>("Edit External"));

    expect(document.body.textContent).toContain("Continue authorization");
    expect(document.body.textContent).not.toContain("Connect OAuth");
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await click(button("Continue authorization"));
    expect(commands.oauthContinue).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, id: McpServerId.make("external") },
    });
    expect(open).toHaveBeenCalledWith(
      "https://auth.example.com/step-up",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("shows and removes stale providers while editing", async () => {
    query.data = catalog([removedProviderId]);
    await renderPanel();
    await click(labelled<HTMLButtonElement>("Edit External"));

    const staleProvider = labelled<HTMLInputElement>(
      "Select unavailable provider removed-provider",
    );
    expect(staleProvider.checked).toBe(true);
    await click(staleProvider);
    await click(button("Save changes"));
    await settle();

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

  it("requires confirmation before removing a server", async () => {
    await renderPanel();
    await click(labelled<HTMLButtonElement>("Remove External"));

    expect(commands.remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Remove "External"?');

    await click(button("Remove server"));
    await settle();

    expect(commands.remove).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, id: externalServer().id },
    });
  });

  it("discards open mutation state when the physical checkout changes", async () => {
    const root = await renderPanel();
    await click(button("Add server"));
    await input(labelled<HTMLInputElement>("MCP server name"), "Stale draft");

    await rerenderPanel(root, {
      environmentId: EnvironmentId.make("environment-two"),
      projectId: ProjectId.make("project-two"),
    });

    expect(document.querySelector("form")).toBeNull();
    expect(document.body.textContent).not.toContain("Stale draft");

    await click(labelled<HTMLButtonElement>("Remove External"));
    expect(document.body.textContent).toContain('Remove "External"?');

    await rerenderPanel(root, {
      environmentId: EnvironmentId.make("environment-three"),
      projectId: ProjectId.make("project-three"),
    });

    expect(document.body.textContent).not.toContain('Remove "External"?');
    expect(commands.create).not.toHaveBeenCalled();
    expect(commands.remove).not.toHaveBeenCalled();
  });
});
