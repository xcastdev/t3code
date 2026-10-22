import {
  asProjectWorkDecision,
  asProjectWorkKnowledge,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  ProjectWorkDecisionId,
  ProjectWorkKnowledgeId,
  type ProjectWorkDecisionRead,
  type ProjectWorkKnowledgeRead,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { cn, randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  makeProjectWorkDecisionCommand,
  makeProjectWorkKnowledgePromoteCommand,
} from "./workMutations";
import { WorkReviewChanged } from "./WorkNotice";
import {
  WorkEmpty,
  WorkField,
  WorkFormStatus,
  WorkMeta,
  WorkRow,
  WorkSection,
  WorkTime,
} from "./WorkLayout";
import { WorkNotice, WorkPager, WorkRecordsNotice } from "./WorkNotice";
import { workWriteBlockedReason } from "./useWorkRead";
import { useWorkPage, useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import { knowledgeLineage } from "./workLogic";
import type { WorkWriter } from "./useWorkWriter";
import { workStateLabel, workStateVariant } from "./workModel";
import { newCommandId, useWorkReview } from "./workTaskSurface";

const WORK_LIST_PAGE = 32;

const projectSelection = (scope: ProjectWorkScope, revision: number): ProjectWorkSelection => ({
  ...scope,
  revision,
  taskRevision: 0,
});

/** Reviewed project knowledge and decisions; both stay as written until a human replaces them. */
export function WorkKnowledge({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <KnowledgeList scope={scope} writer={writer} />
      <DecisionList scope={scope} writer={writer} />
    </div>
  );
}

function TitleBodyForm(props: {
  readonly titleLabel: string;
  readonly bodyLabel: string;
  readonly initialTitle?: string;
  readonly initialBody?: string;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly blocked: string | null;
  readonly changed: boolean;
  readonly onReview: () => void;
  readonly failure: string | null;
  readonly onSubmit: (title: string, body: string) => void;
  readonly onCancel: () => void;
}) {
  const [title, setTitle] = useState(props.initialTitle ?? "");
  const [body, setBody] = useState(props.initialBody ?? "");
  return (
    <WorkRow className="gap-3">
      {props.changed ? <WorkReviewChanged onReview={props.onReview} /> : null}
      <WorkField label={props.titleLabel}>
        {(id) => (
          <Input
            id={id}
            maxLength={4000}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        )}
      </WorkField>
      <WorkField label={props.bodyLabel}>
        {(id) => (
          <Textarea
            id={id}
            maxLength={32000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        )}
      </WorkField>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={title.trim() === "" || props.pending || props.changed || props.blocked !== null}
          title={props.blocked ?? undefined}
          onClick={() => props.onSubmit(title.trim(), body.trim())}
        >
          {props.pending ? "Saving…" : props.submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      <WorkFormStatus message={props.failure} />
    </WorkRow>
  );
}

function KnowledgeList({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  const pager = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "knowledge" },
    WORK_LIST_PAGE,
  );
  // Currentness needs every entry: a replacement may sit on any page.
  const history = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "knowledge",
  });
  const view = pager.view;
  const items = (view.page?.items ?? []).flatMap((item): ProjectWorkKnowledgeRead[] => {
    const entry = asProjectWorkKnowledge(item.value);
    return entry === null ? [] : [entry];
  });
  const lineage = knowledgeLineage(
    history.records.flatMap((value): ProjectWorkKnowledgeRead[] => {
      const entry = asProjectWorkKnowledge(value);
      return entry === null ? [] : [entry];
    }),
  );
  const current = view.page ? projectSelection(scope, view.page.revision) : null;
  const blocked = workWriteBlockedReason(view, writer.canWrite);
  const historyBlocked =
    workRecordsBlockedReason(history, "knowledge history") ??
    (history.revision === view.page?.revision ? null : "Knowledge history is catching up.");
  const [editing, setEditing] = useState<ProjectWorkKnowledgeRead | "new" | null>(null);
  const review = useWorkReview(current ?? projectSelection(scope, -1));
  const key = "knowledge";
  const reviseReason = (entry: ProjectWorkKnowledgeRead) => {
    const replacement = lineage.supersededBy.get(entry.knowledgeId);
    return (
      blocked ??
      historyBlocked ??
      (replacement
        ? `Replaced by “${replacement.title}”. Revise the current version instead.`
        : null)
    );
  };
  const editingReason =
    editing === null ? null : editing === "new" ? blocked : reviseReason(editing);

  const save = async (title: string, body: string) => {
    if (review.selected === null || current === null || editing === null) return;
    if (editing !== "new" && reviseReason(editing) !== null) return;
    const now = new Date().toISOString();
    const sent = await writer.submit(
      key,
      review.selected,
      current,
      makeProjectWorkKnowledgePromoteCommand({
        projectId: scope.projectId,
        expectedRevision: review.selected.revision,
        commandId: newCommandId(),
        knowledgeId: ProjectWorkKnowledgeId.make(randomUUID()),
        ...(editing === "new" ? {} : { supersedesKnowledgeId: editing.knowledgeId }),
        title,
        body,
        sourceKind: "manual",
        sourceId: isElectron ? "desktop" : "web",
        promotedAt: now,
      }),
    );
    if (sent) {
      setEditing(null);
      review.close();
    }
  };
  const open = (target: ProjectWorkKnowledgeRead | "new") => {
    setEditing(target);
    review.open();
  };

  return (
    <WorkSection
      title="Knowledge"
      description="Facts and conventions people have confirmed for this project. Revising keeps the earlier version as history."
      actions={
        editing === null ? (
          <Button
            size="xs"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => open("new")}
          >
            <PlusIcon /> Add knowledge
          </Button>
        ) : null
      }
    >
      {view.status !== "ready" ? (
        <WorkRow>
          <WorkNotice view={view} subject="knowledge" />
        </WorkRow>
      ) : null}
      {history.complete && history.status === "ready" ? null : (
        <WorkRow>
          <WorkRecordsNotice set={history} subject="knowledge history" />
        </WorkRow>
      )}
      {editing !== null ? (
        <TitleBodyForm
          key={editing === "new" ? "new" : editing.knowledgeId}
          titleLabel="Title"
          bodyLabel="What should be remembered"
          {...(editing === "new" ? {} : { initialTitle: editing.title, initialBody: editing.body })}
          submitLabel={editing === "new" ? "Save knowledge" : "Save revision"}
          pending={writer.pendingKey === key}
          blocked={editingReason}
          changed={review.changed}
          onReview={review.rebase}
          failure={writer.failureFor(key)}
          onSubmit={(title, body) => void save(title, body)}
          onCancel={() => {
            setEditing(null);
            review.close();
          }}
        />
      ) : null}
      {view.page !== null && items.length === 0 && editing === null ? (
        <WorkEmpty
          title={pager.offset === 0 ? "No knowledge yet" : "No more knowledge"}
          {...(pager.offset === 0
            ? { detail: "Record what agents and people should keep in mind here." }
            : {})}
        />
      ) : null}
      {items.map((entry) => {
        const replacement = lineage.supersededBy.get(entry.knowledgeId);
        const predecessor =
          entry.supersedesKnowledgeId === undefined
            ? null
            : (lineage.byId.get(entry.supersedesKnowledgeId) ?? null);
        const reason = reviseReason(entry);
        return (
          <WorkRow key={entry.knowledgeId}>
            <div className="flex flex-wrap items-center gap-2">
              <p
                className={cn(
                  "min-w-0 flex-1 text-sm font-medium break-words",
                  replacement && "text-muted-foreground",
                )}
              >
                {entry.title}
              </p>
              {history.complete ? (
                <Badge size="sm" variant={replacement ? "outline" : "success"}>
                  {replacement ? "Replaced" : "Current"}
                </Badge>
              ) : null}
              {replacement ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={reason !== null || editing !== null}
                  title={reason ?? undefined}
                  onClick={() => open(entry)}
                >
                  Revise
                </Button>
              )}
            </div>
            {entry.body ? (
              <p className="text-sm whitespace-pre-wrap break-words">{entry.body}</p>
            ) : null}
            <WorkMeta>
              {workStateLabel(entry.sourceKind)} · <WorkTime value={entry.updatedAt} />
              {replacement ? ` · replaced by “${replacement.title}”` : ""}
              {entry.supersedesKnowledgeId !== undefined
                ? ` · replaces ${predecessor ? `“${predecessor.title}”` : "an earlier entry"}`
                : ""}
            </WorkMeta>
          </WorkRow>
        );
      })}
      <WorkPager pager={pager} noun="Entries" />
    </WorkSection>
  );
}

type DecisionMode = "propose" | "reject" | "supersede";

function DecisionList({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  const pager = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "decisions" },
    WORK_LIST_PAGE,
  );
  const view = pager.view;
  const decisions = (view.page?.items ?? []).flatMap((item): ProjectWorkDecisionRead[] => {
    const entry = asProjectWorkDecision(item.value);
    return entry === null ? [] : [entry];
  });
  const current = view.page ? projectSelection(scope, view.page.revision) : null;
  const blocked = workWriteBlockedReason(view, writer.canWrite);
  const review = useWorkReview(current ?? projectSelection(scope, -1));
  const [target, setTarget] = useState<{
    mode: DecisionMode;
    decision: ProjectWorkDecisionRead | null;
  } | null>(null);
  const [reason, setReason] = useState("");
  const key = "decision";

  const send = async (
    mode: "propose" | "accept" | "reject" | "supersede",
    decision: ProjectWorkDecisionRead | null,
    selected: ProjectWorkSelection,
    fields: { title?: string; body?: string; reason?: string } = {},
  ) => {
    if (current === null) return;
    const now = new Date().toISOString();
    const sent = await writer.submit(
      `${key}:${decision?.decisionId ?? "new"}`,
      selected,
      current,
      makeProjectWorkDecisionCommand({
        mode,
        projectId: scope.projectId,
        expectedRevision: selected.revision,
        commandId: newCommandId(),
        decisionId: decision?.decisionId ?? ProjectWorkDecisionId.make(randomUUID()),
        replacementId: ProjectWorkDecisionId.make(randomUUID()),
        ...fields,
        now,
        // Supersession requires attribution in the payload; the server replaces it.
        attribution: {
          actor: { kind: "human" },
          source: { kind: isElectron ? "desktop" : "web" },
          recordedAt: now,
        },
      }),
    );
    if (sent) {
      setTarget(null);
      setReason("");
      review.close();
    }
  };
  const open = (mode: DecisionMode, decision: ProjectWorkDecisionRead | null) => {
    setTarget({ mode, decision });
    setReason("");
    review.open();
  };
  const formKey = `${key}:${target?.decision?.decisionId ?? "new"}`;

  return (
    <WorkSection
      title="Decisions"
      description="Proposed choices stay proposed until a person accepts or rejects them."
      actions={
        target === null ? (
          <Button
            size="xs"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => open("propose", null)}
          >
            <PlusIcon /> Propose decision
          </Button>
        ) : null
      }
    >
      {view.status !== "ready" ? (
        <WorkRow>
          <WorkNotice view={view} subject="decisions" />
        </WorkRow>
      ) : null}
      {target !== null && target.mode !== "reject" ? (
        <TitleBodyForm
          key={`${target.mode}:${target.decision?.decisionId ?? "new"}`}
          titleLabel={target.mode === "supersede" ? "Replacement decision" : "Decision"}
          bodyLabel="Context and consequences"
          {...(target.decision
            ? { initialTitle: target.decision.title, initialBody: target.decision.body }
            : {})}
          submitLabel={target.mode === "supersede" ? "Propose replacement" : "Propose decision"}
          pending={writer.pendingKey === formKey}
          blocked={blocked}
          changed={review.changed}
          onReview={review.rebase}
          failure={writer.failureFor(formKey)}
          onSubmit={(title, body) => {
            if (review.selected)
              void send(target.mode, target.decision, review.selected, { title, body });
          }}
          onCancel={() => {
            setTarget(null);
            review.close();
          }}
        />
      ) : null}
      {view.page !== null && decisions.length === 0 && target === null ? (
        <WorkEmpty title={pager.offset === 0 ? "No decisions recorded" : "No more decisions"} />
      ) : null}
      {decisions.map((decision) => {
        const rowKey = `${key}:${decision.decisionId}`;
        const rejecting =
          target?.mode === "reject" && target.decision?.decisionId === decision.decisionId;
        return (
          <WorkRow key={decision.decisionId}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-sm font-medium break-words">{decision.title}</p>
              <Badge variant={workStateVariant(decision.state)}>
                {workStateLabel(decision.state)}
              </Badge>
            </div>
            {decision.body ? (
              <p className="text-sm whitespace-pre-wrap break-words">{decision.body}</p>
            ) : null}
            {decision.rejectionReason ? (
              <WorkMeta>Rejected: {decision.rejectionReason}</WorkMeta>
            ) : null}
            <WorkMeta>
              <WorkTime value={decision.updatedAt} />
            </WorkMeta>
            {rejecting ? (
              <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
                <WorkField label="Why reject it?">
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
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={reason.trim() === "" || review.changed || writer.pendingKey !== null}
                    onClick={() => {
                      if (review.selected)
                        void send("reject", decision, review.selected, { reason: reason.trim() });
                    }}
                  >
                    Confirm rejection
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setTarget(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : target === null ? (
              <div className="flex flex-wrap gap-2">
                {decision.state === "proposed" ? (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={blocked !== null || writer.pendingKey !== null || current === null}
                      onClick={() => current && void send("accept", decision, current)}
                    >
                      Accept
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={blocked !== null}
                      onClick={() => open("reject", decision)}
                    >
                      Reject…
                    </Button>
                  </>
                ) : null}
                {decision.state === "accepted" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={blocked !== null}
                    onClick={() => open("supersede", decision)}
                  >
                    Supersede…
                  </Button>
                ) : null}
              </div>
            ) : null}
            <WorkFormStatus message={writer.failureFor(rowKey)} />
          </WorkRow>
        );
      })}
      <WorkPager pager={pager} noun="Decisions" />
    </WorkSection>
  );
}
