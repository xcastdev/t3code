import { CommandId, EnvironmentId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { prepareProjectWorkHumanMutation } from "./workActions";
import {
  buildTeamConfigurationIntent,
  combineWorkPages,
  emptyTeamConfiguration,
  existingTaskRefineChanged,
  existingTaskRefineFields,
  existingTaskRefineSnapshot,
  retainCompleteWorkSet,
  syncModelPolicies,
} from "./workLogic";

const page = (revision: number, count: number, hasMore: boolean) => ({
  status: "ready" as const,
  failed: false,
  page: {
    revision,
    hasMore,
    nextOffset: null,
    items: Array.from({ length: count }, (_, index) => ({ value: `r${index}` })),
  },
});

describe("retainCompleteWorkSet", () => {
  it("keeps the last complete set but reports a newly needed page that failed, until Retry succeeds", () => {
    const previous = combineWorkPages([page(4, 128, false)], 16);
    const failed = retainCompleteWorkSet(
      previous,
      combineWorkPages([page(5, 128, true), { status: "ready", failed: true, page: null }], 16),
    );
    expect(failed).toMatchObject({ complete: true, revision: 4, status: "stale", failed: true });
    expect(failed.records).toHaveLength(128);

    const retried = retainCompleteWorkSet(
      failed,
      combineWorkPages([page(5, 128, true), page(5, 1, false)], 16),
    );
    expect(retried).toMatchObject({ complete: true, revision: 5, status: "ready", failed: false });
    expect(retried.records).toHaveLength(129);
  });
});

describe("disabling a team whose provider or model disappeared", () => {
  const recorded = syncModelPolicies({
    ...emptyTeamConfiguration(),
    enabled: true,
    providerInstanceId: "codex" as never,
    profiles: emptyTeamConfiguration().profiles.map((profile) => ({ ...profile, model: "m1" })),
  });
  const base = {
    commandId: CommandId.make("command-1"),
    projectId: ProjectId.make("project-1"),
    expectedRevision: 7,
    expectedConfigurationGeneration: 3,
    recorded,
  };

  it("sends the recorded configuration unchanged when disabling", () => {
    for (const availableModels of [null, new Set(["m2"])]) {
      const built = buildTeamConfigurationIntent({
        ...base,
        values: { ...recorded, enabled: false },
        availableModels,
      });
      expect("intent" in built && built.intent).toMatchObject({
        ...recorded,
        enabled: false,
        expectedRevision: 7,
        expectedConfigurationGeneration: 3,
      });
    }
  });

  it("still checks the live catalog for edits and enabling", () => {
    const edited = { ...recorded, enabled: false, projectPriority: 1 };
    for (const values of [edited, recorded])
      for (const availableModels of [null, new Set(["m2"])])
        expect(buildTeamConfigurationIntent({ ...base, values, availableModels })).toHaveProperty(
          "reason",
        );
  });
});

describe("existing-task refinement review", () => {
  const task = (revision: number, taskRevision: number) => ({
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("project-1"),
    checkoutPath: "/checkout",
    taskId: ProjectWorkTaskId.make("task-1"),
    revision,
    taskRevision,
  });
  const send = (
    reviewed: NonNullable<ReturnType<typeof existingTaskRefineSnapshot>>,
    current = reviewed.selected,
  ) =>
    prepareProjectWorkHumanMutation({
      selected: reviewed.selected,
      current,
      intent: {
        type: "project-work.issue.refine",
        commandId: CommandId.make("command-1"),
        projectId: ProjectId.make("project-1"),
        issueRecordId: "issue-1",
        refinedAt: "2026-10-01T00:00:00.000Z",
        ...existingTaskRefineFields(reviewed),
      },
    });

  it("attaches after re-reviewing a drifted project with one consistent revision", () => {
    const opened = existingTaskRefineSnapshot(task(4, 2), { revision: 3, projectRevision: 4 })!;
    const now = existingTaskRefineSnapshot(task(5, 2), { revision: 3, projectRevision: 5 })!;
    expect(existingTaskRefineChanged(opened, now)).toBe(true);
    expect(send(now)).toMatchObject({ expectedRevision: 5, expectedIssueRevision: 3 });
  });

  it("asks for review again and refuses the stale snapshot after an issue or task edit", () => {
    const reviewed = existingTaskRefineSnapshot(task(5, 2), { revision: 3, projectRevision: 5 })!;
    const editedTask = existingTaskRefineSnapshot(task(6, 3), { revision: 3, projectRevision: 6 })!;
    const editedIssue = existingTaskRefineSnapshot(task(6, 2), {
      revision: 4,
      projectRevision: 6,
    })!;
    expect(existingTaskRefineChanged(reviewed, editedTask)).toBe(true);
    expect(existingTaskRefineChanged(reviewed, editedIssue)).toBe(true);
    expect(send(reviewed, editedTask.selected)).toBeNull();
    expect(send(reviewed, editedIssue.selected)).toBeNull();
  });
});
