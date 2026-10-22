import {
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type CheckpointRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    readonly matchesCheckpoint?: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly retainCheckpointRef?: (input: {
      readonly cwd: string;
      readonly checkpointRef: CheckpointRef;
      readonly retainedRef: CheckpointRef;
    }) => Effect.Effect<string, CheckpointStoreError>;

    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * Returns null when HEAD did not move or a checkpoint does not record HEAD.
     * Then every changed path belongs to the turn.
     */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const sqlClient = yield* Effect.serviceOption(SqlClient.SqlClient);

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    if (!handle.driver.checkpoints) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      });
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = (cwd) =>
    vcsRegistry
      .detect({ cwd, requestedKind: "git" })
      .pipe(Effect.map((repository) => repository !== null));

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.captureCheckpoint", input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.hasCheckpointRef", input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.restoreCheckpoint", input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.diffCheckpoints", input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.listAuthoredPaths", input.cwd);
    return yield* checkpoints.listAuthoredPaths(input);
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.deleteCheckpointRefs",
      input.cwd,
    );
    if (Option.isNone(sqlClient)) return yield* checkpoints.deleteCheckpointRefs(input);
    const sql = sqlClient.value;
    // Hold the writer transaction through deletion so preparation cannot insert a claim after the check.
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE t3_workflow_v2_history_archives SET state=state WHERE 0`;
          const checkpointRefs: CheckpointRef[] = [];
          for (const ref of input.checkpointRefs) {
            const claims =
              yield* sql`SELECT 1 FROM t3_workflow_v2_history_archive_refs r JOIN t3_workflow_v2_history_archives a USING(archive_id) WHERE (r.source_ref=${ref} OR r.retained_ref=${ref}) AND a.state!='released' AND (r.source_ref=${ref} OR a.state!='releasing') LIMIT 1`;
            if (!claims.length) checkpointRefs.push(ref);
          }
          yield* checkpoints.deleteCheckpointRefs({ ...input, checkpointRefs });
        }),
      )
      .pipe(
        Effect.mapError(
          (_cause) =>
            new VcsProcessExitError({
              operation: "CheckpointStore.deleteCheckpointRefs",
              command: "git update-ref -d",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Checkpoint retention check or deletion failed.",
            }),
        ),
      );
  });

  return CheckpointStore.of({
    isGitRepository,
    matchesCheckpoint: Effect.fn("CheckpointStore.matchesCheckpoint")(function* (input) {
      const checkpoints = yield* resolveCheckpoints("CheckpointStore.matchesCheckpoint", input.cwd);
      if (!checkpoints.matchesCheckpoint)
        return yield* new VcsUnsupportedOperationError({
          operation: "CheckpointStore.matchesCheckpoint",
          kind: "git",
          detail: "Authoritative checkpoint comparison is unavailable.",
        });
      return yield* checkpoints.matchesCheckpoint(input);
    }),
    retainCheckpointRef: Effect.fn("CheckpointStore.retainCheckpointRef")(function* (input) {
      const checkpoints = yield* resolveCheckpoints(
        "CheckpointStore.retainCheckpointRef",
        input.cwd,
      );
      if (!checkpoints.retainCheckpointRef)
        return yield* new VcsUnsupportedOperationError({
          operation: "CheckpointStore.retainCheckpointRef",
          kind: "git",
          detail: "Exact checkpoint retention is unavailable.",
        });
      return yield* checkpoints.retainCheckpointRef(input);
    }),
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
