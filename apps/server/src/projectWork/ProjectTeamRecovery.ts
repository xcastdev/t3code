import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { DispatchSnapshot } from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamDispatchJournalError } from "./ProjectTeamDispatchJournal.ts";

export const readProjectTeamAssignmentReceipt = Effect.fn(
  "ProjectTeamRecovery.readAssignmentReceipt",
)(function* (dispatchId: string, threadId: string) {
  const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
  const messageReceipt = yield* receipts.getByCommandId(
    CommandId.make(`${dispatchId}:initial-message`),
  );
  const receipt = Option.isSome(messageReceipt)
    ? messageReceipt
    : yield* receipts.getByCommandId(CommandId.make(dispatchId));
  const commandType = Option.isSome(messageReceipt) ? "message.dispatch" : "thread.create";
  if (
    Option.isSome(receipt) &&
    (receipt.value.threadId !== threadId ||
      receipt.value.commandType !== commandType ||
      receipt.value.status !== "accepted")
  )
    return yield* new ProjectTeamDispatchJournalError({ reason: "identity-conflict" });
  return receipt;
});

/** Absence permits replay of the same command; a different or unavailable identity never permits replacement. */
export const make = Effect.gen(function* () {
  const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  return Effect.fn("ProjectTeamRecovery.reconcile")(function* (snapshot: DispatchSnapshot) {
    const receipt = yield* readProjectTeamAssignmentReceipt(
      snapshot.dispatchId,
      snapshot.threadId,
    ).pipe(Effect.provideService(CommandReceipts.CommandReceiptStoreV2, receipts));
    if (Option.isNone(receipt)) return { status: "replay" as const };
    const projection = yield* threads.getThreadProjection(ThreadId.make(snapshot.threadId));
    const run = projection.runs.find(
      (run) => run.userMessageId === `${snapshot.dispatchId}:message`,
    );
    if (projection.thread.projectId !== snapshot.projectId)
      return yield* new ProjectTeamDispatchJournalError({ reason: "identity-conflict" });
    // Older launches committed thread creation before their separate initial-message command.
    if (run === undefined && receipt.value.commandType === "thread.create")
      return { status: "replay" as const };
    if (run === undefined)
      return yield* new ProjectTeamDispatchJournalError({ reason: "identity-conflict" });
    return { status: "observed" as const, projection };
  });
});
