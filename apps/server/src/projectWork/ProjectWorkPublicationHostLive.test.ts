import { assert, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
const layer = (
  records: ReadonlyArray<GuardedPublicationRecord>,
  supported = true,
  overrides: {
    readonly git?: Partial<Git.GitWorkflowService["Service"]>;
    readonly reviews?: Partial<Reviews.ProjectTeamReviewFreshness["Service"]>;
  } = {},
) => {
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
        Layer.mock(Git.GitWorkflowService)({
          invalidateStatus: () => Effect.void,
          ...overrides.git,
        }),
        Layer.mock(PullRequests.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
          invalidate: () => Effect.void,
        }),
        Layer.mock(Reviews.ProjectTeamReviewFreshness)({ ...overrides.reviews }),
        Sqlite.layerMemory,
        NodeServices.layer,
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
it.effect("capture refuses a reviewed target that is not its own repository's top level", () => {
  const worktree = "/task-folders/shop/project";
  const snapshot = {
    manifest: {
      projectId: decision.request.target.projectId,
      taskId: decision.source.taskId,
      target: { worktree, headSha: decision.source.headSha, baseSha: decision.source.baseSha },
    },
  } as unknown as Reviews.ReviewSnapshot;
  return Effect.gen(function* () {
    const host = yield* Host.ProjectWorkPublicationHost;
    const result = yield* host
      .capture({
        projectId: decision.request.target.projectId,
        source: decision.source,
        baseRef: "main",
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "not-ready");
  }).pipe(
    Effect.provide(
      layer([nativeRecord], true, {
        // A plain project folder inside a task folder: Git answers for an enclosing repository.
        git: { repositoryRoot: () => Effect.succeed("/task-folders") },
        reviews: {
          completedDispatch: () => Effect.succeed({ snapshot, proof: {} as never }),
          assertPhysical: () => Effect.void,
        },
      }),
    ),
  );
});

it.effect("capture accepts a worktree reached through a symlink, as Git reports it resolved", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-publication-root-" });
    const real = path.join(dir, "real");
    const worktree = path.join(dir, "link");
    yield* fs.makeDirectory(real);
    yield* fs.symlink(real, worktree);
    const snapshot = {
      manifest: {
        projectId: decision.request.target.projectId,
        taskId: decision.source.taskId,
        target: { worktree, headSha: decision.source.headSha, baseSha: decision.source.baseSha },
      },
    } as unknown as Reviews.ReviewSnapshot;
    const result = yield* Effect.gen(function* () {
      const host = yield* Host.ProjectWorkPublicationHost;
      return yield* host.capture({
        projectId: decision.request.target.projectId,
        source: decision.source,
        baseRef: "main",
      });
    }).pipe(
      Effect.result,
      Effect.provide(
        layer([nativeRecord], true, {
          // Git resolves symlinks in --show-toplevel.
          git: { repositoryRoot: () => fs.realPath(worktree).pipe(Effect.orDie) },
          reviews: {
            completedDispatch: () => Effect.succeed({ snapshot, proof: {} as never }),
            assertPhysical: () => Effect.void,
          },
        }),
      ),
    );
    assert.equal(result._tag, "Success");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
