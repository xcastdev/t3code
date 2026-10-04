import { canonicalProjectWorkPayload, GitCommandError } from "@t3tools/contracts";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ManagedGit from "../git/ManagedGitExecution.ts";
import {
  makeProjectManagedSetup,
  ProjectManagedSetupError,
  type ProjectManagedSetupInput,
  type ProjectManagedSetupReceipt,
} from "../project/ProjectManagedSetup.ts";
import { makeProjectManagedSetupJournal } from "../project/ProjectManagedSetupJournal.ts";
import { makeProjectManagedSetupRuntime } from "../project/ProjectManagedSetupRuntime.ts";
import {
  acquirePiManagedProcess,
  preallocatePiManagedProcess,
  reconcilePiManagedProcess,
} from "../provider/pi/PiManagedProcess.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
  ProjectTeamWorkspaceReceipt,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";

interface Options {
  readonly environmentId: string;
  readonly maximumEnvironmentModelCalls: number;
  readonly launchPolicy: { readonly memoryBytes: number; readonly runtimeSeconds: number };
  readonly protectedRoots: readonly string[];
  readonly assertCurrent: (
    snapshot: ProjectTeamDispatchSnapshot,
  ) => Effect.Effect<void, ProjectTeamDispatchJournalError, Scope.Scope>;
}

export class ProjectTeamWorkspaceError extends Schema.TaggedError<ProjectTeamWorkspaceError>()(
  "ProjectTeamWorkspaceError",
  { reason: Schema.String },
) {}
const denied = (reason: string) => new ProjectTeamWorkspaceError({ reason });
const strict = { onExcessProperty: "error" } as const;
const decodeReceipt = Schema.decodeUnknownEffect(ProjectTeamWorkspaceReceipt, strict);
const jsonReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamWorkspaceReceipt),
  strict,
);
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(ProjectTeamWorkspaceReceipt));
const text = Schema.String.check(Schema.isMaxLength(262144));
const rowSchema = Schema.Struct({
  dispatch_id: Schema.String,
  environment_id: Schema.String,
  binding_id: Schema.String,
  generation: Schema.Int,
  claim_generation: Schema.Int,
  assignment_json: text,
  receipt_json: text,
});
const decodeRow = Schema.decodeUnknownEffect(rowSchema, strict);
const same = (left: unknown, right: unknown) =>
  canonicalProjectWorkPayload(left) === canonicalProjectWorkPayload(right);
const freeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const copy = <A>(value: A) => freeze(structuredClone(value));
const captureSnapshot = (snapshot: ProjectTeamDispatchSnapshot) =>
  copy({ fence: snapshot.fence, intent: snapshot.intent });
const setupInput = (snapshot: ProjectTeamDispatchSnapshot): ProjectManagedSetupInput => {
  const claim = snapshot.intent.compiledClaim.transition;
  if (claim?.kind !== "claim") throw denied("Dispatch has no original setup binding");
  return Object.freeze({
    setupId: snapshot.intent.request.setupId,
    dispatchId: snapshot.fence.dispatchId,
    bindingId: claim.binding.recordId,
    generation: claim.binding.generation,
    threadId: claim.binding.threadId,
    worktreePath: snapshot.intent.request.git.worktreePath,
    deadlineAtMs: snapshot.intent.limits.deadlineAtMs,
  });
};

/** Root owns stage transitions; this consumer retains actual Git and setup completion evidence. */
export const makeProjectTeamWorkspace = Effect.fn("makeProjectTeamWorkspace")(function* (
  supplied: Options,
) {
  const options = Object.freeze({
    environmentId: supplied.environmentId,
    maximumEnvironmentModelCalls: supplied.maximumEnvironmentModelCalls,
    launchPolicy: copy(supplied.launchPolicy),
    protectedRoots: copy(supplied.protectedRoots),
    assertCurrent: supplied.assertCurrent,
  });
  const sql = yield* SqlClient.SqlClient;
  const workflow = yield* GitWorkflowService;
  const pi = yield* ProjectTeamPiRuntime;
  const dispatch = yield* makeProjectTeamDispatchJournal(options);
  const clock = yield* Clock.Clock;
  const platform = yield* HostProcessPlatform;
  const uid = yield* HostProcessUserId;
  const services = (yield* Effect.context<
    | Effect.Services<ReturnType<typeof ManagedGit.make>>
    | Effect.Services<ReturnType<typeof makeProjectManagedSetupRuntime>>
    | Effect.Services<ReturnType<typeof reconcilePiManagedProcess>>
  >()).pipe(
    Context.add(Clock.Clock, clock),
    Context.add(HostProcessPlatform, platform),
    Context.add(HostProcessUserId, uid),
    Context.omit(Scope.Scope),
  );
  const assertCurrent = Effect.fn("ProjectTeamWorkspace.assertCurrent")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
  ) {
    yield* options.assertCurrent(snapshot);
    if (!same(yield* dispatch.inspect(snapshot.fence.dispatchId), snapshot))
      return yield* denied("Workspace dispatch snapshot changed");
    yield* options.assertCurrent(snapshot);
  });
  const readWorkspace = Effect.fn("ProjectTeamWorkspace.readWorkspace")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
  ) {
    const rows =
      yield* sql`SELECT dispatch_id,environment_id,binding_id,generation,claim_generation,
      CASE WHEN length(CAST(assignment_json AS BLOB)) <= 262144 THEN assignment_json END AS assignment_json,
      CASE WHEN length(CAST(receipt_json AS BLOB)) <= 262144 THEN receipt_json END AS receipt_json
      FROM project_team_workspace_receipt WHERE dispatch_id=${snapshot.fence.dispatchId}`;
    if (rows.length === 0) return null;
    if (rows.length !== 1) return yield* denied("Workspace receipt identity is ambiguous");
    const row = yield* decodeRow(rows[0]);
    const git = snapshot.intent.request.git;
    if (
      row.environment_id !== options.environmentId ||
      row.binding_id !== git.runId ||
      row.generation !== git.generation ||
      row.claim_generation !== snapshot.fence.claimGeneration ||
      row.assignment_json !== canonicalProjectWorkPayload(git)
    )
      return yield* denied("Workspace receipt belongs to a different original assignment");
    const receipt = yield* jsonReceipt(row.receipt_json);
    if (!same(receipt.assignment, git))
      return yield* denied("Workspace receipt contradicts its frozen assignment");
    return copy(receipt);
  });
  const persistWorkspace = Effect.fn("ProjectTeamWorkspace.persistWorkspace")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    receipt: ManagedGit.ManagedWorkspaceReceipt,
  ) {
    const encoded = encodeReceipt(yield* decodeReceipt(receipt));
    if (Buffer.byteLength(encoded) > 262144)
      return yield* denied("Workspace receipt exceeds its storage bound");
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertCurrent(snapshot);
        const git = snapshot.intent.request.git;
        yield* sql`INSERT INTO project_team_workspace_receipt
          (dispatch_id,environment_id,binding_id,generation,claim_generation,assignment_json,receipt_json)
          VALUES (${snapshot.fence.dispatchId},${options.environmentId},${git.runId},${git.generation},
            ${snapshot.fence.claimGeneration},${canonicalProjectWorkPayload(git)},${encoded})
          ON CONFLICT(dispatch_id) DO NOTHING`;
        if (!same(yield* readWorkspace(snapshot), receipt))
          return yield* denied("Workspace persistence did not retain the original receipt");
        yield* assertCurrent(snapshot);
      }),
    );
    yield* assertCurrent(snapshot);
  });
  const managedContext = Effect.fn("ProjectTeamWorkspace.managedContext")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    prior?: ManagedGit.ManagedWorkspaceReceipt,
  ) {
    const git = snapshot.intent.request.git;
    return yield* ManagedGit.make({
      assignment: git,
      ...(prior ? { priorReceipt: prior } : {}),
      revalidate: assertCurrent(snapshot).pipe(
        Effect.scoped,
        Effect.provide(services),
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "ProjectTeamWorkspace",
              command: "/usr/bin/git",
              cwd: git.primaryRoot,
              detail: "Managed workspace authority changed",
              cause,
            }),
        ),
      ),
      persistWorkspace: (receipt) =>
        persistWorkspace(snapshot, receipt).pipe(
          Effect.scoped,
          Effect.provide(services),
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "ProjectTeamWorkspace.persistWorkspace",
                command: "/usr/bin/git",
                cwd: git.primaryRoot,
                detail: "Original workspace receipt could not be retained",
                cause,
              }),
          ),
        ),
    });
  });
  const physicalWorkspace = Effect.fn("ProjectTeamWorkspace.physicalWorkspace")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    prior?: ManagedGit.ManagedWorkspaceReceipt,
  ) {
    const git = snapshot.intent.request.git;
    const context = yield* managedContext(snapshot, prior);
    yield* workflow.createWorktree(
      {
        cwd: git.primaryRoot,
        path: git.worktreePath,
        refName: git.baseRef,
        newRefName: git.branchRef.slice(11),
      },
      { managed: context },
    );
    yield* assertCurrent(snapshot);
    const retained = yield* readWorkspace(snapshot);
    if (!retained) return yield* denied("Original workspace receipt is missing");
    yield* assertCurrent(snapshot);
    return retained;
  });
  const verifyWorkspace = Effect.fn("ProjectTeamWorkspace.verifyWorkspace")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    receipt: ManagedGit.ManagedWorkspaceReceipt,
  ) {
    yield* assertCurrent(snapshot);
    const retained = yield* readWorkspace(snapshot);
    if (!retained || !same(retained, receipt))
      return yield* denied("Workspace evidence does not match its original retained receipt");
    yield* physicalWorkspace(snapshot, retained);
  });
  const verifyRetainedWorkspace = Effect.fn("ProjectTeamWorkspace.verifyRetainedWorkspace")(
    function* (snapshot: ProjectTeamDispatchSnapshot, receipt: ManagedGit.ManagedWorkspaceReceipt) {
      yield* assertCurrent(snapshot);
      const retained = yield* readWorkspace(snapshot);
      if (!retained || !same(retained, receipt))
        return yield* denied("Workspace evidence does not match its original retained receipt");
      const git = snapshot.intent.request.git;
      const context = yield* managedContext(snapshot, retained);
      yield* ManagedGit.verifyManagedWorkspace(context, {
        cwd: git.primaryRoot,
        path: git.worktreePath,
        refName: git.baseRef,
        newRefName: git.branchRef.slice(11),
      });
      yield* assertCurrent(snapshot);
    },
  );
  const setupJournal = yield* makeProjectManagedSetupJournal({
    ...options,
    validateSelection: () =>
      Effect.fail(new ProjectManagedSetupError({ reason: "Cleanup cannot authorize setup" })),
  });
  const verifyRetainedSetup = Effect.fn("ProjectTeamWorkspace.verifyRetainedSetup")(function* (
    input: ProjectManagedSetupInput,
    receipt: ProjectManagedSetupReceipt,
  ) {
    const retained = yield* setupJournal.read(input);
    if (!retained || retained.uncertain || !retained.receipt || !same(retained.receipt, receipt))
      return yield* denied("Setup evidence does not match certain retained completion");
    if (receipt.outcome !== "skipped" && receipt.outcome !== "succeeded")
      return yield* denied("Setup did not complete successfully");
  });
  const withSetup = Effect.fn("ProjectTeamWorkspace.withSetup")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    workspace: ManagedGit.ManagedWorkspaceReceipt,
    prior?: ProjectManagedSetupReceipt,
    readOnly = false,
  ) {
    const checkWorkspace = readOnly ? verifyRetainedWorkspace : verifyWorkspace;
    yield* checkWorkspace(snapshot, workspace);
    const claim = snapshot.intent.compiledClaim.transition;
    if (claim?.kind !== "claim") return yield* denied("Setup binding is missing");
    const input = setupInput(snapshot);
    return yield* pi.withInstance(claim.binding.providerInstanceId, (instance) =>
      Effect.gen(function* () {
        const runtime = yield* makeProjectManagedSetupRuntime({
          ...options,
          runtimeFiles: instance.assets.runtimeFiles,
          protectedWorkspaceEntries: [".git"],
          revalidateRuntimeAssets: instance.assertCurrent.pipe(
            Effect.andThen(instance.assets.revalidate),
            Effect.mapError(() => new ProjectManagedSetupError({ reason: "Pi assets changed" })),
          ),
          assertWorkspace: (actualInput, actualSnapshot) =>
            Effect.gen(function* () {
              if (!same(input, actualInput) || !same(snapshot, actualSnapshot))
                return yield* denied("Setup input or dispatch snapshot changed");
              yield* checkWorkspace(snapshot, workspace);
              yield* instance.assertCurrent;
            }).pipe(
              Effect.scoped,
              Effect.provide(services),
              Effect.mapError(
                () => new ProjectManagedSetupError({ reason: "Original setup workspace changed" }),
              ),
            ),
        });
        // Execute also validates current script/configuration on exact durable receipt replay.
        if (prior) yield* verifyRetainedSetup(input, prior);
        if (readOnly) {
          if (!prior)
            return yield* denied("Retained setup verification requires its original receipt");
          yield* runtime.verify(input, prior);
          yield* checkWorkspace(snapshot, workspace);
          yield* instance.assertCurrent;
          return copy(prior);
        }
        const receipt = yield* runtime.execute(input);
        yield* verifyRetainedSetup(input, receipt);
        yield* checkWorkspace(snapshot, workspace);
        yield* instance.assertCurrent;
        return copy(receipt);
      }),
    );
  });
  const recovery = makeProjectManagedSetup({
    ...setupJournal,
    resolveSelection: () =>
      Effect.fail(new ProjectManagedSetupError({ reason: "Recovery cannot select a script" })),
    preallocate: preallocatePiManagedProcess,
    acquire: acquirePiManagedProcess,
    reconcileProcess: reconcilePiManagedProcess,
  });
  const reconcile = Effect.fn("ProjectTeamWorkspace.reconcile")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
  ) {
    if (!same(yield* dispatch.readRetained(snapshot.fence.dispatchId), snapshot))
      return yield* denied("Retained cleanup dispatch changed");
    const input = setupInput(snapshot);
    const retained = yield* setupJournal.readOwnership(input);
    if (!retained) return yield* denied("Original setup ownership is missing");
    // Completed evidence is cleanup knowledge; revoked authority never repeats a script.
    if (retained.retained.receipt && !retained.retained.uncertain)
      return copy(retained.retained.receipt);
    return copy(yield* recovery.reconcile(input));
  });
  // Root supplies the operation scope; setup keeps its driver loan through the joined result.
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(services));
  return {
    readWorkspace: (snapshot: ProjectTeamDispatchSnapshot) =>
      provide(
        Effect.suspend(() => {
          const original = captureSnapshot(snapshot);
          return assertCurrent(original).pipe(
            Effect.andThen(readWorkspace(original)),
            Effect.tap(() => assertCurrent(original)),
          );
        }),
      ),
    readSetup: (snapshot: ProjectTeamDispatchSnapshot) =>
      provide(
        Effect.suspend(() => {
          const original = captureSnapshot(snapshot);
          return Effect.gen(function* () {
            yield* assertCurrent(original);
            const retained = yield* setupJournal.read(setupInput(original));
            if (!retained) return null;
            if (retained.uncertain || !retained.receipt)
              return yield* denied("Setup has no certain retained completion");
            yield* verifyRetainedSetup(setupInput(original), retained.receipt);
            yield* assertCurrent(original);
            return copy(retained.receipt);
          });
        }),
      ),
    verifyRetained: (
      snapshot: ProjectTeamDispatchSnapshot,
      workspace: ManagedGit.ManagedWorkspaceReceipt,
      setup?: ProjectManagedSetupReceipt,
    ) =>
      provide(
        Effect.suspend(() => {
          const original = captureSnapshot(snapshot);
          const receipt = copy(workspace);
          return setup === undefined
            ? verifyRetainedWorkspace(original, receipt)
            : withSetup(original, receipt, copy(setup), true).pipe(Effect.asVoid);
        }),
      ),
    workspace: (snapshot: ProjectTeamDispatchSnapshot) =>
      provide(
        Effect.suspend(() => {
          const original = captureSnapshot(snapshot);
          return assertCurrent(original).pipe(
            Effect.andThen(readWorkspace(original)),
            Effect.flatMap((prior) => physicalWorkspace(original, prior ?? undefined)),
          );
        }),
      ),
    verifyWorkspace: (
      snapshot: ProjectTeamDispatchSnapshot,
      receipt: ManagedGit.ManagedWorkspaceReceipt,
    ) => provide(Effect.suspend(() => verifyWorkspace(captureSnapshot(snapshot), copy(receipt)))),
    setup: (snapshot: ProjectTeamDispatchSnapshot, receipt: ManagedGit.ManagedWorkspaceReceipt) =>
      provide(Effect.suspend(() => withSetup(captureSnapshot(snapshot), copy(receipt)))),
    verifySetup: (
      snapshot: ProjectTeamDispatchSnapshot,
      workspace: ManagedGit.ManagedWorkspaceReceipt,
      receipt: ProjectManagedSetupReceipt,
    ) =>
      provide(
        Effect.suspend(() =>
          withSetup(captureSnapshot(snapshot), copy(workspace), copy(receipt)),
        ).pipe(Effect.asVoid),
      ),
    reconcile: (snapshot: ProjectTeamDispatchSnapshot) =>
      provide(Effect.suspend(() => reconcile(captureSnapshot(snapshot)))),
  };
});
