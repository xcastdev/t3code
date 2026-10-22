import { EnvironmentId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { backWorkLocation, openWorkTask, type WorkLocation } from "./workNavigation";

const env = EnvironmentId.make("env");
const other = EnvironmentId.make("other");
const projectId = ProjectId.make("project");
const task = (id: string) => ProjectWorkTaskId.make(id);

it("stacks tasks within one checkout and starts fresh in another environment", () => {
  let location: WorkLocation | null = null;
  location = openWorkTask(location, { environmentId: env, projectId, taskId: task("a") });
  location = openWorkTask(location, { environmentId: env, projectId, taskId: task("b") });
  expect(location.tasks).toEqual(["a", "b"]);
  expect(openWorkTask(location, { environmentId: env, projectId, taskId: task("b") })).toBe(
    location,
  );
  // Same project ID on another environment is a different checkout.
  const moved = openWorkTask(location, { environmentId: other, projectId, taskId: task("c") });
  expect(moved).toEqual({ environmentId: other, projectId, section: "tasks", tasks: ["c"] });
});

it("steps back through tasks, then the project, and only leaves to the list in a single pane", () => {
  const location: WorkLocation = {
    environmentId: env,
    projectId,
    section: "tasks",
    tasks: [task("a")],
  };
  expect(backWorkLocation(location, "full")).toEqual({ ...location, tasks: [] });
  expect(backWorkLocation({ ...location, tasks: [] }, "full")).toBeNull();
  expect(backWorkLocation({ ...location, tasks: [] }, "detail")).toBeUndefined();
  expect(backWorkLocation(location, "list")).toBeUndefined();
  expect(backWorkLocation(null, "full")).toBeUndefined();
});
