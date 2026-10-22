import { assert, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  GuardedPublicationRecord,
  GuardedPublicationApi,
} from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Registry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Reviews from "./ProjectTeamReviewFreshness.ts";
import * as Host from "./ProjectWorkPublicationHost.ts";
import * as Live from "./ProjectWorkPublicationHostLive.ts";
import { decision, operation, at } from "./ProjectWorkPublication.testkit.ts";
const nativeRecord: GuardedPublicationRecord = {
  nodeId: "pull",
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  state: "OPEN",
  marker: decision.request.marker,
  target: {
    host: "github.com",
    repository: { nodeId: "repository", nameWithOwner: "owner/repo" },
    account: decision.account,
    baseRef: "main",
    baseSha: decision.source.baseSha,
    headRef: "feature",
    headSha: decision.source.headSha,
    headRepositoryNodeId: "repository",
    headSelector: "feature",
  },
  mergedAt: null,
  mergedCommitSha: null,
};
const layer = (records: ReadonlyArray<GuardedPublicationRecord>, supported = true) => {
  const guardedPublication: GuardedPublicationApi = {
    capture: () => Effect.succeed(nativeRecord.target),
    read: () => Effect.succeed(records),
    create: () => Effect.succeed(nativeRecord),
    merge: () => Effect.succeed(nativeRecord),
  };
  return Live.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Registry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          resolveHandle: () =>
            Effect.succeed({
              context: null,
              provider: {
                kind: SourceControlProviderKind.make("github"),
                ...(supported ? { guardedPublication } : {}),
                listChangeRequests: () => Effect.succeed([]),
                getChangeRequest: () => Effect.die("unused"),
                createChangeRequest: () => Effect.die("unused"),
                getRepositoryCloneUrls: () => Effect.die("unused"),
                createRepository: () => Effect.die("unused"),
                getDefaultBranch: () => Effect.succeed("main"),
                checkoutChangeRequest: () => Effect.die("unused"),
              },
            }),
        }),
        Layer.mock(Git.GitWorkflowService)({ invalidateStatus: () => Effect.void }),
        Layer.mock(PullRequests.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
          invalidate: () => Effect.void,
        }),
        Layer.mock(Reviews.ProjectTeamReviewFreshness)({}),
        Sqlite.layerMemory,
      ),
    ),
  );
};
it.effect("reconciliation keeps native repository and both heads exact", () =>
  Effect.gen(function* () {
    const host = yield* Host.ProjectWorkPublicationHost;
    const receipt = yield* host.reconcilePublication(operation());
    assert.equal(receipt.kind, "confirmed");
    if (receipt.kind === "confirmed") {
      assert.equal(receipt.repository.nodeId, "repository");
      assert.equal(receipt.pullRequest.baseSha, decision.source.baseSha);
      assert.equal(receipt.pullRequest.headSha, decision.source.headSha);
    }
  }).pipe(Effect.provide(layer([nativeRecord]))),
);
it.effect("a remote head move remains uncertain and never becomes a merge proof", () =>
  Effect.gen(function* () {
    const host = yield* Host.ProjectWorkPublicationHost;
    assert.equal((yield* host.reconcilePublication(operation())).kind, "uncertain");
    assert.equal(yield* host.reconcileMerge(operation("merge")), undefined);
  }).pipe(
    Effect.provide(
      layer([
        {
          ...nativeRecord,
          target: { ...nativeRecord.target, headSha: "f".repeat(40) },
          state: "MERGED",
          mergedAt: at,
          mergedCommitSha: "e".repeat(40),
        },
      ]),
    ),
  ),
);
it.effect("unsupported native providers refuse guarded publication without fallback writes", () =>
  Effect.gen(function* () {
    const host = yield* Host.ProjectWorkPublicationHost;
    const result = yield* host.reconcilePublication(operation()).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "unsupported");
  }).pipe(Effect.provide(layer([], false))),
);
