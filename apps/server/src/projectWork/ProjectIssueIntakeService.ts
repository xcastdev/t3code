// @effect-diagnostics-next-line nodeBuiltinImport:off -- Intake record IDs need synchronous SHA-256 from the pure planner.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  canonicalProjectWorkPayload,
  type ProjectIssueIntake,
  type ProjectTeamRecord,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import type { GitHubIssueRecord } from "@t3tools/source-control-github/server/GitHubIssueApi";
import { mergeIssueObservation } from "./ProjectIssueIntake.ts";
import { IssueBindingGatewayError, type IssueBindingState } from "./ProjectIssueRepositoryState.ts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";

export const issueIntakeHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");

/** External text becomes a proposal record; execution and approval fields come only from Work. */
export function planIssueIntake(input: {
  readonly binding: IssueBindingState;
  readonly state: ProjectWorkReducerState;
  readonly entries: ReadonlyArray<
    Pick<GitHubIssueRecord, "nodeId" | "number" | "title" | "body" | "state" | "updatedAt">
  >;
  readonly observedAt: string;
  readonly requestHash: string;
  readonly nextPage: number;
  readonly nextSince: string;
}): ProjectWorkCommand {
  const { binding, state, observedAt } = input;
  const records: Array<ProjectTeamRecord> = [];
  for (const issue of input.entries) {
    const recordId = `issue:${issueIntakeHash([binding.projectId, binding.workspaceRoot, binding.host, binding.repositoryNodeId, binding.account.accountId, issue.nodeId])}`;
    const existing = state.foundationRecords?.find(
      (record): record is ProjectIssueIntake =>
        record.kind === "issue" && record.recordId === recordId,
    );
    const merged = mergeIssueObservation({
      projectId: binding.projectId,
      recordId,
      repository: {
        host: binding.host,
        nodeId: binding.repositoryNodeId,
        nameWithOwner: binding.repositoryName,
      },
      issue: {
        nodeId: issue.nodeId,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        updatedAt: issue.updatedAt,
      },
      observedAt,
      ...(existing === undefined ? {} : { existing }),
    });
    if (merged.status === "rejected")
      throw new IssueBindingGatewayError({ reason: "invalid-input" });
    if (merged.status === "changed") records.push(merged.record);
  }
  const cursorId = `intake-cursor:${issueIntakeHash([binding.projectId, binding.workspaceRoot, binding.host, binding.repositoryNodeId, binding.account.accountId])}`;
  const oldCursor = state.foundationRecords?.find((record) => record.recordId === cursorId);
  records.push({
    kind: "intake-cursor",
    recordId: cursorId,
    projectId: binding.projectId,
    revision: oldCursor === undefined ? 0 : oldCursor.revision + 1,
    generation: oldCursor?.generation ?? 0,
    updatedAt: observedAt,
    status: "ready",
    host: binding.host,
    repositoryNodeId: binding.repositoryNodeId,
    accountId: binding.account.accountId,
    cursor: String(input.nextPage),
    overlapSince: input.nextSince,
    lastSuccessfulPageAt: observedAt,
  });
  return {
    type: "project-work.foundation.commit",
    commandId: CommandId.make(
      `issue-sync:${issueIntakeHash([binding.projectId, binding.workspaceRoot, binding.host, binding.repositoryNodeId, binding.revision, binding.syncRevision, input.requestHash])}`,
    ),
    projectId: binding.projectId,
    expectedRevision: state.revision,
    attribution: {
      actor: { kind: "system", id: "project-issue-sync" },
      source: { kind: "system", id: "github-issue-intake" },
      recordedAt: observedAt,
    },
    records,
    committedAt: observedAt,
  };
}
