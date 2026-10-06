import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  ProjectWorkTask,
  ProjectIssueIntakeRead,
  ProjectTeamRecord,
  type ProjectWorkWriteIntent,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkCommand,
  type ProjectWorkTaskRead,
  type ProjectWorkWriteResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { CheckCircle2Icon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

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
import {
  TaskVerification,
  TaskVerificationDraftContext,
  TaskVerificationAccessContext,
} from "./TaskVerification";
import { GuidedTaskDetail } from "./GuidedTaskDetail";
import { IssueIntake } from "./IssueIntake";
import { WorkTeamFoundation, type WorkTeamFoundationView } from "./WorkTeamFoundation";
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

const knownTask = Schema.is(ProjectWorkTask);
const knownIssue = Schema.is(ProjectIssueIntakeRead);
const knownFoundationRecord = Schema.is(ProjectTeamRecord);

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

type LegacyWrite = (
  command: ProjectWorkCommand,
  continuation?: { readonly fromRevision: number; readonly toRevision: number },
) => Promise<ProjectWorkWriteResult>;

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

import type { GuidedTaskDraftStore } from "./guidedTaskDraft";

type WorkTasksProps = {
  readonly verificationDrafts?: GuidedTaskDraftStore;
  readonly verifyVerificationAccess?: () => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly streamAvailable?: boolean;
  readonly teamReadSupported?: boolean;
  readonly guidedWritesSupported?: boolean;
  readonly targetTaskId?: ProjectWorkTaskId;
};

export function WorkTasks(props: WorkTasksProps) {
  return (
    <TaskVerificationAccessContext.Provider value={props.verifyVerificationAccess ?? null}>
      <TaskVerificationDraftContext.Provider value={props.verificationDrafts ?? null}>
        <WorkTasksContent {...props} />
      </TaskVerificationDraftContext.Provider>
    </TaskVerificationAccessContext.Provider>
  );
}

function WorkTasksContent(props: WorkTasksProps) {
  return props.teamReadSupported ? (
    <WorkTeamFoundation
      environmentId={props.environmentId}
      projectId={props.projectId}
      connected={props.connected}
      enabled={props.enabled}
      supported={props.teamReadSupported === true}
    >
      {(foundation) => (
        <WorkTaskQueue
          key={JSON.stringify([props.environmentId, props.projectId])}
          {...props}
          foundation={foundation}
        />
      )}
    </WorkTeamFoundation>
  ) : (
    <WorkTaskQueue key={JSON.stringify([props.environmentId, props.projectId])} {...props} />
  );
}

function WorkTaskQueue({
  environmentId,
  projectId,
  connected,
  enabled,
  streamAvailable = false,
  guidedWritesSupported = false,
  targetTaskId,
  foundation,
}: WorkTasksProps & { readonly foundation?: WorkTeamFoundationView }) {
  const canWrite = projectWorkWritesAvailable({
    enabled,
    connectionPhase: connected ? "connected" : "disconnected",
  });
  const [showNewTask, setShowNewTask] = useState(false);
  const [offsets, setOffsets] = useState<ReadonlyArray<number>>([0]);
  const [hasMoreByOffset, setHasMoreByOffset] = useState<Readonly<Record<number, boolean>>>({});

  const registry = useContext(RegistryContext);
  const write = useAtomCommand(projectWorkEnvironment.write, { reportFailure: false });
  const refreshContext = useAtomQueryRunner(projectWorkEnvironment.taskContext, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const [, pageChanged] = useState(0);
  const notifyPage = useCallback(() => pageChanged((value) => value + 1), []);
  const mounted = useRef(true);
  const access = useRef({ connected, enabled, guidedWritesSupported });
  useLayoutEffect(() => {
    access.current = { connected, enabled, guidedWritesSupported };
  }, [connected, enabled, guidedWritesSupported]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const loadedPages = offsets.map((offset) => {
    const result = registry.get(
      projectWorkEnvironment.page({
        environmentId,
        projectId,
        collection: "tasks",
        offset,
        ...(streamAvailable ? { poll: false } : {}),
      }),
    );
    const page = asProjectWorkPage<ProjectWorkTaskRead>(
      Option.getOrNull(AsyncResult.value(result)),
      offset,
    );
    return { result, page };
  });
  const tasks = loadedPages.flatMap(({ page }) => page.records);
  const taskPagesCurrent =
    foundation !== undefined &&
    offsets.length <= 16 &&
    loadedPages.every(
      ({ result, page }) =>
        result._tag === "Success" &&
        !result.waiting &&
        page.revision === foundation.snapshot.revision &&
        page.records.every((task) => task.projectId === projectId && knownTask(task)),
    ) &&
    new Set(tasks.map((task) => task.taskId)).size === tasks.length;
  const guidedCanWrite =
    canWrite && guidedWritesSupported && foundation?.current === true && taskPagesCurrent;
  const runTaskPage = useAtomQueryRunner(projectWorkEnvironment.page, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const refresh = () => {
    foundation?.refresh();
    for (const offset of offsets)
      void runTaskPage({
        environmentId,
        projectId,
        collection: "tasks",
        offset,
        ...(streamAvailable ? { poll: false } : {}),
      });
  };
  const reloaded = useRef<string | null>(null);
  const foundationRevision = foundation?.snapshot.revision;
  const foundationCurrent = foundation?.current === true;
  useEffect(() => {
    if (!foundationCurrent || taskPagesCurrent) return;
    const key = JSON.stringify([foundationRevision, offsets]);
    if (reloaded.current === key) return;
    reloaded.current = key;
    // Keep mounted drafts while reloading every displayed task page at the current revision.
    for (const offset of offsets)
      void runTaskPage({
        environmentId,
        projectId,
        collection: "tasks",
        offset,
        ...(streamAvailable ? { poll: false } : {}),
      });
  }, [
    foundationCurrent,
    foundationRevision,
    taskPagesCurrent,
    offsets,
    runTaskPage,
    environmentId,
    projectId,
    streamAvailable,
  ]);
  const writeLock = useRef(false);
  const acceptedRevision = useRef<number | null>(null);
  const investigations = useRef(
    new Map<
      string,
      Extract<ProjectWorkWriteIntent, { readonly type: "project-team.investigation.start" }>
    >(),
  );
  const verifyQueue = (continuationRevision?: number) => {
    if (!mounted.current || !access.current.connected || !access.current.enabled)
      throw { code: "unavailable", message: "Reconnect before making changes." };
    if (!foundation && access.current.guidedWritesSupported)
      throw { code: "unavailable", message: "Reconnect to a server that supports guided changes." };
    const fresh = foundation?.verify() ?? null;
    const pages = offsets.map((offset) =>
      registry.get(
        projectWorkEnvironment.page({
          environmentId,
          projectId,
          collection: "tasks",
          offset,
          ...(streamAvailable ? { poll: false } : {}),
        }),
      ),
    );
    const currentTasks = pages.flatMap(
      (result) =>
        asProjectWorkPage<ProjectWorkTaskRead>(Option.getOrNull(AsyncResult.value(result))).records,
    );
    if (
      offsets.length > 16 ||
      !pages.every((result) => {
        const page = asProjectWorkPage<ProjectWorkTaskRead>(
          Option.getOrNull(AsyncResult.value(result)),
        );
        return (
          result._tag === "Success" &&
          !result.waiting &&
          (fresh === null || page.revision !== null) &&
          page.revision === (fresh?.revision ?? loadedPages[0]?.page.revision) &&
          page.records.every((task) => task.projectId === projectId && knownTask(task))
        );
      }) ||
      new Set(currentTasks.map((task) => task.taskId)).size !== currentTasks.length
    )
      throw {
        code: "stale-revision",
        message: "Project work changed. Refresh and review the current revisions.",
      };
    const revision =
      fresh?.revision ?? asProjectWorkPage(Option.getOrNull(AsyncResult.value(pages[0]!))).revision;
    if (
      writeLock.current ||
      (acceptedRevision.current !== null &&
        revision !== null &&
        acceptedRevision.current >= revision &&
        !(continuationRevision === acceptedRevision.current && revision === continuationRevision))
    )
      throw { code: "stale-revision", message: "Wait for the saved project work to refresh." };
    return fresh;
  };
  const send = async (intent: ProjectWorkWriteIntent) => {
    if (!access.current.guidedWritesSupported)
      throw { code: "unavailable", message: "This server does not support guided changes." };
    const fresh = verifyQueue();
    if (
      !fresh ||
      fresh.revision === null ||
      intent.projectId !== projectId ||
      intent.expectedRevision !== fresh.revision
    )
      throw {
        code: "stale-revision",
        message: "Project work changed. Refresh and review the current revisions.",
      };
    writeLock.current = true;
    try {
      const result = await write({ environmentId, input: intent });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      acceptedRevision.current = Math.max(acceptedRevision.current ?? -1, fresh.revision);
    } finally {
      writeLock.current = false;
    }
  };
  const writeLegacy: LegacyWrite = async (command, continuation) => {
    const fresh = verifyQueue(continuation?.fromRevision);
    const latestPages = offsets.map((offset) =>
      asProjectWorkPage<ProjectWorkTaskRead>(
        Option.getOrNull(
          AsyncResult.value(
            registry.get(
              projectWorkEnvironment.page({
                environmentId,
                projectId,
                collection: "tasks",
                offset,
                ...(streamAvailable ? { poll: false } : {}),
              }),
            ),
          ),
        ),
      ),
    );
    const revision = fresh?.revision ?? latestPages[0]?.revision;
    const taskId = "taskId" in command ? command.taskId : undefined;
    const task = latestPages.flatMap((page) => page.records).find((item) => item.taskId === taskId);
    const memberships =
      fresh?.records.filter(
        (record) =>
          record.kind === "task-membership" && "taskId" in record && record.taskId === taskId,
      ) ?? [];
    const member = memberships[0];
    if (
      command.projectId !== projectId ||
      !task ||
      !knownTask(task) ||
      (fresh &&
        !(
          memberships.length === 0 ||
          (memberships.length === 1 &&
            member &&
            knownFoundationRecord(member) &&
            member.kind === "task-membership" &&
            member.executionKind === "legacy" &&
            member.status === "active")
        )) ||
      !("expectedRevision" in command) ||
      !(
        command.expectedRevision === revision ||
        (continuation &&
          revision === continuation.fromRevision &&
          command.expectedRevision === continuation.toRevision &&
          continuation.toRevision > continuation.fromRevision)
      )
    )
      throw {
        code: "stale-revision",
        message: "Refresh the current legacy task before making changes.",
      };
    writeLock.current = true;
    try {
      const result = await write({ environmentId, input: command });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      acceptedRevision.current = Math.max(acceptedRevision.current ?? -1, command.expectedRevision);
      return result.value;
    } finally {
      writeLock.current = false;
    }
  };
  const create = async (command: TaskCreateCommand) => {
    const fresh = verifyQueue();
    if (command.projectId !== projectId || writeLock.current)
      throw { code: "unavailable", message: "Review the current project before creating a task." };
    writeLock.current = true;
    try {
      const result = await write({ environmentId, input: command });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const revision = fresh?.revision ?? loadedPages[0]?.page.revision;
      if (revision !== null && revision !== undefined)
        acceptedRevision.current = Math.max(acceptedRevision.current ?? -1, revision);
    } finally {
      writeLock.current = false;
    }
  };
  const issues =
    foundation?.snapshot.records.flatMap((record) => (knownIssue(record) ? [record] : [])) ?? [];
  const investigate = async (issue: typeof ProjectIssueIntakeRead.Type) => {
    if (!foundation) throw { code: "unavailable", message: "The guided view is unavailable." };
    const fresh = foundation.verify();
    const source = fresh?.records.find((record) => record.recordId === issue.recordId);
    if (
      !source ||
      !knownIssue(source) ||
      source.taskId === undefined ||
      source.revision !== issue.revision ||
      source.taskId !== issue.taskId ||
      (source.status !== "open" && source.status !== "closed")
    )
      throw {
        code: "stale-revision",
        message: "Refresh the linked issue before starting investigation.",
      };
    const target = {
      environmentId,
      projectId,
      taskId: source.taskId,
      ...(streamAvailable ? { poll: false } : {}),
    };
    const result = await refreshContext(target);
    if (!mounted.current || result._tag !== "Success")
      throw { code: "unavailable", message: "Could not load the current linked task." };
    const context = asProjectWorkTaskContext(result.value);
    const memberships = fresh.records.filter(
      (record) =>
        record.kind === "task-membership" && "taskId" in record && record.taskId === source.taskId,
    );
    const member = memberships.length === 1 ? memberships[0] : undefined;
    if (
      !context ||
      context.projectId !== projectId ||
      context.task.projectId !== projectId ||
      context.task.taskId !== source.taskId ||
      context.revision !== fresh.revision ||
      !knownTask(context.task) ||
      !member ||
      !knownFoundationRecord(member) ||
      member.kind !== "task-membership" ||
      member.executionKind === "legacy" ||
      member.status !== "active" ||
      (member.controlState !== undefined && member.controlState !== "active") ||
      context.task.state === "completed" ||
      context.task.state === "canceled"
    )
      throw {
        code: "invalid-state",
        message: "Review the current task before starting investigation.",
      };
    const key = JSON.stringify([source.recordId, source.taskId]);
    const command = investigations.current.get(key) ?? {
      type: "project-team.investigation.start" as const,
      commandId: CommandId.make(randomUUID()),
      projectId,
      taskId: source.taskId,
      expectedRevision: fresh.revision ?? 0,
      expectedTaskRevision: context.task.revision,
      issueRecordId: source.recordId,
      expectedIssueRevision: source.revision,
      objective: source.body.trim() || source.title,
      outputDescriptions: ["Findings, sources, and unresolved decisions"],
    };
    investigations.current.set(key, command);
    await send(command);
    investigations.current.delete(key);
    if (mounted.current) refresh();
  };

  const queueCanWrite = foundation
    ? canWrite && foundation.current && taskPagesCurrent
    : canWrite && !guidedWritesSupported;

  const reportPage = useCallback((offset: number, hasNext: boolean) => {
    setHasMoreByOffset((current) =>
      current[offset] === hasNext ? current : { ...current, [offset]: hasNext },
    );
  }, []);

  const lastOffset = offsets.at(-1) ?? 0;
  const canLoadMore = offsets.length < 16 && connected && hasMoreByOffset[lastOffset] === true;
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
      {foundation ? (
        <IssueIntake
          environmentId={environmentId}
          projectId={projectId}
          issues={issues}
          tasks={tasks}
          projectRevision={guidedCanWrite ? foundation.snapshot.revision : null}
          connected={connected}
          enabled={enabled}
          supported={guidedWritesSupported}
          hasMore={false}
          onLoadMore={refresh}
          onRefine={async (command) => {
            await send(command);
            if (mounted.current) refresh();
          }}
          onInvestigate={investigate}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Tasks</h2>
          <p className="text-sm text-muted-foreground">A bounded view of the project queue.</p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowNewTask((current) => !current)}
          disabled={!queueCanWrite}
          title={!queueCanWrite ? "Reconnect to create a task" : undefined}
        >
          <PlusIcon /> New task
        </Button>
      </div>
      {showNewTask ? (
        <NewTaskForm
          key={`${environmentId}:${projectId}`}
          projectId={projectId}
          canWrite={queueCanWrite}
          onCreate={create}
          onCreated={() => setShowNewTask(false)}
          onCancel={() => setShowNewTask(false)}
        />
      ) : null}
      {targetTaskId && foundation ? (
        <LinkedTaskDetail
          key={targetTaskId}
          environmentId={environmentId}
          projectId={projectId}
          taskId={targetTaskId}
          foundation={foundation}
          canWrite={guidedCanWrite}
          access={{ connected, enabled, supported: guidedWritesSupported }}
          streamAvailable={streamAvailable}
          onWrite={send}
        />
      ) : targetTaskId ? (
        <p>The linked task requires current team records on this environment.</p>
      ) : null}
      <div className="flex min-w-0 flex-col gap-3">
        {offsets.map((offset) => (
          <TaskPage
            key={`${environmentId}:${projectId}:tasks:${offset}`}
            environmentId={environmentId}
            projectId={projectId}
            offset={offset}
            connected={connected}
            canWrite={queueCanWrite}
            streamAvailable={streamAvailable}
            onPageState={reportPage}
            onPageData={notifyPage}
            onLegacyWrite={writeLegacy}
            guidedAccess={{ connected, enabled, supported: guidedWritesSupported }}
            {...(foundation ? { foundation, guidedCanWrite, onGuidedWrite: send } : {})}
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
  onPageData,
  onLegacyWrite,
  guidedAccess,
  foundation,
  guidedCanWrite = false,
  onGuidedWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly offset: number;
  readonly connected: boolean;
  readonly canWrite: boolean;
  readonly streamAvailable: boolean;
  readonly onPageState: (offset: number, hasNext: boolean) => void;
  readonly onPageData: () => void;
  readonly onLegacyWrite: LegacyWrite;
  readonly guidedAccess: {
    readonly connected: boolean;
    readonly enabled: boolean;
    readonly supported: boolean;
  };
  readonly foundation?: WorkTeamFoundationView;
  readonly guidedCanWrite?: boolean;
  readonly onGuidedWrite?: (intent: ProjectWorkWriteIntent) => Promise<void>;
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

  useEffect(onPageData, [result, onPageData]);

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
            onLegacyWrite={onLegacyWrite}
            guidedAccess={guidedAccess}
            {...(foundation ? { foundation, guidedCanWrite, onGuidedWrite } : {})}
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
  projectId,
  canWrite,
  onCreate,
  onCreated,
  onCancel,
}: {
  readonly projectId: ProjectId;
  readonly canWrite: boolean;
  readonly onCreate: (command: TaskCreateCommand) => Promise<void>;
  readonly onCreated: () => void;
  readonly onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryCommand, setRetryCommand] = useState<TaskCreateCommand | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = useCallback(async () => {
    const nextTitle = title.trim();
    if (!mounted.current || busy.current || !canWrite || submitting || nextTitle.length === 0)
      return;
    busy.current = true;
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
    try {
      await onCreate(command);
    } catch (error) {
      busy.current = false;
      if (!mounted.current) return;
      setSubmitting(false);
      setError(projectWorkCommandFailure(error).message);
      return;
    }
    busy.current = false;
    if (!mounted.current) return;
    // Settle local form state before closing the successful form.
    setSubmitting(false);
    setRetryCommand(null);
    onCreated();
  }, [canWrite, onCreate, onCreated, projectId, retryCommand, submitting, title]);
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
  guidedAccess,
  onLegacyWrite,
  foundation,
  guidedCanWrite = false,
  onGuidedWrite,
}: {
  readonly task: ProjectWorkTaskRead;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly canWrite: boolean;
  readonly streamAvailable: boolean;
  readonly aggregateRevision: number | null;
  readonly onLegacyWrite: LegacyWrite;
  readonly guidedAccess: {
    readonly connected: boolean;
    readonly enabled: boolean;
    readonly supported: boolean;
  };
  readonly foundation?: WorkTeamFoundationView;
  readonly guidedCanWrite?: boolean;
  readonly onGuidedWrite?: ((intent: ProjectWorkWriteIntent) => Promise<void>) | undefined;
}) {
  const [open, setOpen] = useState(taskNeedsSpecification(task));
  const ready = task.state === "specified";
  const memberships =
    foundation?.snapshot.records.filter(
      (record) =>
        record.kind === "task-membership" && "taskId" in record && record.taskId === task.taskId,
    ) ?? [];
  // Classification survives incomplete refreshes; canWrite separately gates freshness.
  const legacy =
    knownTask(task) &&
    (foundation === undefined ||
      (foundation.snapshot.complete &&
        foundation.snapshot.error === null &&
        (memberships.length === 0 ||
          (memberships.length === 1 &&
            knownFoundationRecord(memberships[0]) &&
            memberships[0].kind === "task-membership" &&
            memberships[0].executionKind === "legacy"))));
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
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const makeReady = useCallback(async () => {
    if (!mounted.current || busy.current || !canWrite || submitting || aggregateRevision === null)
      return;
    busy.current = true;
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
    try {
      await onLegacyWrite(command);
      if (!mounted.current) return;
      setRetryCommand(null);
      setRebasedRevision(null);
    } catch (error) {
      if (mounted.current) setFailure(projectWorkCommandFailure(error));
    } finally {
      busy.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }, [
    aggregateRevision,
    canWrite,
    projectId,
    rebasedRevision,
    retryCommand,
    submitting,
    task,
    onLegacyWrite,
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
          {!legacy && foundation && onGuidedWrite ? (
            <ManagedTaskDetail
              environmentId={environmentId}
              projectId={projectId}
              task={task}
              foundation={foundation}
              canWrite={guidedCanWrite}
              access={guidedAccess}
              streamAvailable={streamAvailable}
              onWrite={onGuidedWrite}
            />
          ) : legacy && taskNeedsSpecification(task) ? (
            <SpecificationForm
              task={task}
              environmentId={environmentId}
              projectId={projectId}
              canWrite={canWrite}
              aggregateRevision={aggregateRevision}
              onWrite={onLegacyWrite}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="text-muted-foreground">
                <span>Revision {task.revision}</span>
                {task.specification ? (
                  <span className="ml-3">Spec {task.specification.revision}</span>
                ) : null}
              </div>
              {legacy && ready ? (
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
          {legacy && typeof projectWorkEnvironment.taskContext === "function" ? (
            <TaskLifecycleControls
              environmentId={environmentId}
              projectId={projectId}
              taskId={task.taskId}
              canWrite={canWrite}
              streamAvailable={streamAvailable}
              onWrite={onLegacyWrite}
            />
          ) : null}
        </div>
      ) : null}
    </WorkCard>
  );
}

/** A task link reads one bounded context, independently of the loaded queue page. */
function LinkedTaskDetail({
  taskId,
  ...props
}: Omit<Parameters<typeof ManagedTaskDetail>[0], "task"> & { readonly taskId: ProjectWorkTaskId }) {
  const result = useAtomValue(
    projectWorkEnvironment.taskContext({
      environmentId: props.environmentId,
      projectId: props.projectId,
      taskId,
      ...(props.streamAvailable ? { poll: false } : {}),
    }),
  );
  const context = asProjectWorkTaskContext(Option.getOrNull(AsyncResult.value(result)));
  if (
    !context ||
    context.projectId !== props.projectId ||
    context.task.projectId !== props.projectId ||
    context.task.taskId !== taskId ||
    !knownTask(context.task)
  )
    return <p>The linked task is unavailable or unsupported. Refresh the current project.</p>;
  return (
    <WorkCard>
      <h3 className="mb-3 font-medium">{context.task.title}</h3>
      <ManagedTaskDetail
        {...props}
        task={context.task}
        canWrite={
          props.canWrite &&
          result._tag === "Success" &&
          !result.waiting &&
          context.revision === props.foundation.snapshot.revision
        }
      />
    </WorkCard>
  );
}

function ManagedTaskDetail({
  environmentId,
  projectId,
  task,
  foundation,
  canWrite,
  access,
  streamAvailable,
  onWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly task: ProjectWorkTaskRead;
  readonly foundation: WorkTeamFoundationView;
  readonly canWrite: boolean;
  readonly streamAvailable: boolean;
  readonly onWrite: (intent: ProjectWorkWriteIntent) => Promise<void>;
  readonly access: {
    readonly connected: boolean;
    readonly enabled: boolean;
    readonly supported: boolean;
  };
}) {
  const registry = useContext(RegistryContext);
  const target = {
    environmentId,
    projectId,
    taskId: task.taskId,
    ...(streamAvailable ? { poll: false } : {}),
  };
  const atom = projectWorkEnvironment.taskContext(target);
  const result = useAtomValue(atom);
  const context = asProjectWorkTaskContext(Option.getOrNull(AsyncResult.value(result)));
  const refreshContext = useAtomQueryRunner(projectWorkEnvironment.taskContext, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const refresh = () => {
    foundation.refresh();
    void refreshContext(target);
  };
  const submit = async (intent: ProjectWorkWriteIntent) => {
    const latest = registry.get(atom);
    const current = asProjectWorkTaskContext(Option.getOrNull(AsyncResult.value(latest)));
    if (
      latest._tag !== "Success" ||
      latest.waiting ||
      !current ||
      current.projectId !== projectId ||
      current.task.projectId !== projectId ||
      current.task.taskId !== task.taskId ||
      current.revision !== intent.expectedRevision ||
      !("taskId" in intent) ||
      intent.taskId !== task.taskId ||
      ("expectedTaskRevision" in intent && intent.expectedTaskRevision !== current.task.revision)
    )
      throw {
        code: "stale-revision",
        message: "Refresh the current task before making changes.",
      };
    await onWrite(intent);
  };
  const current =
    foundation.current &&
    canWrite &&
    result._tag === "Success" &&
    !result.waiting &&
    context?.task.revision === task.revision;
  return (
    <>
      <GuidedTaskDetail
        environmentId={environmentId}
        projectId={projectId}
        taskContext={context}
        foundationRecords={foundation.snapshot.records}
        foundationRevision={foundation.snapshot.revision}
        foundationComplete={
          foundation.current &&
          canWrite &&
          result._tag === "Success" &&
          !result.waiting &&
          context?.task.revision === task.revision
        }
        connected={access.connected}
        enabled={access.enabled}
        supported={access.supported}
        onRefresh={refresh}
        onWrite={submit}
      />
      <TaskVerification
        environmentId={environmentId}
        projectId={projectId}
        context={context}
        records={foundation.snapshot.records}
        current={current}
        connected={access.connected}
        enabled={access.enabled}
        supported={access.supported}
        onWrite={submit}
        onRefresh={refresh}
        verify={() => {
          const fresh = foundation.verify();
          const latest = registry.get(atom);
          const currentContext = asProjectWorkTaskContext(
            Option.getOrNull(AsyncResult.value(latest)),
          );
          if (
            latest._tag !== "Success" ||
            latest.waiting ||
            !currentContext ||
            currentContext.projectId !== projectId ||
            currentContext.task.projectId !== projectId ||
            currentContext.task.taskId !== task.taskId ||
            currentContext.revision !== fresh.revision
          )
            throw {
              code: "stale-revision",
              message: "Refresh the current task and project before verification.",
            };
          return { context: currentContext, records: fresh.records };
        }}
      />
    </>
  );
}

function SpecificationForm({
  task,
  environmentId,
  projectId,
  canWrite,
  aggregateRevision,
  onWrite,
}: {
  readonly task: ProjectWorkTaskRead;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly canWrite: boolean;
  readonly aggregateRevision: number | null;
  readonly onWrite: LegacyWrite;
}) {
  const [objective, setObjective] = useState("");
  const [scopeIn, setScopeIn] = useState("");
  const [scopeOut, setScopeOut] = useState("");
  const [criterion, setCriterion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ProjectWorkCommandFailure | null>(null);
  const [retryStage, setRetryStage] = useState<SpecificationRetry | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
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
    if (!mounted.current || busy.current || !canWrite || aggregateRevision === null) return;
    if ([objective, scopeIn, scopeOut, criterion].some((value) => value.trim() === "")) return;
    busy.current = true;
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
    try {
      let specificationCommand: TaskSpecifyCommand;
      if (
        currentRetry?.stage !== "specification" &&
        currentRetry?.stage !== "rebased-specification"
      ) {
        setRetryStage({ stage: "criterion", criterion: criterionCommand });
        const criterionResult = await onWrite(criterionCommand);
        if (!mounted.current) return;
        specificationCommand = makeProjectWorkTaskSpecifyCommand({
          projectId,
          taskId: task.taskId,
          criterionId: criterionCommand.criterion.criterionId,
          criterionRevision: criterionResult.revision,
          specificationRevision: task.specRevision + 1,
          commandId: CommandId.make(randomUUID()),
          objective: objective.trim(),
          scopeIn: scopeIn.trim(),
          scopeOut: scopeOut.trim(),
          updatedAt: now,
        });
      } else {
        specificationCommand =
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
      }
      // Retain the accepted criterion and exact specification command if eligibility changes between stages.
      setRetryStage({
        stage: "specification",
        criterion: criterionCommand,
        specification: specificationCommand,
      });
      const fromRevision = criterionCommand.expectedRevision;
      const toRevision = specificationCommand.expectedRevision;
      if (fromRevision === undefined || toRevision === undefined)
        throw {
          code: "stale-revision",
          message: "Refresh the current specification before saving.",
        };
      await onWrite(specificationCommand, { fromRevision, toRevision });
      if (mounted.current) setRetryStage(null);
    } catch (error) {
      if (mounted.current) setFailure(projectWorkCommandFailure(error));
    } finally {
      busy.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }, [
    aggregateRevision,
    canWrite,
    criterion,
    objective,
    onWrite,
    projectId,
    retryStage,
    scopeIn,
    scopeOut,
    task,
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
