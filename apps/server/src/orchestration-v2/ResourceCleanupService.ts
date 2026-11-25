import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ThreadHistoryArchive from "./ThreadHistoryArchiveService.ts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { parseAttachmentFileExtension, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "preview", "device", "attachment", "scheduled-tasks"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  /** Releases the thread's device claims, as `device_close` does; the devices stay booted. */
  readonly cleanupDevices: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
  /**
   * Releases purged threads' rewind archives: their rows, Git refs and attachment claims. Never
   * fails: a thread whose release fails is logged and left to the purged-thread release worker.
   */
  readonly cleanupHistoryArchives: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<void>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupScheduledTasks: () => Effect.void,
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupDevices: () => Effect.void,
    cleanupAttachments: () => Effect.void,
    cleanupHistoryArchives: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const devices = yield* DeviceService.DeviceService;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const archives = yield* ThreadHistoryArchive.ThreadHistoryArchiveService;
    const sql = yield* SqlClient.SqlClient;
    return {
      cleanupScheduledTasks: Effect.fn("ResourceCleanupService.cleanupScheduledTasks")(function (
        threadId: ThreadId,
      ) {
        return scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          );
      }),
      cleanupTerminals: Effect.fn("ResourceCleanupService.cleanupTerminals")(function (
        threadId: string,
      ) {
        return terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          );
      }),
      cleanupPreviews: Effect.fn("ResourceCleanupService.cleanupPreviews")(function (
        threadId: string,
      ) {
        return previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          );
      }),
      cleanupDevices: Effect.fn("ResourceCleanupService.cleanupDevices")(function* (
        threadId: ThreadId,
      ) {
        // One close per session, so a reconnecting host does not keep the other hosts' claims.
        const sessions = yield* devices.sessionsForThread(threadId);
        const [, failures] = yield* Effect.partition(
          sessions,
          (session) =>
            devices.close({ threadId, hostId: session.hostId, deviceId: session.deviceId }),
          { concurrency: 1 },
        );
        const [failure] = failures;
        if (failure !== undefined)
          return yield* new ResourceCleanupError({ operation: "device", threadId, cause: failure });
      }),
      cleanupAttachments: Effect.fn("ResourceCleanupService.cleanupAttachments")(function (
        attachmentIds: ReadonlyArray<string>,
      ) {
        return Effect.forEach(
          attachmentIds,
          Effect.fn("ResourceCleanup.cleanupAttachment")(function* (attachmentId: string) {
            return yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`UPDATE t3_workflow_v2_history_archives SET state=state WHERE 0`;
                  if (
                    yield* archives.isAttachmentRetained(attachmentId).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ResourceCleanupError({
                            operation: "attachment",
                            attachmentId,
                            cause,
                          }),
                      ),
                    )
                  )
                    return;
                  const extension = parseAttachmentFileExtension(attachmentId);
                  const path =
                    resolveAttachmentPathById({
                      attachmentsDir: config.attachmentsDir,
                      attachmentId,
                    }) ??
                    (extension
                      ? resolveAttachmentRelativePath({
                          attachmentsDir: config.attachmentsDir,
                          relativePath: `${attachmentId}.${extension}`,
                        })
                      : null);
                  return yield* path === null
                    ? Effect.void
                    : fileSystem.remove(path, { force: true }).pipe(
                        Effect.andThen(fileSystem.remove(`${path}.txt`, { force: true })),
                        Effect.mapError(
                          (cause) =>
                            new ResourceCleanupError({
                              operation: "attachment",
                              attachmentId,
                              cause,
                            }),
                        ),
                      );
                }),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                ),
              );
          }),
          { discard: true, concurrency: 4 },
        );
      }),
      cleanupHistoryArchives: Effect.fn("ResourceCleanupService.cleanupHistoryArchives")(function (
        threadIds: ReadonlyArray<ThreadId>,
      ) {
        return Effect.forEach(
          threadIds,
          (threadId) =>
            archives.releaseThread(threadId).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Purged thread's history archives remain pending.", {
                  threadId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        );
      }),
    };
  }),
);
