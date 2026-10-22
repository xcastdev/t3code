import { asProjectTeamRecord } from "@t3tools/client-runtime/project-work";
import { ProjectWorkBlockerId } from "@t3tools/contracts";
import { useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  makeProjectWorkSimpleTaskCommand,
  makeProjectWorkTaskBlockCommand,
  makeProjectWorkTaskReadyCommand,
} from "./workMutations";
import { WorkReviewChanged } from "./WorkNotice";
import {
  WorkField,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
} from "./WorkLayout";
import { useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import { isMemberRecord } from "./workLogic";
import { GUIDED_CONTROL_LABELS, guidedControls, type WorkGuidedControl } from "./workModel";
import { guidedFields, newCommandId, useWorkReview, type WorkTaskSurface } from "./workTaskSurface";

type OrdinaryAction = "ready" | "block" | "reopen" | "cancel";
type Pending =
  | { readonly kind: "guided"; readonly action: WorkGuidedControl }
  | { readonly kind: "ordinary"; readonly action: OrdinaryAction };

const ORDINARY_LABELS: Record<OrdinaryAction, string> = {
  ready: "Mark ready",
  block: "Block",
  reopen: "Reopen",
  cancel: "Cancel task",
};

/** Human steering for one task. Starting a worker lives in the Workers section. */
export function WorkTaskControls({ surface }: { surface: WorkTaskSurface }) {
  const { context, model, writer } = surface;
  const task = context.task;
  const review = useWorkReview(surface.current);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [resolver, setResolver] = useState("");
  const key = "control";
  const blocked = model.blockedReason ?? surface.blocked;
  const ordinary = (["ready", "block", "reopen", "cancel"] as const).filter(
    (action) => context.policy.actions[action].available,
  );
  const openBlockers = context.blockers.filter((blocker) => blocker.resolvedAt === undefined);

  const start = (next: Pending) => {
    setPending(next);
    setReason("");
    setResolver("");
    review.open();
  };
  const finish = () => {
    setPending(null);
    review.close();
  };

  const send = async () => {
    const selected = review.selected;
    if (selected === null || pending === null) return;
    const now = new Date().toISOString();
    const common = {
      projectId: surface.scope.projectId,
      taskId: task.taskId,
      expectedRevision: selected.revision,
      commandId: newCommandId(),
    };
    const intent =
      pending.kind === "guided"
        ? {
            ...guidedFields(surface, selected),
            type: "project-team.task.control",
            control: { action: pending.action, reason: reason.trim() },
          }
        : pending.action === "ready"
          ? makeProjectWorkTaskReadyCommand({ ...common, updatedAt: now })
          : pending.action === "block"
            ? makeProjectWorkTaskBlockCommand({
                ...common,
                blockerId: ProjectWorkBlockerId.make(randomUUID()),
                reason: reason.trim(),
                resolver: resolver.trim(),
                blockedAt: now,
              })
            : makeProjectWorkSimpleTaskCommand(
                pending.action === "reopen"
                  ? "project-work.task.reopen"
                  : "project-work.task.cancel",
                { ...common, now, ...(reason.trim() ? { reason: reason.trim() } : {}) },
              );
    if (await writer.submit(key, selected, surface.current, intent)) finish();
  };

  const resolveBlocker = async (blockerId: ProjectWorkBlockerId) => {
    const selected = surface.current;
    await writer.submit(
      `blocker:${blockerId}`,
      selected,
      surface.current,
      makeProjectWorkSimpleTaskCommand("project-work.task.resolve-blocker", {
        projectId: surface.scope.projectId,
        taskId: task.taskId,
        expectedRevision: selected.revision,
        commandId: newCommandId(),
        now: new Date().toISOString(),
        blockerId,
      }),
    );
  };

  const actions: ReadonlyArray<Pending> = model.guided
    ? guidedControls(model).map((action) => ({ kind: "guided", action }))
    : ordinary.map((action) => ({ kind: "ordinary", action }));
  const label = (entry: Pending) =>
    entry.kind === "guided" ? GUIDED_CONTROL_LABELS[entry.action] : ORDINARY_LABELS[entry.action];
  // Guided steering always records why; an ordinary block needs a reason and a resolver.
  const reasonRequired =
    pending !== null && (pending.kind === "guided" || pending.action === "block");
  const ready =
    pending !== null &&
    (!reasonRequired || reason.trim() !== "") &&
    (pending.action !== "block" || resolver.trim() !== "");

  return (
    <WorkSection
      title="Task controls"
      description={
        model.guided
          ? `Steering state: ${model.controlState}. Each change keeps the task's history.`
          : "Each change is recorded on the task."
      }
    >
      {openBlockers.map((blocker) => (
        <WorkRow key={blocker.blockerId}>
          <p className="text-sm break-words">Blocked: {blocker.reason}</p>
          <WorkMeta>Resolves when: {blocker.resolver}</WorkMeta>
          {model.guided ? null : (
            <div>
              <Button
                size="xs"
                variant="outline"
                disabled={blocked !== null || writer.pendingKey !== null}
                onClick={() => void resolveBlocker(blocker.blockerId)}
              >
                Resolve blocker
              </Button>
              <WorkFormStatus message={writer.failureFor(`blocker:${blocker.blockerId}`)} />
            </div>
          )}
        </WorkRow>
      ))}
      <WorkRow>
        {pending === null ? (
          actions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {actions.map((entry) => (
                <Button
                  key={entry.action}
                  size="sm"
                  variant="outline"
                  disabled={blocked !== null || writer.pendingKey !== null}
                  title={blocked ?? undefined}
                  onClick={() => start(entry)}
                >
                  {label(entry)}
                </Button>
              ))}
            </div>
          ) : (
            <WorkMeta>No steering change applies in the task's current state.</WorkMeta>
          )
        ) : (
          <div className="flex flex-col gap-3">
            {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
            <p className="text-sm font-medium">{label(pending)}</p>
            <WorkField label={reasonRequired ? "Reason" : "Reason (optional)"}>
              {(id) => (
                <Textarea
                  id={id}
                  size="sm"
                  maxLength={4000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </WorkField>
            {pending.action === "block" ? (
              <WorkField label="Resolves when">
                {(id) => (
                  <Input
                    id={id}
                    maxLength={4000}
                    value={resolver}
                    onChange={(event) => setResolver(event.target.value)}
                  />
                )}
              </WorkField>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={
                  !ready || review.changed || blocked !== null || writer.pendingKey !== null
                }
                onClick={() => void send()}
              >
                {writer.pendingKey === key ? "Saving…" : `Confirm ${label(pending).toLowerCase()}`}
              </Button>
              <Button size="sm" variant="ghost" onClick={finish}>
                Cancel
              </Button>
            </div>
            <WorkFormStatus message={writer.failureFor(key)} />
          </div>
        )}
      </WorkRow>
      {model.guided && !model.terminal ? <ReassignControl surface={surface} /> : null}
    </WorkSection>
  );
}

/**
 * Names who should take over a guided task. The server records the successor
 * and pauses the task; resuming hands it to that member.
 */
function ReassignControl({ surface }: { surface: WorkTaskSurface }) {
  const { model, writer, scope } = surface;
  const membersSet = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    recordKind: "member",
  });
  const members = membersSet.records.flatMap((value) => {
    const record = asProjectTeamRecord(value);
    return record !== null && isMemberRecord(record) && record.status === "active" ? [record] : [];
  });
  const review = useWorkReview(surface.current);
  const [recipient, setRecipient] = useState<{ id: string; revision: number } | null>(null);
  const [reason, setReason] = useState("");
  const key = "control:reassign";
  const listBlocked = workRecordsBlockedReason(membersSet, "team members");
  const blocked = model.blockedReason ?? surface.blocked ?? listBlocked;
  const chosen =
    recipient === null ? null : members.find((member) => member.recordId === recipient.id);
  const recipientChanged =
    recipient !== null && (chosen === undefined || chosen?.revision !== recipient.revision);

  const send = async () => {
    if (review.selected === null || recipient === null) return;
    const sent = await writer.submit(key, review.selected, surface.current, {
      ...guidedFields(surface, review.selected),
      type: "project-team.task.control",
      control: {
        action: "reassign",
        reason: reason.trim(),
        recipientMemberId: recipient.id,
        expectedMemberRevision: recipient.revision,
      },
    });
    if (sent) {
      review.close();
      setRecipient(null);
      setReason("");
    }
  };

  if (review.selected === null)
    return (
      <WorkRow>
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={blocked !== null || writer.pendingKey !== null}
            title={blocked ?? undefined}
            onClick={() => {
              setRecipient(null);
              setReason("");
              review.open();
            }}
          >
            Reassign…
          </Button>
        </div>
      </WorkRow>
    );

  return (
    <WorkRow className="gap-3">
      {review.changed || recipientChanged ? (
        <WorkReviewChanged
          onReview={() => {
            setRecipient(null);
            review.rebase();
          }}
        />
      ) : null}
      <p className="text-sm font-medium">Reassign</p>
      <div role="radiogroup" aria-label="Team member" className="flex flex-col gap-0.5">
        {members.length === 0 ? (
          <WorkMeta>
            {listBlocked ?? "No active team members. Configure the team in Overview first."}
          </WorkMeta>
        ) : null}
        {members.map((member) => {
          const selected = recipient?.id === member.recordId;
          return (
            // A semantic choice row; the whole row selects the member.
            <button
              key={member.recordId}
              type="button"
              role="radio"
              aria-checked={selected}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected && "bg-accent/60",
              )}
              onClick={() => setRecipient({ id: member.recordId, revision: member.revision })}
            >
              <span className="min-w-0 flex-1 truncate">{member.name}</span>
              {member.coordinator ? (
                <Badge size="sm" variant="outline">
                  Coordinator
                </Badge>
              ) : null}
              <WorkRevision className="text-muted-foreground">r{member.revision}</WorkRevision>
            </button>
          );
        })}
      </div>
      <WorkField label="Reason">
        {(id) => (
          <Textarea
            id={id}
            size="sm"
            maxLength={4000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </WorkField>
      <WorkMeta>
        This records who should take over and pauses the task. It doesn't start a worker.
      </WorkMeta>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            recipient === null ||
            recipientChanged ||
            reason.trim() === "" ||
            review.changed ||
            blocked !== null ||
            writer.pendingKey !== null
          }
          onClick={() => void send()}
        >
          {writer.pendingKey === key ? "Saving…" : "Confirm reassignment"}
        </Button>
        <Button size="sm" variant="ghost" onClick={review.close}>
          Cancel
        </Button>
      </div>
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}
