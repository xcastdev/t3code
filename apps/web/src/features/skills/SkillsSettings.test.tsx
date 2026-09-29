import { EnvironmentId, SkillCatalogListResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  target: null as unknown,
  catalog: null as unknown,
  contentById: {} as Record<string, unknown>,
  queries: [] as Array<{ readonly kind: string; readonly input: unknown }>,
  atoms: {
    catalog: Symbol("catalog"),
    content: Symbol("content"),
    history: Symbol("history"),
    deployment: Symbol("deployment"),
    nativeContent: Symbol("nativeContent"),
    changes: Symbol("changes"),
  },
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({ target: state.target }),
}));
vi.mock("../../state/skills", () => ({
  skillsEnvironment: {
    catalog: (input: { readonly environmentId: string; readonly input: unknown }) => ({
      kind: "catalog",
      ...input,
    }),
    content: (input: {
      readonly environmentId: string;
      readonly input: { readonly skillId: string };
    }) => ({ kind: "content", ...input }),
    history: (input: { readonly environmentId: string; readonly input: unknown }) => ({
      kind: "history",
      ...input,
    }),
    deployment: (input: { readonly environmentId: string; readonly input: unknown }) => ({
      kind: "deployment",
      ...input,
    }),
    nativeContent: (input: { readonly environmentId: string; readonly input: unknown }) => ({
      kind: "native-content",
      ...input,
    }),
    changes: (input: { readonly environmentId: string; readonly input: unknown }) => ({
      kind: "changes",
      ...input,
    }),
    globalCreate: state.atoms.catalog,
    projectSetOverride: state.atoms.content,
    globalUpdate: state.atoms.content,
    globalDelete: state.atoms.content,
    globalRollback: state.atoms.content,
    projectRename: state.atoms.content,
    projectSetDisabled: state.atoms.content,
    projectDeleteState: state.atoms.content,
    globalRename: state.atoms.content,
    deploymentChange: state.atoms.content,
    nativeImport: state.atoms.content,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (
    atom: { readonly kind: string; readonly input: { readonly skillId?: string } } | null,
  ) => {
    if (!atom) return { data: null, error: null, isPending: false, refresh: vi.fn() };
    state.queries.push(atom);
    return {
      data:
        atom.kind === "catalog"
          ? state.catalog
          : atom.kind === "content"
            ? (state.contentById[atom.input.skillId ?? ""] ?? null)
            : null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn().mockResolvedValue({ _tag: "Success" }),
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
    readonly title?: string;
  }) => (
    <section {...props}>
      {title ? <h2>{title}</h2> : null}
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

import { ManagedSkillId } from "@t3tools/contracts";
import { SkillsSettings } from "./SkillsSettings";

const environmentId = EnvironmentId.make("skills-environment");
const firstSkillId = ManagedSkillId.make("first-skill");
const requestedSkillId = ManagedSkillId.make("requested-skill");
const decodeCatalog = Schema.decodeSync(SkillCatalogListResult);

function managedSkill(id: ManagedSkillId, key: string, name: string) {
  return {
    origin: "managed" as const,
    id,
    key,
    name,
    scope: "global" as const,
    scopeId: "global",
    projectState: "inherit" as const,
    revision: { revision: 1, hash: `sha256:${id}` },
    validity: "valid" as const,
    effective: true,
    compatibility: [],
  };
}

function resetState() {
  state.target = { environmentId, projectId: null, label: "Skills server" };
  state.catalog = decodeCatalog({
    catalogRevision: 1,
    entries: [
      managedSkill(firstSkillId, "first", "First skill"),
      managedSkill(requestedSkillId, "requested", "Requested skill"),
    ],
  });
  state.contentById = {
    [firstSkillId]: { content: { name: "First skill", body: "first body" } },
    [requestedSkillId]: { content: { name: "Requested skill", body: "requested body" } },
  };
  state.queries = [];
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
  resourceTarget: React.ComponentProps<typeof SkillsSettings>["resourceTarget"] = null,
) {
  await act(() => {
    renderer = create(<SkillsSettings resourceTarget={resourceTarget} />);
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

describe("skill editor targets", () => {
  it("opens the requested managed skill instead of the first catalog entry", async () => {
    const page = await render({
      namespace: "t3-resource",
      version: 1,
      kind: "skill",
      scope: "environment",
      scopeId: environmentId,
      intent: "item",
      identity: "skill",
      id: requestedSkillId,
    });

    expect(
      page.root
        .findAllByType("textarea")
        .some((textarea) => textarea.props.value === "requested body"),
    ).toBe(true);
    expect(
      state.queries.some(
        (query) =>
          query.kind === "content" &&
          (query.input as { skillId?: string }).skillId === requestedSkillId,
      ),
    ).toBe(true);
    expect(
      state.queries.some(
        (query) =>
          query.kind === "content" &&
          (query.input as { skillId?: string }).skillId === firstSkillId,
      ),
    ).toBe(false);
  });

  it("keeps a stale target missing instead of selecting another managed skill", async () => {
    const page = await render({
      namespace: "t3-resource",
      version: 1,
      kind: "skill",
      scope: "environment",
      scopeId: environmentId,
      intent: "item",
      identity: "skill",
      id: "deleted-skill",
    });

    expect(page.root.findByProps({ role: "status" }).children.join("")).toContain(
      "no longer available",
    );
    expect(state.queries.some((query) => query.kind === "content")).toBe(false);
  });

  it("opens a diagnostic target in recovery context without loading a skill editor", async () => {
    state.catalog = decodeCatalog({
      catalogRevision: 1,
      entries: [managedSkill(firstSkillId, "first", "First skill")],
      diagnostics: [
        {
          scope: "global",
          scopeId: "global",
          name: "broken",
          reasons: [{ code: "parse", message: "Bad frontmatter" }],
        },
      ],
    });
    const page = await render({
      namespace: "t3-resource",
      version: 1,
      kind: "skill",
      scope: "environment",
      scopeId: environmentId,
      intent: "item",
      identity: "diagnostic",
      id: "global:global:broken",
    });

    expect(page.root.findByProps({ id: "resource-target-diagnostic" })).toBeDefined();
    expect(
      page.root
        .findAllByProps({ role: "status" })
        .some((node) => nodeText(node).includes("cannot be opened in the editor")),
    ).toBe(true);
    expect(state.queries.some((query) => query.kind === "content")).toBe(false);
  });
});
