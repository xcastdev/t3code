import * as NodeCrypto from "node:crypto";
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
  ProjectTeamWorkspaceEvidence,
  ProjectTeamIntegrationCombinationReceipt,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamIntegrationSources } from "./ProjectTeamIntegrationSources.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
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
const decodeEvidence = Schema.decodeUnknownEffect(ProjectTeamWorkspaceEvidence, {
  onExcessProperty: "error",
});
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
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
  const repository = yield* ProjectWorkRepository;
  const sources = yield* makeProjectTeamIntegrationSources({
    environmentId: options.environmentId,
  });
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
  const physicalWorkspace = Effect.fn("ProjectTeamWorkspace.physicalWorkspace")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    prior?: ManagedGit.ManagedWorkspaceReceipt,
  ) {
    const git = snapshot.intent.request.git;
    const context = yield* ManagedGit.make({
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
  const activeWorkspaces = new Map<
    string,
    {
      readonly snapshot: ProjectTeamDispatchSnapshot;
      readonly evidence: typeof ProjectTeamWorkspaceEvidence.Type;
    }
  >();
  const verifyWorkspace = Effect.fn("ProjectTeamWorkspace.verifyWorkspace")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    receipt: ManagedGit.ManagedWorkspaceReceipt,
  ) {
    yield* assertCurrent(snapshot);
    const retained = yield* readWorkspace(snapshot);
    if (!retained || !same(retained, receipt))
      return yield* denied("Workspace evidence does not match its original retained receipt");
    const active = activeWorkspaces.get(snapshot.fence.dispatchId);
    if (active && same(active.snapshot, snapshot) && same(active.evidence.workspace, receipt))
      return;
    yield* physicalWorkspace(snapshot, retained);
  });
  const assertSources = Effect.fn("ProjectTeamWorkspace.assertSources")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
  ) {
    const integration = snapshot.intent.integration;
    if (integration === undefined) return;
    const claim = snapshot.intent.compiledClaim.transition;
    if (claim?.kind !== "claim") return yield* denied("Integration binding is missing");
    yield* sql
      .withTransaction(
        sources.assertCurrentInTransaction({
          projectId: claim.binding.projectId,
          integrationTaskId: claim.binding.taskId,
          sources: integration.selection,
        }),
      )
      .pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ProjectWorkRepository, repository),
      );
  });
  const retainedEnvelope = Effect.fn("ProjectTeamWorkspace.retainedEnvelope")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
  ) {
    const history = yield* sql
      .withTransaction(dispatch.readHistoricalInTransaction(snapshot.fence.dispatchId))
      .pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ProjectWorkRepository, repository),
      );
    const receipts = history.receipts.filter((receipt) => receipt.stage === "workspace-ready");
    if (receipts.length === 0) return null;
    if (receipts.length !== 1) return yield* denied("Integration workspace stage is ambiguous");
    return yield* decodeEvidence(receipts[0]?.evidence);
  });
  const sourceContexts = Effect.fn("ProjectTeamWorkspace.sourceContexts")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    revalidate: Effect.Effect<
      void,
      | Effect.Error<ReturnType<typeof assertCurrent>>
      | Effect.Error<ReturnType<typeof assertSources>>
      | Effect.Error<ReturnType<typeof retainedEnvelope>>,
      | Effect.Services<ReturnType<typeof assertCurrent>>
      | Effect.Services<ReturnType<typeof assertSources>>
    >,
  ) {
    const selected = snapshot.intent.integration;
    if (!selected) return [];
    yield* assertSources(snapshot);
    return yield* Effect.forEach(selected.selection.sources, (source) =>
      Effect.gen(function* () {
        const history = yield* sql
          .withTransaction(dispatch.readHistoricalInTransaction(source.dispatchId))
          .pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectWorkRepository, repository),
          );
        const original = yield* readWorkspace(history.snapshot);
        if (
          !original ||
          digest(original) !== source.workspaceReceiptSha256 ||
          original.assignment.primaryRoot !== snapshot.intent.request.git.primaryRoot ||
          original.common.path !== snapshot.intent.request.git.commonGitDirectory
        )
          return yield* denied("Selected source physical repository or ownership changed");
        const context = yield* ManagedGit.make({
          assignment: history.snapshot.intent.request.git,
          priorReceipt: original,
          revalidate: revalidate.pipe(
            Effect.scoped,
            Effect.provide(services),
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  operation: "integration.source",
                  command: "/usr/bin/git",
                  cwd: original.assignment.worktreePath,
                  detail: "Selected source authority changed",
                  cause,
                }),
            ),
          ),
          persistWorkspace: () =>
            Effect.fail(
              new GitCommandError({
                operation: "integration.source",
                command: "/usr/bin/git",
                cwd: original.assignment.worktreePath,
                detail: "Source capture cannot replace ownership",
              }),
            ),
        });
        return { context, source };
      }),
    );
  });
  const withSources = <A, E, R>(
    contexts: Effect.Success<ReturnType<typeof sourceContexts>>,
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | GitCommandError, R> => {
    const next = contexts[0];
    if (!next) return use;
    return ManagedGit.withManagedVerificationTarget(next.context, (target) =>
      Effect.gen(function* () {
        if (
          target.baseSha !== next.source.baseSha ||
          target.headSha !== next.source.headSha ||
          target.testedTree !== next.source.testedTree ||
          digest(target.receipt) !== next.source.workspaceReceiptSha256
        )
          return yield* new GitCommandError({
            operation: "integration.source",
            command: "/usr/bin/git",
            cwd: target.cwd,
            detail: "Selected reviewed source commit changed",
          });
        return yield* withSources(contexts.slice(1), use);
      }),
    );
  };
  const withWorkspace = <A, E, R>(
    supplied: ProjectTeamDispatchSnapshot,
    use: (evidence: typeof ProjectTeamWorkspaceEvidence.Type) => Effect.Effect<A, E, R>,
  ) => {
    const original = captureSnapshot(supplied);
    return provide(
      Effect.gen(function* () {
        yield* assertCurrent(original);
        const prior = yield* readWorkspace(original);
        const retained = yield* retainedEnvelope(original);
        if (original.intent.integration !== undefined && prior !== null && retained === null)
          return yield* denied(
            "Integration ownership exists without a committed combination; uncertain combination cannot be repeated",
          );
        const workspace = yield* physicalWorkspace(original, prior ?? undefined);
        if (original.intent.integration === undefined)
          return yield* Effect.suspend(() => use(copy({ workspace })));
        const selection = original.intent.integration;
        let expected: typeof ProjectTeamWorkspaceEvidence.Type | undefined;
        const revalidate = Effect.gen(function* () {
          const actual = yield* dispatch.readRetained(original.fence.dispatchId);
          if (
            !same(actual.intent, original.intent) ||
            actual.fence.claimGeneration !== original.fence.claimGeneration ||
            (!same(actual.fence, original.fence) &&
              (actual.fence.stage !== "workspace-ready" ||
                actual.fence.revision !== original.fence.revision + 1))
          )
            return yield* denied("Integration capture fence changed");
          if (
            !same(actual.fence, original.fence) &&
            (!expected || !same(yield* retainedEnvelope(actual), expected))
          )
            return yield* denied("Integration stage did not retain the exact physical combination");
          yield* options.assertCurrent(actual);
          yield* assertSources(actual);
        });
        return yield* workflow.withRepositoryPermit(
          "integration.combine",
          workspace.assignment.primaryRoot,
          Effect.gen(function* () {
            const contexts = yield* sourceContexts(original, revalidate);
            const context = yield* ManagedGit.make({
              assignment: workspace.assignment,
              priorReceipt: workspace,
              revalidate: revalidate.pipe(
                Effect.scoped,
                Effect.provide(services),
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.mapError(
                  (cause) =>
                    new GitCommandError({
                      operation: "integration.combine",
                      command: "/usr/bin/git",
                      cwd: workspace.assignment.worktreePath,
                      detail: "Integration authority changed",
                      cause,
                    }),
                ),
              ),
              persistWorkspace: () =>
                Effect.fail(
                  new GitCommandError({
                    operation: "integration.combine",
                    command: "/usr/bin/git",
                    cwd: workspace.assignment.worktreePath,
                    detail: "Combination cannot replace original ownership",
                  }),
                ),
            });
            const persist = (target: ManagedGit.ManagedVerificationTarget) =>
              Effect.gen(function* () {
                const integration: typeof ProjectTeamIntegrationCombinationReceipt.Type =
                  retained?.integration ?? {
                    version: 1,
                    selectionSha256: selection.selectionSha256,
                    baseSha: target.baseSha,
                    combinedHeadSha: target.headSha,
                    combinedTree: target.testedTree,
                    sourceHeads: selection.selection.sources.map((source) => source.headSha),
                  };
                if (
                  integration.selectionSha256 !== selection.selectionSha256 ||
                  integration.baseSha !== workspace.assignment.baseOid ||
                  !same(
                    integration.sourceHeads,
                    selection.selection.sources.map((source) => source.headSha),
                  )
                )
                  return yield* denied("Integration stage selection changed");
                if (
                  retained &&
                  (target.headSha !== integration.combinedHeadSha ||
                    target.testedTree !== integration.combinedTree)
                )
                  return yield* denied("Retained original combined target changed before setup");
                const evidence = copy({ workspace, integration });
                expected = evidence;
                if (activeWorkspaces.has(original.fence.dispatchId))
                  return yield* denied("An original workspace capture is already active");
                activeWorkspaces.set(original.fence.dispatchId, { snapshot: original, evidence });
                return yield* Effect.suspend(() => use(evidence)).pipe(
                  Effect.ensuring(
                    Effect.sync(() => activeWorkspaces.delete(original.fence.dispatchId)),
                  ),
                );
              });
            if (retained && !retained.integration)
              return yield* denied("Integration dispatch is missing its combination receipt");
            return yield* withSources(
              contexts,
              retained?.integration
                ? ManagedGit.withManagedVerificationAncestry(
                    context,
                    {
                      requiredHeads: [
                        retained.integration.combinedHeadSha,
                        ...retained.integration.sourceHeads,
                      ],
                    },
                    persist,
                  )
                : ManagedGit.withManagedIntegrationTarget(
                    context,
                    {
                      baseSha: workspace.assignment.baseOid,
                      sourceHeads: selection.selection.sources.map((source) => source.headSha),
                    },
                    persist,
                  ),
            );
          }),
        );
      }),
    );
  };
  const verifyIntegration = Effect.fn("ProjectTeamWorkspace.verifyIntegration")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
    combination: typeof ProjectTeamIntegrationCombinationReceipt.Type,
  ) {
    yield* assertCurrent(snapshot);
    yield* assertSources(snapshot);
    const active = activeWorkspaces.get(snapshot.fence.dispatchId);
    if (active && same(active.snapshot, snapshot) && same(active.evidence.integration, combination))
      return;
    const retained = yield* retainedEnvelope(snapshot);
    if (
      !retained?.integration ||
      !same(retained.integration, combination) ||
      combination.selectionSha256 !== snapshot.intent.integration?.selectionSha256
    )
      return yield* denied("Original combination stage changed");
    const revalidate = assertCurrent(snapshot).pipe(Effect.andThen(assertSources(snapshot)));
    return yield* workflow.withRepositoryPermit(
      "integration.verify",
      retained.workspace.assignment.primaryRoot,
      Effect.gen(function* () {
        const contexts = yield* sourceContexts(snapshot, revalidate);
        const context = yield* ManagedGit.make({
          assignment: retained.workspace.assignment,
          priorReceipt: retained.workspace,
          revalidate: revalidate.pipe(
            Effect.scoped,
            Effect.provide(services),
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  operation: "integration.verify",
                  command: "/usr/bin/git",
                  cwd: retained.workspace.assignment.worktreePath,
                  detail: "Integration authority changed",
                  cause,
                }),
            ),
          ),
          persistWorkspace: () =>
            Effect.fail(
              new GitCommandError({
                operation: "integration.verify",
                command: "/usr/bin/git",
                cwd: retained.workspace.assignment.worktreePath,
                detail: "Read cannot replace ownership",
              }),
            ),
        });
        yield* withSources(
          contexts,
          ManagedGit.withManagedVerificationAncestry(
            context,
            { requiredHeads: [combination.combinedHeadSha, ...combination.sourceHeads] },
            () => Effect.void,
          ),
        );
      }),
    );
  });
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
  ) {
    yield* verifyWorkspace(snapshot, workspace);
    const envelope = yield* retainedEnvelope(snapshot);
    if (snapshot.intent.integration !== undefined) {
      if (!envelope?.integration)
        return yield* denied("Setup requires its retained original combination");
      yield* verifyIntegration(snapshot, envelope.integration);
    }
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
              yield* verifyWorkspace(snapshot, workspace);
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
        const receipt = yield* runtime.execute(input);
        yield* verifyRetainedSetup(input, receipt);
        yield* verifyWorkspace(snapshot, workspace);
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
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provide(services));
  return {
    withWorkspace,
    workspace: (snapshot: ProjectTeamDispatchSnapshot) => withWorkspace(snapshot, Effect.succeed),
    verifyIntegration: (
      snapshot: ProjectTeamDispatchSnapshot,
      combination: typeof ProjectTeamIntegrationCombinationReceipt.Type,
    ) =>
      provide(
        Effect.suspend(() => verifyIntegration(captureSnapshot(snapshot), copy(combination))),
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
