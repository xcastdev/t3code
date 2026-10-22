import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as GitHubIssueApi from "@t3tools/source-control-github/server/GitHubIssueApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Identity from "../project/RepositoryIdentityResolver.ts";
import * as Search from "./IssueSearchService.ts";

const projectId = ProjectId.make("search-project");
const account = {
  host: "github.enterprise.test",
  accountId: "12",
  viewer: "viewer",
  credentialFingerprint: "pin",
};
const repository = {
  host: account.host,
  nodeId: "repo-1",
  nameWithOwner: "owner/repo",
  url: `https://${account.host}/owner/repo`,
  updatedAt: "2026-10-01T00:00:00Z",
};
const entry = {
  number: 1,
  title: "An issue",
  url: `${repository.url}/issues/1`,
  state: "open" as const,
};
function harness(
  options: { readonly active?: boolean; readonly provider?: string; readonly move?: boolean } = {},
) {
  const calls: unknown[] = [];
  let reads = 0;
  const base = Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.sync(() => {
          reads++;
          return options.active === false
            ? Option.none()
            : Option.some({
                projectId,
                title: "Search",
                workspaceRoot: options.move && reads > 1 ? "/moved" : "/server/project",
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-10-01T00:00:00Z",
                deletedAt: null,
              });
        }),
    }),
    Layer.succeed(Identity.RepositoryIdentityResolver, {
      resolve: (cwd) =>
        Effect.sync(() => {
          calls.push(cwd);
          return {
            canonicalKey: `${account.host}/owner/repo`,
            provider: options.provider ?? "github",
            displayName: "owner/repo",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: repository.url,
            },
          };
        }),
    }),
    Layer.mock(GitHubIssueApi.GitHubIssueApi)({
      getAccount: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return account;
        }),
      lookupRepository: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return { status: "changed" as const, etag: null, data: repository };
        }),
      searchIssues: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return [entry];
        }),
    }),
  );
  return { calls, layer: Search.layer.pipe(Layer.provide(base)) };
}

describe("IssueSearchService", () => {
  it.effect("uses the current project's workspace and native host/account binding", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const service = yield* Search.IssueSearchService;
      expect(yield* service.search({ projectId, query: "broken" })).toEqual({ entries: [entry] });
      expect(calls).toContainEqual({ cwd: "/server/project", host: account.host });
      expect(calls).toContainEqual({
        cwd: "/server/project",
        account,
        repository,
        query: "broken",
      });
    }).pipe(Effect.provide(layer));
  });
  it.effect("does not contact GitHub for missing projects or unsupported hosts", () =>
    Effect.gen(function* () {
      for (const options of [{ active: false }, { provider: "gitlab" }]) {
        const { layer, calls } = harness(options);
        const error = yield* Effect.gen(function* () {
          const service = yield* Search.IssueSearchService;
          return yield* Effect.flip(service.search({ projectId, query: "" }));
        }).pipe(Effect.provide(layer));
        expect(error._tag).toBe(
          options.active === false ? "PullRequestOperationError" : "PullRequestUnavailableError",
        );
        expect(calls.every((call) => typeof call === "string")).toBe(true);
      }
    }),
  );
  it.effect("rejects results if the project moves while the native read runs", () => {
    const { layer } = harness({ move: true });
    return Effect.gen(function* () {
      const service = yield* Search.IssueSearchService;
      expect((yield* Effect.flip(service.search({ projectId, query: "" })))._tag).toBe(
        "PullRequestOperationError",
      );
    }).pipe(Effect.provide(layer));
  });
});
