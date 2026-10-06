/* @vitest-environment happy-dom */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { validateWorkRouteSearch } from "./-workSearch";

function workRouter(entry: string) {
  const root = createRootRoute();
  const work = createRoute({
    getParentRoute: () => root,
    path: "/work/$environmentId/$projectId",
    validateSearch: validateWorkRouteSearch,
  });
  return createRouter({
    isServer: false,
    routeTree: root.addChildren([work]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
}

describe("project Work URLs", () => {
  it("opens a task without losing escaped environment/project identity on reload", async () => {
    const entry = "/work/remote%20server/shared%20project?taskId=task%2F42";
    for (const router of [workRouter(entry), workRouter(entry)]) {
      await router.load();
      const match = router.state.matches.at(-1);
      expect(match?.params).toMatchObject({
        environmentId: "remote server",
        projectId: "shared project",
      });
      expect(match?.search).toEqual({ tab: "tasks", taskId: "task/42" });
    }
  });

  it("restores the selected task when navigating Back", async () => {
    const router = workRouter("/work/remote/shared?taskId=first");
    await router.load();
    await router.navigate({
      to: "/work/$environmentId/$projectId",
      params: { environmentId: "other", projectId: "shared" },
      search: { tab: "tasks", taskId: "second" },
    });
    expect(router.state.matches.at(-1)?.params).toMatchObject({ environmentId: "other" });
    expect(router.state.matches.at(-1)?.search).toEqual({ tab: "tasks", taskId: "second" });
    router.history.back();
    await router.load();
    expect(router.state.matches.at(-1)?.params).toMatchObject({ environmentId: "remote" });
    expect(router.state.matches.at(-1)?.search).toEqual({ tab: "tasks", taskId: "first" });
  });

  it("retains a known section and rejects malformed task targets", () => {
    for (const taskId of ["", " ", " task ", 42, ["task"], { id: "task" }]) {
      expect(validateWorkRouteSearch({ tab: "supervision", taskId })).toEqual({
        tab: "supervision",
      });
    }
    expect(validateWorkRouteSearch({ tab: "unrecognized" })).toEqual({ tab: "overview" });
    expect(validateWorkRouteSearch({ tab: ["inbox"] })).toEqual({ tab: "overview" });
    expect(validateWorkRouteSearch({ tab: "overview", taskId: "task-1" })).toEqual({
      tab: "tasks",
      taskId: "task-1",
    });
  });
});
