import { ProjectWorkCommentId, ProjectWorkEvidenceId } from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { makeProjectWorkEvidenceAddCommand } from "./workMutations";
import { WorkField, WorkFormStatus, WorkMeta, WorkRow, WorkSection, WorkTime } from "./WorkLayout";
import { workStateLabel } from "./workModel";
import { newCommandId, type WorkTaskSurface } from "./workTaskSurface";

/** Human notes and evidence. Evidence is a record; it never marks a criterion met by itself. */
export function WorkTaskActivity({ surface }: { surface: WorkTaskSurface }) {
  const { context, writer } = surface;
  const task = context.task;
  const [comment, setComment] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [uri, setUri] = useState("");
  const [criterionId, setCriterionId] = useState<string>("");
  const evidenceAction = context.policy.actions["add-evidence"];
  const commentKey = "comment";
  const evidenceKey = "evidence";
  const busy = writer.pendingKey !== null;

  const addComment = async () => {
    const selected = surface.current;
    const now = new Date().toISOString();
    const sent = await writer.submit(commentKey, selected, surface.current, {
      type: "project-work.comment.add",
      commandId: newCommandId(),
      projectId: surface.scope.projectId,
      expectedRevision: selected.revision,
      comment: {
        commentId: ProjectWorkCommentId.make(randomUUID()),
        projectId: surface.scope.projectId,
        taskId: task.taskId,
        body: comment.trim(),
        createdAt: now,
        revision: 0,
      },
      addedAt: now,
    });
    if (sent) setComment("");
  };

  const criterion = context.criteria.find((entry) => entry.criterionId === criterionId) ?? null;
  const addEvidence = async () => {
    const selected = surface.current;
    const sent = await writer.submit(
      evidenceKey,
      selected,
      surface.current,
      makeProjectWorkEvidenceAddCommand({
        projectId: surface.scope.projectId,
        taskId: task.taskId,
        expectedRevision: selected.revision,
        commandId: newCommandId(),
        evidenceId: ProjectWorkEvidenceId.make(randomUUID()),
        summary: summary.trim(),
        ...(uri.trim() ? { uri: uri.trim() } : {}),
        ...(criterion ? { criterionId: criterion.criterionId } : {}),
        recordedAt: new Date().toISOString(),
      }),
    );
    if (sent) {
      setSummary("");
      setUri("");
      setCriterionId("");
      setEvidenceOpen(false);
    }
  };

  return (
    <>
      <WorkSection
        title="Evidence"
        description="Observations, links and results recorded against this task."
        actions={
          evidenceOpen ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={!evidenceAction.available || surface.blocked !== null}
              title={
                evidenceAction.available
                  ? (surface.blocked ?? undefined)
                  : (evidenceAction.reason ?? undefined)
              }
              onClick={() => setEvidenceOpen(true)}
            >
              Add evidence
            </Button>
          )
        }
      >
        {evidenceOpen ? (
          <WorkRow className="gap-3">
            <WorkField label="What was observed">
              {(id) => (
                <Textarea
                  id={id}
                  size="sm"
                  maxLength={4000}
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                />
              )}
            </WorkField>
            <WorkField label="Link (optional)">
              {(id) => (
                <Input
                  id={id}
                  type="url"
                  value={uri}
                  onChange={(event) => setUri(event.target.value)}
                />
              )}
            </WorkField>
            {context.criteria.length > 0 ? (
              <WorkField label="About criterion (optional)">
                {(id) => (
                  <Select
                    value={criterionId}
                    onValueChange={(value) =>
                      setCriterionId(typeof value === "string" ? value : "")
                    }
                  >
                    <SelectTrigger id={id}>
                      <SelectValue placeholder="The whole task" />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="">The whole task</SelectItem>
                      {context.criteria.map((entry) => (
                        <SelectItem key={entry.criterionId} value={entry.criterionId}>
                          {entry.description}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
              </WorkField>
            ) : null}
            <WorkMeta>
              Saved as your observation, attributed to this session. It doesn't mark a criterion met
              or verify anything by itself.
            </WorkMeta>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={summary.trim() === "" || busy || surface.blocked !== null}
                onClick={() => void addEvidence()}
              >
                {writer.pendingKey === evidenceKey ? "Saving…" : "Record evidence"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEvidenceOpen(false)}>
                Cancel
              </Button>
            </div>
            <WorkFormStatus message={writer.failureFor(evidenceKey)} />
          </WorkRow>
        ) : null}
        {context.evidence.length === 0 && !evidenceOpen ? (
          <WorkRow>
            <WorkMeta>No evidence recorded.</WorkMeta>
          </WorkRow>
        ) : null}
        {context.evidence.map((evidence) => (
          <WorkRow key={evidence.evidenceId}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{workStateLabel(evidence.kind)}</Badge>
              <p className="min-w-0 flex-1 text-sm break-words">{evidence.summary}</p>
            </div>
            {evidence.criterionId ? (
              <WorkMeta className="break-words">
                About:{" "}
                {context.criteria.find((entry) => entry.criterionId === evidence.criterionId)
                  ?.description ?? "a criterion no longer on this task"}
              </WorkMeta>
            ) : null}
            {evidence.detail ? (
              <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
                {evidence.detail}
              </p>
            ) : null}
            <WorkMeta>
              <WorkTime value={evidence.recordedAt} />
              {evidence.attribution
                ? ` · ${evidence.attribution.actor.displayName ?? evidence.attribution.actor.kind}`
                : ""}
              {evidence.uri ? (
                <>
                  {" · "}
                  {/* Remote text stays inert: shown as text, never fetched or embedded. */}
                  <span className="break-all">{evidence.uri}</span>
                </>
              ) : null}
            </WorkMeta>
          </WorkRow>
        ))}
      </WorkSection>
      <WorkSection title="Comments">
        {context.comments.map((entry) => (
          <WorkRow key={entry.commentId}>
            <p className="text-sm whitespace-pre-wrap break-words">{entry.body}</p>
            <WorkMeta>
              {entry.attribution?.actor.displayName ?? entry.attribution?.actor.kind ?? "Unknown"} ·{" "}
              <WorkTime value={entry.createdAt} />
            </WorkMeta>
          </WorkRow>
        ))}
        <WorkRow className="gap-2">
          <WorkField label="Add a comment">
            {(id) => (
              <Textarea
                id={id}
                size="sm"
                maxLength={32000}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            )}
          </WorkField>
          <div>
            <Button
              size="sm"
              disabled={comment.trim() === "" || busy || surface.blocked !== null}
              title={surface.blocked ?? undefined}
              onClick={() => void addComment()}
            >
              {writer.pendingKey === commentKey ? "Saving…" : "Comment"}
            </Button>
          </div>
          <WorkFormStatus message={writer.failureFor(commentKey)} />
        </WorkRow>
      </WorkSection>
    </>
  );
}
