import { assert, it } from "@effect/vitest";
import { ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import { mergeIssueObservation } from "./ProjectIssueIntake.ts";
import { issue, repository, projectId } from "./ProjectIssue.test-utils.ts";

const input = {
  projectId,
  recordId: "record",
  repository,
  issue,
  observedAt: "1970-01-02T00:00:00Z",
};
const captured = () => {
  const result = mergeIssueObservation(input);
  if (result.status !== "changed") throw new Error("Invalid test observation");
  return result.record;
};

it("preserves human work links and generation while merging later issue content", () => {
  const existing = {
    ...captured(),
    taskId: ProjectWorkTaskId.make("task"),
    missionId: "mission",
    generation: 7,
  };
  const merged = mergeIssueObservation({
    ...input,
    existing,
    issue: { ...issue, updatedAt: "1970-01-01T01:00:00Z", title: "Updated title" },
  });
  assert.equal(merged.status, "changed");
  if (merged.status !== "changed") return;
  assert.equal(merged.record.taskId, existing.taskId);
  assert.equal(merged.record.missionId, existing.missionId);
  assert.equal(merged.record.generation, 7);
  assert.equal(merged.record.revision, 1);
  assert.equal("approval" in merged.record, false);
});

it("deduplicates padded titles and ignores older observations without rolling back links", () => {
  const observation = { ...input, issue: { ...issue, title: "  Padded title  " } };
  const merged = mergeIssueObservation(observation);
  assert.equal(merged.status, "changed");
  if (merged.status !== "changed") return;
  assert.equal(merged.record.title, "Padded title");
  assert.deepStrictEqual(mergeIssueObservation({ ...observation, existing: merged.record }), {
    status: "unchanged",
    record: merged.record,
  });
  const existing = { ...captured(), sourceRevision: "1970-01-01T01:00:00Z" };
  assert.deepStrictEqual(mergeIssueObservation({ ...input, existing }), {
    status: "unchanged",
    record: existing,
  });
});

it("rejects conflicting source revisions, detached records and cross-project identity reuse", () => {
  const existing = captured();
  assert.deepStrictEqual(
    mergeIssueObservation({ ...input, existing, issue: { ...issue, title: "Conflicting title" } }),
    { status: "rejected", reason: "source-conflict" },
  );
  assert.deepStrictEqual(
    mergeIssueObservation({ ...input, existing: { ...existing, status: "detached" } }),
    { status: "rejected", reason: "detached" },
  );
  assert.deepStrictEqual(
    mergeIssueObservation({ ...input, existing, projectId: ProjectId.make("foreign") }),
    { status: "rejected", reason: "identity-mismatch" },
  );
  assert.deepStrictEqual(
    mergeIssueObservation({ ...input, existing, issue: { ...issue, nodeId: "foreign" } }),
    { status: "rejected", reason: "identity-mismatch" },
  );
});
