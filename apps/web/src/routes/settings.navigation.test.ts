/* @vitest-environment happy-dom */
import {
  createHashHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The router executes the production guards; the layout is never rendered.
vi.mock("../components/settings/SettingsPanels", () => ({}));
vi.mock("../components/settings/SettingsBreadcrumb", () => ({}));
vi.mock("../components/WorkspacePageHeader", () => ({}));
vi.mock("../components/settings/SettingsScopeContext", () => ({}));
vi.mock("../components/settings/useSettingsProjectGroups", () => ({}));
vi.mock("../state/environments", () => ({}));
vi.mock("../components/settings/SettingsScopeNotice", () => ({}));

import { Route as SettingsRoute } from "./settings";
import { Route as SettingsIndexRoute } from "./settings.index";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(
  historyKind: "memory" | "hash",
  authGateState:
    | { status: "hosted-static" }
    | { status: "authenticated" }
    | { status: "hosted-pairing" } = { status: "hosted-static" },
) {
  const calls: string[] = [];
  let heldPath: string | undefined;
  const entered = deferred();
  const release = deferred();
  const beforeRootLoad: NonNullable<typeof import("./__root").Route.options.beforeLoad> = async ({
    location,
  }) => {
    calls.push(`root:${location.pathname}`);
    if (location.pathname === heldPath) {
      heldPath = undefined;
      entered.resolve();
      await release.promise;
    }
    if (authGateState.status === "hosted-static") return { authGateState };
    if (authGateState.status === "authenticated") return { authGateState };
    return { authGateState };
  };
  const root = createRootRoute({ beforeLoad: beforeRootLoad });
  const beforeSettingsLoad: NonNullable<typeof SettingsRoute.options.beforeLoad> = (options) => {
    calls.push(`settings:${options.location.pathname}:${options.cause}`);
    return SettingsRoute.options.beforeLoad?.(options);
  };
  const settings = createRoute({
    ...SettingsRoute.options,
    getParentRoute: () => root,
    path: "/settings",
    beforeLoad: beforeSettingsLoad,
  });
  const general = createRoute({ getParentRoute: () => settings, path: "general" });
  const connections = createRoute({ getParentRoute: () => settings, path: "connections" });
  const index = createRoute({
    ...SettingsIndexRoute.options,
    getParentRoute: () => settings,
    path: "/",
  });
  const pair = createRoute({ getParentRoute: () => root, path: "pair" });
  window.history.replaceState(null, "", "/#/settings/general");
  const history =
    historyKind === "hash"
      ? createHashHistory()
      : createMemoryHistory({ initialEntries: ["/settings/general"] });
  const router = createRouter({
    routeTree: root.addChildren([settings.addChildren([index, general, connections]), pair]),
    history,
    isServer: false,
    defaultPreload: "intent",
  });
  cleanups.push(
    router.history.subscribe(({ location }) => calls.push(`history:${location.pathname}`)),
  );
  // A mounted RouterProvider installs this history listener in the client.
  cleanups.push(router.history.subscribe(() => void router.load()));
  cleanups.push(() => history.destroy());
  return {
    router,
    calls,
    entered,
    release,
    hold: (path: string) => {
      heldPath = path;
    },
  };
}

describe.each(["memory", "hash"] as const)("settings navigation with %s history", (historyKind) => {
  it.each(["authenticated", "hosted-static"] as const)(
    "redirects bare settings to General for %s without losing scope",
    async (status) => {
      const { router } = fixture(historyKind, { status });
      await router.load();
      const length = router.history.length;
      await router.navigate({ to: "/settings", search: { machine: "remote" } });
      expect(router.state.location.pathname).toBe("/settings/general");
      expect(router.state.location.search).toEqual({ machine: "remote" });
      expect(router.history.length).toBe(length + 1);
      expect(router.state.matches.at(-1)?.routeId).toBe("/settings/general");
    },
  );

  it.each(["/settings", "/settings/connections"] as const)(
    "retains the parent authentication gate for %s",
    async (to) => {
      const { router } = fixture(historyKind, { status: "hosted-pairing" });
      await router.navigate({ to });
      expect(router.state.location.pathname).toBe("/pair");
      expect(router.state.matches.at(-1)?.routeId).toBe("/pair");
    },
  );

  it("keeps a direct Connections navigation after General has loaded", async () => {
    const { router, calls } = fixture(historyKind);
    await router.load();
    await router.navigate({ to: "/settings/connections" });
    expect(router.state.location.pathname, calls.join("\n")).toBe("/settings/connections");
    expect(router.state.matches.at(-1)?.routeId).toBe("/settings/connections");
  });

  it("keeps Connections when a bare-settings preload is pending", async () => {
    const { router, calls, hold, entered, release } = fixture(historyKind);
    await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe("/settings/general");
    hold("/settings");
    const preload = router.preloadRoute({ to: "/settings" });
    await entered.promise;
    const navigation = router.navigate({ to: "/settings/connections" });
    release.resolve();
    await Promise.all([preload, navigation]);
    expect(router.state.location.pathname, calls.join("\n")).toBe("/settings/connections");
  });

  it("keeps Connections when a superseded bare-settings load finishes", async () => {
    const { router, calls, hold, entered, release } = fixture(historyKind);
    await router.load();
    hold("/settings");
    const stale = router.navigate({ to: "/settings" });
    await entered.promise;
    const navigation = router.navigate({ to: "/settings/connections" });
    release.resolve();
    await Promise.all([stale, navigation]);
    expect(router.state.location.pathname, calls.join("\n")).toBe("/settings/connections");
    expect(router.state.matches.at(-1)?.routeId).toBe("/settings/connections");
  });

  it("keeps Connections when it supersedes bare settings in the same turn", async () => {
    const { router, calls } = fixture(historyKind);
    await router.load();
    const stale = router.navigate({ to: "/settings" });
    const navigation = router.navigate({ to: "/settings/connections" });
    await Promise.all([stale, navigation]);
    expect(router.state.location.pathname, calls.join("\n")).toBe("/settings/connections");
    expect(router.state.matches.at(-1)?.routeId).toBe("/settings/connections");
  });
});
