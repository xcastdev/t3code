import {
  CommandId,
  type CheckpointRef,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  OrchestrationThread,
  ProviderSession,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { isDeepStrictEqual } from "node:util";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForArchivedTurn,
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ThreadHistoryArchiveRepository } from "../../persistence/ThreadHistoryArchive.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { retainThreadMessagesAfterRevert } from "../projector.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const encodeArchiveThread = Schema.encodeUnknownSync(Schema.fromJsonString(OrchestrationThread));
const encodeArchiveSession = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(ProviderSession)),
);
const decodeArchiveThread = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationThread));
const decodeArchiveSession = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(ProviderSession)),
);

function forkHistorySnapshot(
  source: OrchestrationThread,
  forkThreadId: ThreadId,
  turnCount: number,
) {
  const checkpoints = source.checkpoints.filter(
    (checkpoint) => checkpoint.checkpointTurnCount <= turnCount,
  );
  const retainedTurns = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
  const firstRemovedCheckpoint = source.checkpoints
    .filter((checkpoint) => checkpoint.checkpointTurnCount > turnCount)
    .toSorted((a, b) => a.checkpointTurnCount - b.checkpointTurnCount)
    .at(0);
  const firstRemovedAt =
    source.turns?.find((turn) => turn.turnId === firstRemovedCheckpoint?.turnId)?.requestedAt ??
    firstRemovedCheckpoint?.completedAt;
  const retainUnbound = (createdAt: string) =>
    firstRemovedAt === undefined || createdAt < firstRemovedAt;
  const turnId = (value: TurnId) => TurnId.make(`${forkThreadId}:${value}`);
  const messageId = (value: MessageId) => MessageId.make(`${forkThreadId}:${value}`);
  const latestCheckpoint = checkpoints.at(-1);
  return {
    ...source,
    id: forkThreadId,
    session: null,
    messages: retainThreadMessagesAfterRevert(source.messages, retainedTurns, turnCount).map(
      (message) => ({
        ...message,
        id: messageId(message.id),
        turnId: message.turnId === null ? null : turnId(message.turnId),
      }),
    ),
    proposedPlans: source.proposedPlans
      .filter(
        (plan) =>
          (plan.turnId === null && retainUnbound(plan.createdAt)) ||
          retainedTurns.has(plan.turnId!),
      )
      .map((plan) => ({
        ...plan,
        id: `${forkThreadId}:${plan.id}`,
        turnId: plan.turnId === null ? null : turnId(plan.turnId),
      })),
    activities: source.activities
      .filter(
        (activity) =>
          (activity.turnId === null && retainUnbound(activity.createdAt)) ||
          retainedTurns.has(activity.turnId!),
      )
      .map((activity) => ({
        ...activity,
        id: EventId.make(`${forkThreadId}:${activity.id}`),
        turnId: activity.turnId === null ? null : turnId(activity.turnId),
      })),
    checkpoints: checkpoints.map((checkpoint) => ({
      ...checkpoint,
      turnId: turnId(checkpoint.turnId),
      assistantMessageId:
        checkpoint.assistantMessageId === null ? null : messageId(checkpoint.assistantMessageId),
      checkpointRef: checkpointRefForThreadTurn(forkThreadId, checkpoint.checkpointTurnCount),
    })),
    turns: source.turns
      ?.filter((turn) => retainedTurns.has(turn.turnId))
      .map((turn) => ({
        ...turn,
        turnId: turnId(turn.turnId),
        assistantMessageId:
          turn.assistantMessageId === null ? null : messageId(turn.assistantMessageId),
      })),
    partialTurnIds: source.partialTurnIds?.filter((id) => retainedTurns.has(id)).map(turnId),
    latestTurn: latestCheckpoint
      ? (() => {
          const retained = source.turns?.find((turn) => turn.turnId === latestCheckpoint.turnId);
          return {
            turnId: turnId(latestCheckpoint.turnId),
            state:
              retained?.state ??
              (latestCheckpoint.status === "error" ? ("error" as const) : ("completed" as const)),
            requestedAt: retained?.requestedAt ?? latestCheckpoint.completedAt,
            startedAt: retained?.startedAt ?? latestCheckpoint.completedAt,
            completedAt: retained?.completedAt ?? latestCheckpoint.completedAt,
            assistantMessageId: retained?.assistantMessageId
              ? messageId(retained.assistantMessageId)
              : latestCheckpoint.assistantMessageId === null
                ? null
                : messageId(latestCheckpoint.assistantMessageId),
          };
        })()
      : null,
  } satisfies OrchestrationThread;
}

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const historyArchives = yield* ThreadHistoryArchiveRepository;
  const gitWorkflow = yield* GitWorkflowService;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const startedTurns = new Map<ThreadId, TurnId>();
  const pending = new Set<ThreadId>();

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, CheckpointStoreError> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!(yield* checkpointStore.isGitRepository(cwd))) {
      return undefined;
    }
    return cwd;
  });

  // Capture the completed turn's files, then publish its summary and receipts.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd);

    // Git may have been initialized during this turn, leaving no pre-turn
    // snapshot. Keep the completion checkpoint for future turns, but do not
    // invent a baseline or attempt a diff against a ref that does not exist.
    const files = yield* (
      fromCheckpointExists
        ? checkpointStore.diffCheckpoints({
            cwd: input.cwd,
            fromCheckpointRef,
            toCheckpointRef: targetCheckpointRef,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
            format: "numstat",
          })
        : Effect.succeed("")
    ).pipe(
      Effect.map((diff) =>
        parseTurnDiffFilesFromNumstat(diff).map((file) => ({
          path: file.path,
          kind: "modified" as const,
          additions: file.additions,
          deletions: file.deletions,
        })),
      ),
      Effect.tapError((error) =>
        appendCaptureFailureActivity({
          threadId: input.threadId,
          turnId: input.turnId,
          detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("failed to derive checkpoint file summary", {
          threadId: input.threadId,
          turnId: input.turnId,
          turnCount: input.turnCount,
          detail: error.message,
        }).pipe(Effect.as([])),
      ),
    );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Capture the files left by a completed or interrupted turn.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status:
          event.type === "turn.aborted"
            ? "ready"
            : checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: existingPlaceholder?.assistantMessageId ?? undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) {
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
      yield* refreshPullRequestAfterTurn({
        threadId: event.threadId,
        turnId: toTurnId(event.turnId),
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // Retry a missing PR after the agent finishes its push and PR creation.
  // Re-read the projected branch after drift adoption. A rejected metadata
  // update must not let this thread refresh another thread's checkout.
  const refreshPullRequestAfterTurn = Effect.fn("refreshPullRequestAfterTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || input.local.isDefaultRef) return;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread || thread.branch !== checkedOutBranch) return;
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, input.turnId)) return;
    yield* vcsStatusBroadcaster.refreshPullRequestStatus(input.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh pull request status after turn completion", {
          threadId: input.threadId,
          cwd: input.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to follow worktree branch drift", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  // Refreshing git status ends in a remote PR lookup under the vcs status
  // write lock. Run it on its own worker so file capture for this turn (and
  // checkpoints for other threads) never wait behind that network call.
  const statusRefreshWorker = yield* makeDrainableWorker(
    (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) =>
      refreshLocalGitStatusFromTurnCompletion(event).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("failed to refresh git status after turn completion", {
                threadId: event.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.metadata.historyImport === true ||
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  const archiveCurrentPath = Effect.fn("archiveCurrentPath")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly checkpointCwd: string | undefined;
    readonly now: string;
  }) {
    const fullThread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadDetailById(input.thread.id),
    );
    if (!fullThread) {
      return yield* Effect.die(new Error(`Cannot archive missing thread ${input.thread.id}`));
    }
    const archiveId = yield* randomUUID;
    const copies: Array<{ from: CheckpointRef; to: CheckpointRef }> = [];
    const checkpointRefMap: Record<string, string> = {};
    const archivedCheckpoints = [];
    for (const checkpoint of fullThread.checkpoints) {
      const archivedRef = checkpointRefForArchivedTurn(
        input.thread.id,
        archiveId,
        checkpoint.checkpointTurnCount,
      );
      const present = input.checkpointCwd
        ? yield* checkpointStore.hasCheckpointRef({
            cwd: input.checkpointCwd,
            checkpointRef: checkpoint.checkpointRef,
          })
        : false;
      if (present) {
        copies.push({ from: checkpoint.checkpointRef, to: archivedRef });
        checkpointRefMap[checkpoint.checkpointRef] = archivedRef;
      }
      archivedCheckpoints.push({
        ...checkpoint,
        checkpointRef: present ? archivedRef : checkpoint.checkpointRef,
      });
    }
    if (input.checkpointCwd) {
      const baselineRef = checkpointRefForThreadTurn(input.thread.id, 0);
      if (
        !copies.some(
          (entry) => entry.to === checkpointRefForArchivedTurn(input.thread.id, archiveId, 0),
        ) &&
        (yield* checkpointStore.hasCheckpointRef({
          cwd: input.checkpointCwd,
          checkpointRef: baselineRef,
        }))
      ) {
        const archivedBaselineRef = checkpointRefForArchivedTurn(input.thread.id, archiveId, 0);
        copies.push({ from: baselineRef, to: archivedBaselineRef });
        checkpointRefMap[baselineRef] = archivedBaselineRef;
      }
      yield* checkpointStore.copyCheckpointRefs({ cwd: input.checkpointCwd, copies });
    }
    const liveProviderSession = (yield* providerService.listSessions()).find(
      (session) => session.threadId === input.thread.id,
    );
    const persistedBinding = liveProviderSession
      ? undefined
      : Option.getOrUndefined(yield* providerSessionDirectory.getBinding(input.thread.id));
    const providerSession: ProviderSession | null =
      liveProviderSession ??
      (persistedBinding
        ? {
            threadId: input.thread.id,
            provider: persistedBinding.provider,
            ...(persistedBinding.providerInstanceId
              ? { providerInstanceId: persistedBinding.providerInstanceId }
              : {}),
            status: "closed",
            runtimeMode: persistedBinding.runtimeMode ?? fullThread.runtimeMode,
            ...(input.checkpointCwd ? { cwd: input.checkpointCwd } : {}),
            ...(persistedBinding.resumeCursor != null
              ? { resumeCursor: persistedBinding.resumeCursor }
              : {}),
            createdAt: fullThread.createdAt,
            updatedAt: input.now,
          }
        : null);
    const projectionRowsJson = yield* historyArchives.captureProjectionRows(
      input.thread.id,
      checkpointRefMap,
    );
    const currentTurnCount = fullThread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    yield* historyArchives.insert({
      archiveId,
      threadId: input.thread.id,
      createdAt: input.now,
      turnCount: currentTurnCount,
      snapshotJson: encodeArchiveThread({ ...fullThread, checkpoints: archivedCheckpoints }),
      providerBindingJson: encodeArchiveSession(providerSession),
      projectionRowsJson,
    });
    return archiveId;
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: event.payload.threadId,
      thread,
      projects: yield* resolveThreadProjects(thread.projectId),
      preferSessionRuntime: true,
    }).pipe(
      Effect.catch((error) =>
        event.payload.restoreFiles === false ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    yield* providerService.assertConversationRollbackSupported(event.payload.threadId);

    const archivedPathId =
      currentTurnCount > event.payload.turnCount
        ? yield* archiveCurrentPath({ thread, checkpointCwd, now })
        : undefined;

    if (event.payload.restoreFiles !== false) {
      if (!checkpointCwd) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "Checkpoint workspace is unavailable or is not a git repository.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const targetCheckpointRef =
        event.payload.turnCount === 0
          ? checkpointRefForThreadTurn(event.payload.threadId, 0)
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
            )?.checkpointRef;

      if (!targetCheckpointRef) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const restored = yield* checkpointStore.restoreCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: targetCheckpointRef,
        fallbackToHead: event.payload.turnCount === 0,
      });
      if (!restored) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      // Refresh the workspace entry index so the @-mention file picker
      // reflects the reverted filesystem state.
      yield* workspaceEntries.refresh(checkpointCwd);
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: event.payload.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.checkpointTurnCount > event.payload.turnCount) {
        staleCheckpointRefs.push(checkpoint.checkpointRef);
      }
    }

    if (checkpointCwd && staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: checkpointCwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        ...(archivedPathId ? { archivedPathId } : {}),
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const handleHistoryRestoreRequested = Effect.fn("handleHistoryRestoreRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.history-restore-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) return;
    const runtimeSession = (yield* providerService.listSessions()).find(
      (session) => session.threadId === thread.id,
    );
    if (
      thread.session?.status === "running" ||
      thread.session?.status === "starting" ||
      runtimeSession?.status === "running" ||
      runtimeSession?.status === "connecting"
    ) {
      yield* appendRevertFailureActivity({
        threadId: thread.id,
        turnCount: 0,
        detail: "Stop the running session before restoring archived history.",
        createdAt: now,
      });
      return;
    }
    const archive = yield* historyArchives.get(event.payload.threadId, event.payload.archiveId);
    if (!archive) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: 0,
        detail: "History archive was not found.",
        createdAt: now,
      });
      return;
    }
    const archivedThread = decodeArchiveThread(archive.snapshotJson);
    const archivedSession = decodeArchiveSession(archive.providerBindingJson);
    if (archivedThread.id !== thread.id || archivedThread.projectId !== thread.projectId) {
      return yield* Effect.die(
        new Error("History archive belongs to a different thread or project"),
      );
    }
    if (archive.turnCount > 0 && (!archivedSession || archivedSession.resumeCursor === undefined)) {
      yield* appendRevertFailureActivity({
        threadId: thread.id,
        turnCount: archive.turnCount,
        detail: "Archived provider conversation is unavailable.",
        createdAt: now,
      });
      return;
    }
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects: yield* resolveThreadProjects(thread.projectId),
      preferSessionRuntime: true,
    });
    const targetRef =
      archivedThread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === archive.turnCount,
      )?.checkpointRef ?? checkpointRefForArchivedTurn(thread.id, archive.archiveId, 0);
    if (event.payload.restoreFiles) {
      const available =
        checkpointCwd &&
        (yield* checkpointStore.hasCheckpointRef({
          cwd: checkpointCwd,
          checkpointRef: targetRef,
        }));
      if (!available) {
        yield* appendRevertFailureActivity({
          threadId: thread.id,
          turnCount: archive.turnCount,
          detail: "Archived filesystem checkpoint is unavailable.",
          createdAt: now,
        });
        return;
      }
    }
    if (checkpointCwd) {
      for (const checkpoint of archivedThread.checkpoints.filter(
        (entry) => entry.status === "ready",
      )) {
        if (
          !(yield* checkpointStore.hasCheckpointRef({
            cwd: checkpointCwd,
            checkpointRef: checkpoint.checkpointRef,
          }))
        ) {
          yield* appendRevertFailureActivity({
            threadId: thread.id,
            turnCount: archive.turnCount,
            detail: "An archived checkpoint ref is unavailable.",
            createdAt: now,
          });
          return;
        }
      }
    }
    const archivedPathId = yield* archiveCurrentPath({ thread, checkpointCwd, now });
    if (event.payload.restoreFiles && checkpointCwd) {
      yield* checkpointStore.restoreCheckpoint({ cwd: checkpointCwd, checkpointRef: targetRef });
      yield* workspaceEntries.refresh(checkpointCwd);
    }
    const currentSession = (yield* providerService.listSessions()).find(
      (session) => session.threadId === thread.id,
    );
    if (currentSession) yield* providerService.stopSession({ threadId: thread.id });
    const session = archivedSession ?? currentSession;
    if (session) {
      yield* providerService.startSession(thread.id, {
        threadId: thread.id,
        provider: session.provider,
        ...(session.providerInstanceId ? { providerInstanceId: session.providerInstanceId } : {}),
        ...(checkpointCwd ? { cwd: checkpointCwd } : {}),
        ...(thread.title ? { title: thread.title } : {}),
        modelSelection: archivedThread.modelSelection,
        ...(archivedSession?.resumeCursor !== undefined
          ? { resumeCursor: archivedSession.resumeCursor }
          : {}),
        runtimeMode: archivedThread.runtimeMode,
      });
    }
    const replacements = archivedThread.checkpoints.map((checkpoint) => ({
      from: checkpoint.checkpointRef,
      to: checkpointRefForThreadTurn(thread.id, checkpoint.checkpointTurnCount),
    }));
    const baselineArchivedRef = checkpointRefForArchivedTurn(thread.id, archive.archiveId, 0);
    if (
      checkpointCwd &&
      !replacements.some((entry) => entry.to === checkpointRefForThreadTurn(thread.id, 0)) &&
      (yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineArchivedRef,
      }))
    ) {
      replacements.push({
        from: baselineArchivedRef,
        to: checkpointRefForThreadTurn(thread.id, 0),
      });
    }
    if (checkpointCwd) {
      yield* checkpointStore.replaceCheckpointRefs({ cwd: checkpointCwd, replacements });
    }
    const restoredSnapshot = {
      ...archivedThread,
      checkpoints: archivedThread.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        checkpointRef: checkpointRefForThreadTurn(thread.id, checkpoint.checkpointTurnCount),
      })),
    };
    yield* orchestrationEngine.dispatch({
      type: "thread.revert.complete",
      commandId: yield* serverCommandId("history-restore-complete"),
      threadId: thread.id,
      turnCount: archive.turnCount,
      archivedPathId,
      restoredArchiveId: archive.archiveId,
      restoredSnapshot,
      createdAt: now,
    });
  });

  const handleHistoryForkRequested = Effect.fn("handleHistoryForkRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.history-fork-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const source = yield* resolveThreadDetail(event.payload.threadId);
    if (!source) return;
    const destination = yield* resolveThreadDetail(event.payload.forkThreadId);
    if (destination) {
      yield* appendRevertFailureActivity({
        threadId: source.id,
        turnCount: event.payload.turnCount,
        detail: "Fork destination thread already exists.",
        createdAt: now,
      });
      return;
    }
    const activeSession = (yield* providerService.listSessions()).find(
      (session) => session.threadId === source.id,
    );
    if (
      source.session?.status === "running" ||
      source.session?.status === "starting" ||
      activeSession?.status === "running" ||
      activeSession?.status === "connecting"
    ) {
      yield* appendRevertFailureActivity({
        threadId: source.id,
        turnCount: event.payload.turnCount,
        detail: "Stop the running session before forking history.",
        createdAt: now,
      });
      return;
    }
    const sourceCwd = yield* resolveCheckpointCwd({
      threadId: source.id,
      thread: source,
      projects: yield* resolveThreadProjects(source.projectId),
      preferSessionRuntime: true,
    });
    if (!sourceCwd) {
      yield* appendRevertFailureActivity({
        threadId: source.id,
        turnCount: event.payload.turnCount,
        detail: "Fork workspace is unavailable or is not a Git repository.",
        createdAt: now,
      });
      return;
    }
    const currentTurnCount = source.checkpoints.reduce(
      (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
      0,
    );
    if (event.payload.archiveId === undefined && event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: source.id,
        turnCount: event.payload.turnCount,
        detail: "Fork checkpoint exceeds current thread history.",
        createdAt: now,
      });
      return;
    }
    if (
      event.payload.archiveId === undefined &&
      event.payload.turnCount > 0 &&
      event.payload.turnCount < currentTurnCount
    ) {
      yield* providerService.assertConversationRollbackSupported(source.id);
    }
    const archiveId =
      event.payload.archiveId ??
      (yield* archiveCurrentPath({
        thread: source,
        checkpointCwd: sourceCwd,
        now,
      }));
    const archive = yield* historyArchives.get(source.id, archiveId);
    if (!archive) return;
    const archivedThread = decodeArchiveThread(archive.snapshotJson);
    const archivedSession = decodeArchiveSession(archive.providerBindingJson);
    if (archivedThread.id !== source.id || archivedThread.projectId !== source.projectId) {
      return yield* Effect.die(new Error("Fork archive belongs to a different thread or project"));
    }
    const targetCount = event.payload.turnCount;
    if (targetCount > archive.turnCount) {
      yield* appendRevertFailureActivity({
        threadId: source.id,
        turnCount: targetCount,
        detail: "Fork checkpoint exceeds archived thread history.",
        createdAt: now,
      });
      return;
    }
    if (targetCount > 0 && (!archivedSession || archivedSession.resumeCursor === undefined)) {
      yield* appendRevertFailureActivity({
        threadId: source.id,
        turnCount: targetCount,
        detail: "Archived provider conversation is unavailable.",
        createdAt: now,
      });
      return;
    }
    if (targetCount > 0 && targetCount < archive.turnCount) {
      yield* providerService.assertConversationRollbackSupported(source.id);
    }
    if (!archivedSession) {
      yield* appendRevertFailureActivity({
        threadId: source.id,
        turnCount: targetCount,
        detail: "Archived provider session is unavailable for the fork.",
        createdAt: now,
      });
      return;
    }
    const targetRef =
      targetCount === 0
        ? checkpointRefForArchivedTurn(source.id, archiveId, 0)
        : archivedThread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === targetCount,
          )?.checkpointRef;
    if (
      !targetRef ||
      !(yield* checkpointStore.hasCheckpointRef({ cwd: sourceCwd, checkpointRef: targetRef }))
    ) {
      yield* appendRevertFailureActivity({
        threadId: source.id,
        turnCount: targetCount,
        detail: "Fork checkpoint is unavailable.",
        createdAt: now,
      });
      return;
    }
    const forkThreadId = event.payload.forkThreadId;
    const restoredSnapshot = forkHistorySnapshot(archivedThread, forkThreadId, targetCount);
    const checkpoints: Array<{ from: CheckpointRef; to: CheckpointRef }> = [];
    for (const checkpoint of restoredSnapshot.checkpoints) {
      const original = archivedThread.checkpoints.find(
        (entry) => entry.checkpointTurnCount === checkpoint.checkpointTurnCount,
      );
      if (!original) continue;
      const present = yield* checkpointStore.hasCheckpointRef({
        cwd: sourceCwd,
        checkpointRef: original.checkpointRef,
      });
      if (!present && original.status === "ready") {
        yield* appendRevertFailureActivity({
          threadId: source.id,
          turnCount: targetCount,
          detail: "A retained checkpoint ref is unavailable.",
          createdAt: now,
        });
        return;
      }
      if (present) checkpoints.push({ from: original.checkpointRef, to: checkpoint.checkpointRef });
    }
    const archivedBaseline = checkpointRefForArchivedTurn(source.id, archiveId, 0);
    if (
      !checkpoints.some((entry) => entry.to === checkpointRefForThreadTurn(forkThreadId, 0)) &&
      (yield* checkpointStore.hasCheckpointRef({ cwd: sourceCwd, checkpointRef: archivedBaseline }))
    ) {
      checkpoints.push({ from: archivedBaseline, to: checkpointRefForThreadTurn(forkThreadId, 0) });
    }
    const branch = event.payload.restoreFiles ? `t3/fork/${forkThreadId}` : source.branch;
    const worktreePath = event.payload.restoreFiles
      ? (yield* gitWorkflow.createWorktree({
          cwd: sourceCwd,
          refName: targetRef,
          newRefName: branch!,
          path: null,
        })).worktree.path
      : source.worktreePath;
    const sourceBinding = yield* providerSessionDirectory.getBinding(source.id);
    const forkFromLiveSource =
      event.payload.archiveId === undefined ||
      (Option.isSome(sourceBinding) &&
        isDeepStrictEqual(sourceBinding.value.resumeCursor, archivedSession.resumeCursor));
    let created = false;
    yield* Effect.gen(function* () {
      if (forkFromLiveSource && targetCount > 0 && !providerService.forkConversation) {
        return yield* Effect.die(new Error("Provider does not support native conversation forks"));
      }
      const nativeCursor =
        forkFromLiveSource && targetCount > 0
          ? yield* providerService.forkConversation!(source.id, { preserveSource: true })
          : undefined;
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: yield* serverCommandId("history-fork-create"),
        threadId: forkThreadId,
        projectId: source.projectId,
        title: `Fork of ${source.title}`,
        modelSelection: source.modelSelection,
        runtimeMode: source.runtimeMode,
        interactionMode: source.interactionMode,
        branch,
        worktreePath,
        createdAt: now,
      });
      created = true;
      yield* checkpointStore.copyCheckpointRefs({ cwd: sourceCwd, copies: checkpoints });
      yield* providerService.startSession(forkThreadId, {
        threadId: forkThreadId,
        provider: archivedSession.provider,
        ...(archivedSession.providerInstanceId
          ? { providerInstanceId: archivedSession.providerInstanceId }
          : {}),
        cwd: worktreePath ?? sourceCwd,
        title: restoredSnapshot.title,
        modelSelection: restoredSnapshot.modelSelection,
        ...(targetCount > 0 && archivedSession.resumeCursor !== undefined
          ? { resumeCursor: nativeCursor ?? archivedSession.resumeCursor }
          : {}),
        runtimeMode: restoredSnapshot.runtimeMode,
      });
      if (targetCount > 0) {
        if (nativeCursor !== undefined) {
          if (targetCount < archive.turnCount) {
            yield* providerService.rollbackConversation({
              threadId: forkThreadId,
              numTurns: archive.turnCount - targetCount,
            });
          }
        } else if (targetCount === archive.turnCount) {
          if (!providerService.forkConversation) {
            return yield* Effect.die(
              new Error("Provider does not support native conversation forks"),
            );
          }
          const nativeCursor = yield* providerService.forkConversation(forkThreadId);
          yield* providerService.startSession(forkThreadId, {
            threadId: forkThreadId,
            provider: archivedSession.provider,
            ...(archivedSession.providerInstanceId
              ? { providerInstanceId: archivedSession.providerInstanceId }
              : {}),
            cwd: worktreePath ?? sourceCwd,
            title: restoredSnapshot.title,
            modelSelection: restoredSnapshot.modelSelection,
            resumeCursor: nativeCursor,
            runtimeMode: restoredSnapshot.runtimeMode,
          });
        } else {
          yield* providerService.rollbackConversation({
            threadId: forkThreadId,
            numTurns: archive.turnCount - targetCount,
          });
        }
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("history-fork-complete"),
        threadId: forkThreadId,
        turnCount: targetCount,
        forkSourceThreadId: source.id,
        restoredArchiveId: archiveId,
        restoredSnapshot,
        createdAt: now,
      });
    }).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          if (created) {
            yield* providerService.stopSession({ threadId: forkThreadId }).pipe(Effect.ignore);
            yield* orchestrationEngine
              .dispatch({
                type: "thread.delete",
                commandId: yield* serverCommandId("history-fork-cleanup"),
                threadId: forkThreadId,
              })
              .pipe(Effect.ignore);
          }
          if (event.payload.restoreFiles && worktreePath) {
            yield* gitWorkflow
              .removeWorktree({ cwd: sourceCwd, path: worktreePath, force: true })
              .pipe(Effect.ignore);
          }
        }).pipe(Effect.ignore),
      ),
    );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      if (event.type === "thread.turn-start-requested") pending.add(event.payload.threadId);
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }
    if (event.type === "thread.history-restore-requested") {
      yield* handleHistoryRestoreRequested(event).pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: 0,
            detail: error.message,
            createdAt: event.occurredAt,
          }),
        ),
      );
      return;
    }
    if (event.type === "thread.history-fork-requested") {
      yield* handleHistoryForkRequested(event).pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: event.occurredAt,
          }),
        ),
      );
      return;
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.exited") {
      startedTurns.delete(event.threadId);
      pending.delete(event.threadId);
      return;
    }

    if (event.type === "turn.started") {
      const turnId = toTurnId(event.turnId);
      const activeTurnId = (yield* providerService.listSessions()).find((session) =>
        sameId(session.threadId, event.threadId),
      )?.activeTurnId;
      const mayReplace = pending.has(event.threadId) && sameId(activeTurnId, turnId);
      if (turnId !== null && (!startedTurns.has(event.threadId) || mayReplace)) {
        startedTurns.set(event.threadId, turnId);
        pending.delete(event.threadId);
      }
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      const thread = yield* resolveThreadDetail(event.threadId);
      const startedTurnId = startedTurns.get(event.threadId);
      const isTrackedTurn = sameId(startedTurnId, turnId);
      if (isTrackedTurn) startedTurns.delete(event.threadId);
      if (event.type === "turn.completed") {
        yield* statusRefreshWorker.enqueue(event);
      }
      if (
        turnId !== null &&
        thread !== undefined &&
        (isTrackedTurn ||
          sameId(thread.session?.activeTurnId, turnId) ||
          (startedTurnId === undefined && !thread.session?.activeTurnId))
      ) {
        pending.delete(event.threadId);
        yield* pullRequests.refreshAfterTurn;
      }
      if (
        event.type === "turn.aborted" &&
        !isTrackedTurn &&
        !sameId(thread?.session?.activeTurnId, turnId)
      ) {
        return;
      }
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.history-restore-requested" &&
          event.type !== "thread.history-fork-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted" &&
          event.type !== "session.exited"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain.pipe(Effect.andThen(statusRefreshWorker.drain)),
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
