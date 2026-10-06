/* @vitest-environment happy-dom */
import { scopeProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, OrchestrationProjectShell } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  projects: [] as ReturnType<typeof scopeProject>[],
  thread: null as { environmentId: string; projectId: string; id: string } | null,
  draft: null as { environmentId: string; projectId: string } | null,
  revision: 0,
  listeners: new Set<() => void>(),
}));
function useRevision() {
  useSyncExternalStore(
    (listener) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    () => fixture.revision,
  );
}
vi.mock("../state/entities", () => ({
  useProjects: () => {
    useRevision();
    return fixture.projects;
  },
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) => {
    useRevision();
    return ref &&
      fixture.thread?.environmentId === ref.environmentId &&
      fixture.thread.id === ref.threadId
      ? fixture.thread
      : null;
  },
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (state: {
      getDraftSession: () => typeof fixture.draft;
      getDraftThread: () => typeof fixture.draft;
    }) => unknown,
  ) => {
    useRevision();
    return select({ getDraftSession: () => fixture.draft, getDraftThread: () => fixture.draft });
  },
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: (path: string) => path,
  useUiStateStore: (select: (state: { projectOrder: string[] }) => unknown) =>
    select({ projectOrder: [] }),
}));
import { useProjectWorkTarget } from "./useProjectWorkTarget";
const decodeProject = Schema.decodeUnknownSync(OrchestrationProjectShell);
function project(environment: string, id = "shared") {
  return scopeProject(
    EnvironmentId.make(environment),
    decodeProject({
      id,
      title: environment,
      workspaceRoot: `/fixture/${environment}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-05T00:00:00Z",
      updatedAt: "2026-10-05T00:00:00Z",
    }),
  );
}
function Target() {
  const target = useProjectWorkTarget();
  return <output>{target ? `${target.environmentId}/${target.projectId}` : "unavailable"}</output>;
}
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.projects = [project("first"), project("remote")];
  fixture.thread = null;
  fixture.draft = null;
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
        <Target />
        <Outlet />
      </>
    ),
  });
  const children = [
    "/portfolio",
    "/settings",
    "/work/$environmentId/$projectId",
    "/$environmentId/$threadId",
    "/draft/$draftId",
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
describe("current project Work navigation", () => {
  it("uses the exact Work URL owner instead of the first project with the same ID", async () => {
    await mount("/work/remote/shared");
    expect(host.textContent).toBe("remote/shared");
  });
  it("does not fall back when the Work URL owner is missing", async () => {
    await mount("/work/missing/shared");
    expect(host.textContent).toBe("unavailable");
  });
  it("revokes the target when the current owner is removed", async () => {
    await mount("/work/remote/shared");
    await act(async () => {
      fixture.projects = [project("first")];
      fixture.revision++;
      fixture.listeners.forEach((listener) => listener());
    });
    expect(host.textContent).toBe("unavailable");
  });
  it("uses a current thread and never borrows a thread from another environment", async () => {
    fixture.thread = { environmentId: "remote", projectId: "shared", id: "thread" };
    const router = await mount("/remote/thread");
    expect(host.textContent).toBe("remote/shared");
    await act(async () => {
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: "missing", threadId: "thread" },
      });
    });
    expect(host.textContent).toBe("unavailable");
  });
  it("uses a draft owner and disables Work if the draft disappears", async () => {
    fixture.draft = { environmentId: "remote", projectId: "shared" };
    await mount("/draft/draft");
    expect(host.textContent).toBe("remote/shared");
    await act(async () => {
      fixture.draft = null;
      fixture.revision++;
      fixture.listeners.forEach((listener) => listener());
    });
    expect(host.textContent).toBe("unavailable");
  });
  it.each(["/portfolio", "/settings"])("uses the default project on %s", async (entry) => {
    await mount(entry);
    expect(host.textContent).toBe("first/shared");
  });
});
