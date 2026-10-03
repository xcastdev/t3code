/* @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CodexSettings,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsPatch,
  type ProviderInstanceConfig,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  providers: [] as ServerProvider[],
  updateSettings: vi.fn(),
  updateClientSettings: vi.fn(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => state.settings,
  useUpdateEnvironmentSettings: () => state.updateSettings,
  useUpdateClientSettings: () => state.updateClientSettings,
  usePrimarySettingsAvailable: () => true,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.providers,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("./UsageProviderSettings", () => ({ UsageProviderSettings: () => null }));
vi.mock("./AddProviderInstanceDialog", () => ({ AddProviderInstanceDialog: () => null }));

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { getDriverOption } from "./providerDriverMeta";

const decodeSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodePiSettings = Schema.decodeUnknownSync(PiSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

const pi = ProviderDriverKind.make("piAgent");
const codex = ProviderDriverKind.make("codex");
const piId = ProviderInstanceId.make("piAgent");
const environmentId = EnvironmentId.make("pi-settings-environment");
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.providers = [];
  state.updateSettings.mockReset();
  state.updateClientSettings.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("Input value setter was not found");
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const nativeModels = [
  { slug: "native-one", name: "Native one", isCustom: false, capabilities: null },
  { slug: "native-two", name: "Native two", isCustom: false, capabilities: null },
];

async function renderCard(driver: ProviderDriverKind) {
  const instance: ProviderInstanceConfig = {
    driver,
    enabled: true,
    config: driver === pi ? { agentDirectory: "/one" } : {},
  };
  await act(async () =>
    root.render(
      <ProviderInstanceCard
        instanceId={piId}
        instance={instance}
        driverOption={getDriverOption(driver)}
        liveProvider={{
          instanceId: piId,
          driver,
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-10-03T00:00:00Z",
          models: nativeModels,
          slashCommands: [],
          skills: [],
        }}
        mode="editor"
        onUpdate={state.updateSettings}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={state.updateClientSettings}
        onFavoriteModelsChange={state.updateClientSettings}
        onModelOrderChange={state.updateClientSettings}
      />,
    ),
  );
  return instance;
}

describe("Pi model configuration", () => {
  it("keeps native model preferences without offering invalid custom-model writes", async () => {
    const instance = await renderCard(pi);
    expect(host.textContent).toContain("Native one");
    expect(host.textContent).toContain("Native two");
    expect(host.textContent).not.toContain("Add custom model");

    await act(async () => button("Add Native one to favorites").click());
    expect(state.updateClientSettings).toHaveBeenLastCalledWith(["native-one"]);
    await act(async () => button("Move Native two up").click());
    expect(state.updateClientSettings).toHaveBeenLastCalledWith(["native-two", "native-one"]);
    const visibility = host.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Show Native one in the model picker"]',
    );
    if (!visibility) throw new Error("Native model visibility switch was not rendered");
    await act(async () => visibility.click());
    expect(state.updateClientSettings).toHaveBeenLastCalledWith(["native-one"]);
    expect(state.updateSettings).not.toHaveBeenCalled();

    const persisted = decodeSettingsPatch({
      providerInstances: { [piId]: instance },
    }).providerInstances?.[piId];
    expect(decodePiSettings(persisted?.config)).toEqual({
      agentDirectory: "/one",
    });
  });

  it("keeps actual custom-model additions valid for Codex", async () => {
    await renderCard(codex);
    await act(async () => button("Add custom model").click());
    const input = host.querySelector<HTMLInputElement>('input[id$="-custom-model"]');
    if (!input) throw new Error("Custom model input was not rendered");
    await fill(input, "test-model");
    await act(async () => button("Add").click());

    const instance = state.updateSettings.mock.lastCall?.[0];
    const persisted = decodeSettingsPatch({
      providerInstances: { [piId]: instance },
    }).providerInstances?.[piId];
    expect(decodeCodexSettings(persisted?.config).customModels).toEqual(["test-model"]);
  });

  it("withdraws an open custom-model editor when the driver becomes Pi", async () => {
    const model = { slug: "custom", name: "Custom", isCustom: true, capabilities: null };
    const renderModels = async (driverKind: ProviderDriverKind) => {
      await act(async () =>
        root.render(
          <ProviderModelsSection
            instanceId={piId}
            driverKind={driverKind}
            models={[model]}
            customModels={[model]}
            hiddenModels={[]}
            favoriteModels={[]}
            modelOrder={[]}
            onChange={state.updateSettings}
            onHiddenModelsChange={state.updateClientSettings}
            onFavoriteModelsChange={state.updateClientSettings}
            onModelOrderChange={state.updateClientSettings}
          />,
        ),
      );
    };
    await renderModels(codex);
    await act(async () => button("Edit custom").click());
    expect(host.textContent).toContain("Save");
    await renderModels(pi);
    expect(host.textContent).toContain("Custom");
    expect(host.textContent).not.toContain("Save");
    expect(host.textContent).not.toContain("Add custom model");
    expect(host.querySelector('button[aria-label="Edit custom"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Remove custom"]')).toBeNull();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });
});

async function renderPanel(instanceId: ProviderInstanceId, driver: ProviderDriverKind) {
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [instanceId]: {
        driver,
        enabled: true,
        config: driver === pi ? { agentDirectory: "/one" } : { homePath: "/one" },
      },
    },
  };
  await act(async () =>
    root.render(
      <EnvironmentProviderSettings
        environmentId={environmentId}
        environmentLabel="Pi environment"
        targetInstanceId={instanceId}
      />,
    ),
  );
}

describe("Pi instance removal", () => {
  it.each([piId, ProviderInstanceId.make("piAgent_work")])(
    "deletes explicit instance %s through the actual settings panel",
    async (instanceId) => {
      await renderPanel(instanceId, pi);
      expect(
        host.querySelector('button[aria-label="Reset Pi Agent provider settings to default"]'),
      ).toBeNull();
      await act(async () => button(`Delete instance ${instanceId}`).click());
      const patch = decodeSettingsPatch(state.updateSettings.mock.lastCall?.[0]);
      expect(patch.providerInstances).toEqual({});
      expect(patch.providers).toBeUndefined();
      expect(state.updateClientSettings).not.toHaveBeenCalled();
    },
  );

  it("keeps Codex's legacy default reset working", async () => {
    const instanceId = ProviderInstanceId.make("codex");
    await renderPanel(instanceId, codex);
    expect(host.querySelector('button[aria-label="Delete instance codex"]')).toBeNull();
    await act(async () => button("Reset Codex provider settings to default").click());
    const patch = decodeSettingsPatch(state.updateSettings.mock.lastCall?.[0]);
    expect(patch.providerInstances).toEqual({});
    expect(patch.providers?.codex).toEqual(DEFAULT_UNIFIED_SETTINGS.providers.codex);
    expect(state.updateClientSettings).not.toHaveBeenCalled();
  });
});
