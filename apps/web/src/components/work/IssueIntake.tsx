import {
  CommandId,
  ProjectWorkTaskId,
  type EnvironmentId,
  type ProjectId,
  type ProjectIssueIntakeRead,
  type ProjectWorkIssueRefineCommand,
  type ProjectWorkTaskRead,
} from "@t3tools/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { WorkCard, WorkDataNotice } from "./WorkDataNotice";
import { projectWorkCommandFailure, type ProjectWorkCommandFailure } from "./workCommandFailure";
import { taskStateLabel, taskStateVariant } from "./workPresentation";

type IssueRead = typeof ProjectIssueIntakeRead.Type;

export interface IssueIntakeProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issues: ReadonlyArray<IssueRead>;
  readonly tasks: ReadonlyArray<ProjectWorkTaskRead>;
  readonly projectRevision: number | null;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly hasMore: boolean;
  readonly onLoadMore: () => void;
  readonly onRefine: (command: ProjectWorkIssueRefineCommand) => Promise<void>;
  readonly onInvestigate: (issue: IssueRead) => Promise<void>;
}

type TargetKind = ProjectWorkIssueRefineCommand["target"]["kind"];
type DeliverableKind = Extract<
  ProjectWorkIssueRefineCommand["target"],
  { readonly kind: "new-task" }
>["deliverableKind"];
type Draft = {
  readonly kind: TargetKind;
  readonly title: string;
  readonly body: string;
  readonly deliverableKind: DeliverableKind;
  readonly taskId: ProjectWorkTaskId | null;
  readonly taskRevision: number | null;
  readonly projectRevision: number;
  readonly issueRevision: number;
};
const deliverables: ReadonlyArray<DeliverableKind> = [
  "code",
  "research",
  "plan",
  "review",
  "reminder",
  "non-code",
];
const knownTaskStates = new Set([
  "draft",
  "specified",
  "ready",
  "in-progress",
  "blocked",
  "in-review",
  "completed",
  "failed",
  "canceled",
]);
const knownRevision = (revision: number | null) =>
  revision !== null && Number.isSafeInteger(revision) && revision >= 0;
const canLinkTask = (task: ProjectWorkTaskRead, projectId: ProjectId) =>
  task.projectId === projectId &&
  knownRevision(task.revision) &&
  knownTaskStates.has(task.state) &&
  task.state !== "completed" &&
  task.state !== "canceled";
const sourceKey = (issue: IssueRead) =>
  JSON.stringify([
    issue.recordId,
    issue.identity.host,
    issue.identity.repositoryNodeId,
    issue.identity.issueNodeId,
    issue.identity.number,
  ]);

/** Source records stay readable when their environment cannot accept commands. */
export function IssueIntake(props: IssueIntakeProps) {
  return <IntakeQueue key={JSON.stringify([props.environmentId, props.projectId])} {...props} />;
}

function IntakeQueue(props: IssueIntakeProps) {
  const unavailable = !props.supported
    ? "Issue refinement is unavailable on this server."
    : !props.enabled
      ? "Enable Project Work to refine issues."
      : !props.connected
        ? "Reconnect to refine issues."
        : !knownRevision(props.projectRevision)
          ? "Waiting for the current project revision before refining issues."
          : null;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Issue intake</h2>
        <p className="text-sm text-muted-foreground">
          GitHub issues ready to develop into project work.
        </p>
      </div>
      <WorkDataNotice stale={!props.connected && props.issues.length > 0} waiting={false} />
      {unavailable ? <p className="text-sm text-muted-foreground">{unavailable}</p> : null}
      {props.issues.length === 0 ? (
        <WorkCard>
          <p className="text-sm text-muted-foreground">No issues in this intake view.</p>
        </WorkCard>
      ) : (
        <ul className="divide-y divide-border/70 rounded-xl border border-border/70 bg-card/50">
          {props.issues.map((issue) => (
            <IssueRow
              key={sourceKey(issue)}
              {...props}
              issue={issue}
              canWrite={unavailable === null}
            />
          ))}
        </ul>
      )}
      {props.hasMore ? (
        <Button
          size="sm"
          variant="outline"
          className="self-center"
          disabled={!props.connected || !props.supported}
          onClick={props.onLoadMore}
        >
          Load more issues
        </Button>
      ) : null}
    </div>
  );
}

function IssueRow({
  issue,
  canWrite,
  ...props
}: IssueIntakeProps & { readonly issue: IssueRead; readonly canWrite: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [command, setCommand] = useState<ProjectWorkIssueRefineCommand | null>(null);
  const [failure, setFailure] = useState<ProjectWorkCommandFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [investigated, setInvestigated] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(false);
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sourceSupported =
    issue.projectId === props.projectId &&
    (issue.status === "open" || issue.status === "closed") &&
    knownRevision(issue.revision);
  const unlinked = !issue.taskId && !issue.missionId;
  const canRefine = canWrite && sourceSupported && unlinked && !saved;
  const linkedTask = props.tasks.find(
    (task) => task.taskId === issue.taskId && task.projectId === props.projectId,
  );
  const canInvestigate =
    canWrite &&
    sourceSupported &&
    linkedTask !== undefined &&
    canLinkTask(linkedTask, props.projectId) &&
    linkedTask.state !== "completed" &&
    linkedTask.state !== "canceled" &&
    !investigated;
  const selectedTask = props.tasks.find(
    (task) => task.taskId === draft?.taskId && task.projectId === props.projectId,
  );
  const changed =
    draft !== null &&
    (draft.projectRevision !== props.projectRevision ||
      draft.issueRevision !== issue.revision ||
      (draft.kind === "existing-task" && draft.taskRevision !== selectedTask?.revision));
  const href =
    issue.identity.host === "github.com" &&
    /^[A-Za-z0-9][A-Za-z0-9-]*\/[\w.-]+$/.test(issue.repositoryName) &&
    ![".", ".."].includes(issue.repositoryName.split("/")[1] ?? "") &&
    Number.isSafeInteger(issue.identity.number) &&
    issue.identity.number > 0
      ? `https://github.com/${issue.repositoryName.split("/").map(encodeURIComponent).join("/")}/issues/${issue.identity.number}`
      : null;
  const begin = () => {
    if (!canRefine || props.projectRevision === null) return;
    setDraft({
      kind: "new-task",
      title: issue.title,
      body: issue.body,
      deliverableKind: "code",
      taskId: null,
      taskRevision: null,
      projectRevision: props.projectRevision,
      issueRevision: issue.revision,
    });
    setFailure(null);
  };
  const submit = async () => {
    if (lock.current || !canRefine || draft === null || failure?.staleRevision) return;
    let next = command;
    if (next === null) {
      const title = draft.title.trim();
      if (
        (draft.kind !== "existing-task" &&
          (title.length === 0 || title.length > 4_000 || draft.body.length > 32_000)) ||
        (draft.kind === "existing-task" &&
          (draft.taskId === null ||
            !knownRevision(draft.taskRevision) ||
            selectedTask === undefined ||
            !canLinkTask(selectedTask, props.projectId)))
      )
        return;
      const target: ProjectWorkIssueRefineCommand["target"] =
        draft.kind === "existing-task" && draft.taskId !== null && draft.taskRevision !== null
          ? {
              kind: "existing-task",
              taskId: draft.taskId,
              expectedTaskRevision: draft.taskRevision,
            }
          : draft.kind === "mission"
            ? { kind: "mission", title, objective: draft.body }
            : {
                kind: "new-task",
                taskId: ProjectWorkTaskId.make(randomUUID()),
                title,
                summary: draft.body,
                deliverableKind: draft.deliverableKind,
              };
      next = {
        type: "project-work.issue.refine",
        commandId: CommandId.make(randomUUID()),
        projectId: props.projectId,
        expectedRevision: draft.projectRevision,
        issueRecordId: issue.recordId,
        expectedIssueRevision: draft.issueRevision,
        target,
        refinedAt: new Date().toISOString(),
      };
      setCommand(next);
    }
    lock.current = true;
    setPending(true);
    setFailure(null);
    try {
      await props.onRefine(next);
      if (mounted.current) {
        setSaved(true);
        setDraft(null);
        setCommand(null);
      }
    } catch (error) {
      if (mounted.current) setFailure(projectWorkCommandFailure(error));
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const refreshRevisions = () => {
    if (
      lock.current ||
      !canRefine ||
      draft === null ||
      props.projectRevision === null ||
      (draft.kind === "existing-task" &&
        (selectedTask === undefined || !canLinkTask(selectedTask, props.projectId)))
    )
      return;
    setDraft({
      ...draft,
      projectRevision: props.projectRevision,
      issueRevision: issue.revision,
      taskRevision: selectedTask?.revision ?? null,
    });
    setCommand(null);
    setFailure(null);
  };
  const investigate = async () => {
    if (lock.current || !canInvestigate) return;
    lock.current = true;
    setPending(true);
    setFailure(null);
    try {
      await props.onInvestigate(issue);
      if (mounted.current) setInvestigated(true);
    } catch (error) {
      if (mounted.current) setFailure(projectWorkCommandFailure(error));
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const validDraft =
    draft !== null &&
    (draft.kind === "existing-task"
      ? draft.taskId !== null &&
        selectedTask !== undefined &&
        canLinkTask(selectedTask, props.projectId) &&
        knownRevision(draft.taskRevision)
      : draft.title.trim().length > 0 &&
        draft.title.trim().length <= 4_000 &&
        draft.body.length <= 32_000);
  return (
    <li className="min-w-0 p-4">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {href ? (
              <a
                className="break-all rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {issue.repositoryName} #{issue.identity.number}
              </a>
            ) : (
              <span className="break-all">
                {issue.identity.host} · {issue.repositoryName} #{issue.identity.number}
              </span>
            )}
            <Badge
              variant="outline"
              className="h-auto min-h-5.5 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
            >
              GitHub: {issue.status}
            </Badge>
          </div>
          <h3 className="mt-1 break-words text-sm font-medium [overflow-wrap:anywhere]">
            {issue.title}
          </h3>
          <p className="mt-1 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
            Observed {issue.observedAt} · Source revision {issue.sourceRevision}
          </p>
          {issue.body ? (
            <div className="mt-2">
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {expanded ? issue.body : issue.body.slice(0, 360)}
                {!expanded && issue.body.length > 360 ? "…" : ""}
              </p>
              {issue.body.length > 360 ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded ? "Show less" : "Read issue body"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {issue.taskId ? (
            <p className="mt-2 break-words text-sm [overflow-wrap:anywhere]">
              Linked task: {linkedTask?.title ?? issue.taskId}{" "}
              {linkedTask ? (
                <Badge
                  variant={taskStateVariant(linkedTask.state)}
                  className="h-auto min-h-5.5 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                >
                  {taskStateLabel(linkedTask.state)}
                </Badge>
              ) : null}
            </p>
          ) : issue.missionId ? (
            <p className="mt-2 break-words text-sm [overflow-wrap:anywhere]">
              Linked mission: {issue.missionId}
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              {saved
                ? "Refinement saved. Waiting for the linked work to refresh."
                : "Unlinked · Refine this issue before starting investigation."}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {unlinked ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canRefine || pending || draft !== null}
              onClick={begin}
            >
              Refine issue
            </Button>
          ) : issue.taskId ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canInvestigate || pending}
              onClick={() => void investigate()}
            >
              {pending && draft === null
                ? "Starting…"
                : investigated
                  ? "Investigation requested"
                  : "Start investigation"}
            </Button>
          ) : null}
        </div>
      </div>
      {!sourceSupported ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This source state is read-only in this client.
        </p>
      ) : null}
      {draft ? (
        <form
          className="mt-4 flex min-w-0 flex-col gap-3 border-t border-border/70 pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm font-medium">Develop #{issue.identity.number} into work</p>
          <fieldset disabled={pending || command !== null} className="flex min-w-0 flex-col gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-xs" htmlFor={`${id}-target`}>
              Refine into
              <select
                id={`${id}-target`}
                className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                value={draft.kind}
                onChange={(event) => {
                  const kind = event.target.value;
                  if (kind === "new-task" || kind === "existing-task" || kind === "mission")
                    setDraft({ ...draft, kind });
                }}
              >
                <option value="new-task">New draft task</option>
                <option value="existing-task">Existing task</option>
                <option value="mission">Draft mission</option>
              </select>
            </label>
            {draft.kind === "existing-task" ? (
              <label className="flex min-w-0 flex-col gap-1 text-xs" htmlFor={`${id}-task`}>
                Task
                <select
                  id={`${id}-task`}
                  className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  value={draft.taskId ?? ""}
                  onChange={(event) => {
                    const task = props.tasks.find(
                      (candidate) =>
                        candidate.taskId === event.target.value &&
                        canLinkTask(candidate, props.projectId),
                    );
                    setDraft({
                      ...draft,
                      taskId: task?.taskId ?? null,
                      taskRevision: task?.revision ?? null,
                    });
                  }}
                >
                  <option value="">Choose a task</option>
                  {props.tasks
                    .filter((task) => canLinkTask(task, props.projectId))
                    .map((task) => (
                      <option key={task.taskId} value={task.taskId}>
                        {task.title} · {taskStateLabel(task.state)}
                      </option>
                    ))}
                </select>
              </label>
            ) : (
              <>
                <label className="flex min-w-0 flex-col gap-1 text-xs" htmlFor={`${id}-title`}>
                  Title
                  <Input
                    nativeInput
                    id={`${id}-title`}
                    maxLength={4_000}
                    value={draft.title}
                    onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  />
                </label>
                {draft.kind === "new-task" ? (
                  <label
                    className="flex min-w-0 flex-col gap-1 text-xs"
                    htmlFor={`${id}-deliverable`}
                  >
                    Deliverable
                    <select
                      id={`${id}-deliverable`}
                      className="h-8 rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                      value={draft.deliverableKind}
                      onChange={(event) => {
                        const kind = deliverables.find((value) => value === event.target.value);
                        if (kind) setDraft({ ...draft, deliverableKind: kind });
                      }}
                    >
                      {deliverables.map((kind) => (
                        <option key={kind} value={kind}>
                          {taskStateLabel(kind)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="flex min-w-0 flex-col gap-1 text-xs" htmlFor={`${id}-body`}>
                  {draft.kind === "mission" ? "Objective" : "Summary"}
                  <Textarea
                    id={`${id}-body`}
                    maxLength={32_000}
                    className="max-h-64 overflow-y-auto"
                    value={draft.body}
                    onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                  />
                </label>
              </>
            )}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            Reviewing project revision {draft.projectRevision}, issue revision {draft.issueRevision}
            {draft.kind === "existing-task" && draft.taskRevision !== null
              ? `, task revision ${draft.taskRevision}`
              : ""}
            . Refinement creates a link; it does not start an agent.
          </p>
          {changed ? (
            <p role="status" className="text-xs text-warning-foreground">
              The saved records changed while you were editing. Your draft and expected revisions
              are retained. Review the current source and task before using current revisions.
            </p>
          ) : null}
          {failure ? (
            <div role="alert" className="flex flex-col gap-2">
              <WorkDataNotice stale={false} waiting={false} error={failure.message} />
              <p className="text-xs text-muted-foreground">
                {failure.staleRevision
                  ? "Your draft is retained. Review the current source and selected task before submitting a new command."
                  : "The result is uncertain. Retry sends the exact same command. Review the linked work before editing this draft again."}
              </p>
              {failure.staleRevision ? (
                <Button
                  size="sm-multiline"
                  variant="outline"
                  className="max-w-full self-start text-left"
                  disabled={!canRefine || pending}
                  onClick={refreshRevisions}
                >
                  I reviewed the changes · Use current revisions
                </Button>
              ) : (
                <Button
                  size="sm-multiline"
                  variant="ghost"
                  className="max-w-full self-start text-left"
                  disabled={pending || !canRefine}
                  onClick={() => {
                    setCommand(null);
                    setFailure(null);
                  }}
                >
                  I checked the result · Edit draft
                </Button>
              )}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={
                !canRefine ||
                pending ||
                (command === null && !validDraft) ||
                failure?.staleRevision === true
              }
            >
              {pending ? "Saving…" : command ? "Retry exact command" : "Save refinement"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || (command !== null && !failure?.staleRevision)}
              onClick={() => {
                setDraft(null);
                setCommand(null);
                setFailure(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : failure ? (
        <div role="alert" className="mt-3">
          <WorkDataNotice stale={false} waiting={false} error={failure.message} />
          <p className="mt-1 text-xs text-muted-foreground">
            Check linked work before requesting investigation again.
          </p>
        </div>
      ) : null}
    </li>
  );
}
