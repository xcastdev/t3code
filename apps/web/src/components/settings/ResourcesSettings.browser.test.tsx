import {
  EnvironmentId,
  SkillCatalogListResult,
  ManagedTextResourceCatalogListResult,
  McpCatalogReadResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ResourcesSettings } from "./ResourcesSettings";

const catalogs = vi.hoisted(() => new Map<string, unknown>());
const decodeSkills = Schema.decodeSync(SkillCatalogListResult);
const decodeText = Schema.decodeSync(ManagedTextResourceCatalogListResult);
const decodeMcp = Schema.decodeSync(McpCatalogReadResult);

vi.mock("../../state/resources", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const permission = { permissionAtom: () => Atom.make(true) };
  const loaded = (name: string) => Atom.make(AsyncResult.success(catalogs.get(name)));
  return {
    useResourceCatalogSubscriptions: () => {},
    skillsEnvironment: {
      catalog: () => loaded("skills"),
      globalUpdate: permission,
      projectSetOverride: permission,
      sessionSetEnabled: permission,
      deploymentChange: permission,
    },
    managedTextEnvironment: {
      catalog: () => loaded("text"),
      environmentUpdate: permission,
      projectSetOverride: permission,
      threadSetEnabled: permission,
    },
    mcpCatalogEnvironment: {
      read: () => loaded("mcp"),
      write: permission,
      oauthBegin: permission,
      sessionReset: permission,
    },
  };
});

vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(null);
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: () => config },
  };
});

vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
  useSettingsScope: () => ({
    target: { environmentId: EnvironmentId.make("resource-test") },
    scope: { kind: "environment" },
    search: {},
    selectScope: () => {},
  }),
}));

function setup() {
  catalogs.clear();
  catalogs.set(
    "skills",
    decodeSkills({
      catalogRevision: 1,
      entries: [
        {
          origin: "managed",
          id: "skill-review",
          key: "review-code",
          name: "Review code",
          scope: "global",
          scopeId: "resource-test",
          projectState: "inherit",
          revision: { revision: 1, hash: "a".repeat(64) },
          validity: "valid",
          effective: true,
          compatibility: [],
        },
      ],
    }),
  );
  catalogs.set(
    "text",
    decodeText({
      catalogRevision: 1,
      entries: [
        {
          kind: "command",
          id: "inspect",
          key: "inspect-changes",
          name: "Inspect changes",
          scope: "environment",
          scopeId: "resource-test",
          projectState: "inherit",
          revision: "a".repeat(64),
          effective: true,
        },
        {
          kind: "snippet",
          id: "completion",
          key: "completion-note",
          name: "Completion note",
          scope: "environment",
          scopeId: "resource-test",
          projectState: "inherit",
          revision: "b".repeat(64),
          effective: true,
        },
      ],
    }),
  );
  catalogs.set(
    "mcp",
    decodeMcp({
      revision: 1,
      overrides: [],
      definitions: [
        {
          definitionId: "docs-definition",
          logicalServerId: "docs-server",
          name: "Documentation server",
          scope: "global",
          scopeId: "resource-test",
          revision: 1,
          enabled: false,
          providerInstanceIds: [],
          transport: {
            type: "streamable-http",
            url: "http://127.0.0.1:9/mcp",
            headers: [],
            authorization: { type: "none" },
          },
        },
      ],
    }),
  );
}

it("shows each resource once with its management action", async () => {
  setup();
  await using screen = await render(<ResourcesSettings />);
  for (const name of ["Review code", "Documentation server", "Inspect changes", "Completion note"])
    await expect.element(screen.getByText(name, { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Actions for Review code" }))
    .toBeVisible();
});

it("selects one resource kind and its creation action", async () => {
  setup();
  await using screen = await render(<ResourcesSettings />);
  await userEvent.click(screen.getByRole("button", { name: "MCP", exact: true }));
  await expect.element(screen.getByText("Documentation server", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "New skill", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByText("Inspect changes", { exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Commands", exact: true }));
  await expect.element(screen.getByText("Inspect changes", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Completion note", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "New command", exact: true }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Snippets", exact: true }));
  await expect.element(screen.getByText("Completion note", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Inspect changes", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "New snippet", exact: true }))
    .toBeVisible();
});

it("searches names and keys across the editable catalogs and keeps the query when switching kinds", async () => {
  setup();
  await using screen = await render(<ResourcesSettings />);
  await userEvent.type(screen.getByRole("searchbox", { name: "Filter resources" }), "REVIEW-CODE");
  await expect.element(screen.getByText("Review code", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Documentation server", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByText("Inspect changes", { exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Commands", exact: true }));
  await expect
    .element(screen.getByRole("searchbox", { name: "Filter resources" }))
    .toHaveValue("REVIEW-CODE");
  await expect
    .element(screen.getByRole("button", { name: "New command", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByText("Inspect changes", { exact: true }))
    .not.toBeInTheDocument();
});
