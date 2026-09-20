import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkCommand,
  type ProjectWorkTaskRead,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { CheckCircle2Icon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  asProjectWorkPage,
  asProjectWorkTaskContext,
  projectWorkWritesAvailable,
} from "@t3tools/client-runtime/project-work";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { randomUUID } from "../../lib/utils";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { WorkCard, WorkDataNotice } from "./WorkDataNotice";
import { WorkCommandFailureNotice } from "./WorkCommandFailureNotice";
import { projectWorkCommandFailure, type ProjectWorkCommandFailure } from "./workCommandFailure";
import { TaskLifecycleControls } from "./TaskLifecycleControls";
import {
  makeProjectWorkCriterionUpsertCommand,
  makeProjectWorkTaskCreateCommand,
  makeProjectWorkTaskReadyCommand,
  makeProjectWorkTaskSpecifyCommand,
} from "./workMutations";
import {
  taskNeedsSpecification,
  taskStateLabel,
  taskStateVariant,
  workReadStatus,
} from "./workPresentation";

type TaskCreateCommand = Extract<ProjectWorkCommand, { readonly type: "project-work.task.create" }>;
type TaskReadyCommand = Extract<ProjectWorkCommand, { readonly type: "project-work.task.ready" }>;
type CriterionUpsertCommand = Extract<
  ProjectWorkCommand,
  { readonly type: "project-work.criterion.upsert" }
>;
type TaskSpecifyCommand = Extract<
  ProjectWorkCommand,
  { readonly type: "project-work.task.specify" }
>;

type SpecificationRetry =
  | { readonly stage: "criterion"; readonly criterion: CriterionUpsertCommand }
  | {
      readonly stage: "specification";
      readonly criterion: CriterionUpsertCommand;
      readonly specification: TaskSpecifyCommand;
    }
  | {
      readonly stage: "rebased-specification";
      readonly criterion: CriterionUpsertCommand;
      readonly expectedRevision: number;
      readonly specificationRevision: number;
    };

export function WorkTasks({
  environmentId,
  projectId,
  connected,
  enabled,
  streamAvailable = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly streamAvailable?: boolean;
}) {
  const canWrite = projectWorkWritesAvailable({
    enabled,
    connectionPhase: connected ? "connected" : "disconnected",
  });
  const [showNewTask, setShowNewTask] = useState(false);
  const [offsets, setOffsets] = useState<ReadonlyArray<number>>([0]);
  const [hasMoreByOffset, setHasMoreByOffset] = useState<Readonly<Record<number, boolean>>>({});

  const reportPage = useCallback((offset: number, hasNext: boolean) => {
    setHasMoreByOffset((current) =>
      current[offset] === hasNext ? current : { ...current, [offset]: hasNext },
    );
  }, []);

  const lastOffset = offsets.at(-1) ?? 0;
  const canLoadMore = connected && hasMoreByOffset[lastOffset] === true;
  const loadMore = () => {
    if (!canLoadMore) return;
    setOffsets((current) => {
      const offset = current.at(-1) ?? 0;
      return current.includes(offset + projectWorkEnvironment.pageSize)
        ? current
        : [...current, offset + projectWorkEnvironment.pageSize];
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Tasks</h2>
          <p className="text-sm text-muted-foreground">A bounded view of the project queue.</p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowNewTask((current) => !current)}
          disabled={!canWrite}
          title={!canWrite ? "Reconnect to create a task" : undefined}
        >
          <PlusIcon /> New task
        </Button>
      </div>
      {showNewTask ? (
        <NewTaskForm
          key={`${environmentId}:${projectId}`}
          environmentId={environmentId}
          projectId={projectId}
          canWrite={canWrite}
          onCreated={() => setShowNewTask(false)}
          onCancel={() => setShowNewTask(false)}
        />
      ) : null}
      <div className="flex min-w-0 flex-col gap-3">
        {offsets.map((offset) => (
          <TaskPage
            key={`${environmentId}:${projectId}:tasks:${offset}`}
            environmentId={environmentId}
            projectId={projectId}
            offset={offset}
            connected={connected}
            canWrite={canWrite}
            streamAvailable={streamAvailable}
            onPageState={reportPage}
          />
        ))}
      </div>
      {canLoadMore ? (
        <Button size="sm" variant="outline" className="self-center" onClick={loadMore}>
          Load more tasks
        </Button>
      ) : null}
    </div>
  );
}

function TaskPage({
  environmentId,
  projectId,
  offset,
  connected,
  canWrite,
  streamAvailable,
  onPageState,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly offset: number;
  readonly connected: boolean;
  readonly canWrite: boolean;
  readonly streamAvailable: boolean;
  readonly onPageState: (offset: number, hasNext: boolean) => void;
}) {
  const target = {
    environmentId,
    projectId,
    collection: "tasks" as const,
    offset,
    ...(streamAvailable ? { poll: false } : {}),
  };
  const result = useAtomValue(projectWorkEnvironment.page(target));
  const value = Option.getOrNull(AsyncResult.value(result));
  const page = value === null ? null : asProjectWorkPage<ProjectWorkTaskRead>(value, offset);
  const status = workReadStatus({ connected, hasValue: page !== null });
  const error = result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : null;
  const runPage = useAtomQueryRunner(projectWorkEnvironment.page, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const retryPage = useCallback(
    () => void runPage(target),
    [environmentId, offset, projectId, runPage, streamAvailable],
  );

  useEffect(() => {
    onPageState(offset, page?.hasNext === true);
  }, [offset, onPageState, page?.hasNext]);

  return (
    <>
      {offset === 0 || error !== null ? (
        <WorkDataNotice
          stale={status === "stale"}
          waiting={status === "waiting"}
          offline={!connected}
          error={error}
          onRetry={retryPage}
        />
      ) : null}
      {page && page.records.length > 0 ? (
        page.records.map((task) => (
          <TaskRow
            key={task.taskId}
            task={task}
            environmentId={environmentId}
            projectId={projectId}
            canWrite={canWrite}
            streamAvailable={streamAvailable}
            aggregateRevision={page.revision}
          />
        ))
      ) : page && offset === 0 && page.records.length === 0 ? (
        <WorkCard className="py-10 text-center">
          <p className="font-medium">No durable tasks yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Start with a title. You can add the specification when the shape is clearer.
          </p>
        </WorkCard>
      ) : null}
    </>
  );
}

function NewTaskForm({
  environmentId,
  projectId,
  canWrite,
  onCreated,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly canWrite: boolean;
  readonly onCreated: () => void;
  readonly onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryCommand, setRetryCommand] = useState<TaskCreateCommand | null>(null);
  const mounted = useRef(true);
  const write = useAtomCommand(projectWorkEnvironment.write, { reportFailure: false });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = useCallback(async () => {
    const nextTitle = title.trim();
    if (!canWrite || submitting || nextTitle.length === 0) return;
    setSubmitting(true);
    setError(null);
    const command =
      retryCommand ??
      makeProjectWorkTaskCreateCommand({
        projectId,
        commandId: CommandId.make(randomUUID()),
        taskId: ProjectWorkTaskId.make(randomUUID()),
        title: nextTitle,
        createdAt: new Date().toISOString(),
      });
    setRetryCommand(command);
    const result = await write({ environmentId, input: command });
    if (!mounted.current) return;
    if (result._tag === "Failure") {
      setSubmitting(false);
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    // Settle local form state before closing the successful form.
    setSubmitting(false);
    setRetryCommand(null);
    onCreated();
  }, [canWrite, environmentId, onCreated, projectId, retryCommand, submitting, title, write]);
  const retrySubmit = useCallback(() => void submit(), [submit]);

  return (
    <WorkCard>
      <h3 className="font-medium">New draft task</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        A title is enough to capture work before it is fully specified.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm font-medium">
          Title
          <Input
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Document the release checklist"
            disabled={!canWrite || submitting}
          />
        </label>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!canWrite || submitting || title.trim() === ""}
          >
            {submitting ? "Saving…" : "Create draft"}
          </Button>
        </div>
      </div>
      {error ? (
        <WorkDataNotice stale={false} waiting={false} error={error} onRetry={retrySubmit} />
      ) : null}
    </WorkCard>
  );
}

function TaskRow({
  task,
  environmentId,
  projectId,
  canWrite,
  streamAvailable,
  aggregateRevision,
}: {
  readonly task: ProjectWorkTaskRead;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly canWrite: boolean;
  readonly streamAvailable: boolean;
  readonly aggregateRevision: number | null;
}) {
  const [open, setOpen] = useState(taskNeedsSpecification(task));
  const ready = task.state === "specified";
  const write = useAtomCommand(projectWorkEnvironment.write, { reportFailure: false });
  const [failure, setFailure] = useState<ProjectWorkCommandFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryCommand, setRetryCommand] = useState<TaskReadyCommand | null>(null);
  const [rebasedRevision, setRebasedRevision] = useState<number | null>(null);
  const refreshContext = useAtomQueryRunner(projectWorkEnvironment.taskContext, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const makeReady = useCallback(async () => {
    if (!canWrite || submitting || aggregateRevision === null) return;
    setSubmitting(true);
    setFailure(null);
    const command =
      retryCommand ??
      makeProjectWorkTaskReadyCommand({
        projectId,
        taskId: task.taskId,
        expectedRevision: rebasedRevision ?? aggregateRevision,
        commandId: CommandId.make(randomUUID()),
        updatedAt: new Date().toISOString(),
      });
    setRetryCommand(command);
    const result = await write({ environmentId, input: command });
    if (!mounted.current) return;
    setSubmitting(false);
    if (result._tag === "Failure")
      setFailure(projectWorkCommandFailure(squashAtomCommandFailure(result)));
    else {
      setRetryCommand(null);
      setRebasedRevision(null);
    }
  }, [
    aggregateRevision,
    canWrite,
    environmentId,
    projectId,
    rebasedRevision,
    retryCommand,
    submitting,
    task,
    write,
  ]);
  const retryReady = useCallback(() => void makeReady(), [makeReady]);

  return (
    <WorkCard className="p-0">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 p-4 text-left"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{task.title}</span>
          {task.summary ? (
            <span className="mt-1 block truncate text-sm text-muted-foreground">
              {task.summary}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Badge variant={taskStateVariant(task.state)}>{taskStateLabel(task.state)}</Badge>
          <ChevronDownIcon
            className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open ? (
        <div className="border-t border-border/60 px-4 pt-4 pb-4">
          {taskNeedsSpecification(task) ? (
            <SpecificationForm
              task={task}
              environmentId={environmentId}
              projectId={projectId}
              canWrite={canWrite}
              aggregateRevision={aggregateRevision}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="text-muted-foreground">
                <span>Revision {task.revision}</span>
                {task.specification ? (
                  <span className="ml-3">Spec {task.specification.revision}</span>
                ) : null}
              </div>
              {ready ? (
                <Button
                  size="sm"
                  onClick={() => void makeReady()}
                  disabled={!canWrite || submitting || aggregateRevision === null}
                >
                  <CheckCircle2Icon /> Mark ready
                </Button>
              ) : null}
            </div>
          )}
          {failure ? (
            <WorkCommandFailureNotice
              failure={failure}
              onRetry={retryReady}
              onDiscard={() => {
                setRetryCommand(null);
                setFailure(null);
                setRebasedRevision(null);
              }}
              onRebase={() => {
                void refreshContext({ environmentId, projectId, taskId: task.taskId }).then(
                  (fresh) => {
                    if (fresh._tag !== "Success") return;
                    const context = asProjectWorkTaskContext(fresh.value);
                    if (!context) return;
                    setRetryCommand(null);
                    setRebasedRevision(context.revision);
                    setFailure(null);
                  },
                );
              }}
            />
          ) : null}
          {typeof projectWorkEnvironment.taskContext === "function" ? (
            <TaskLifecycleControls
              environmentId={environmentId}
              projectId={projectId}
              taskId={task.taskId}
              canWrite={canWrite}
              streamAvailable={streamAvailable}
            />
          ) : null}
        </div>
      ) : null}
    </WorkCard>
  );
}

function SpecificationForm({
  task,
  environmentId,
  projectId,
  canWrite,
  aggregateRevision,
}: {
  readonly task: ProjectWorkTaskRead;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly canWrite: boolean;
  readonly aggregateRevision: number | null;
}) {
  const [objective, setObjective] = useState("");
  const [scopeIn, setScopeIn] = useState("");
  const [scopeOut, setScopeOut] = useState("");
  const [criterion, setCriterion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ProjectWorkCommandFailure | null>(null);
  const [retryStage, setRetryStage] = useState<SpecificationRetry | null>(null);
  const mounted = useRef(true);
  const write = useAtomCommand(projectWorkEnvironment.write, { reportFailure: false });
  const refreshContext = useAtomQueryRunner(projectWorkEnvironment.taskContext, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = useCallback(async () => {
    if (!canWrite || submitting || aggregateRevision === null) return;
    if ([objective, scopeIn, scopeOut, criterion].some((value) => value.trim() === "")) return;
    setSubmitting(true);
    setFailure(null);
    const now = new Date().toISOString();
    const currentRetry = retryStage;
    const criterionCommand =
      currentRetry?.criterion ??
      makeProjectWorkCriterionUpsertCommand({
        projectId,
        taskId: task.taskId,
        taskRevision: aggregateRevision,
        criterionId: ProjectWorkCriterionId.make(randomUUID()),
        commandId: CommandId.make(randomUUID()),
        description: criterion.trim(),
        updatedAt: now,
      });

    if (
      currentRetry?.stage !== "specification" &&
      currentRetry?.stage !== "rebased-specification"
    ) {
      setRetryStage({ stage: "criterion", criterion: criterionCommand });
      const criterionResult = await write({ environmentId, input: criterionCommand });
      if (!mounted.current) return;
      if (criterionResult._tag === "Failure") {
        setFailure(projectWorkCommandFailure(squashAtomCommandFailure(criterionResult)));
        setSubmitting(false);
        return;
      }
      const specificationCommand = makeProjectWorkTaskSpecifyCommand({
        projectId,
        taskId: task.taskId,
        criterionId: criterionCommand.criterion.criterionId,
        criterionRevision: criterionResult.value.revision,
        specificationRevision: task.specRevision + 1,
        commandId: CommandId.make(randomUUID()),
        objective: objective.trim(),
        scopeIn: scopeIn.trim(),
        scopeOut: scopeOut.trim(),
        updatedAt: now,
      });
      setRetryStage({
        stage: "specification",
        criterion: criterionCommand,
        specification: specificationCommand,
      });

      const specificationResult = await write({
        environmentId,
        input: specificationCommand,
      });
      if (!mounted.current) return;
      if (specificationResult._tag === "Failure") {
        setFailure(projectWorkCommandFailure(squashAtomCommandFailure(specificationResult)));
      } else {
        setRetryStage(null);
      }
      setSubmitting(false);
      return;
    }

    const specificationCommand =
      currentRetry.stage === "rebased-specification"
        ? makeProjectWorkTaskSpecifyCommand({
            projectId,
            taskId: task.taskId,
            criterionId: currentRetry.criterion.criterion.criterionId,
            criterionRevision: currentRetry.expectedRevision,
            specificationRevision: currentRetry.specificationRevision,
            commandId: CommandId.make(randomUUID()),
            objective: objective.trim(),
            scopeIn: scopeIn.trim(),
            scopeOut: scopeOut.trim(),
            updatedAt: now,
          })
        : currentRetry.specification;
    if (currentRetry.stage === "rebased-specification") {
      setRetryStage({
        stage: "specification",
        criterion: currentRetry.criterion,
        specification: specificationCommand,
      });
    }
    const specificationResult = await write({ environmentId, input: specificationCommand });
    if (!mounted.current) return;
    if (specificationResult._tag === "Failure") {
      setFailure(projectWorkCommandFailure(squashAtomCommandFailure(specificationResult)));
    } else {
      setRetryStage(null);
    }
    setSubmitting(false);
  }, [
    aggregateRevision,
    canWrite,
    criterion,
    environmentId,
    objective,
    projectId,
    retryStage,
    scopeIn,
    scopeOut,
    submitting,
    task,
    write,
  ]);
  const retrySubmit = useCallback(() => void submit(), [submit]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="font-medium">Define this task</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Add the smallest useful specification. You can refine it later with an explicit revision.
        </p>
      </div>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Objective
        <Textarea
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          disabled={!canWrite || submitting}
          placeholder="What outcome should exist?"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          In scope
          <Textarea
            size="sm"
            value={scopeIn}
            onChange={(event) => setScopeIn(event.target.value)}
            disabled={!canWrite || submitting}
            placeholder="What is included?"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Out of scope
          <Textarea
            size="sm"
            value={scopeOut}
            onChange={(event) => setScopeOut(event.target.value)}
            disabled={!canWrite || submitting}
            placeholder="What is explicitly excluded?"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Required criterion
        <Input
          value={criterion}
          onChange={(event) => setCriterion(event.target.value)}
          disabled={!canWrite || submitting}
          placeholder="How will we know it is done?"
        />
      </label>
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => void submit()}
          disabled={
            !canWrite ||
            aggregateRevision === null ||
            submitting ||
            [objective, scopeIn, scopeOut, criterion].some((value) => value.trim() === "")
          }
        >
          {submitting ? "Saving…" : "Save specification"}
        </Button>
      </div>
      {failure ? (
        <WorkCommandFailureNotice
          failure={failure}
          onRetry={retrySubmit}
          onDiscard={() => {
            setRetryStage(null);
            setFailure(null);
          }}
          onRebase={() => {
            void refreshContext({ environmentId, projectId, taskId: task.taskId }).then((fresh) => {
              if (fresh._tag !== "Success") return;
              const context = asProjectWorkTaskContext(fresh.value);
              if (!context) return;
              const criterionCommand = retryStage?.criterion;
              if (!criterionCommand) return;
              if (retryStage.stage === "criterion") {
                setRetryStage({
                  stage: "criterion",
                  criterion: {
                    ...criterionCommand,
                    commandId: CommandId.make(randomUUID()),
                    expectedRevision: context.revision,
                    criterion: {
                      ...criterionCommand.criterion,
                      updatedAt: new Date().toISOString(),
                    },
                    updatedAt: new Date().toISOString(),
                  },
                });
                setFailure(null);
                return;
              }
              setRetryStage({
                stage: "rebased-specification",
                criterion: criterionCommand,
                expectedRevision: context.revision,
                specificationRevision: context.task.specRevision + 1,
              });
              setFailure(null);
            });
          }}
        />
      ) : null}
    </div>
  );
}
