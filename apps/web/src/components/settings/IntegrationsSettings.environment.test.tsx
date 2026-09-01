import type { ReactElement } from "react";
import { isValidElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  type ExternalNotificationDestination,
  type ServerConfig,
  type UnifiedSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PrimaryConnectionTarget, RelayConnectionTarget } from "@t3tools/client-runtime/connection";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import type { EnvironmentPresentation } from "~/state/environments";

const atoms = vi.hoisted(() => ({
  updateSettings: Symbol("updateSettings"),
  testExternalNotification: Symbol("testExternalNotification"),
}));

const commands = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  testExternalNotification: vi.fn(),
  updatePrimarySettings: vi.fn(),
}));

const state = vi.hoisted(() => ({
  session: {
    data: {
      authenticated: true,
      scopes: ["orchestration:operate"],
    },
    error: null,
    isPending: false,
  },
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

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({
    select,
  }: {
    readonly select: (location: { readonly hash: string }) => unknown;
  }) => select({ hash: "" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../../env", () => ({ isElectron: false }));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => state.session,
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => state.session,
}));

vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (settings: UnifiedSettings) => T) =>
    selector(DEFAULT_UNIFIED_SETTINGS),
  useEnvironmentSettings: () => settingsValue,
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdatePrimarySettings: () => commands.updatePrimarySettings,
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments,
    isReady: true,
  }),
  usePrimaryEnvironmentId: () => primaryEnvironmentId,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    testExternalNotification: atoms.testExternalNotification,
    updateSettings: atoms.updateSettings,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.testExternalNotification
      ? commands.testExternalNotification
      : commands.updateSettings,
}));

import {
  AccessGatedExternalNotificationsSettings,
  ExternalNotificationDestinationCard,
  EnvironmentExternalNotificationsSettings,
  ExternalNotificationsSettings,
} from "./IntegrationsSettings";

const primaryEnvironmentId = EnvironmentId.make("primary");
const remoteEnvironmentId = EnvironmentId.make("remote");
const savedWebhookUrl = "https://hooks.example.test/secret-token";
const destination = {
  _tag: "home-assistant-webhook",
  id: "home-assistant-primary",
  label: "Home Assistant",
  enabled: true,
  configured: true,
} satisfies ExternalNotificationDestination;
const settingsValue: UnifiedSettings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  externalNotifications: {
    appScheme: "t3code-preview",
    destinations: [destination],
  },
};

const primaryTarget = new PrimaryConnectionTarget({
  environmentId: primaryEnvironmentId,
  label: "This device",
  httpBaseUrl: "http://127.0.0.1:4780",
  wsBaseUrl: "ws://127.0.0.1:4780",
});
const remoteTarget = new RelayConnectionTarget({
  environmentId: remoteEnvironmentId,
  label: "Remote device",
});

const makeEnvironment = (
  target: typeof primaryTarget | typeof remoteTarget,
): EnvironmentPresentation => ({
  environmentId: target.environmentId,
  label: target.label,
  displayUrl: target._tag === "PrimaryConnectionTarget" ? target.httpBaseUrl : null,
  relayManaged: target._tag === "RelayConnectionTarget",
  entry: { target, profile: Option.none() },
  connection: { phase: "connected", error: null, traceId: null },
  serverConfig: { settings: settingsValue } as unknown as ServerConfig,
});

const environments = [makeEnvironment(remoteTarget), makeEnvironment(primaryTarget)];

function isEnvironmentWithId(
  value: unknown,
): value is Pick<EnvironmentPresentation, "environmentId"> {
  return typeof value === "object" && value !== null && "environmentId" in value;
}

function renderSelectedSettings(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ExternalNotificationsSettings() as ReactElement<Record<string, unknown>>;
}

function renderDestinationCard(readOnly: boolean): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ExternalNotificationDestinationCard({
    destination,
    readOnly,
    onChange: () => undefined,
    onChangeType: () => undefined,
    onRemove: () => undefined,
    onTest: async () => undefined,
  }) as ReactElement<Record<string, unknown>>;
}

function renderEnvironmentSettings(readOnly: boolean): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentExternalNotificationsSettings({
    environmentId: primaryEnvironmentId,
    environmentLabel: "This device",
    readOnly,
    deviceTabs: null,
  }) as ReactElement<Record<string, unknown>>;
}

function elementText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(elementText).join("");
  if (isValidElement<Record<string, unknown>>(node)) return elementText(node.props.children);
  return "";
}

function invokeHandler(handler: unknown, ...args: ReadonlyArray<unknown>): unknown {
  if (typeof handler !== "function") throw new Error("expected an event handler");
  return Reflect.apply(handler, undefined, args);
}

describe("external notification settings boundary", () => {
  beforeEach(() => {
    hooks.reset();
    state.session = {
      data: {
        authenticated: true,
        scopes: ["orchestration:operate"],
      },
      error: null,
      isPending: false,
    };
    commands.updateSettings.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.testExternalNotification.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updatePrimarySettings.mockReset();
  });

  it("renders device tabs and keeps the saved webhook secret out of client elements", () => {
    const selectedSettings = renderSelectedSettings();
    const remoteTab = visitElements(
      selectedSettings,
      (element) => element.props.role === "tab" && element.props["aria-selected"] === false,
    );
    const onRemoteTabClick = remoteTab?.props.onClick;
    if (typeof onRemoteTabClick === "function") onRemoteTabClick();
    const selectedRemoteSettings = renderSelectedSettings();
    expect(
      visitElements(
        selectedRemoteSettings,
        (element) =>
          isEnvironmentWithId(element.props.environment) &&
          element.props.environment.environmentId === remoteEnvironmentId,
      ),
    ).not.toBeNull();

    hooks.reset();
    const panel = renderDestinationCard(false);
    const tablist = visitElements(selectedSettings, (element) => element.props.role === "tablist");
    const webhookInput = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Replace Home Assistant webhook URL",
    );

    expect(tablist).not.toBeNull();
    expect(tablist?.props.children).toHaveLength(2);
    expect(webhookInput?.props.value).toBe("");
    expect(elementText(panel)).toContain("Webhook URL saved securely.");
    expect(elementText(panel)).not.toContain(savedWebhookUrl);
    expect(elementText(panel)).toContain("Integration");
    expect(elementText(panel)).toContain("Name");
    expect(elementText(panel)).toContain("Actions");
    expect(commands.testExternalNotification).not.toHaveBeenCalled();
  });

  it("disables notification writes and tests when the selected environment is read only", () => {
    state.session = {
      data: {
        authenticated: true,
        scopes: ["orchestration:read"],
      },
      error: null,
      isPending: false,
    };
    hooks.reset();
    const gatedSettings = AccessGatedExternalNotificationsSettings({
      environment: environments[1]!,
      operateAccess: "denied",
      deviceTabs: null,
    });
    expect(
      visitElements(
        gatedSettings,
        (element) =>
          element.props.environmentId === primaryEnvironmentId && element.props.readOnly === true,
      ),
    ).not.toBeNull();

    hooks.reset();
    const panel = renderDestinationCard(true);
    hooks.reset();
    const environmentPanel = renderEnvironmentSettings(true);

    const webhookInput = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Replace Home Assistant webhook URL",
    );
    const sendTestButton = visitElements(
      panel,
      (element) =>
        typeof element.props.onClick === "function" &&
        element.props.disabled === true &&
        elementText(element.props.children).includes("Test"),
    );
    const addButton = visitElements(
      environmentPanel,
      (element) =>
        element.props.disabled === true &&
        elementText(element.props.children).includes("Add external notification"),
    );

    expect(webhookInput?.props.disabled).toBe(true);
    expect(sendTestButton).not.toBeNull();
    expect(addButton).not.toBeNull();
    expect(commands.updateSettings).not.toHaveBeenCalled();
    expect(commands.testExternalNotification).not.toHaveBeenCalled();
  });

  it("supports destination replacement, scheme changes, tests, removal, and addition", () => {
    const panel = renderDestinationCard(false);
    const webhookInput = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Replace Home Assistant webhook URL",
    );
    invokeHandler(webhookInput?.props.onChange, {
      target: { value: "https://hooks.example.test/replacement" },
    });
    hooks.beginRender();
    const updatedPanel = ExternalNotificationDestinationCard({
      destination,
      readOnly: false,
      onChange: commands.updateSettings,
      onChangeType: () => undefined,
      onRemove: commands.updateSettings,
      onTest: async () => {
        commands.testExternalNotification();
      },
    }) as ReactElement<Record<string, unknown>>;
    const updatedReplaceButton = visitElements(
      updatedPanel,
      (element) =>
        typeof element.props.onClick === "function" &&
        elementText(element.props.children) === "Save",
    );
    const updatedSendTestButton = visitElements(
      updatedPanel,
      (element) =>
        typeof element.props.onClick === "function" &&
        elementText(element.props.children).includes("Test"),
    );
    const updatedRemoveButton = visitElements(
      updatedPanel,
      (element) => element.props["aria-label"] === "Remove Home Assistant",
    );

    invokeHandler(updatedReplaceButton?.props.onClick);
    invokeHandler(updatedSendTestButton?.props.onClick);
    invokeHandler(updatedRemoveButton?.props.onClick);
    hooks.beginRender();
    const confirmationPanel = ExternalNotificationDestinationCard({
      destination,
      readOnly: false,
      onChange: commands.updateSettings,
      onChangeType: () => undefined,
      onRemove: commands.updateSettings,
      onTest: async () => undefined,
    }) as ReactElement<Record<string, unknown>>;
    const confirmDeleteButton = visitElements(
      confirmationPanel,
      (element) =>
        typeof element.props.onClick === "function" &&
        elementText(element.props.children).includes("Delete destination"),
    );
    invokeHandler(confirmDeleteButton?.props.onClick);

    hooks.reset();
    const environmentPanel = renderEnvironmentSettings(false);
    const schemeSelect = visitElements(
      environmentPanel,
      (element) =>
        element.props.value === "t3code-preview" &&
        typeof element.props.onValueChange === "function",
    );
    const addButton = visitElements(
      environmentPanel,
      (element) =>
        typeof element.props.onClick === "function" &&
        elementText(element.props.children).includes("Add external notification"),
    );

    invokeHandler(schemeSelect?.props.onValueChange, "t3code");
    invokeHandler(addButton?.props.onClick);

    expect(commands.updateSettings).toHaveBeenCalled();
    expect(commands.testExternalNotification).toHaveBeenCalled();
  });
});
