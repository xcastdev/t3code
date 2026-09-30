import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProjectIssueIdentity, ProjectIssueIntake } from "./projectIssueIntake.ts";

const decodeIdentity = Schema.decodeUnknownSync(ProjectIssueIdentity);
const decodeIssue = Schema.decodeUnknownSync(ProjectIssueIntake);
it("uses immutable node identity independently of display repository name", () => {
  const identity = decodeIdentity({
    host: "github.com",
    repositoryNodeId: "repo-node",
    issueNodeId: "issue-node",
    number: 1,
  });
  const issue = {
    kind: "issue",
    recordId: "issue",
    projectId: "project",
    revision: 0,
    generation: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "open",
    identity,
    repositoryName: "owner/old",
    title: "Reminder",
    body: "",
    sourceRevision: "1",
    observedAt: "2026-01-01T00:00:00.000Z",
  };
  expect(decodeIssue({ ...issue, repositoryName: "owner/new" }).identity).toEqual(identity);
  expect(() => decodeIssue({ ...issue, body: "x".repeat(32001) })).toThrow();
  expect(() => decodeIdentity({ ...identity, number: 0 })).toThrow();
});
