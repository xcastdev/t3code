/* @vitest-environment happy-dom */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  target: null as ReturnType<typeof scopeProjectRef> | null,
  paletteOpen: false,
  terminalFocus: false,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => DEFAULT_RESOLVED_KEYBINDINGS }));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: null }));
vi.mock("../hooks/useProjectWorkTarget", () => ({ useProjectWorkTarget: () => fixture.target }));
vi.mock("../lib/terminalFocus", () => ({ isTerminalFocused: () => fixture.terminalFocus }));
vi.mock("../lib/previewFocus", () => ({ isPreviewFocused: () => false }));
import { ProjectWorkShortcut } from "./ProjectWorkShortcut";
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.target = scopeProjectRef(EnvironmentId.make("remote"), ProjectId.make("shared"));
  fixture.paletteOpen = false;
  fixture.terminalFocus = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function mount(entry: string) {
  const route = createRootRoute({
    component: () => (
      <>
        <ProjectWorkShortcut
          paletteOpen={fixture.paletteOpen}
          terminalOpen={false}
          previewOpen={false}
        />
        <Outlet />
      </>
    ),
  });
  const children = [
    "/portfolio",
    "/settings",
    "/work/$environmentId/$projectId",
    "/$environmentId/$threadId",
  ].map((path) => createRoute({ getParentRoute: () => route, path }));
  const router = createRouter({
    isServer: false,
    routeTree: route.addChildren(children),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  return router;
}
async function shortcut(prevented = false) {
  const event = new KeyboardEvent("keydown", {
    key: "W",
    code: "KeyW",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  if (prevented) event.preventDefault();
  await act(async () => {
    window.dispatchEvent(event);
  });
  return event;
}
describe("global Work shortcut", () => {
  it.each(["/portfolio", "/settings", "/remote/thread"])("opens Work from %s", async (entry) => {
    const router = await mount(entry);
    const event = await shortcut();
    expect(router.state.location.pathname).toBe("/work/remote/shared");
    expect(event.defaultPrevented).toBe(true);
  });
  it("does not navigate when there is no current project", async () => {
    fixture.target = null;
    const router = await mount("/portfolio");
    await shortcut();
    expect(router.state.location.pathname).toBe("/portfolio");
  });
  it("leaves an open palette in control", async () => {
    fixture.paletteOpen = true;
    const router = await mount("/settings");
    await shortcut();
    expect(router.state.location.pathname).toBe("/settings");
  });
  it("honors the terminal-focus binding condition", async () => {
    fixture.terminalFocus = true;
    const router = await mount("/settings");
    await shortcut();
    expect(router.state.location.pathname).toBe("/settings");
  });
  it("does not act on an already consumed keyboard event", async () => {
    const router = await mount("/settings");
    await shortcut(true);
    expect(router.state.location.pathname).toBe("/settings");
  });
});
