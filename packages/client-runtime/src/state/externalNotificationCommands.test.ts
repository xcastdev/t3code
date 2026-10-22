import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  WS_METHODS,
  clientRpcRequiredScopes,
  EnvironmentId,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import { createExternalNotificationEnvironmentAtoms } from "./externalNotificationCommands.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const session = (scopes: AuthEnvironmentScope[]): AuthSessionState => ({
  authenticated: true,
  scopes,
  permissions: scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
});

it("requires the selected environment's current settings grant to save or test destinations", () => {
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry,
      Effect.die("Permission availability must not access the environment registry."),
    ),
  );
  const commands = createExternalNotificationEnvironmentAtoms(runtime);
  const origin = EnvironmentId.make("origin");
  const remote = EnvironmentId.make("remote");
  const registry = AtomRegistry.make();
  const unmountOrigin = registry.mount(sessions(origin));
  const unmountRemote = registry.mount(sessions(remote));
  try {
    registry.set(sessions(origin), AsyncResult.success(session([AuthSettingsWriteScope])));
    registry.set(sessions(remote), AsyncResult.success(session([AuthOrchestrationOperateScope])));
    const input = { patch: { externalNotifications: { destinations: [] } } };
    for (const command of [commands.updateSettings, commands.test]) {
      expect(registry.get(command.permissionAtom(null, input))).toBe(false);
      expect(registry.get(command.permissionAtom(origin, input))).toBe(true);
      expect(registry.get(command.permissionAtom(remote, input))).toBe(false);
    }
    registry.set(sessions(remote), AsyncResult.success(session([AuthSettingsWriteScope])));
    expect(registry.get(commands.test.permissionAtom(remote))).toBe(true);
    registry.set(sessions(remote), AsyncResult.success(session([])));
    expect(registry.get(commands.test.permissionAtom(remote))).toBe(false);
    expect(registry.get(commands.updateSettings.permissionAtom(remote, input))).toBe(false);
  } finally {
    unmountRemote();
    unmountOrigin();
    registry.dispose();
  }
});

it("preserves provider-only settings grants while requiring settings permission for destinations", () => {
  expect(
    clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, {
      patch: { externalNotifications: { destinations: [] } },
    }),
  ).toEqual([AuthSettingsWriteScope]);
  expect(
    clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, {
      patch: { providerInstances: {} },
    }),
  ).toEqual([AuthProvidersManageScope]);
  expect(
    clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, {
      patch: { providerInstances: {}, externalNotifications: { destinations: [] } },
    }),
  ).toEqual([AuthSettingsWriteScope, AuthProvidersManageScope]);
});

it("keeps atomic provider-only mutations separate from mixed settings updates", () => {
  const providerInstanceMutation = { operation: "remove", instanceId: "custom" };
  expect(
    clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, {
      patch: {},
      providerInstanceMutation,
    }),
  ).toEqual([AuthProvidersManageScope]);
  expect(
    clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, {
      patch: { externalNotifications: { destinations: [] } },
      providerInstanceMutation,
    }),
  ).toEqual([AuthSettingsWriteScope, AuthProvidersManageScope]);
});
