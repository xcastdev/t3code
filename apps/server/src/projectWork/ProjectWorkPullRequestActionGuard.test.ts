import {
  canonicalProjectWorkPayload,
  ProjectId,
  ProjectTeamEffect,
  ProjectWorkTaskId,
  ThreadId,
  type ProjectWorkPublicationRequest,
  type ProjectWorkPublicationOutcome,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { publicationRequestHash } from "./github/ProjectWorkGitHubOutbox.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import {
  ProjectWorkPullRequestActionGuard,
  layer,
  type Input,
} from "./ProjectWorkPullRequestActionGuard.ts";

const at = "2026-10-06T00:00:00.000Z";
const input: Input = {
  projectId: ProjectId.make("selected-project"),
  host: "github.com",
  repository: "owner/repo",
  number: 42,
  action: "merge",
};
const services = layer.pipe(
  Layer.provide(Authorization.layer),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);
type PublicationEffect = typeof ProjectTeamEffect.Type;
const request: ProjectWorkPublicationRequest = {
  version: 1,
  kind: "create-pr",
  operationId: "retained-publication",
  marker: "opaque-marker-retained",
  repository: { host: "github.com", nodeId: "R_repo", nameWithOwner: "owner/repo" },
  target: {
    projectId: ProjectId.make("actual-owner"),
    taskId: ProjectWorkTaskId.make("task"),
    specRevision: 2,
    planRevision: 3,
    scopeHash: "scope",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    headRef: "feature",
    headRepositoryNodeId: "R_repo",
    headSelector: "feature",
  },
  expectedTaskRevision: 0,
  authorizationRecordIds: ["proof"],
  threadId: ThreadId.make("managed-thread"),
  title: "Verified work",
  body: "Retained change.",
};
const receipt = (
  next = request,
): Extract<ProjectWorkPublicationOutcome, { kind: "confirmed" }> => ({
  version: 1,
  operationId: next.operationId,
  requestHash: publicationRequestHash(next),
  claimGeneration: 1,
  observedAt: at,
  kind: "confirmed",
  marker: next.marker,
  repository: next.repository,
  pullRequest: {
    nodeId: "PR_repo",
    number: 42,
    url: `https://${next.repository.host}/${next.repository.nameWithOwner}/pull/42`,
    state: "OPEN",
    baseSha: next.target.baseSha,
    headSha: next.target.headSha,
    baseRef: next.target.baseRef,
    headRef: next.target.headRef,
    headRepositoryNodeId: next.target.headRepositoryNodeId,
  },
});
const publication = (next = request): PublicationEffect => ({
  kind: "effect",
  recordId: next.operationId,
  effectId: next.operationId,
  projectId: next.target.projectId,
  taskId: next.target.taskId,
  revision: 2,
  generation: 0,
  updatedAt: at,
  effectKind: "publication",
  status: "succeeded",
  targetId: `${next.repository.host}/${next.repository.nameWithOwner}`,
  claimGeneration: 1,
  availableAt: at,
  payload: {
    recordIds: next.authorizationRecordIds,
    expectedRevision: next.expectedTaskRevision,
    summary: canonicalProjectWorkPayload(next),
  },
  outcome: canonicalProjectWorkPayload(receipt(next)),
});
const retain = Effect.fn("actionGuardTest.retain")(function* (record = publication()) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_team_effect (record_id,project_id,status,revision,generation,updated_at,unique_key,payload_json)
    VALUES (${record.recordId},${record.projectId},${record.status},${record.revision},${record.generation},${at},${record.effectId},${canonicalProjectWorkPayload(record)})`;
});
const setup = Effect.fn("actionGuardTest.setup")(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  return { sql, guard: yield* ProjectWorkPullRequestActionGuard };
});
const link = Effect.fn("actionGuardTest.link")(function* (
  threadId = ThreadId.make("managed-thread"),
  number = 42,
  repository = "owner/repo",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_thread_pull_requests (thread_id,host,repository,number,url,source,linked_at)
    VALUES (${threadId},'github.com',${repository},${number},'https://github.com/owner/repo/pull/42','created',${at})`;
});
const binding = Effect.fn("actionGuardTest.binding")(function* (status = "settled") {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_team_run_binding (record_id,project_id,status,revision,generation,updated_at,thread_id,payload_json)
    VALUES ('run','actual-owner',${status},0,0,${at},'managed-thread','{}')`;
});
it.effect(
  "denies merging an indexed PR link belonging to settled managed history across selected projects",
  () =>
    Effect.gen(function* () {
      const { guard } = yield* setup();
      yield* link();
      yield* binding();
      expect(yield* guard.check(input).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "managed-merge-unavailable" },
      });
    }).pipe(Effect.provide(services)),
);

it.effect("explicit unlink does not permit merging a retained confirmed managed publication", () =>
  Effect.gen(function* () {
    const { sql, guard } = yield* setup();
    yield* link();
    yield* binding();
    yield* retain();
    yield* sql`DELETE FROM projection_thread_pull_requests WHERE thread_id='managed-thread'`;
    expect(yield* guard.check(input).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "managed-merge-unavailable" },
    });
  }).pipe(Effect.provide(services)),
);

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(services));
it.effect("inspection classifies another selected project's managed PR by its original owner", () =>
  provide(
    Effect.gen(function* () {
      const { guard } = yield* setup();
      yield* retain();
      const inspect = guard.inspect;
      if (!inspect) return yield* Effect.die("Managed publication inspection is missing");
      const found = yield* inspect(input);
      expect(found.managed).toBe(true);
      expect(found.publication?.request.target.projectId).toBe(request.target.projectId);
      expect(yield* guard.check(input).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "managed-merge-unavailable" },
      });
    }),
  ),
);
for (const action of ["merge", "enable-auto-merge"] as const)
  it.effect(`denies ${action} for retained publication even without optional thread metadata`, () =>
    provide(
      Effect.gen(function* () {
        const { guard } = yield* setup();
        const { threadId: _threadId, ...withoutThread } = request;
        yield* retain(publication(withoutThread));
        expect(yield* guard.check({ ...input, action }).pipe(Effect.flip)).toMatchObject({
          reason: "managed-merge-unavailable",
        });
      }),
    ),
  );
for (const state of ["CLOSED", "MERGED"] as const)
  it.effect(`confirmed ${state.toLowerCase()} publication remains managed history`, () =>
    provide(
      Effect.gen(function* () {
        const { guard } = yield* setup();
        const outcome = receipt();
        yield* retain({
          ...publication(),
          outcome: canonicalProjectWorkPayload({
            ...outcome,
            pullRequest: { ...outcome.pullRequest, state },
          }),
        });
        expect(yield* guard.check(input).pipe(Effect.flip)).toMatchObject({
          reason: "managed-merge-unavailable",
        });
      }),
    ),
  );
it.effect("ordinary linked PRs and different exact PR identities remain available", () =>
  provide(
    Effect.gen(function* () {
      const { guard } = yield* setup();
      yield* link(ThreadId.make("ordinary-thread"));
      yield* link(ThreadId.make("managed-thread"), 99);
      yield* binding();
      expect((yield* guard.check(input).pipe(Effect.result))._tag).toBe("Success");
      yield* retain();
      for (const changed of [
        { ...input, number: 43 },
        { ...input, repository: "owner/other" },
        { ...input, host: "github.enterprise.test" },
      ])
        expect((yield* guard.check(changed).pipe(Effect.result))._tag).toBe("Success");
    }),
  ),
);
it.effect("canonical host and repository case cannot bypass publication identity", () =>
  provide(
    Effect.gen(function* () {
      const { guard } = yield* setup();
      yield* retain();
      expect(
        yield* guard
          .check({ ...input, host: "GITHUB.COM", repository: "Owner/Repo" })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "managed-merge-unavailable" });
    }),
  ),
);
it.effect("valid foreign publications and valid unrelated effect kinds are excluded", () =>
  provide(
    Effect.gen(function* () {
      const { guard } = yield* setup();
      yield* retain(
        publication({
          ...request,
          repository: { host: "github.com", nodeId: "R_foreign", nameWithOwner: "other/repo" },
        }),
      );
      yield* retain({
        ...publication(),
        recordId: "memory",
        effectId: "memory",
        effectKind: "memory-index",
      });
      expect((yield* guard.check(input).pipe(Effect.result))._tag).toBe("Success");
    }),
  ),
);
for (const status of ["claimed", "uncertain"] as const)
  it.effect(`${status} writes block the exact repository until the unknown PR is reconciled`, () =>
    provide(
      Effect.gen(function* () {
        const { guard } = yield* setup();
        const { outcome: _outcome, ...record } = publication();
        yield* retain(
          status === "claimed"
            ? { ...record, status }
            : {
                ...record,
                status,
                outcome: canonicalProjectWorkPayload({
                  version: 1,
                  operationId: request.operationId,
                  requestHash: publicationRequestHash(request),
                  claimGeneration: 1,
                  observedAt: at,
                  kind: "uncertain",
                  reason: "interrupted-write",
                }),
              },
        );
        expect(yield* guard.check(input).pipe(Effect.flip)).toMatchObject({
          reason: "history-unavailable",
        });
        expect(
          (yield* guard.check({ ...input, repository: "other/repo" }).pipe(Effect.result))._tag,
        ).toBe("Success");
      }),
    ),
  );
it.effect("never-sent pending publication alone does not classify an ordinary PR as managed", () =>
  provide(
    Effect.gen(function* () {
      const { guard } = yield* setup();
      const { outcome: _outcome, ...record } = publication();
      yield* retain({ ...record, status: "pending", claimGeneration: 0 });
      expect((yield* guard.check(input).pipe(Effect.result))._tag).toBe("Success");
    }),
  ),
);

const corruptRecords: ReadonlyArray<readonly [string, () => unknown]> = [
  [
    "marker",
    () => ({
      ...publication(),
      outcome: canonicalProjectWorkPayload({ ...receipt(), marker: "foreign-marker" }),
    }),
  ],
  [
    "request hash",
    () => ({
      ...publication(),
      outcome: canonicalProjectWorkPayload({ ...receipt(), requestHash: "c".repeat(64) }),
    }),
  ],
  [
    "claim generation",
    () => ({
      ...publication(),
      outcome: canonicalProjectWorkPayload({ ...receipt(), claimGeneration: 2 }),
    }),
  ],
  [
    "fork node",
    () => ({
      ...publication(),
      outcome: canonicalProjectWorkPayload({
        ...receipt(),
        pullRequest: { ...receipt().pullRequest, headRepositoryNodeId: "foreign" },
      }),
    }),
  ],
  [
    "head",
    () => ({
      ...publication(),
      outcome: canonicalProjectWorkPayload({
        ...receipt(),
        pullRequest: { ...receipt().pullRequest, headSha: "c".repeat(40) },
      }),
    }),
  ],
  [
    "URL",
    () => ({
      ...publication(),
      outcome: canonicalProjectWorkPayload({
        ...receipt(),
        pullRequest: { ...receipt().pullRequest, url: "https://github.com/foreign/repo/pull/42" },
      }),
    }),
  ],
  [
    "repository node",
    () => ({
      ...publication(),
      outcome: canonicalProjectWorkPayload({
        ...receipt(),
        repository: { ...receipt().repository, nodeId: "R_foreign" },
      }),
    }),
  ],
  ["task", () => ({ ...publication(), taskId: "foreign" })],
  [
    "noncanonical request",
    () => ({
      ...publication(),
      payload: { ...publication().payload, summary: ` ${canonicalProjectWorkPayload(request)}` },
    }),
  ],
  [
    "padded title",
    () => {
      const next = { ...request, title: " padded " };
      return { ...publication(next) };
    },
  ],
  [
    "oversized request",
    () => {
      const next = { ...request, body: "x".repeat(32000) };
      return { ...publication(next) };
    },
  ],
  ["oversized outcome", () => ({ ...publication(), outcome: "x".repeat(4001) })],
];
for (const [name, record] of corruptRecords)
  it.effect(`corrupt ${name} cannot be treated as ordinary PR history`, () =>
    provide(
      Effect.gen(function* () {
        const { sql, guard } = yield* setup();
        yield* retain();
        yield* sql`UPDATE project_team_effect SET payload_json=${canonicalProjectWorkPayload(record())} WHERE record_id=${request.operationId}`;
        expect(yield* guard.check(input).pipe(Effect.flip)).toMatchObject({
          reason: "history-unavailable",
        });
      }),
    ),
  );
for (const payload of ["{", "{}", " ".repeat(262145)])
  it.effect(`unreadable potential publication of ${payload.length} bytes fails closed`, () =>
    provide(
      Effect.gen(function* () {
        const { sql, guard } = yield* setup();
        yield* retain();
        yield* sql`UPDATE project_team_effect SET payload_json=${payload} WHERE record_id=${request.operationId}`;
        expect(yield* guard.check(input).pipe(Effect.flip)).toMatchObject({
          reason: "history-unavailable",
        });
      }),
    ),
  );
it.effect(
  "missing history tables fail closed for merge, while other actions perform no history reads",
  () =>
    provide(
      Effect.gen(function* () {
        const guard = yield* ProjectWorkPullRequestActionGuard;
        expect(yield* guard.check(input).pipe(Effect.flip)).toMatchObject({
          reason: "history-unavailable",
        });
        for (const action of ["close", "reopen", "update-branch", "disable-auto-merge"] as const)
          expect((yield* guard.check({ ...input, action }).pipe(Effect.result))._tag).toBe(
            "Success",
          );
      }),
    ),
);
it.effect("managed links beyond the first indexed page are still denied", () =>
  provide(
    Effect.gen(function* () {
      const { guard } = yield* setup();
      for (let i = 0; i < 130; i++)
        yield* link(ThreadId.make(`ordinary-${String(i).padStart(3, "0")}`));
      yield* link(ThreadId.make("zz-managed"));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO project_team_identity_fences (provider_instance_id,thread_id) VALUES ('pi','zz-managed')`;
      expect(yield* guard.check(input).pipe(Effect.flip)).toMatchObject({
        reason: "managed-merge-unavailable",
      });
    }),
  ),
);
it.effect(
  "confirmed managed publication beyond one keyset page remains denied without mutations",
  () =>
    provide(
      Effect.gen(function* () {
        const { sql, guard } = yield* setup();
        for (let i = 0; i < 130; i++)
          yield* retain(
            publication({
              ...request,
              operationId: `a-${String(i).padStart(3, "0")}`,
              repository: { host: "github.com", nodeId: "R_foreign", nameWithOwner: "other/repo" },
            }),
          );
        yield* retain(publication({ ...request, operationId: "z-managed" }));
        const before =
          yield* sql`SELECT record_id,payload_json FROM project_team_effect ORDER BY record_id`;
        expect(yield* guard.check(input).pipe(Effect.flip)).toMatchObject({
          reason: "managed-merge-unavailable",
        });
        expect(
          yield* sql`SELECT record_id,payload_json FROM project_team_effect ORDER BY record_id`,
        ).toEqual(before);
      }),
    ),
);

it.effect(
  "never-claimed canceled publication does not block ordinary merges, but canceled claimed work does",
  () =>
    provide(
      Effect.gen(function* () {
        const { sql, guard } = yield* setup();
        const { outcome: _outcome, ...record } = publication();
        const unsent: PublicationEffect = { ...record, status: "canceled", claimGeneration: 0 };
        yield* retain(unsent);
        expect((yield* guard.check(input).pipe(Effect.result))._tag).toBe("Success");
        yield* sql`UPDATE project_team_effect SET payload_json=${canonicalProjectWorkPayload({ ...unsent, claimGeneration: 1 })}
      WHERE record_id=${request.operationId}`;
        expect(yield* guard.check(input).pipe(Effect.flip)).toMatchObject({
          reason: "history-unavailable",
        });
      }),
    ),
);
