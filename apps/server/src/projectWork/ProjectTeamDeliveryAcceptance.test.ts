import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectWorkEvidenceId,
  ProjectWorkAttemptId,
  ProjectWorkTaskId,
  ProjectWorkTask,
  type ProjectTeamDeliveryAcceptanceProof,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  emptyProjectWorkReducerState,
  decideProjectWorkCommand,
  applyProjectWorkEvents,
} from "./ProjectWorkDecider.ts";
import { assertDeliveryAcceptanceCurrent } from "./ProjectTeamDeliveryAcceptanceState.ts";
import { publicationHash } from "./ProjectWorkPublicationJournal.ts";
import { decision, at, principal } from "./ProjectWorkPublication.testkit.ts";
const task = Schema.decodeUnknownSync(ProjectWorkTask)({
  taskId: "task",
  projectId: "project",
  title: "Task",
  state: "in-review",
  watchers: [],
  revision: 0,
  specRevision: 0,
  createdAt: at,
  updatedAt: at,
  attribution: { ...principal, recordedAt: at },
});
const state = () => ({
  ...emptyProjectWorkReducerState("project"),
  tasks: [task],
  foundationRecords: [decision.gate],
});
const proof: ProjectTeamDeliveryAcceptanceProof = {
  version: 1,
  environmentId: EnvironmentId.make("environment"),
  operationId: "merge",
  receiptSha256: "a".repeat(64),
  decisionSha256: publicationHash(decision),
  gateId: decision.gate.recordId,
  gateSha256: publicationHash(decision.gate),
  source: decision.source,
  sourceRef: decision.sourceRef,
  criteria: [],
  support: [],
};
it("acceptance records evidence without completing the delivered task or its parent", () => {
  const initial = {
    ...state(),
    tasks: [task, { ...task, taskId: ProjectWorkTaskId.make("parent"), title: "Parent" }],
  };
  const command: ProjectWorkCommand = {
    type: "project-work.foundation.commit",
    commandId: CommandId.make("accept"),
    projectId: task.projectId,
    expectedRevision: 0,
    records: [],
    committedAt: at,
    attribution: {
      actor: { kind: "system", id: "project-team-delivery-acceptance" },
      source: { kind: "system", id: "project-team-delivery-acceptance" },
      recordedAt: at,
    },
    transition: { kind: "delivery.accept", expectedTaskRevision: 0, proof },
  };
  const events = decideProjectWorkCommand(initial, command);
  const next = applyProjectWorkEvents(initial, events);
  assert.deepEqual(
    events.map((e) => e.type),
    ["project-work.evidence.added"],
  );
  assert.deepEqual(next.tasks, initial.tasks);
  assert.equal(next.evidence.length, 1);
});
it("the original approved gate and current criterion support hashes are required", () => {
  assert.throws(() =>
    assertDeliveryAcceptanceCurrent(
      { ...state(), foundationRecords: [{ ...decision.gate, revision: 1 }] },
      proof,
    ),
  );
  assert.throws(() =>
    assertDeliveryAcceptanceCurrent(state(), {
      ...proof,
      support: [{ evidenceId: ProjectWorkEvidenceId.make("missing"), sha256: "f".repeat(64) }],
    }),
  );
});
it("an active V2 attempt cannot be accepted as delivered", () => {
  assert.throws(() =>
    assertDeliveryAcceptanceCurrent(
      { ...state(), tasks: [{ ...task, activeAttemptId: ProjectWorkAttemptId.make("attempt") }] },
      proof,
    ),
  );
});
