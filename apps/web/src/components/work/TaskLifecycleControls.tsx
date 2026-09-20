import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  ProjectWorkAttemptId,
  ProjectWorkBlockerId,
  ProjectWorkEvidenceId,
  ProjectWorkApprovalId,
  ProjectWorkRelationshipId,
  ProjectWorkResultId,
  ProjectWorkTaskId,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkAction,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";

import { asProjectWorkTaskContext } from "@t3tools/client-runtime/project-work";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { randomUUID } from "../../lib/utils";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { WorkDataNotice } from "./WorkDataNotice";
import { WorkCommandFailureNotice } from "./WorkCommandFailureNotice";
import { projectWorkCommandFailure, type ProjectWorkCommandFailure } from "./workCommandFailure";
import {
  makeProjectWorkAttemptTransitionCommand,
  makeProjectWorkEvidenceAddCommand,
  makeProjectWorkCriterionWaiveCommand,
  makeProjectWorkProtectedRevisionCommand,
  makeProjectWorkRelationshipCommand,
  makeProjectWorkResolveFailureCommand,
  makeProjectWorkSimpleTaskCommand,
  makeProjectWorkTaskBlockCommand,
  makeProjectWorkTaskClaimCommand,
  makeProjectWorkTaskCompleteCommand,
  makeProjectWorkTaskFailCommand,
  makeProjectWorkTaskManagementCommand,
} from "./workMutations";

const LABELS: Partial<Record<ProjectWorkAction, string>> = {
  claim: "Claim",
  complete: "Complete",
  fail: "Record failure",
  block: "Block",
  "resolve-blocker": "Resolve blocker",
  "resolve-failure": "Resolve failure",
  reopen: "Reopen",
  cancel: "Cancel",
  approve: "Approve",
  "protect-specification": "Protect spec",
  "revise-protected-specification": "Revise protected spec",
  "waive-criterion": "Waive criterion",
  "add-evidence": "Add evidence",
  "link-relationship": "Link dependency",
  "unlink-relationship": "Unlink dependency",
  reclaim: "Reclaim",
  takeover: "Take over",
  duplicate: "Duplicate",
  assign: "Assign",
  watch: "Watch",
  unwatch: "Unwatch",
};

const now = () => new Date().toISOString();
const commandId = () => CommandId.make(randomUUID());
const leaseUntil = () => new Date(Date.now() + 30 * 60_000).toISOString();
const ask = (message: string) => window.prompt(message)?.trim() || null;

export function TaskLifecycleControls({
  environmentId,
  projectId,
  taskId,
  canWrite,
  streamAvailable,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectWorkTaskId;
  readonly canWrite: boolean;
  readonly streamAvailable: boolean;
}) {
  const result = useAtomValue(
    projectWorkEnvironment.taskContext({
      environmentId,
      projectId,
      taskId,
      ...(streamAvailable ? { poll: false } : {}),
    }),
  );
  const contextTarget = {
    environmentId,
    projectId,
    taskId,
    ...(streamAvailable ? { poll: false as const } : {}),
  };
  const context = asProjectWorkTaskContext(Option.getOrNull(AsyncResult.value(result)));
  const write = useAtomCommand(projectWorkEnvironment.write, { reportFailure: false });
  const refreshContext = useAtomQueryRunner(projectWorkEnvironment.taskContext, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState<ProjectWorkCommand | null>(null);
  const [failure, setFailure] = useState<ProjectWorkCommandFailure | null>(null);

  const actor = useMemo(
    () => ({
      actor: { kind: "human" as const },
      source: { kind: "web" as const },
      recordedAt: now(),
    }),
    [],
  );

  const submit = useCallback(
    async (command: ProjectWorkCommand) => {
      if (!canWrite || pending) return;
      setPending(true);
      setRetry(command);
      setFailure(null);
      const next = await write({ environmentId, input: command });
      setPending(false);
      if (next._tag === "Failure")
        setFailure(projectWorkCommandFailure(squashAtomCommandFailure(next)));
      else setRetry(null);
    },
    [canWrite, environmentId, pending, write],
  );

  const build = useCallback(
    (action: ProjectWorkAction): ProjectWorkCommand | null => {
      if (!context) return null;
      const base = {
        projectId,
        taskId,
        expectedRevision: context.revision,
        commandId: commandId(),
      };
      const activeAttemptId = context.activeAttempt?.attemptId;
      switch (action) {
        case "claim":
          return makeProjectWorkTaskClaimCommand({
            ...base,
            attemptId: ProjectWorkAttemptId.make(randomUUID()),
            leaseToken: randomUUID(),
            leasedUntil: leaseUntil(),
            claimedAt: now(),
          });
        case "complete":
          return makeProjectWorkTaskCompleteCommand({
            ...base,
            ...(activeAttemptId ? { attemptId: activeAttemptId } : {}),
            satisfiedCriterionIds: context.criteria
              .filter((item) => item.required)
              .map((item) => item.criterionId),
            completedAt: now(),
          });
        case "fail": {
          const reason = ask("Failure reason");
          return reason
            ? makeProjectWorkTaskFailCommand({
                ...base,
                ...(activeAttemptId ? { attemptId: activeAttemptId } : {}),
                failureKind: "recoverable",
                reason,
                failedAt: now(),
              })
            : null;
        }
        case "block": {
          const reason = ask("Why is this blocked?");
          const resolver = reason && ask("Who or what can resolve it?");
          return reason && resolver
            ? makeProjectWorkTaskBlockCommand({
                ...base,
                blockerId: ProjectWorkBlockerId.make(randomUUID()),
                reason,
                resolver,
                blockedAt: now(),
              })
            : null;
        }
        case "resolve-blocker": {
          const blockerId =
            context.blockers.length === 1
              ? context.blockers[0]?.blockerId
              : ProjectWorkBlockerId.make(ask("Blocker ID to resolve") ?? "");
          const blocker = context.blockers.find((item) => item.blockerId === blockerId);
          return blocker
            ? makeProjectWorkSimpleTaskCommand("project-work.task.resolve-blocker", {
                ...base,
                now: now(),
                blockerId: blocker.blockerId,
              })
            : null;
        }
        case "resolve-failure": {
          const reason = ask("Resolution reason");
          return reason
            ? makeProjectWorkResolveFailureCommand({
                ...base,
                reason,
                evidenceIds: [],
                resolvedAt: now(),
                attribution: actor,
              })
            : null;
        }
        case "reopen":
          return makeProjectWorkSimpleTaskCommand("project-work.task.reopen", {
            ...base,
            now: now(),
          });
        case "cancel": {
          const reason = ask("Cancellation reason (optional)") ?? undefined;
          return makeProjectWorkSimpleTaskCommand("project-work.task.cancel", {
            ...base,
            now: now(),
            ...(reason ? { reason } : {}),
          });
        }
        case "approve":
          return makeProjectWorkSimpleTaskCommand("project-work.task.approve", {
            ...base,
            now: now(),
            approvalId: `approval-${randomUUID()}` as never,
            specRevision: context.task.specRevision,
          });
        case "protect-specification":
          return makeProjectWorkSimpleTaskCommand("project-work.task.protect-specification", {
            ...base,
            now: now(),
            specRevision: context.task.specRevision,
          });
        case "revise-protected-specification": {
          if (!context.task.specification) return null;
          const objective = ask("Revised objective");
          const affected = objective && ask("Affected result IDs (comma separated)");
          const affectedResultIds = affected
            ? affected
                .split(",")
                .map((value) => ProjectWorkResultId.make(value.trim()))
                .filter((value) => value.length > 0)
            : [];
          return objective
            ? makeProjectWorkProtectedRevisionCommand({
                ...base,
                specification: {
                  ...context.task.specification,
                  objective,
                  revision: context.task.specRevision + 1,
                  protected: true,
                },
                criterionSnapshots: context.criteria,
                affectedResultIds,
                approvalId: ProjectWorkApprovalId.make(randomUUID()),
                revisedAt: now(),
                attribution: actor,
              })
            : null;
        }
        case "waive-criterion": {
          const criterion = context.criteria.find(
            (item) => item.required && item.status === "unsatisfied",
          );
          const reason = criterion && ask("Waiver reason");
          return criterion && reason
            ? makeProjectWorkCriterionWaiveCommand({
                ...base,
                criterion,
                reason,
                specRevision: context.task.specRevision,
                evidenceIds: [],
                waivedAt: now(),
                attribution: actor,
              })
            : null;
        }
        case "add-evidence": {
          const summary = ask("Evidence summary");
          const selectedCriterionId = ask("Criterion ID (optional)");
          const criterion = selectedCriterionId
            ? context.criteria.find((item) => item.criterionId === selectedCriterionId)
            : undefined;
          if (selectedCriterionId && !criterion) return null;
          return summary
            ? makeProjectWorkEvidenceAddCommand({
                ...base,
                evidenceId: ProjectWorkEvidenceId.make(randomUUID()),
                summary,
                ...(criterion ? { criterionId: criterion.criterionId } : {}),
                recordedAt: now(),
              })
            : null;
        }
        case "link-relationship": {
          const other = ask("Dependency task ID");
          return other
            ? makeProjectWorkRelationshipCommand({
                ...base,
                mode: "link",
                otherTaskId: ProjectWorkTaskId.make(other),
                relationshipId: ProjectWorkRelationshipId.make(randomUUID()),
                now: now(),
              })
            : null;
        }
        case "unlink-relationship": {
          const selected =
            context.relationships.length === 1
              ? context.relationships[0]?.relationshipId
              : ProjectWorkRelationshipId.make(ask("Relationship ID to unlink") ?? "");
          const relationship = context.relationships.find(
            (item) => item.relationshipId === selected,
          );
          return relationship
            ? makeProjectWorkRelationshipCommand({
                ...base,
                mode: "unlink",
                otherTaskId: relationship.toTaskId,
                relationshipId: relationship.relationshipId,
                now: now(),
              })
            : null;
        }
        case "duplicate": {
          const title = ask("Duplicate title (optional)") ?? undefined;
          return makeProjectWorkTaskManagementCommand({
            ...base,
            mode: "duplicate",
            duplicateTaskId: ProjectWorkTaskId.make(randomUUID()),
            ...(title ? { title } : {}),
            now: now(),
          });
        }
        case "assign": {
          const assigneeId = ask("Assignee ID (leave blank to unassign)");
          return makeProjectWorkTaskManagementCommand({
            ...base,
            mode: "assign",
            assignee: assigneeId ? { kind: "human", id: assigneeId } : null,
            now: now(),
          });
        }
        case "watch": {
          const watcherId = ask("Watcher ID");
          return watcherId
            ? makeProjectWorkTaskManagementCommand({
                ...base,
                mode: "watch",
                watcher: { kind: "human", id: watcherId },
                now: now(),
              })
            : null;
        }
        case "unwatch": {
          const selected = ask("Watcher ID to remove");
          const watcher = selected
            ? context.task.watchers.find((item) => item.id === selected)
            : undefined;
          return watcher
            ? makeProjectWorkTaskManagementCommand({
                ...base,
                mode: "unwatch",
                watcher: { kind: "human", ...(watcher.id ? { id: watcher.id } : {}) },
                now: now(),
              })
            : null;
        }
        case "reclaim":
        case "takeover": {
          const previousAttemptId =
            action === "reclaim" ? context.reclaimableAttempt?.attemptId : activeAttemptId;
          if (!previousAttemptId) return null;
          const approvalToken = action === "takeover" ? ask("Approval token") : null;
          if (action === "takeover" && !approvalToken) return null;
          return makeProjectWorkAttemptTransitionCommand({
            ...base,
            mode: action,
            previousAttemptId,
            attemptId: ProjectWorkAttemptId.make(randomUUID()),
            leaseToken: randomUUID(),
            leasedUntil: leaseUntil(),
            claimedAt: now(),
            ...(approvalToken ? { approvalToken } : {}),
          });
        }
        default:
          return null;
      }
    },
    [actor, context, projectId, taskId],
  );

  if (!context) {
    return (
      <div className="mt-4 border-t border-border/60 pt-3">
        <WorkDataNotice
          stale={false}
          waiting={result._tag === "Initial" || result.waiting === true}
          error={
            result._tag === "Failure"
              ? projectWorkCommandFailure(squashAtomCommandFailure(result)).message
              : null
          }
          onRetry={() => void refreshContext(contextTarget)}
        />
      </div>
    );
  }
  const available = Object.entries(context.policy.actions).filter(
    ([action, value]) => value.available && LABELS[action as ProjectWorkAction],
  ) as Array<[ProjectWorkAction, { available: boolean; reason?: string }]>;

  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <p className="mb-2 text-xs text-muted-foreground">Project revision {context.revision}</p>
      <div className="flex flex-wrap gap-2">
        {available.map(([action]) => (
          <Button
            key={action}
            size="sm"
            variant="outline"
            disabled={!canWrite || pending}
            onClick={() => {
              const command = build(action);
              if (command) void submit(command);
            }}
          >
            {LABELS[action]}
          </Button>
        ))}
      </div>
      {failure ? (
        <div className="mt-3">
          <WorkCommandFailureNotice
            failure={failure}
            onRetry={() => {
              if (retry) void submit(retry);
            }}
            onDiscard={() => {
              setRetry(null);
              setFailure(null);
            }}
            onRebase={() => {
              setRetry(null);
              setFailure(null);
              void refreshContext({
                environmentId,
                projectId,
                taskId,
                ...(streamAvailable ? { poll: false } : {}),
              });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
