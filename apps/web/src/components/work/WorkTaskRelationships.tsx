import type { ProjectWorkRelationshipRead, ProjectWorkTaskId } from "@t3tools/contracts";
import { ProjectWorkRelationshipId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WorkReviewChanged } from "./WorkNotice";
import { WorkField, WorkFormStatus, WorkMeta, WorkRow, WorkSection } from "./WorkLayout";
import { WorkTaskLink, WorkTaskPicker } from "./WorkTaskRefs";
import { RELATIONSHIP_KINDS, relationshipFromTask, relationshipKindLabel } from "./workLogic";
import { newCommandId, useWorkReview, type WorkTaskSurface } from "./workTaskSurface";

type Kind = (typeof RELATIONSHIP_KINDS)[number];
const KIND_ITEMS = Object.fromEntries(
  RELATIONSHIP_KINDS.map((kind) => [kind, relationshipKindLabel(kind)]),
) as Record<Kind, string>;

/** Typed links between tasks in this project. Linking never changes approvals by itself. */
export function WorkTaskRelationships({
  surface,
  onOpenTask,
}: {
  readonly surface: WorkTaskSurface;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { context, writer, scope } = surface;
  const task = context.task;
  const linkAction = context.policy.actions["link-relationship"];
  const unlinkAction = context.policy.actions["unlink-relationship"];
  const linkReason = linkAction.available
    ? surface.blocked
    : (linkAction.reason ?? "Links can't change in this state.");
  const review = useWorkReview(surface.current);
  const [kind, setKind] = useState<Kind>("depends-on");
  const [target, setTarget] = useState<ProjectWorkTaskId | null>(null);
  const [unlinking, setUnlinking] = useState<ProjectWorkRelationshipRead | null>(null);
  const linkKey = "relationship:link";
  const linked = context.relationships.map(
    (relationship) => relationshipFromTask(relationship, task.taskId).otherTaskId,
  );

  const link = async () => {
    if (review.selected === null || target === null) return;
    const now = new Date().toISOString();
    const sent = await writer.submit(linkKey, review.selected, surface.current, {
      type: "project-work.relationship.link",
      commandId: newCommandId(),
      projectId: scope.projectId,
      expectedRevision: review.selected.revision,
      relationship: {
        relationshipId: ProjectWorkRelationshipId.make(randomUUID()),
        projectId: scope.projectId,
        fromTaskId: task.taskId,
        toTaskId: target,
        kind,
        revision: 0,
        createdAt: now,
      },
      linkedAt: now,
    });
    if (sent) {
      review.close();
      setTarget(null);
    }
  };

  const unlink = async (relationship: ProjectWorkRelationshipRead) => {
    const selected = surface.current;
    const sent = await writer.submit(
      `relationship:${relationship.relationshipId}`,
      selected,
      surface.current,
      {
        type: "project-work.relationship.unlink",
        commandId: newCommandId(),
        projectId: scope.projectId,
        expectedRevision: selected.revision,
        relationshipId: relationship.relationshipId,
        unlinkedAt: new Date().toISOString(),
      },
    );
    if (sent) setUnlinking(null);
  };

  return (
    <WorkSection
      title="Related tasks"
      description="Dependencies and other links. Open a linked task to review it."
      actions={
        review.selected === null ? (
          <Button
            size="xs"
            variant="outline"
            disabled={linkReason !== null}
            title={linkReason ?? undefined}
            onClick={() => {
              setTarget(null);
              review.open();
            }}
          >
            <PlusIcon /> Link task
          </Button>
        ) : null
      }
    >
      {review.selected !== null ? (
        <WorkRow className="gap-3">
          {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
          <WorkField label="This task">
            {(id) => (
              <Select
                value={kind}
                items={KIND_ITEMS}
                onValueChange={(value) => {
                  if (typeof value === "string" && value in KIND_ITEMS) setKind(value as Kind);
                }}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {RELATIONSHIP_KINDS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {KIND_ITEMS[value]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </WorkField>
          <WorkTaskPicker
            scope={scope}
            label="Task to link"
            selectedTaskId={target}
            excludeTaskIds={[task.taskId, ...linked]}
            onSelect={(choice) => setTarget(choice.taskId)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                target === null ||
                review.changed ||
                linkReason !== null ||
                writer.pendingKey !== null
              }
              onClick={() => void link()}
            >
              {writer.pendingKey === linkKey ? "Linking…" : "Link task"}
            </Button>
            <Button size="sm" variant="ghost" onClick={review.close}>
              Cancel
            </Button>
          </div>
          <WorkFormStatus message={writer.failureFor(linkKey)} />
        </WorkRow>
      ) : null}
      {context.relationships.length === 0 && review.selected === null ? (
        <WorkRow>
          <WorkMeta>No linked tasks.</WorkMeta>
        </WorkRow>
      ) : null}
      {context.relationships.map((relationship) => {
        const view = relationshipFromTask(relationship, task.taskId);
        const key = `relationship:${relationship.relationshipId}`;
        const confirming = unlinking?.relationshipId === relationship.relationshipId;
        const unlinkReason = unlinkAction.available
          ? surface.blocked
          : (unlinkAction.reason ?? "Links can't change in this state.");
        return (
          <WorkRow key={relationship.relationshipId} className="gap-1">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <WorkTaskLink
                  scope={scope}
                  taskId={view.otherTaskId}
                  prefix={view.label}
                  onOpen={onOpenTask}
                />
              </div>
              {confirming ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={unlinkReason !== null || writer.pendingKey !== null}
                  title={unlinkReason ?? undefined}
                  onClick={() => setUnlinking(relationship)}
                >
                  Unlink…
                </Button>
              )}
            </div>
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2 px-2">
                <WorkMeta>Remove this link? Both tasks stay as they are.</WorkMeta>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={unlinkReason !== null || writer.pendingKey !== null}
                  onClick={() => void unlink(relationship)}
                >
                  {writer.pendingKey === key ? "Unlinking…" : "Confirm unlink"}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setUnlinking(null)}>
                  Cancel
                </Button>
              </div>
            ) : null}
            <WorkFormStatus message={writer.failureFor(key)} />
          </WorkRow>
        );
      })}
      {review.selected === null && linkReason !== null ? (
        <WorkRow>
          <WorkFormStatus tone="muted" message={linkReason} />
        </WorkRow>
      ) : null}
    </WorkSection>
  );
}
