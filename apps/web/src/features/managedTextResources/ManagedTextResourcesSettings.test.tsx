import { EnvironmentId, ManagedTextResourceCatalogListResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  target: null as unknown,
  catalogs: {} as Record<string, unknown>,
  content: null as unknown,
  queries: [] as Array<{
    readonly kind: string;
    readonly environmentId: string;
    readonly input: unknown;
  }>,
  refresh: vi.fn(),
  update: vi.fn(),
  atoms: {
    environmentCreate: Symbol("environmentCreate"),
    environmentUpdate: Symbol("environmentUpdate"),
    environmentDelete: Symbol("environmentDelete"),
    projectSetOverride: Symbol("projectSetOverride"),
    projectSetDisabled: Symbol("projectSetDisabled"),
    projectDeleteState: Symbol("projectDeleteState"),
    environmentSetEnabled: Symbol("environmentSetEnabled"),
  },
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({ target: state.target }),
}));
vi.mock("../../state/managedTextResources", () => ({
  managedTextResourcesEnvironment: {
    catalog: (input: { readonly environmentId: string; readonly input: unknown }) => ({
      kind: "catalog",
      ...input,
    }),
    changes: (input: { readonly environmentId: string; readonly input: unknown }) => ({
      kind: "changes",
      ...input,
    }),
    content: (input: { readonly environmentId: string; readonly input: unknown }) => ({
      kind: "content",
      ...input,
    }),
    ...state.atoms,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (
    atom: { readonly kind: string; readonly environmentId: string; readonly input: unknown } | null,
  ) => {
    if (!atom) return { data: null, error: null, isPending: false, refresh: state.refresh };
    state.queries.push(atom);
    return {
      data: atom.kind === "catalog" ? (state.catalogs[atom.environmentId] ?? null) : state.content,
      error: null,
      isPending: false,
      refresh: state.refresh,
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.update,
}));
vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { readonly children: React.ReactNode }) => (
    <main>{children}</main>
  ),
  SettingsSection: ({
    children,
    title,
    ...props
  }: {
    readonly children: React.ReactNode;
    readonly title: string;
  }) => (
    <section {...props}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock("../../components/ui/badge", () => ({
  Badge: ({ children }: { readonly children: React.ReactNode }) => <span>{children}</span>,
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
vi.mock("../../components/ui/textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { ManagedTextResourcesSettings } from "./ManagedTextResourcesSettings";

const firstEnvironmentId = EnvironmentId.make("first-environment");
const secondEnvironmentId = EnvironmentId.make("second-environment");
const decodeCatalog = Schema.decodeSync(ManagedTextResourceCatalogListResult);

function emptyCatalog() {
  return decodeCatalog({ catalogRevision: 1, entries: [] });
}

function environmentTarget(environmentId: EnvironmentId) {
  return { environmentId, projectId: null, label: environmentId };
}

function commandCatalog(environmentId: EnvironmentId) {
  return decodeCatalog({
    catalogRevision: 1,
    entries: [
      {
        kind: "command",
        id: `id-${environmentId}`,
        key: "review",
        name: "Review",
        scope: "environment",
        scopeId: environmentId,
        projectState: "inherit",
        environmentState: "active",
        revision: "revision-1",
        effective: true,
      },
    ],
  });
}

function resetState() {
  state.target = environmentTarget(firstEnvironmentId);
  state.catalogs = {
    [firstEnvironmentId]: emptyCatalog(),
    [secondEnvironmentId]: emptyCatalog(),
  };
  state.content = null;
  state.queries = [];
  state.refresh.mockReset();
  state.update.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { catalogRevision: 2, summaries: [], changedKeys: [], audit: {} },
  });
}

function nodeText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node && typeof node === "object" && "children" in node) {
    return nodeText((node as { readonly children: unknown }).children);
  }
  return "";
}

let renderer: ReactTestRenderer | undefined;

async function render(
  resourceTarget: React.ComponentProps<
    typeof ManagedTextResourcesSettings
  >["resourceTarget"] = null,
) {
  await act(() => {
    renderer = create(<ManagedTextResourcesSettings resourceTarget={resourceTarget} />);
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

describe("managed text resource editor targets", () => {
  it("opens the requested catalog summary and refreshes after saving its mutation", async () => {
    state.catalogs[firstEnvironmentId] = commandCatalog(firstEnvironmentId);
    const summary = (state.catalogs[firstEnvironmentId] as ReturnType<typeof commandCatalog>)
      .entries[0]!;
    state.content = {
      id: summary.id,
      revision: summary.revision,
      name: summary.name,
      body: "Original instructions",
    };
    const target = {
      namespace: "t3-resource",
      version: 1,
      kind: "command",
      scope: "environment",
      scopeId: firstEnvironmentId,
      intent: "item",
      identity: "summary",
      id: `command:review:environment:${firstEnvironmentId}`,
    } as const;
    const page = await render(target);

    expect(page.root.findByProps({ "aria-label": "Command template" }).props.value).toBe(
      "Original instructions",
    );
    expect(state.queries.find((query) => query.kind === "content")?.input).toMatchObject({
      id: summary.id,
      kind: "command",
    });
    await act(() =>
      page.root
        .findByProps({ "aria-label": "Command template" })
        .props.onChange({ currentTarget: { value: "Updated instructions" } }),
    );
    await act(() =>
      page.root
        .findAllByType("button")
        .find((button) => nodeText(button.children) === "Save changes")
        ?.props.onClick(),
    );

    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: firstEnvironmentId,
        input: expect.objectContaining({ id: summary.id, body: "Updated instructions" }),
      }),
    );
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("clears a new-resource draft when the selected physical environment changes", async () => {
    const page = await render();
    await act(() =>
      page.root
        .findByProps({ "aria-label": "Command template" })
        .props.onChange({ currentTarget: { value: "First environment draft" } }),
    );

    state.target = environmentTarget(secondEnvironmentId);
    await act(() => page.update(<ManagedTextResourcesSettings />));

    expect(page.root.findByProps({ "aria-label": "Command template" }).props.value).toBe("");
    expect(
      state.queries.some(
        (query) => query.kind === "catalog" && query.environmentId === secondEnvironmentId,
      ),
    ).toBe(true);
  });

  it("clears a new command draft when switching the active resource kind", async () => {
    const page = await render();
    await act(() =>
      page.root
        .findByProps({ "aria-label": "Command template" })
        .props.onChange({ currentTarget: { value: "Command-only draft" } }),
    );
    const snippets = page.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Snippets");
    await act(() => snippets?.props.onClick());

    expect(page.root.findByProps({ "aria-label": "Snippet text" }).props.value).toBe("");
  });

  it("shows a stale target instead of selecting the first catalog entry", async () => {
    state.catalogs[firstEnvironmentId] = commandCatalog(firstEnvironmentId);
    const target = {
      namespace: "t3-resource",
      version: 1,
      kind: "command",
      scope: "environment",
      scopeId: firstEnvironmentId,
      intent: "item",
      identity: "summary",
      id: "command:deleted:environment:first-environment",
    } as const;
    const page = await render(target);

    expect(page.root.findByProps({ role: "status" }).children.join("")).toContain(
      "no longer available",
    );
    expect(state.queries.some((query) => query.kind === "content")).toBe(false);
  });
});
