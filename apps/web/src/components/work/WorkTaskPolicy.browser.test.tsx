import {
  EnvironmentId,
  ProjectId,
  ProjectWorkAction,
  ProjectWorkTaskContext,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { render } from "../../../test/render";
import { WorkTaskRelationships } from "./WorkTaskRelationships";
import { WorkApprovalRow } from "./WorkApprovalRow";
import { deriveWorkTask } from "./workModel";
import type { WorkWriter } from "./useWorkWriter";

const decodeContext = Schema.decodeUnknownSync(ProjectWorkTaskContext);

function setup(state: "draft" | "canceled" = "draft") {
  document.documentElement.classList.add("dark");
  const context = decodeContext({
    projectId: "approval-project",
    revision: 1,
    task: {
      taskId: "approval-task",
      projectId: "approval-project",
      title: "Draft task",
      state,
      watchers: [],
      revision: 0,
      specRevision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    criteria: [],
    evidence: [],
    relationships: [],
    blockers: [],
    comments: [],
    children: { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] },
    policy: {
      taskId: "approval-task",
      readiness: { ready: false, reasons: [] },
      claimability: { claimable: false },
      actions: Object.fromEntries(
        ProjectWorkAction.literals.map((action) => [
          action,
          {
            available: false,
            reason: state === "canceled" ? "canceled-task" : "no-pending-approval",
          },
        ]),
      ),
      attention: [],
    },
  });
  const writer: WorkWriter = {
    canWrite: true,
    canIssue: false,
    canDeliver: false,
    pendingKey: null,
    failure: null,
    submit: vi.fn(async () => false),
    runIssue: vi.fn(async () => null),
    runDelivery: vi.fn(async () => null),
    failureFor: () => null,
    dismiss: () => {},
  };
  const scope = {
    environmentId: EnvironmentId.make("approval-env"),
    projectId: ProjectId.make("approval-project"),
    checkoutPath: "/demo",
  };
  return {
    scope,
    current: { ...scope, revision: 1, taskRevision: 0 },
    context,
    model: deriveWorkTask({ context, records: [], recordsRevision: 1 }),
    records: [],
    writer,
    blocked: null,
  };
}

it("explains a missing scope without displaying the approval policy code", async () => {
  const surface = setup();
  await using screen = await render(<WorkApprovalRow surface={surface} />);
  await expect.element(screen.getByText("Write a specification.", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Approve", exact: true }))
    .not.toBeInTheDocument();
});

it("explains why canceled-task links cannot change without exposing the policy code", async () => {
  const surface = setup("canceled");
  await using screen = await render(
    <WorkTaskRelationships surface={surface} onOpenTask={() => {}} />,
  );
  await expect
    .element(screen.getByText("Links can't change in this state.", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Link task" })).toBeDisabled();
});
