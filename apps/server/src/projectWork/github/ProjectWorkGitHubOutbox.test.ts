import {
  ProjectId,
  ProjectWorkTaskId,
  type ProjectWorkPublicationRequest,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitHubCli from "../../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as Outbox from "./ProjectWorkGitHubOutbox.ts";

const request: ProjectWorkPublicationRequest = {
  version: 1,
  kind: "create-pr",
  operationId: "publication-one",
  marker: "opaque-marker-one",
  repository: { host: "github.com", nodeId: "R_base", nameWithOwner: "owner/repo" },
  target: {
    projectId: ProjectId.make("publication-project"),
    taskId: ProjectWorkTaskId.make("publication-task"),
    specRevision: 2,
    planRevision: 3,
    scopeHash: "scope-one",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    headRef: "feature",
    headRepositoryNodeId: "R_head",
    headSelector: "contributor:feature",
  },
  expectedTaskRevision: 4,
  authorizationRecordIds: ["retained-proof-one"],
  title: "Repair the task",
  body: "Verified change.",
};
const credential: Outbox.PublicationCredential = {
  cwd: "/disposable/publication",
  host: "github.com",
  repositoryNodeId: "R_base",
  headRepositoryNodeId: "R_head",
  credentialFingerprint: "synthetic-account-epoch",
  token: Redacted.make("synthetic-token"),
};
const pullRequest = () => ({
  node_id: "PR_one",
  number: 42,
  html_url: "https://github.com/owner/repo/pull/42",
  state: "open",
  merged_at: null,
  body: "Verified change.\n\n<!-- t3-project-work-publication:v1:opaque-marker-one -->",
  base: { sha: "a".repeat(40), ref: "main", repo: { node_id: "R_base", full_name: "owner/repo" } },
  head: { sha: "b".repeat(40), ref: "feature", repo: { node_id: "R_head" } },
});
const output = (body: unknown, exitCode = 0): VcsProcess.VcsProcessOutput => ({
  stdout: JSON.stringify(body),
  stderr: "",
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdoutTruncated: false,
  stderrTruncated: false,
});
const refs = () => ({
  data: {
    base: {
      id: "R_base",
      nameWithOwner: "owner/repo",
      ref: { name: "main", target: { oid: "a".repeat(40) } },
    },
    head: {
      id: "R_head",
      nameWithOwner: "contributor/fork",
      ref: { name: "feature", target: { oid: "b".repeat(40) } },
    },
  },
});
const provide = <A, E>(
  effect: Effect.Effect<A, E, GitHubCli.GitHubCli>,
  run: VcsProcess.VcsProcess["Service"]["run"],
) => effect.pipe(Effect.provide(GitHubCli.layer.pipe(EffectLayer(run))));
const EffectLayer = (run: VcsProcess.VcsProcess["Service"]["run"]) =>
  Layer.provide(Layer.succeed(VcsProcess.VcsProcess, VcsProcess.VcsProcess.of({ run })));
const serve =
  (
    rows: unknown,
    changes: Partial<VcsProcess.VcsProcessOutput> = {},
  ): VcsProcess.VcsProcess["Service"]["run"] =>
  (input) =>
    Effect.succeed(
      input.args.includes("graphql")
        ? output(refs())
        : input.args.at(-1) === "repos/owner/repo"
          ? output({ node_id: "R_base", full_name: "owner/repo" })
          : { ...output(rows), ...changes },
    );

describe("ProjectWorkGitHubOutbox", () => {
  it.effect("sends canonical creation JSON through gh's explicit stdin input", () => {
    let created = false;
    let writes = 0;
    const body =
      '{"base":"main","body":"Verified change.\\n\\n<!-- t3-project-work-publication:v1:opaque-marker-one -->","head":"contributor:feature","title":"Repair the task"}';
    const run: VcsProcess.VcsProcess["Service"]["run"] = (input) => {
      if (input.args.includes("graphql")) {
        expect(input.args).not.toContain("--input");
        expect(input.stdin).toBeUndefined();
        return Effect.succeed(output(refs()));
      }
      if (input.args.includes("POST")) {
        writes++;
        if (input.args.at(-2) !== "--input" || input.args.at(-1) !== "-" || input.stdin !== body)
          return Effect.succeed(output({ message: "Creation JSON was not consumed" }, 1));
        created = true;
        return Effect.succeed(output({}));
      }
      return serve(created ? [pullRequest()] : [])(input);
    };
    return provide(
      Effect.gen(function* () {
        const outbox = yield* Outbox.make();
        expect(yield* outbox.create(request, credential, 1)).toMatchObject({
          kind: "confirmed",
          pullRequest: { number: 42 },
        });
        expect(writes).toBe(1);
      }),
      run,
    );
  });
  it.effect("captures the request and credential before asynchronous remote reads", () => {
    const next = {
      ...request,
      target: { ...request.target },
      authorizationRecordIds: [...request.authorizationRecordIds],
    };
    const nextCredential = { ...credential };
    let entered: Deferred.Deferred<void>;
    let resume: Deferred.Deferred<void>;
    let paused = false;
    let writes = 0;
    const run: VcsProcess.VcsProcess["Service"]["run"] = (input) =>
      Effect.gen(function* () {
        expect(input.cwd).toBe("/disposable/publication");
        expect(input.env?.GH_HOST).toBe("github.com");
        if (!paused && input.args.at(-1) === "repos/owner/repo") {
          paused = true;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
        }
        if (input.args.includes("POST")) {
          writes++;
          expect(input.stdin).toContain('"title":"Repair the task"');
          expect(input.stdin).toContain("opaque-marker-one");
          return output({});
        }
        return yield* serve(writes > 0 ? [pullRequest()] : [])(input);
      });
    return provide(
      Effect.scoped(
        Effect.gen(function* () {
          entered = yield* Deferred.make<void>();
          resume = yield* Deferred.make<void>();
          const outbox = yield* Outbox.make();
          const fiber = yield* Effect.forkScoped(outbox.create(next, nextCredential, 1));
          yield* Deferred.await(entered);
          next.marker = "changed-marker-one";
          next.title = "Changed after authorization";
          next.target.headSha = "c".repeat(40);
          nextCredential.host = "other.example";
          nextCredential.cwd = "/changed";
          yield* Deferred.succeed(resume, undefined);
          expect(yield* Fiber.join(fiber)).toMatchObject({
            kind: "confirmed",
            marker: "opaque-marker-one",
          });
          expect(writes).toBe(1);
        }),
      ),
      run,
    );
  });
  it.effect(
    "reconciles a created PR after its mutation response is lost without creating twice",
    () => {
      let writes = 0;
      let created = false;
      const run: VcsProcess.VcsProcess["Service"]["run"] = (input) =>
        Effect.sync(() => {
          if (input.args.includes("graphql")) return output(refs());
          if (input.args.includes("POST")) {
            writes++;
            created = true;
            return { ...output({ error: "lost response" }, 1), stdoutTruncated: true };
          }
          if (input.args.at(-1) === "repos/owner/repo")
            return output({ node_id: "R_base", full_name: "owner/repo" });
          return output(created ? [pullRequest()] : []);
        });
      return provide(
        Effect.gen(function* () {
          const outbox = yield* Outbox.make();
          const result = yield* outbox.create(request, credential, 1);
          expect(result).toMatchObject({
            kind: "confirmed",
            operationId: "publication-one",
            pullRequest: { number: 42, headSha: "b".repeat(40) },
          });
          const recovered = yield* outbox.reconcile(request, credential, 1);
          expect(recovered.kind).toBe("confirmed");
          expect(writes).toBe(1);
        }),
        run,
      );
    },
  );
  for (const side of ["base", "head"] as const)
    it.effect(`does not create after the remote ${side} commit changes`, () => {
      let writes = 0;
      return provide(
        Effect.gen(function* () {
          const outbox = yield* Outbox.make();
          expect(yield* outbox.create(request, credential, 1)).toMatchObject({
            kind: "uncertain",
            reason: "changed-identity",
          });
          expect(writes).toBe(0);
        }),
        (input) => {
          if (input.args.includes("graphql")) {
            const changed = refs();
            changed.data[side].ref.target.oid = "c".repeat(40);
            return Effect.succeed(output(changed));
          }
          if (input.args.includes("POST")) {
            writes++;
            return Effect.succeed(output({}));
          }
          return serve(writes > 0 ? [pullRequest()] : [])(input);
        },
      );
    });
  for (const replacement of [
    { ...refs(), data: { ...refs().data, head: { ...refs().data.head, id: "R_other" } } },
    {
      ...refs(),
      data: { ...refs().data, head: { ...refs().data.head, nameWithOwner: "other/fork" } },
    },
    {
      ...refs(),
      data: { ...refs().data, base: { ...refs().data.base, nameWithOwner: "other/repo" } },
    },
    { ...refs(), data: { ...refs().data, head: null } },
  ])
    it.effect("does not create with changed remote repository or selector identity", () =>
      provide(
        Effect.gen(function* () {
          const outbox = yield* Outbox.make();
          expect(yield* outbox.create(request, credential, 1)).toMatchObject({
            kind: "uncertain",
            reason: "changed-identity",
          });
        }),
        (input) => {
          expect(input.args).not.toContain("POST");
          return input.args.includes("graphql")
            ? Effect.succeed(output(replacement))
            : serve([])(input);
        },
      ),
    );
  for (const state of ["open", "closed", "merged"] as const) {
    it.effect(`confirms retained publication in ${state} state without creating`, () => {
      const pr = {
        ...pullRequest(),
        state: state === "open" ? "open" : "closed",
        merged_at: state === "merged" ? "2026-10-05T00:00:00Z" : null,
      };
      return provide(
        Effect.gen(function* () {
          const outbox = yield* Outbox.make();
          const result = yield* outbox.reconcile(request, credential, 1);
          expect(result).toMatchObject({
            kind: "confirmed",
            pullRequest: { state: state.toUpperCase() },
          });
        }),
        serve([pr]),
      );
    });
  }
  const changed = [
    [
      "head SHA",
      () => ({ ...pullRequest(), head: { ...pullRequest().head, sha: "c".repeat(40) } }),
    ],
    [
      "base SHA",
      () => ({ ...pullRequest(), base: { ...pullRequest().base, sha: "c".repeat(40) } }),
    ],
    [
      "head repository",
      () => ({ ...pullRequest(), head: { ...pullRequest().head, repo: { node_id: "R_other" } } }),
    ],
    [
      "base repository",
      () => ({
        ...pullRequest(),
        base: { ...pullRequest().base, repo: { node_id: "R_other", full_name: "owner/repo" } },
      }),
    ],
    [
      "repository name",
      () => ({
        ...pullRequest(),
        base: { ...pullRequest().base, repo: { node_id: "R_base", full_name: "other/repo" } },
      }),
    ],
    ["head ref", () => ({ ...pullRequest(), head: { ...pullRequest().head, ref: "other" } })],
    ["base ref", () => ({ ...pullRequest(), base: { ...pullRequest().base, ref: "other" } })],
    [
      "URL host",
      () => ({ ...pullRequest(), html_url: "https://other.example/owner/repo/pull/42" }),
    ],
    [
      "URL PR number",
      () => ({ ...pullRequest(), html_url: "https://github.com/owner/repo/pull/43" }),
    ],
  ] as const;
  for (const [name, makePr] of changed)
    it.effect(`leaves changed ${name} uncertain without another write`, () =>
      provide(
        Effect.gen(function* () {
          const outbox = yield* Outbox.make();
          expect(yield* outbox.create(request, credential, 1)).toMatchObject({
            kind: "uncertain",
            reason: "changed-identity",
          });
        }),
        (input) => {
          expect(input.args).not.toContain("POST");
          return serve([makePr()])(input);
        },
      ),
    );
  for (const [name, rows] of [
    ["missing state", [{ ...pullRequest(), state: undefined }]],
    ["unknown state", [{ ...pullRequest(), state: "unknown" }]],
    ["missing body", [{ ...pullRequest(), body: undefined }]],
    ["missing merge observation", [{ ...pullRequest(), merged_at: undefined }]],
    ["malformed unrelated row", [pullRequest(), { number: 7 }]],
  ] as const)
    it.effect(`does not silently normalize ${name}`, () =>
      provide(
        Effect.gen(function* () {
          const outbox = yield* Outbox.make();
          expect(yield* outbox.reconcile(request, credential, 1)).toMatchObject({
            kind: "uncertain",
            reason: "incomplete-response",
          });
        }),
        serve(rows),
      ),
    );
  for (const rows of [
    [pullRequest(), { ...pullRequest(), number: 43 }],
    [{ ...pullRequest(), body: `${pullRequest().body}\n${pullRequest().body}` }],
  ])
    it.effect("rejects ambiguous retained markers without creating", () =>
      provide(
        Effect.gen(function* () {
          const outbox = yield* Outbox.make();
          expect(yield* outbox.create(request, credential, 1)).toMatchObject({
            kind: "uncertain",
            reason: "ambiguous-match",
          });
        }),
        (input) => {
          expect(input.args).not.toContain("POST");
          return serve(rows)(input);
        },
      ),
    );
  it.effect("does not adopt an unmarked existing PR for the requested branch", () =>
    provide(
      Effect.gen(function* () {
        const outbox = yield* Outbox.make();
        expect(yield* outbox.create(request, credential, 1)).toMatchObject({
          kind: "uncertain",
          reason: "changed-identity",
        });
      }),
      (input) => {
        expect(input.args).not.toContain("POST");
        return serve([{ ...pullRequest(), body: "Human-created PR" }])(input);
      },
    ),
  );
  it.effect("does not create while reconciling a missing marker", () =>
    provide(
      Effect.gen(function* () {
        const outbox = yield* Outbox.make();
        expect(yield* outbox.reconcile(request, credential, 1)).toMatchObject({
          kind: "uncertain",
          reason: "missing-match",
        });
      }),
      (input) => {
        expect(input.args).not.toContain("POST");
        return serve([])(input);
      },
    ),
  );
  for (const changes of [
    { stdoutTruncated: true },
    { stdoutInvalidUtf8: true },
    { exitCode: ChildProcessSpawner.ExitCode(1) },
  ])
    it.effect("stops creation when the remote read is incomplete", () =>
      provide(
        Effect.gen(function* () {
          const outbox = yield* Outbox.make();
          expect(yield* outbox.create(request, credential, 1)).toMatchObject({
            kind: "uncertain",
            reason: "incomplete-response",
          });
        }),
        (input) => {
          expect(input.args).not.toContain("POST");
          return serve([pullRequest()], changes)(input);
        },
      ),
    );
  for (const next of [
    { ...request, title: " padded " },
    { ...request, body: '"'.repeat(32_000) },
    { ...request, body: "<!-- t3-project-work-publication:v1:other-marker -->" },
  ])
    it.effect("rejects invalid or oversized original envelopes before any remote call", () =>
      provide(
        Effect.gen(function* () {
          const outbox = yield* Outbox.make();
          expect(yield* outbox.create(next, credential, 1).pipe(Effect.flip)).toMatchObject({
            reason: "invalid-request",
          });
        }),
        () => Effect.die("Remote call after invalid request"),
      ),
    );
  it.effect("rejects a credential for another repository before any remote call", () =>
    provide(
      Effect.gen(function* () {
        const outbox = yield* Outbox.make();
        expect(
          yield* outbox
            .reconcile(request, { ...credential, repositoryNodeId: "R_other" }, 1)
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "credential-mismatch" });
      }),
      () => Effect.die("Remote call after invalid credential"),
    ),
  );
  it.effect("reconciles a marker on a later complete page", () =>
    provide(
      Effect.gen(function* () {
        const outbox = yield* Outbox.make();
        expect(yield* outbox.reconcile(request, credential, 1)).toMatchObject({
          kind: "confirmed",
          pullRequest: { number: 42 },
        });
      }),
      (input) =>
        input.args.at(-1)?.endsWith("&page=1")
          ? Effect.succeed(
              output(
                Array.from({ length: 100 }, (_, index) => ({
                  ...pullRequest(),
                  number: index + 100,
                  body: "Other PR",
                })),
              ),
            )
          : serve([pullRequest()])(input),
    ),
  );
  it.effect("refuses an exhausted page budget without interpreting it as absence", () =>
    provide(
      Effect.gen(function* () {
        const outbox = yield* Outbox.make();
        expect(yield* outbox.create(request, credential, 1)).toMatchObject({
          kind: "uncertain",
          reason: "incomplete-response",
        });
      }),
      (input) => {
        expect(input.args).not.toContain("POST");
        return serve(Array.from({ length: 100 }, () => ({ ...pullRequest(), body: "Other PR" })))(
          input,
        );
      },
    ),
  );
});
