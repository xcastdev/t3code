import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { DispatchSnapshot } from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamDispatchJournalError } from "./ProjectTeamDispatchJournal.ts";
/** Absence permits replay of the same command; a different or unavailable identity never permits replacement. */
export const make = Effect.gen(function* () {
  const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  return Effect.fn("ProjectTeamRecovery.reconcile")(function* (snapshot: DispatchSnapshot) {
    const receipt = yield* receipts.getByCommandId(
      CommandId.make(`${snapshot.dispatchId}:initial-message`),
    );
    if (Option.isNone(receipt)) return { status: "replay" as const };
    if (
      receipt.value.threadId !== snapshot.threadId ||
      receipt.value.commandType !== "message.dispatch" ||
      receipt.value.status !== "accepted"
    )
      return yield* new ProjectTeamDispatchJournalError({ reason: "identity-conflict" });
    const projection = yield* threads.getThreadProjection(ThreadId.make(snapshot.threadId));
    const run = projection.runs.find(
      (run) => run.userMessageId === `${snapshot.dispatchId}:message`,
    );
    if (projection.thread.projectId !== snapshot.projectId || run === undefined)
      return yield* new ProjectTeamDispatchJournalError({ reason: "identity-conflict" });
    return { status: "observed" as const, projection };
  });
});
