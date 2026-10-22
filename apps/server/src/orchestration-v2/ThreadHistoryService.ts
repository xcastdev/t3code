import type { ThreadHistoryRecoverInput } from "@t3tools/contracts";
import type * as History from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Archive from "./ThreadHistoryArchiveService.ts";
import * as Recovery from "./ThreadHistoryRecoveryService.ts";

type ArchiveError = Archive.HistoryArchiveError;
type RecoveryError = Recovery.HistoryRecoveryError;

export class ThreadHistoryService extends Context.Service<
  ThreadHistoryService,
  {
    readonly list: (
      input: typeof History.ThreadHistoryListInput.Type,
    ) => Effect.Effect<typeof History.ThreadHistoryListResult.Type, ArchiveError>;
    readonly detail: (
      input: typeof History.ThreadHistoryDetailInput.Type,
    ) => Effect.Effect<typeof History.ThreadHistoryDetailResult.Type, ArchiveError | RecoveryError>;
    readonly recover: (
      input: ThreadHistoryRecoverInput,
    ) => Effect.Effect<typeof History.ThreadHistoryRecoveryResult.Type, RecoveryError>;
    readonly restoreFiles: (
      input: typeof History.ThreadHistoryRestoreFilesInput.Type,
    ) => Effect.Effect<typeof History.ThreadHistoryRestoreFilesResult.Type, RecoveryError>;
    readonly fileRestoreStatus: (
      input: typeof History.ThreadHistoryFileRestoreStatusInput.Type,
    ) => Effect.Effect<typeof History.ThreadHistoryFileRestoreStatusResult.Type, RecoveryError>;
    readonly release: (
      input: typeof History.ThreadHistoryArchiveIdentity.Type,
    ) => Effect.Effect<void, ArchiveError>;
    readonly reconcile: (
      input: typeof History.ThreadHistoryReconcileInput.Type,
    ) => Effect.Effect<typeof History.ThreadHistoryReconcileResult.Type, RecoveryError>;
  }
>()("t3/orchestration-v2/ThreadHistoryService") {}

const make = Effect.gen(function* () {
  const archive = yield* Archive.ThreadHistoryArchiveService;
  const recovery = yield* Recovery.ThreadHistoryRecoveryService;
  return ThreadHistoryService.of({
    list: Effect.fn("ThreadHistoryService.list")((input) =>
      archive.list({
        threadId: input.threadId,
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    ),
    detail: Effect.fn("ThreadHistoryService.detail")((input) =>
      archive
        .detail({
          threadId: input.threadId,
          archiveId: input.archiveId,
          ...(input.after === undefined ? {} : { after: input.after }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        .pipe(
          Effect.flatMap((detail) =>
            recovery
              .capabilities(input)
              .pipe(Effect.map((capabilities) => ({ ...detail, capabilities }))),
          ),
        ),
    ),
    recover: Effect.fn("ThreadHistoryService.recover")((input) =>
      recovery.recover({
        threadId: input.threadId,
        archiveId: input.archiveId,
        commandId: input.commandId,
        messageId: input.messageId,
        mode: input.mode,
        ...(input.targetThreadId === undefined ? {} : { targetThreadId: input.targetThreadId }),
        createdBy: "user",
        creationSource: "web",
      }),
    ),
    restoreFiles: Effect.fn("ThreadHistoryService.restoreFiles")(recovery.restoreFiles),
    fileRestoreStatus: Effect.fn("ThreadHistoryService.fileRestoreStatus")(
      recovery.fileRestoreStatus,
    ),
    release: Effect.fn("ThreadHistoryService.release")(archive.release),
    reconcile: Effect.fn("ThreadHistoryService.reconcile")(recovery.reconcileFiles),
  });
});

export const layer = Layer.effect(ThreadHistoryService, make);
