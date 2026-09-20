import { describe, expect, it } from "vite-plus/test";

import { projectWorkCommandFailure } from "./workCommandFailure";

describe("projectWorkCommandFailure", () => {
  it("classifies only an explicit stale-revision code as safe to rebase", () => {
    expect(
      projectWorkCommandFailure({
        code: "stale-revision",
        message: "The project changed.",
        details: { currentRevision: 8, changedFields: ["tasks", "criteria"] },
      }),
    ).toMatchObject({
      staleRevision: true,
      currentRevision: 8,
      changedFields: ["tasks", "criteria"],
      message: "The project changed.",
    });
    expect(projectWorkCommandFailure(new Error("stale revision"))).toMatchObject({
      staleRevision: false,
    });
    expect(projectWorkCommandFailure({ message: "stale-revision" })).toMatchObject({
      staleRevision: false,
    });
  });

  it("keeps the raw failure and gives opaque failures an uncertainty-safe message", () => {
    const raw = { transport: "closed" };
    expect(projectWorkCommandFailure(raw)).toEqual({
      raw,
      message: "The write may not have completed. Retry the exact command or discard it.",
      staleRevision: false,
      currentRevision: null,
      changedFields: [],
    });
  });
});
