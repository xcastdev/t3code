import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  type ProjectWorkPublicationRequest,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { runMigrations, runForkMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import * as PullRequests from "./ProjectWorkPullRequests.ts";

const projectId = ProjectId.make("publication-repository");
const taskId = ProjectWorkTaskId.make("publication-task");
const at = "2026-10-05T00:00:00.000Z";
const request: ProjectWorkPublicationRequest = {
  version: 1,
  kind: "create-pr",
  operationId: "create-one",
  marker: "opaque-marker-one",
  repository: { host: "github.com", nodeId: "R_base", nameWithOwner: "owner/repo" },
  target: {
    projectId,
    taskId,
    specRevision: 2,
    planRevision: 3,
    scopeHash: "scope-one",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    headRef: "feature",
    headRepositoryNodeId: "R_base",
    headSelector: "feature",
  },
  expectedTaskRevision: 0,
  authorizationRecordIds: ["proof-one"],
  title: "Repair task",
  body: "Verified change.",
};
const credential: PullRequests.PublicationCredential = {
  cwd: "/disposable/publication",
  host: "github.com",
  repositoryNodeId: "R_base",
  headRepositoryNodeId: "R_base",
  credentialFingerprint: "synthetic-epoch",
  token: Redacted.make("synthetic-token"),
};
const output = (body: unknown): VcsProcess.VcsProcessOutput => ({
  stdout: JSON.stringify(body),
  stderr: "",
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdoutTruncated: false,
  stderrTruncated: false,
});
const rawPr = (next: ProjectWorkPublicationRequest) => ({
  node_id: "PR_one",
  number: 42,
  html_url: "https://github.com/owner/repo/pull/42",
  state: "open",
  merged_at: null,
  body: `<!-- t3-project-work-publication:v1:${next.marker} -->`,
  base: {
    sha: next.target.baseSha,
    ref: next.target.baseRef,
    repo: { node_id: "R_base", full_name: "owner/repo" },
  },
  head: { sha: next.target.headSha, ref: next.target.headRef, repo: { node_id: "R_base" } },
});
const rawRefs = () => ({
  data: {
    base: {
      id: "R_base",
      nameWithOwner: "owner/repo",
      ref: { name: "main", target: { oid: "a".repeat(40) } },
    },
    head: {
      id: "R_base",
      nameWithOwner: "owner/repo",
      ref: { name: "feature", target: { oid: "b".repeat(40) } },
    },
  },
});
const layer = it.layer(NodeSqliteClient.layerMemory());
const setup = Effect.fn("publicationTest.setup")(function* () {
  yield* runMigrations();
  yield* runForkMigrations();
  const repository = yield* ProjectWorkRepository;
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    taskId,
    commandId: CommandId.make("seed-task"),
    title: "Publication task",
    createdAt: at,
  });
  return repository;
});
const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R | ProjectWorkRepository | GitHubCli.GitHubCli>,
  run: VcsProcess.VcsProcess["Service"]["run"] = () => Effect.succeed(output([])),
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        ProjectWorkRepositoryLive,
        GitHubCli.layer.pipe(
          Layer.provide(Layer.succeed(VcsProcess.VcsProcess, VcsProcess.VcsProcess.of({ run }))),
        ),
      ),
    ),
  );

layer("ProjectWorkPullRequests", (it) => {
  it.effect(
    "allows only one writer across independent service instances sharing a repository",
    () => {
      const next = {
        ...request,
        operationId: "independent-dispatch",
        marker: "opaque-marker-independent",
      };
      let arrivals = 0;
      let ready: Deferred.Deferred<void>;
      let releaseWrite: Deferred.Deferred<void>;
      let created = false;
      let writes = 0;
      const run: VcsProcess.VcsProcess["Service"]["run"] = (input) =>
        Effect.gen(function* () {
          if (input.args.includes("graphql")) return output(rawRefs());
          if (input.args.includes("POST")) {
            writes++;
            if (writes === 2) yield* Deferred.succeed(releaseWrite, undefined);
            // Hold visibility until the contender settles; a second writer sees no marker.
            yield* Deferred.await(releaseWrite);
            created = true;
            return output({});
          }
          if (input.args.at(-1) === "repos/owner/repo")
            return output({ node_id: "R_base", full_name: "owner/repo" });
          return output(created ? [rawPr(next)] : []);
        });
      return provide(
        Effect.gen(function* () {
          yield* setup();
          ready = yield* Deferred.make<void>();
          releaseWrite = yield* Deferred.make<void>();
          const options: PullRequests.Options = {
            authorizePublication: () => Effect.void,
            resolveCredential: () =>
              Effect.gen(function* () {
                arrivals++;
                if (arrivals === 2) yield* Deferred.succeed(ready, undefined);
                yield* Deferred.await(ready);
                return credential;
              }),
          };
          const first = yield* PullRequests.make(options);
          const second = yield* PullRequests.make(options);
          yield* first.enqueue(next);
          const settle = (effect: Effect.Effect<unknown, PullRequests.PublicationError>) =>
            effect.pipe(
              Effect.result,
              Effect.tap(() => Deferred.succeed(releaseWrite, undefined)),
            );
          const results = yield* Effect.all(
            [settle(first.dispatch(next.operationId)), settle(second.dispatch(next.operationId))],
            { concurrency: "unbounded" },
          );
          expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
          expect(arrivals).toBe(2);
          expect(writes).toBe(1);
        }),
        run,
      );
    },
  );
  it.effect("freezes the authorized envelope while the caller changes its original object", () =>
    provide(
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* setup();
          const next = {
            ...request,
            operationId: "mutable-request",
            target: { ...request.target },
            authorizationRecordIds: [...request.authorizationRecordIds],
          };
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const service = yield* PullRequests.make({
            authorizePublication: (captured) =>
              Effect.gen(function* () {
                expect(captured.body).toBe("Verified change.");
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(resume);
              }),
            resolveCredential: () => Effect.succeed(credential),
          });
          const fiber = yield* Effect.forkScoped(service.enqueue(next));
          yield* Deferred.await(entered);
          next.body = "Changed after approval";
          next.target.headSha = "c".repeat(40);
          next.authorizationRecordIds[0] = "unapproved-proof";
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(fiber);
          const events = yield* repository.replay(projectId);
          const recorded = events.find(
            (event) =>
              event.type === "project-work.foundation.recorded" &&
              event.record.recordId === "mutable-request",
          );
          expect(recorded).toMatchObject({
            record: {
              payload: {
                recordIds: ["proof-one"],
                summary: expect.stringContaining('"body":"Verified change."'),
              },
            },
          });
          expect(recorded).toMatchObject({
            record: {
              payload: {
                summary: expect.stringContaining(
                  '"headSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
                ),
              },
            },
          });
        }),
      ),
    ),
  );
  it.effect("retains the operation and marker in the repository before publication can run", () =>
    provide(
      Effect.gen(function* () {
        const repository = yield* setup();
        const service = yield* PullRequests.make({
          authorizePublication: () => Effect.void,
          resolveCredential: () => Effect.succeed(credential),
        });
        const receipt = yield* service.enqueue(request);
        expect(receipt).toMatchObject({ operationId: "create-one", status: "pending" });
        const events = yield* repository.replay(projectId);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "project-work.foundation.recorded",
            record: expect.objectContaining({
              effectId: "create-one",
              status: "pending",
              payload: expect.objectContaining({
                summary: expect.stringContaining('"marker":"opaque-marker-one"'),
              }),
            }),
          }),
        );
      }),
    ),
  );
  it.effect(
    "commits its claim before the provider write and returns the retained confirmed result",
    () => {
      const next = { ...request, operationId: "dispatch-one" };
      let writes = 0;
      let created = false;
      let repository: ProjectWorkRepository["Service"];
      const run: VcsProcess.VcsProcess["Service"]["run"] = (input) =>
        Effect.gen(function* () {
          if (input.args.includes("graphql")) return output(rawRefs());
          if (input.args.includes("POST")) {
            const events = yield* repository.replay(projectId).pipe(Effect.orDie);
            expect(events).toContainEqual(
              expect.objectContaining({
                type: "project-work.foundation.recorded",
                record: expect.objectContaining({
                  effectId: "dispatch-one",
                  status: "claimed",
                  claimGeneration: 1,
                }),
              }),
            );
            expect(input.stdin).toContain(
              "<!-- t3-project-work-publication:v1:opaque-marker-one -->",
            );
            writes++;
            created = true;
            return output({});
          }
          if (input.args.at(-1) === "repos/owner/repo")
            return output({ node_id: "R_base", full_name: "owner/repo" });
          return output(
            created
              ? [
                  {
                    node_id: "PR_one",
                    number: 42,
                    html_url: "https://github.com/owner/repo/pull/42",
                    state: "open",
                    merged_at: null,
                    body: "<!-- t3-project-work-publication:v1:opaque-marker-one -->",
                    base: {
                      sha: "a".repeat(40),
                      ref: "main",
                      repo: { node_id: "R_base", full_name: "owner/repo" },
                    },
                    head: { sha: "b".repeat(40), ref: "feature", repo: { node_id: "R_base" } },
                  },
                ]
              : [],
          );
        });
      return provide(
        Effect.gen(function* () {
          repository = yield* setup();
          const service = yield* PullRequests.make({
            authorizePublication: () => Effect.void,
            resolveCredential: () => Effect.succeed(credential),
          });
          yield* service.enqueue(next);
          const result = yield* service.dispatch(next.operationId);
          expect(result).toMatchObject({
            kind: "confirmed",
            operationId: "dispatch-one",
            claimGeneration: 1,
          });
          expect(yield* service.dispatch(next.operationId)).toEqual(result);
          expect(writes).toBe(1);
        }),
        run,
      );
    },
  );
  for (const phase of ["read", "write"] as const)
    it.effect(`recovers an interrupted ${phase} through a new service without redispatch`, () => {
      const next = {
        ...request,
        operationId: `interrupted-${phase}`,
        marker: `opaque-marker-${phase}`,
      };
      let entered: Deferred.Deferred<void>;
      let interrupted = false;
      let created = false;
      let writes = 0;
      const run: VcsProcess.VcsProcess["Service"]["run"] = (input) =>
        Effect.gen(function* () {
          if (input.args.includes("graphql")) return output(rawRefs());
          if (
            !interrupted &&
            ((phase === "write" && input.args.includes("POST")) ||
              (phase === "read" && input.args.at(-1) === "repos/owner/repo"))
          ) {
            if (phase === "write") {
              writes++;
              created = true;
            }
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }
          expect(input.args).not.toContain("POST");
          if (input.args.at(-1) === "repos/owner/repo")
            return output({ node_id: "R_base", full_name: "owner/repo" });
          return output(created ? [rawPr(next)] : []);
        });
      return provide(
        Effect.scoped(
          Effect.gen(function* () {
            const repository = yield* setup();
            entered = yield* Deferred.make<void>();
            const original = yield* PullRequests.make({
              authorizePublication: () => Effect.void,
              resolveCredential: () => Effect.succeed(credential),
            });
            yield* original.enqueue(next);
            const fiber = yield* Effect.forkScoped(original.dispatch(next.operationId));
            yield* Deferred.await(entered);
            yield* Fiber.interrupt(fiber);
            interrupted = true;
            const restarted = yield* PullRequests.make({
              resolveCredential: () => Effect.succeed(credential),
            });
            const counts = yield* restarted.recoverAll();
            expect(counts.recovered).toBeGreaterThanOrEqual(1);
            const result = yield* restarted.reconcile(next.operationId);
            expect(result).toMatchObject(
              phase === "write"
                ? { kind: "confirmed", operationId: next.operationId }
                : { kind: "uncertain", operationId: next.operationId, reason: "missing-match" },
            );
            expect(writes).toBe(phase === "write" ? 1 : 0);
            const events = yield* repository.replay(projectId);
            expect(
              events.filter((event) => event.type === "project-work.task.created"),
            ).toHaveLength(1);
            expect(
              events.filter(
                (event) =>
                  event.type !== "project-work.foundation.recorded" &&
                  event.type !== "project-work.task.created",
              ),
            ).toHaveLength(0);
          }),
        ),
        run,
      );
    });
  it.effect("retains unavailable-credential recovery as uncertain work needing attention", () =>
    provide(
      Effect.gen(function* () {
        const repository = yield* setup();
        const next = { ...request, operationId: "unavailable-credential" };
        const creator = yield* PullRequests.make({
          authorizePublication: () => Effect.void,
          resolveCredential: () => Effect.succeed(credential),
        });
        yield* creator.enqueue(next);
        const events = yield* repository.replay(projectId);
        yield* repository.execute({
          type: "project-work.foundation.commit",
          commandId: CommandId.make("simulate-lost-owner"),
          projectId,
          expectedRevision: events.at(-1)?.revision ?? 0,
          attribution: {
            actor: { kind: "system", id: "project-work-github-outbox" },
            source: { kind: "system", id: "project-work-github-outbox" },
            recordedAt: at,
          },
          committedAt: at,
          records: [],
          transition: {
            kind: "publication.claim",
            effectId: next.operationId,
            expectedEffectRevision: 0,
            expectedClaimGeneration: 0,
          },
        });
        const service = yield* PullRequests.make({
          resolveCredential: () =>
            Effect.fail(new PullRequests.PublicationError({ reason: "credential-mismatch" })),
        });
        expect(yield* service.recoverAll()).toMatchObject({ failed: 0 });
        expect(yield* service.reconcile(next.operationId)).toMatchObject({
          kind: "uncertain",
          reason: "incomplete-response",
        });
        const state = yield* repository.execute({
          type: "project-work.task.create",
          projectId,
          taskId,
          commandId: CommandId.make("seed-task"),
          title: "Publication task",
          createdAt: at,
        });
        expect(state.state.attention).toContainEqual(
          expect.objectContaining({ taskId, reason: "blocked" }),
        );
      }),
      () => Effect.die("External call without credentials"),
    ),
  );
  it.effect(
    "denies enqueue and dispatch without a host authorizer before claiming or calling GitHub",
    () =>
      provide(
        Effect.gen(function* () {
          const repository = yield* setup();
          const next = { ...request, operationId: "default-denied" };
          const denied = yield* PullRequests.make({
            resolveCredential: () => Effect.succeed(credential),
          });
          expect(yield* denied.enqueue(next).pipe(Effect.flip)).toMatchObject({
            reason: "authorization-denied",
          });
          const trusted = yield* PullRequests.make({
            authorizePublication: () => Effect.void,
            resolveCredential: () => Effect.succeed(credential),
          });
          yield* trusted.enqueue(next);
          expect(yield* denied.dispatch(next.operationId).pipe(Effect.flip)).toMatchObject({
            reason: "authorization-denied",
          });
          const events = yield* repository.replay(projectId);
          expect(
            events.some(
              (event) =>
                event.type === "project-work.foundation.recorded" &&
                event.record.kind === "effect" &&
                event.record.effectId === next.operationId &&
                event.record.status === "claimed",
            ),
          ).toBe(false);
        }),
        () => Effect.die("Remote call despite missing authorizer"),
      ),
  );
  it.effect(
    "does not commit a claim when authorization changes during credential preparation",
    () =>
      provide(
        Effect.gen(function* () {
          const repository = yield* setup();
          const next = { ...request, operationId: "revoked-before-claim" };
          let allowed = true;
          const service = yield* PullRequests.make({
            authorizePublication: () =>
              allowed
                ? Effect.void
                : Effect.fail(
                    new PullRequests.PublicationError({ reason: "authorization-denied" }),
                  ),
            resolveCredential: () =>
              Effect.sync(() => {
                allowed = false;
                return credential;
              }),
          });
          yield* service.enqueue(next);
          expect(yield* service.dispatch(next.operationId).pipe(Effect.flip)).toMatchObject({
            reason: "authorization-denied",
          });
          const events = yield* repository.replay(projectId);
          expect(
            events.some(
              (event) =>
                event.type === "project-work.foundation.recorded" &&
                event.record.kind === "effect" &&
                event.record.effectId === next.operationId &&
                event.record.status === "claimed",
            ),
          ).toBe(false);
        }),
        () => Effect.die("Remote call after revocation"),
      ),
  );
  it.effect(
    "returns the original enqueue receipt and rejects a changed request under the same operation ID",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup();
          const service = yield* PullRequests.make({
            authorizePublication: () => Effect.void,
            resolveCredential: () => Effect.succeed(credential),
          });
          const next = { ...request, operationId: "duplicate-enqueue" };
          expect(yield* service.enqueue(next)).toMatchObject({
            status: "pending",
            duplicate: false,
          });
          expect(yield* service.enqueue(next)).toMatchObject({
            status: "pending",
            duplicate: true,
          });
          expect(
            yield* service
              .enqueue({ ...next, body: "Changed after authorization" })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "invalid-state" });
        }),
      ),
  );
  it.effect(
    "serializes concurrent dispatches and committed-event recovery without another mutation",
    () => {
      const next = {
        ...request,
        operationId: "concurrent-dispatch",
        marker: "opaque-marker-concurrent",
      };
      let created = false;
      let writes = 0;
      const run: VcsProcess.VcsProcess["Service"]["run"] = (input) =>
        Effect.sync(() => {
          if (input.args.includes("graphql")) return output(rawRefs());
          if (input.args.includes("POST")) {
            writes++;
            created = true;
            return output({});
          }
          if (input.args.at(-1) === "repos/owner/repo")
            return output({ node_id: "R_base", full_name: "owner/repo" });
          return output(created ? [rawPr(next)] : []);
        });
      return provide(
        Effect.gen(function* () {
          yield* setup();
          const service = yield* PullRequests.make({
            authorizePublication: () => Effect.void,
            resolveCredential: () => Effect.succeed(credential),
          });
          yield* service.enqueue(next);
          const [first, second] = yield* Effect.all(
            [
              service.dispatch(next.operationId),
              service.dispatch(next.operationId),
              service.recoverAll(),
            ],
            { concurrency: "unbounded" },
          );
          expect(first).toEqual(second);
          expect(first.kind).toBe("confirmed");
          expect(writes).toBe(1);
        }),
        run,
      );
    },
  );
});
