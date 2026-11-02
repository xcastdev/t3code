import {
  asProjectWorkDecision,
  asProjectWorkKnowledge,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  ProjectWorkDecisionId,
  ProjectWorkKnowledgeId,
  ProjectWorkTaskId,
  type ProjectWorkActorRead,
  type ProjectWorkDecisionRead,
  type ProjectWorkKnowledgeRead,
} from "@t3tools/contracts";
import {
  BookPlusIcon,
  BotIcon,
  CirclePlayIcon,
  GitBranchIcon,
  HistoryIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PencilIcon,
  PenLineIcon,
  ScaleIcon,
  TerminalSquareIcon,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { isElectron } from "../../env";
import { cn, randomUUID } from "../../lib/utils";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  makeProjectWorkDecisionCommand,
  makeProjectWorkKnowledgePromoteCommand,
} from "./workMutations";
import { WorkReviewChanged } from "./WorkNotice";
import { WorkField, WorkFormStatus, WorkMeta, WorkRow } from "./WorkLayout";
import { WorkNotice, WorkPager, WorkRecordsNotice } from "./WorkNotice";
import { workWriteBlockedReason } from "./useWorkRead";
import { useWorkPage, useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import { knowledgeLineage } from "./workLogic";
import type { WorkWriter } from "./useWorkWriter";
import { workStateLabel } from "./workModel";
import { WorkStatusGlyph } from "./WorkStatus";
import { WorkTaskLink } from "./WorkTaskRefs";
import { newCommandId, useWorkReview } from "./workTaskSurface";

const WORK_LIST_PAGE = 32;

const projectSelection = (scope: ProjectWorkScope, revision: number): ProjectWorkSelection => ({
  ...scope,
  revision,
  taskRevision: 0,
});

const SOURCE_PRESENTATION: Record<string, { readonly label: string; readonly icon: LucideIcon }> = {
  manual: { label: "Added by hand", icon: PenLineIcon },
  task: { label: "From a task", icon: ListTodoIcon },
  thread: { label: "From a thread", icon: MessageSquareIcon },
  session: { label: "From a session", icon: TerminalSquareIcon },
  worktree: { label: "From a worktree", icon: GitBranchIcon },
  attempt: { label: "From an attempt", icon: CirclePlayIcon },
};

const actorLabel = (actor: ProjectWorkActorRead | undefined) =>
  actor?.displayName ??
  (actor === undefined
    ? null
    : actor.kind === "human"
      ? "A person"
      : actor.kind === "agent"
        ? "An agent"
        : workStateLabel(actor.kind));

/** Reviewed project knowledge and decisions; both stay as written until a human replaces them. */
export function WorkKnowledge({
  scope,
  writer,
  onOpenTask,
}: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  onOpenTask?: (taskId: ProjectWorkTaskId) => void;
}) {
  return (
    // Capped and split once wide, so a sparse page never stretches across the screen.
    <div className="mx-auto grid w-full max-w-6xl min-w-0 items-start gap-6 @4xl/work:grid-cols-[minmax(0,1fr)_20rem]">
      <KnowledgeList scope={scope} writer={writer} onOpenTask={onOpenTask} />
      <DecisionList scope={scope} writer={writer} />
    </div>
  );
}

function ListHeader(props: {
  readonly title: string;
  readonly count: number | null;
  readonly description: string;
  readonly action: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 px-1">
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-sm font-medium text-foreground">
          {props.title}
          {props.count === null ? null : (
            <span className="ms-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {props.count}
            </span>
          )}
        </h2>
        <WorkMeta>{props.description}</WorkMeta>
      </div>
      {props.action}
    </div>
  );
}

function IconAction(props: {
  readonly label: string;
  readonly blocked: string | null;
  readonly variant?: "default" | "ghost";
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant={props.variant ?? "default"}
            aria-label={props.label}
            disabled={props.blocked !== null}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.blocked ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}

function Byline(props: { readonly actor: ProjectWorkActorRead | undefined; readonly at: string }) {
  const author = actorLabel(props.actor);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {author ? (
        <>
          <span className="truncate">{author}</span>
          <span aria-hidden="true">·</span>
        </>
      ) : null}
      <span className="shrink-0 tabular-nums">
        <RelativeTime timestamp={props.at} />
      </span>
    </span>
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

function KnowledgeList({
  scope,
  writer,
  onOpenTask,
}: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  onOpenTask: ((taskId: ProjectWorkTaskId) => void) | undefined;
}) {
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
    <section aria-label="Knowledge" className="flex min-w-0 flex-col gap-2">
      <ListHeader
        title="Knowledge"
        count={view.page === null ? null : items.length}
        description="Facts and conventions people confirmed for this project. Revising keeps the earlier version."
        action={
          editing === null ? (
            <IconAction label="Add knowledge" blocked={blocked} onClick={() => open("new")}>
              <BookPlusIcon />
            </IconAction>
          ) : null
        }
      />
      {view.status !== "ready" ? (
        <div className="rounded-xl border border-border/60 bg-card/40">
          <WorkRow>
            <WorkNotice view={view} subject="knowledge" />
          </WorkRow>
        </div>
      ) : null}
      {history.complete && history.status === "ready" ? null : (
        <div className="rounded-xl border border-border/60 bg-card/40">
          <WorkRow>
            <WorkRecordsNotice set={history} subject="knowledge history" />
          </WorkRow>
        </div>
      )}
      {editing !== null ? (
        <div className="rounded-xl border border-border/60 bg-card/40">
          <TitleBodyForm
            key={editing === "new" ? "new" : editing.knowledgeId}
            titleLabel="Title"
            bodyLabel="What should be remembered"
            {...(editing === "new"
              ? {}
              : { initialTitle: editing.title, initialBody: editing.body })}
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
        </div>
      ) : null}
      {view.page !== null && items.length === 0 && editing === null ? (
        <div className="rounded-xl border border-border/60 bg-card/40">
          <WorkRow>
            <WorkMeta>
              {pager.offset === 0
                ? "No knowledge yet. Add what agents and people should keep in mind."
                : "No more knowledge."}
            </WorkMeta>
          </WorkRow>
        </div>
      ) : null}
      {items.length > 0 ? (
        <div className="grid min-w-0 gap-3 @2xl/work:grid-cols-2 @4xl/work:grid-cols-1 @6xl/work:grid-cols-2">
          {items.map((entry) => {
            const replacement = lineage.supersededBy.get(entry.knowledgeId);
            const predecessor =
              entry.supersedesKnowledgeId === undefined
                ? null
                : (lineage.byId.get(entry.supersedesKnowledgeId) ?? null);
            return (
              <KnowledgeCard
                key={entry.knowledgeId}
                scope={scope}
                entry={entry}
                status={history.complete ? (replacement ? "replaced" : "current") : null}
                replacementTitle={replacement?.title ?? null}
                predecessorTitle={
                  entry.supersedesKnowledgeId === undefined
                    ? null
                    : (predecessor?.title ?? "an earlier entry")
                }
                reviseBlocked={
                  editing !== null ? "Finish the open edit first." : reviseReason(entry)
                }
                onRevise={replacement ? null : () => open(entry)}
                onOpenTask={onOpenTask}
              />
            );
          })}
        </div>
      ) : null}
      <WorkPager pager={pager} noun="Entries" />
    </section>
  );
}

function KnowledgeCard(props: {
  readonly scope: ProjectWorkScope;
  readonly entry: ProjectWorkKnowledgeRead;
  readonly status: "current" | "replaced" | null;
  readonly replacementTitle: string | null;
  readonly predecessorTitle: string | null;
  readonly reviseBlocked: string | null;
  readonly onRevise: (() => void) | null;
  readonly onOpenTask: ((taskId: ProjectWorkTaskId) => void) | undefined;
}) {
  const { entry } = props;
  const [expanded, setExpanded] = useState(false);
  const source = SOURCE_PRESENTATION[entry.sourceKind] ?? {
    label: `From ${workStateLabel(entry.sourceKind).toLowerCase()}`,
    icon: BotIcon,
  };
  const SourceIcon = source.icon;
  const replaced = props.status === "replaced";
  // Long entries clamp to an excerpt; the full text is one click away.
  const long = entry.body.length > 280 || entry.body.split("\n").length > 4;
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-xl border border-border/60 bg-card/40 p-4",
        replaced && "bg-muted/10",
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        >
          <SourceIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              "m-0 text-sm leading-5 font-semibold break-words",
              replaced && "text-muted-foreground",
            )}
          >
            {entry.title}
          </h3>
          <WorkMeta>{source.label}</WorkMeta>
        </div>
        {props.status === null ? null : (
          <Badge size="sm" variant={replaced ? "outline" : "success"}>
            {replaced ? "Replaced" : "Current"}
          </Badge>
        )}
        {props.onRevise === null ? null : (
          <IconAction
            label="Revise"
            variant="ghost"
            blocked={props.reviseBlocked}
            onClick={props.onRevise}
          >
            <PencilIcon />
          </IconAction>
        )}
      </div>
      {entry.body ? (
        <div className="flex min-w-0 flex-col items-start gap-1">
          <p
            className={cn(
              "m-0 text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground/85",
              long && !expanded && "line-clamp-4",
            )}
          >
            {entry.body}
          </p>
          {long ? (
            <Button size="xs" variant="ghost" onClick={() => setExpanded((open) => !open)}>
              {expanded ? "Show less" : "Show more"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {props.replacementTitle !== null || props.predecessorTitle !== null ? (
        <div className="flex flex-col gap-1">
          {props.replacementTitle !== null ? (
            <WorkMeta className="flex items-center gap-1.5">
              <HistoryIcon aria-hidden="true" className="size-3 shrink-0" />
              <span className="min-w-0 break-words">Replaced by “{props.replacementTitle}”</span>
            </WorkMeta>
          ) : null}
          {props.predecessorTitle !== null ? (
            <WorkMeta className="flex items-center gap-1.5">
              <HistoryIcon aria-hidden="true" className="size-3 shrink-0" />
              <span className="min-w-0 break-words">Replaces “{props.predecessorTitle}”</span>
            </WorkMeta>
          ) : null}
        </div>
      ) : null}
      {entry.sourceKind === "task" && props.onOpenTask ? (
        <WorkTaskLink
          scope={props.scope}
          taskId={ProjectWorkTaskId.make(entry.sourceId)}
          prefix="From"
          onOpen={props.onOpenTask}
        />
      ) : null}
      <div className="mt-auto border-t border-border/50 pt-2.5">
        <Byline actor={entry.attribution?.actor} at={entry.updatedAt} />
      </div>
    </article>
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
    <section aria-label="Decisions" className="flex min-w-0 flex-col gap-2">
      <ListHeader
        title="Decisions"
        count={view.page === null ? null : decisions.length}
        description="Proposed choices stay proposed until a person accepts or rejects them."
        action={
          target === null ? (
            <IconAction
              label="Propose decision"
              blocked={blocked}
              onClick={() => open("propose", null)}
            >
              <ScaleIcon />
            </IconAction>
          ) : null
        }
      />
      <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40">
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
          <WorkRow>
            <WorkMeta>
              {pager.offset === 0 ? "No decisions recorded yet." : "No more decisions."}
            </WorkMeta>
          </WorkRow>
        ) : null}
        {decisions.map((decision) => {
          const rowKey = `${key}:${decision.decisionId}`;
          const rejecting =
            target?.mode === "reject" && target.decision?.decisionId === decision.decisionId;
          return (
            <div
              key={decision.decisionId}
              className="flex min-w-0 flex-col gap-2 border-border/50 px-4 py-3 not-first:border-t"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="pt-0.5">
                  <WorkStatusGlyph state={decision.state} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p
                    className={cn(
                      "m-0 text-sm leading-5 font-medium break-words",
                      (decision.state === "rejected" || decision.state === "superseded") &&
                        "text-muted-foreground",
                    )}
                  >
                    {decision.title}
                  </p>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="shrink-0">{workStateLabel(decision.state)}</span>
                    <span aria-hidden="true">·</span>
                    <Byline actor={decision.attribution?.actor} at={decision.updatedAt} />
                  </span>
                </div>
              </div>
              <div className="flex min-w-0 flex-col gap-2 ps-6.5">
                {decision.body ? (
                  <p className="m-0 line-clamp-3 text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground/80">
                    {decision.body}
                  </p>
                ) : null}
                {decision.rejectionReason ? (
                  <WorkMeta className="break-words">Rejected: {decision.rejectionReason}</WorkMeta>
                ) : null}
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
                        disabled={
                          reason.trim() === "" || review.changed || writer.pendingKey !== null
                        }
                        onClick={() => {
                          if (review.selected)
                            void send("reject", decision, review.selected, {
                              reason: reason.trim(),
                            });
                        }}
                      >
                        Confirm rejection
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setTarget(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : target === null &&
                  (decision.state === "proposed" || decision.state === "accepted") ? (
                  <div className="flex flex-wrap gap-2">
                    {decision.state === "proposed" ? (
                      <>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={
                            blocked !== null || writer.pendingKey !== null || current === null
                          }
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
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={blocked !== null}
                        onClick={() => open("supersede", decision)}
                      >
                        Supersede…
                      </Button>
                    )}
                  </div>
                ) : null}
                <WorkFormStatus message={writer.failureFor(rowKey)} />
              </div>
            </div>
          );
        })}
      </div>
      <WorkPager pager={pager} noun="Decisions" />
    </section>
  );
}
