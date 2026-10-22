import {
  canonicalProjectWorkPayload,
  SourceControlProviderError,
  SourceControlProviderKind,
  type ProjectWorkPublicationOutcome,
} from "@t3tools/contracts";
import type {
  GuardedPublicationTarget,
  GuardedPublicationRecord,
} from "@t3tools/source-control-core/server/SourceControlProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Registry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Reviews from "./ProjectTeamReviewFreshness.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import * as Host from "./ProjectWorkPublicationHost.ts";
import {
  PublicationError,
  publicationHash,
  type PublicationDecision,
  type DeliveryOperation,
  type MergeConfirmation,
} from "./ProjectWorkPublicationJournal.ts";
const isPublicationError = Schema.is(PublicationError);
const boundary = (cause: unknown) =>
  isPublicationError(cause) ? cause : new PublicationError({ reason: "uncertain", cause });
const nativeTarget = (decision: PublicationDecision): GuardedPublicationTarget => ({
  host: decision.request.repository.host,
  repository: {
    nodeId: decision.request.repository.nodeId,
    nameWithOwner: decision.request.repository.nameWithOwner,
  },
  account: decision.account,
  baseRef: decision.request.target.baseRef,
  baseSha: decision.request.target.baseSha,
  headRef: decision.request.target.headRef.replace(/^refs\/heads\//u, ""),
  headSha: decision.request.target.headSha,
  headRepositoryNodeId: decision.request.target.headRepositoryNodeId,
  headSelector: decision.request.target.headSelector,
});
const exact = (decision: PublicationDecision, record: GuardedPublicationRecord) =>
  canonicalProjectWorkPayload(nativeTarget(decision)) ===
    canonicalProjectWorkPayload(record.target) && record.marker === decision.request.marker;
const make = Effect.gen(function* () {
  const registry = yield* Registry.SourceControlProviderRegistry;
  const sql = yield* SqlClient.SqlClient;
  const reviews = yield* Reviews.ProjectTeamReviewFreshness;
  const git = yield* Git.GitWorkflowService;
  const pullRequests = yield* PullRequests.PullRequestService;
  const capture: Host.ProjectWorkPublicationHost["Service"]["capture"] = Effect.fn(
    "ProjectWorkPublicationHost.capture",
  )(function* (input) {
    const state = yield* readCurrentState(sql, input.projectId);
    const { snapshot } = yield* reviews.completedDispatch(state, input.source.reviewDispatchId);
    yield* reviews.assertPhysical(input.projectId, input.source.jobId);
    const cwd = snapshot.manifest.target.worktree;
    if (
      snapshot.manifest.target.headSha !== input.source.headSha ||
      snapshot.manifest.target.baseSha !== input.source.baseSha ||
      snapshot.manifest.projectId !== input.projectId ||
      snapshot.manifest.taskId !== input.source.taskId
    )
      return yield* new PublicationError({ reason: "stale" });
    const handle = yield* registry.resolveHandle({ cwd });
    const api = handle.provider.guardedPublication;
    if (!api) return yield* new PublicationError({ reason: "unsupported" });
    const target = yield* api.capture({
      cwd,
      ...(handle.context ? { context: handle.context } : {}),
      baseRef: input.baseRef,
      headRef: input.source.branchRef.replace(/^refs\/heads\//u, ""),
    });
    if (target.headSha !== input.source.headSha || target.baseSha !== input.source.baseSha)
      return yield* new PublicationError({ reason: "stale" });
    return {
      cwd,
      providerId: handle.provider.kind,
      account: target.account,
      repository: { host: target.host, ...target.repository },
      headRepositoryNodeId: target.headRepositoryNodeId,
      headSelector: target.headSelector,
      baseRef: target.baseRef,
    };
  }, Effect.mapError(boundary));
  const resolve = Effect.fn("ProjectWorkPublicationHost.resolve")(function* (
    decision: PublicationDecision,
  ) {
    const handle = yield* registry.resolveHandle({ cwd: decision.cwd });
    if (handle.provider.kind !== decision.providerId || !handle.provider.guardedPublication)
      return yield* new PublicationError({ reason: "unsupported" });
    return handle.provider.guardedPublication;
  }, Effect.mapError(boundary));
  const assertCurrent = Effect.fn("ProjectWorkPublicationHost.assertCurrent")(function* (
    decision: PublicationDecision,
  ) {
    const current = yield* capture({
      projectId: decision.request.target.projectId,
      source: decision.source,
      baseRef: decision.request.target.baseRef,
    });
    const local = yield* git.localStatus({ cwd: decision.cwd });
    if (
      !local.isRepo ||
      local.hasWorkingTreeChanges ||
      local.refName !== decision.source.branchRef.replace(/^refs\/heads\//u, "") ||
      current.cwd !== decision.cwd ||
      current.providerId !== decision.providerId ||
      canonicalProjectWorkPayload(current.repository) !==
        canonicalProjectWorkPayload(decision.request.repository) ||
      canonicalProjectWorkPayload(current.account) !== canonicalProjectWorkPayload(decision.account)
    )
      return yield* new PublicationError({ reason: "stale" });
  }, Effect.mapError(boundary));
  const refresh = Effect.fn("ProjectWorkPublicationHost.refresh")(function* (
    operation: DeliveryOperation,
    number: number,
  ) {
    yield* git.invalidateStatus(operation.decision.cwd);
    yield* pullRequests.refreshAfterTurn(operation.decision.request.target.projectId);
    yield* pullRequests.invalidate(
      {
        reference: {
          projectId: operation.decision.request.target.projectId,
          host: operation.decision.request.repository.host,
          repository: operation.decision.request.repository.nameWithOwner,
          number,
        },
      },
      { notifyReaders: true },
    );
  });
  const observation = Effect.fn("ProjectWorkPublicationHost.observation")(function* (
    operation: DeliveryOperation,
    records: ReadonlyArray<GuardedPublicationRecord>,
  ): Effect.fn.Return<ProjectWorkPublicationOutcome> {
    const common = {
      version: 1 as const,
      operationId: operation.operationId,
      requestHash: publicationHash(operation.decision.request),
      claimGeneration: 1,
      observedAt: DateTime.formatIso(yield* DateTime.now),
    };
    if (records.length !== 1)
      return {
        ...common,
        kind: "uncertain",
        reason: records.length === 0 ? "missing-match" : "ambiguous-match",
      };
    const record = records[0]!;
    if (!exact(operation.decision, record))
      return { ...common, kind: "uncertain", reason: "changed-identity" };
    yield* refresh(operation, record.number);
    return {
      ...common,
      kind: "confirmed",
      marker: record.marker,
      repository: operation.decision.request.repository,
      pullRequest: {
        nodeId: record.nodeId,
        number: record.number,
        url: record.url,
        state: record.state,
        baseSha: record.target.baseSha,
        headSha: record.target.headSha,
        baseRef: record.target.baseRef,
        headRef: operation.decision.request.target.headRef,
        headRepositoryNodeId: record.target.headRepositoryNodeId,
      },
    };
  });
  const reconcilePublication = Effect.fn("ProjectWorkPublicationHost.reconcilePublication")(
    function* (operation: DeliveryOperation) {
      const api = yield* resolve(operation.decision);
      const records = yield* api.read({
        cwd: operation.decision.cwd,
        target: nativeTarget(operation.decision),
        marker: operation.decision.request.marker,
      });
      return yield* observation(operation, records);
    },
    Effect.mapError(boundary),
  );
  const create = Effect.fn("ProjectWorkPublicationHost.create")(function* (
    operation: DeliveryOperation,
    assertHuman: Effect.Effect<void, PublicationError>,
  ) {
    yield* assertCurrent(operation.decision);
    const api = yield* resolve(operation.decision);
    const record = yield* api.create({
      cwd: operation.decision.cwd,
      target: nativeTarget(operation.decision),
      marker: operation.decision.request.marker,
      title: operation.decision.request.title,
      body: operation.decision.request.body,
      beforeWrite: assertHuman.pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make(operation.decision.providerId),
              operation: "createPublication",
              cwd: operation.decision.cwd,
              detail: "Human publication authority expired.",
              cause,
            }),
        ),
      ),
    });
    return yield* observation(operation, [record]);
  }, Effect.mapError(boundary));
  const supportsExactMerge = Effect.fn("ProjectWorkPublicationHost.supportsExactMerge")(function* (
    operation: DeliveryOperation,
  ) {
    yield* resolve(operation.decision);
    if (operation.publication?.kind !== "confirmed") return false;
    const detail = yield* pullRequests.detail({
      projectId: operation.decision.request.target.projectId,
      host: operation.decision.request.repository.host,
      repository: operation.decision.request.repository.nameWithOwner,
      number: operation.publication.pullRequest.number,
      expectedAccountId: operation.decision.account.accountId,
      allowStale: false,
    });
    const method = operation.decision.gate.mergeMethod;
    return (
      detail.provider === operation.decision.providerId &&
      detail.headSha === operation.decision.request.target.headSha &&
      detail.baseBranch === operation.decision.request.target.baseRef &&
      detail.capabilities.actions.includes("merge") &&
      detail.viewerPermissions.actions.includes("merge") &&
      method !== undefined &&
      detail.mergeCapabilities[method]
    );
  }, Effect.mapError(boundary));
  const toMerge = (
    operation: DeliveryOperation,
    record: GuardedPublicationRecord,
  ): MergeConfirmation | undefined =>
    exact(operation.decision, record) &&
    operation.publication?.kind === "confirmed" &&
    record.nodeId === operation.publication.pullRequest.nodeId &&
    record.number === operation.publication.pullRequest.number &&
    record.state === "MERGED" &&
    record.mergedAt &&
    record.mergedCommitSha
      ? {
          providerId: operation.decision.providerId,
          host: record.target.host,
          repositoryNodeId: record.target.repository.nodeId,
          repository: record.target.repository.nameWithOwner,
          number: record.number,
          authorizedHeadSha: record.target.headSha,
          baseSha: record.target.baseSha,
          baseRef: record.target.baseRef,
          mergedCommitSha: record.mergedCommitSha,
          mergedAt: record.mergedAt,
        }
      : undefined;
  const reconcileMerge = Effect.fn("ProjectWorkPublicationHost.reconcileMerge")(function* (
    operation: DeliveryOperation,
  ) {
    const api = yield* resolve(operation.decision);
    if (operation.publication?.kind !== "confirmed") return undefined;
    const records = yield* api.read({
      cwd: operation.decision.cwd,
      target: nativeTarget(operation.decision),
      marker: operation.decision.request.marker,
      number: operation.publication.pullRequest.number,
    });
    const confirmation = records.length === 1 ? toMerge(operation, records[0]!) : undefined;
    if (confirmation) yield* refresh(operation, confirmation.number);
    return confirmation;
  }, Effect.mapError(boundary));
  const mergeExact = Effect.fn("ProjectWorkPublicationHost.mergeExact")(function* (
    operation: DeliveryOperation,
    assertHuman: Effect.Effect<void, PublicationError>,
  ) {
    if (
      !(yield* supportsExactMerge(operation)) ||
      operation.publication?.kind !== "confirmed" ||
      !operation.decision.gate.mergeMethod
    )
      return yield* new PublicationError({ reason: "unsupported" });
    const api = yield* resolve(operation.decision);
    const record = yield* api.merge({
      cwd: operation.decision.cwd,
      target: nativeTarget(operation.decision),
      marker: operation.decision.request.marker,
      number: operation.publication.pullRequest.number,
      method: operation.decision.gate.mergeMethod,
      beforeWrite: assertHuman.pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make(operation.decision.providerId),
              operation: "mergePublication",
              cwd: operation.decision.cwd,
              detail: "Human merge authority expired.",
              cause,
            }),
        ),
      ),
    });
    const confirmation = toMerge(operation, record);
    if (!confirmation) return yield* new PublicationError({ reason: "uncertain" });
    yield* refresh(operation, record.number);
    return confirmation;
  }, Effect.mapError(boundary));
  return Host.ProjectWorkPublicationHost.of({
    capture,
    assertCurrent,
    create,
    reconcilePublication,
    supportsExactMerge,
    mergeExact,
    reconcileMerge,
  });
});
export const layer = Layer.effect(Host.ProjectWorkPublicationHost, make);
