// @effect-diagnostics-next-line nodeBuiltinImport:off -- Receipt IDs are deterministic across restarts.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  ThreadId,
  TurnItemId,
  TerminalToolError,
  ProjectId,
  type ProjectTerminalSummary,
  RunId,
  RunAttemptId,
  ProviderThreadId,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { RunAdmission } from "../orchestration-v2/RunAdmission.ts";
import { decodeCompletionAuthority, projectTerminalOwnerMatches } from "./ProjectTerminalStore.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { completionIdentity } from "./ProjectTerminalStore.ts";
const isTerminalToolError = Schema.is(TerminalToolError);
const sqlError = (
  operation: TerminalToolError["operation"],
  projectId: ProjectId,
  terminalId: string,
) => new TerminalToolError({ operation, reason: "cleanup-failed", projectId, terminalId });
type Subscription = {
  project_id: string;
  terminal_id: string;
  generation: string;
  recipient_thread_id: string;
  mode: string;
  phase: string;
  authority_json: string;
};
export const claimTerminalCompletion = Effect.fn("ProjectTerminalCompletion.claim")(
  function* (input: {
    readonly sql: SqlClient.SqlClient;
    readonly subscription: Subscription;
    readonly recoverPending: boolean;
  }) {
    const { sql, subscription } = input;
    const expected =
      subscription.phase === "pending" && input.recoverPending ? "pending" : "subscribed";
    if (subscription.phase !== expected) return null;
    const rows =
      yield* sql<Subscription>`UPDATE t3_workflow_v2_terminal_completions SET phase='pending' WHERE project_id=${subscription.project_id} AND terminal_id=${subscription.terminal_id} AND generation=${subscription.generation} AND recipient_thread_id=${subscription.recipient_thread_id} AND phase=${expected} RETURNING *`.pipe(
        Effect.mapError(() =>
          sqlError(
            "subscribeCompletion",
            ProjectId.make(subscription.project_id),
            subscription.terminal_id,
          ),
        ),
      );
    return rows[0] ?? null;
  },
);
export const cancelTerminalCompletion = Effect.fn("ProjectTerminalCompletion.cancel")(
  function* (input: {
    readonly sql: SqlClient.SqlClient;
    readonly projectId: ProjectId;
    readonly terminalId: string;
    readonly recipientThreadId: string;
  }): Effect.fn.Return<void, TerminalToolError> {
    const { sql } = input;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE t3_workflow_v2_terminal_completions SET phase='cancelled' WHERE project_id=${input.projectId} AND terminal_id=${input.terminalId} AND recipient_thread_id=${input.recipientThreadId} AND phase='subscribed'`;
          const active =
            yield* sql`SELECT phase FROM t3_workflow_v2_terminal_completions WHERE project_id=${input.projectId} AND terminal_id=${input.terminalId} AND recipient_thread_id=${input.recipientThreadId} AND phase IN ('pending','unknown','delivered') LIMIT 1`;
          if (active.length > 0)
            return yield* new TerminalToolError({
              operation: "unsubscribeCompletion",
              reason: "completion-in-flight",
              projectId: input.projectId,
              terminalId: input.terminalId,
            });
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isTerminalToolError(cause)
            ? cause
            : sqlError("unsubscribeCompletion", input.projectId, input.terminalId),
        ),
      );
  },
);
export const deliverProjectTerminalCompletion = Effect.fn("ProjectTerminalCompletion.deliver")(
  function* (
    terminal: ProjectTerminalSummary,
    dependencies: {
      readonly sql: SqlClient.SqlClient;
      readonly admission: Pick<RunAdmission["Service"], "check">;
      readonly recoverPending?: boolean;
      readonly orchestrator: Pick<OrchestratorV2["Service"], "dispatch">;
      readonly threads: Pick<ThreadManagementService["Service"], "dispatch">;
    },
  ) {
    const { sql, orchestrator, threads, admission } = dependencies;
    if (terminal.status !== "exited") return;
    const subscriptions =
      yield* sql<Subscription>`SELECT * FROM t3_workflow_v2_terminal_completions WHERE project_id=${terminal.projectId} AND terminal_id=${terminal.terminalId} AND generation=${terminal.generation} AND (phase='subscribed' OR (${dependencies.recoverPending === true ? 1 : 0}=1 AND phase='pending'))`.pipe(
        Effect.mapError(() =>
          sqlError("subscribeCompletion", terminal.projectId, terminal.terminalId),
        ),
      );
    for (const selected of subscriptions) {
      const subscription = yield* claimTerminalCompletion({
        sql,
        subscription: selected,
        recoverPending: dependencies.recoverPending === true,
      });
      if (subscription === null) continue;
      const identity = completionIdentity({
        ...terminal,
        recipientThreadId: subscription.recipient_thread_id,
      });
      const digest = NodeCrypto.createHash("sha256").update(identity).digest("hex");
      const authority = yield* decodeCompletionAuthority(subscription.authority_json).pipe(
        Effect.result,
      );
      let allowed = false;
      if (authority._tag === "Success") {
        const captured = authority.success;
        const owner = captured.owner;
        const retainedOwner = owner
          ? {
              ...owner,
              projectId: ProjectId.make(owner.projectId),
              threadId: ThreadId.make(owner.threadId),
              runId: RunId.make(captured.runId),
              runAttemptId: RunAttemptId.make(captured.nativeTarget.runAttemptId),
            }
          : undefined;
        const decision = yield* admission
          .check({
            threadId: ThreadId.make(subscription.recipient_thread_id),
            runId: RunId.make(captured.runId),
            operation: "completion",
            ...(retainedOwner ? { retainedOwner } : {}),
            nativeTarget: {
              runAttemptId: RunAttemptId.make(captured.nativeTarget.runAttemptId),
              providerThreadId: ProviderThreadId.make(captured.nativeTarget.providerThreadId),
              providerSessionId: ProviderSessionId.make(captured.nativeTarget.providerSessionId),
            },
            now: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.result);
        allowed =
          decision._tag === "Success" &&
          (owner
            ? owner.projectId === terminal.projectId &&
              owner.threadId === subscription.recipient_thread_id &&
              decision.success._tag === "admitted" &&
              projectTerminalOwnerMatches(owner, { ...owner, ...decision.success.owner })
            : decision.success._tag === "ordinary");
      }
      if (!allowed) {
        yield* sql`UPDATE t3_workflow_v2_terminal_completions SET phase='unknown' WHERE project_id=${terminal.projectId} AND terminal_id=${terminal.terminalId} AND generation=${terminal.generation} AND recipient_thread_id=${subscription.recipient_thread_id} AND phase='pending'`.pipe(
          Effect.mapError(() =>
            sqlError("subscribeCompletion", terminal.projectId, terminal.terminalId),
          ),
        );
        continue;
      }
      const notice = yield* orchestrator
        .dispatch({
          type: "thread.notice.append",
          commandId: CommandId.make(`project-terminal-notice:${digest}`),
          projectId: terminal.projectId,
          threadId: ThreadId.make(subscription.recipient_thread_id),
          turnItemId: TurnItemId.make(`project-terminal:${digest}`),
          notification: {
            source: { kind: "background_task" },
            outcome: terminal.exitCode === 0 ? "completed" : "failed",
            summary: `Terminal ${terminal.label} exited with code ${terminal.exitCode ?? "unknown"}.`,
          },
        })
        .pipe(Effect.result);
      const result =
        subscription.mode !== "noticeAndWake" || notice._tag === "Failure"
          ? notice
          : yield* threads
              .dispatch({
                type: "message.dispatch",
                ...(authority._tag === "Success" && authority.success.owner
                  ? {
                      retainedOwner: {
                        ...authority.success.owner,
                        projectId: terminal.projectId,
                        threadId: ThreadId.make(subscription.recipient_thread_id),
                        runId: RunId.make(authority.success.runId),
                        runAttemptId: RunAttemptId.make(
                          authority.success.nativeTarget.runAttemptId,
                        ),
                      },
                    }
                  : { retainedOwner: null }),
                commandId: CommandId.make(`project-terminal:${digest}`),
                threadId: ThreadId.make(subscription.recipient_thread_id),
                messageId: MessageId.make(`project-terminal:${digest}`),
                text: `Project terminal ${terminal.label} exited with code ${terminal.exitCode ?? "unknown"}.`,
                notification: {
                  source: { kind: "background_task" },
                  outcome: terminal.exitCode === 0 ? "completed" : "failed",
                  summary: `Terminal ${terminal.label} exited`,
                },
                attachments: [],
                dispatchMode: { type: "queue_after_active" },
                createdBy: "agent",
                creationSource: "server",
              })
              .pipe(Effect.result);
      // The V2 command receipt owns replay. Unknown dispatch outcomes stay visible and are never blindly resent.
      yield* sql`UPDATE t3_workflow_v2_terminal_completions SET phase=${result._tag === "Success" ? "delivered" : "unknown"} WHERE project_id=${terminal.projectId} AND terminal_id=${terminal.terminalId} AND generation=${terminal.generation} AND recipient_thread_id=${subscription.recipient_thread_id} AND phase='pending'`.pipe(
        Effect.mapError(() =>
          sqlError("subscribeCompletion", terminal.projectId, terminal.terminalId),
        ),
      );
    }
  },
);
