import type { ReactElement } from "react";
import {
  AuthAccessReadScope,
  AuthAdministrativeScopes,
  EnvironmentId,
  type DesktopPrimaryBackendState,
} from "@t3tools/contracts";
import { PrimaryConnectionTarget, RelayConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const mocks = vi.hoisted(() => {
  const atoms = {
    authAccessChanges: Symbol("auth-access-changes"),
    desktopNetworkAccess: Symbol("desktop-network-access"),
    desktopPrimaryBackend: Symbol("desktop-primary-backend"),
    desktopSshHosts: Symbol("desktop-ssh-hosts"),
    desktopWsl: Symbol("desktop-wsl"),
    serverUpdate: Symbol("server-update"),
  };
  return {
    atoms,
    backendState: { mode: "attached" } as DesktopPrimaryBackendState,
    environments: [] as ReadonlyArray<unknown>,
    primaryEnvironment: null as unknown,
    session: {
      data: {
        authenticated: true,
        scopes: ["access:read"] as ReadonlyArray<string>,
        auth: { policy: "remote-reachable" },
      },
      error: null,
      isPending: false,
    },
    queryCalls: [] as Array<unknown>,
    serverUpdateState: { status: "idle" as const },
    defaultQuery: {
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    },
    backendQuery: {
      data: { mode: "attached" } as DesktopPrimaryBackendState,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    },
    networkQuery: {
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    },
    wslQuery: {
      data: {
        available: true,
        distro: null,
        distros: [],
        enabled: false,
        preflightError: null,
        wslOnly: false,
      },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    },
    accessChanges: vi.fn(() => atoms.authAccessChanges),
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.serverUpdateState,
}));

vi.mock("~/state/desktopPrimaryBackendState", () => ({
  desktopPrimaryBackendStateAtom: mocks.atoms.desktopPrimaryBackend,
}));

vi.mock("~/state/desktopNetworkAccess", () => ({
  desktopNetworkAccessStateAtom: mocks.atoms.desktopNetworkAccess,
  refreshDesktopNetworkAccessState: vi.fn(),
}));

vi.mock("~/state/desktopSshHosts", () => ({
  desktopSshHostsStateAtom: mocks.atoms.desktopSshHosts,
}));

vi.mock("~/state/desktopWslState", () => ({
  desktopWslStateAtom: mocks.atoms.desktopWsl,
  refreshDesktopWslState: vi.fn(),
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    mocks.queryCalls.push(atom);
    if (atom === mocks.atoms.desktopPrimaryBackend) return mocks.backendQuery;
    if (atom === mocks.atoms.desktopWsl) return mocks.wslQuery;
    if (atom === mocks.atoms.desktopNetworkAccess) return mocks.networkQuery;
    return mocks.defaultQuery;
  },
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments, isReady: true }),
  usePrimaryEnvironment: () => mocks.primaryEnvironment,
}));

vi.mock("~/environments/primary", () => ({
  usePrimarySessionState: () => mocks.session,
  createServerPairingCredential: vi.fn(),
  revokeOtherServerClientSessions: vi.fn(),
  revokeServerClientSession: vi.fn(),
  revokeServerPairingLink: vi.fn(),
  isLoopbackHostname: () => false,
}));

vi.mock("~/connection/catalog", () => ({
  environmentCatalog: {
    remove: Symbol("remove-environment"),
    retryNow: Symbol("retry-environment"),
  },
}));

vi.mock("~/connection/onboarding", () => ({
  connectPairing: Symbol("connect-pairing"),
  connectSshEnvironment: Symbol("connect-ssh-environment"),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: "Success" })),
}));

vi.mock("~/state/auth", () => ({
  authEnvironment: { accessChanges: mocks.accessChanges },
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { updateStateAtom: () => mocks.atoms.serverUpdate },
}));

vi.mock("~/uiStateStore", () => ({
  useUiStateStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ defaultAdvertisedEndpointKey: null, setDefaultAdvertisedEndpointKey: vi.fn() }),
}));

vi.mock("~/cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/cloud/publicConfig")>()),
  hasCloudPublicConfig: () => false,
}));
vi.mock("~/cloud/useCloudLinkController", () => ({ useCloudLinkController: vi.fn() }));

vi.mock("~/connection/desktopLocal", () => ({
  isDesktopLocalConnectionTarget: (target: { readonly _tag: string }) =>
    target._tag === "BearerConnectionTarget",
}));

vi.mock("~/versionSkew", () => ({
  resolveServerConfigVersionMismatch: () => null,
  resolveServerSelfUpdateCapability: () => null,
}));

import { ConnectionsSettings } from "./ConnectionsSettings";

const primaryEnvironmentId = EnvironmentId.make("primary-environment");
const remoteEnvironmentId = EnvironmentId.make("saved-remote-environment");

const primaryTarget = new PrimaryConnectionTarget({
  environmentId: primaryEnvironmentId,
  label: "This device",
  httpBaseUrl: "http://127.0.0.1:4773/",
  wsBaseUrl: "ws://127.0.0.1:4773/",
});
const remoteTarget = new RelayConnectionTarget({
  environmentId: remoteEnvironmentId,
  label: "Saved remote",
});

function environment(target: typeof primaryTarget | typeof remoteTarget) {
  return {
    environmentId: target.environmentId,
    label: target.label,
    displayUrl: target._tag === "PrimaryConnectionTarget" ? target.httpBaseUrl : null,
    relayManaged: target._tag === "RelayConnectionTarget",
    entry: { target, profile: Option.none() },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: null,
  };
}

function renderSettings(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ConnectionsSettings() as ReactElement<Record<string, unknown>>;
}

function settingsRows(panel: unknown): Array<ReactElement<Record<string, unknown>>> {
  const rows: Array<ReactElement<Record<string, unknown>>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object" || !("props" in node)) return;
    const element = node as ReactElement<Record<string, unknown>>;
    if (typeof element.props.title === "string") rows.push(element);
    for (const value of Object.values(element.props)) visit(value);
  };
  visit(panel);
  return rows;
}

describe("ConnectionsSettings attached primary", () => {
  beforeEach(() => {
    hooks.reset();
    mocks.backendState = {
      mode: "attached",
      httpBaseUrl: "http://127.0.0.1:4773/",
      environmentId: primaryEnvironmentId,
      label: "Workstation",
      bearerExpiresAt: "2099-09-08T18:00:00.000Z",
    };
    mocks.backendQuery.data = mocks.backendState;
    mocks.environments = [environment(remoteTarget), environment(primaryTarget)];
    mocks.primaryEnvironment = environment(primaryTarget);
    mocks.session = {
      data: {
        authenticated: true,
        scopes: [AuthAccessReadScope],
        auth: { policy: "remote-reachable" },
      },
      error: null,
      isPending: false,
    };
    mocks.queryCalls = [];
    mocks.wslQuery.data = {
      available: true,
      distro: null,
      distros: [],
      enabled: false,
      preflightError: null,
      wslOnly: false,
    };
    vi.stubGlobal("window", { desktopBridge: {} });
  });

  it("uses remote session scopes and hides desktop-local ownership controls when attached", () => {
    const panel = renderSettings();
    const rows = settingsRows(panel);
    expect(rows.some((row) => row.props.title === "WSL backend")).toBe(false);
    expect(rows.some((row) => row.props.title === "Tailscale HTTPS")).toBe(false);
    expect(mocks.queryCalls).not.toContain(mocks.atoms.desktopNetworkAccess);
    expect(mocks.queryCalls).not.toContain(mocks.atoms.desktopWsl);
    expect(mocks.accessChanges).not.toHaveBeenCalled();
  });

  it("does not duplicate the primary connection among saved environments", () => {
    const panel = renderSettings();
    const primarySavedRow = visitElements(panel, (element) => {
      const candidate = element.props.environment as
        | { readonly environmentId?: EnvironmentId }
        | undefined;
      return candidate?.environmentId === primaryEnvironmentId;
    });
    const remoteSavedRow = visitElements(panel, (element) => {
      const candidate = element.props.environment as
        | { readonly environmentId?: EnvironmentId }
        | undefined;
      return candidate?.environmentId === remoteEnvironmentId;
    });

    expect(primarySavedRow).toBeNull();
    expect(remoteSavedRow).not.toBeNull();
  });

  it("keeps the desktop-local ownership path in managed mode", () => {
    mocks.backendState = { mode: "managed" };
    mocks.backendQuery.data = mocks.backendState;
    mocks.session = {
      data: {
        authenticated: true,
        scopes: AuthAdministrativeScopes,
        auth: { policy: "desktop-managed-local" },
      },
      error: null,
      isPending: false,
    };
    const panel = renderSettings();
    const rows = settingsRows(panel);
    expect(rows.some((row) => row.props.title === "WSL backend")).toBe(true);
    expect(mocks.queryCalls).toContain(mocks.atoms.desktopWsl);
  });

  it("keeps invalid attachment in the recovery ownership branch", () => {
    mocks.backendState = {
      mode: "invalid-attached",
      reason: "The saved attachment could not be reached.",
    };
    mocks.backendQuery.data = mocks.backendState;
    const panel = renderSettings();
    const rows = settingsRows(panel);
    expect(rows.some((row) => row.props.title === "WSL backend")).toBe(false);
    expect(rows.some((row) => row.props.title === "Tailscale HTTPS")).toBe(false);
    expect(mocks.queryCalls).not.toContain(mocks.atoms.desktopWsl);
  });
});
