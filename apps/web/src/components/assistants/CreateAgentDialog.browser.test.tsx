import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { CreateAgentDialog } from "./CreateAgentDialog";

const writer = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "fixture-model", name: "Fixture model", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([provider]).pipe(Atom.keepAlive);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => providers) as never,
    } as never,
  };
});
vi.mock(import("./useAssistants"), async (original) => ({
  ...(await original()),
  useAssistantConnection: (() => ({ connected: true, epoch: null })) as never,
  useAssistantWriter: (() => ({
    permissions: { create: true },
    pendingKey: null,
    failureFor: () => null,
    run: writer.run,
  })) as never,
}));

describe("CreateAgentDialog", () => {
  it("asks for a model instead of showing an unchosen default", async () => {
    await using screen = await render(
      <CreateAgentDialog environmentId={EnvironmentId.make("local")} onClose={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText("Name"), "Helper");

    const create = page.getByRole("button", { name: "Create agent" });
    const picker = page.getByRole("button", { name: "Choose a model" });
    await expect.element(picker).toBeVisible();
    await expect.element(create).toBeDisabled();

    await userEvent.click(picker);
    await userEvent.click(page.getByText("Fixture model"));

    await expect.element(page.getByRole("button", { name: /Fixture model/ })).toBeVisible();
    await expect.element(create).toBeEnabled();
  });
});
