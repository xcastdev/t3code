import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Statement from "effect/unstable/sql/Statement";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  canonicalProjectWorkPayload,
  ProjectVerificationJobManifest,
  ProjectWorkCriterionId,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeProjectWorkVerificationJobs } from "./ProjectWorkVerificationJobs.ts";

const manifest = Schema.decodeUnknownSync(ProjectVerificationJobManifest)({
  version: 1,
  jobId: "job-1",
  environmentId: "environment-1",
  projectId: "project-1",
  taskId: "task-1",
  specRevision: 4,
  specificationHash: "a".repeat(64),
  planRevision: 2,
  planHash: "b".repeat(64),
  criteria: [{ criterionId: "criterion-1", revision: 3 }],
  dispatchId: "implementation-1",
  bindingId: "binding-1",
  generation: 7,
  workspaceReceiptHash: "c".repeat(64),
  command: {
    executable: "/opt/runner",
    argv: ["", "  preserved  ", "$(literal); *", "line\nbreak"],
    limits: { maxDurationMs: 120_000, maxOutputBytes: 65_536 },
    environment: "clean",
  },
  target: {
    repository: "/project",
    worktree: "/worktree",
    branchRef: "refs/heads/team/implementation",
    baseSha: "d".repeat(40),
    headSha: "e".repeat(40),
    testedCommit: "e".repeat(40),
    testedTree: "f".repeat(40),
    workspaceState: "clean-committed",
  },
  executable: {
    target: "/opt/runner",
    sha256: "1".repeat(64),
    runtimeClosureSha256: "2".repeat(64),
  },
});
const database = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  body.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
const manifestHash = "a73f2a9a4e9524fac2b668cf6c12629f219a3570e8cccce409c09affbf11a8d6";
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const jobs = yield* makeProjectWorkVerificationJobs({ environmentId: "environment-1" });
  return { sql, jobs };
});

it.effect(
  "retains an exact prepared manifest and preserves literal arguments without authority",
  () =>
    database(
      Effect.gen(function* () {
        const { jobs } = yield* fixture;
        const receipt = yield* jobs.retainPrepared(manifest);
        expect(receipt.manifest).toEqual(manifest);
        expect(receipt.sha256).toBe(manifestHash);
        expect(Object.keys(receipt).sort()).toEqual(["manifest", "sha256"]);
        expect(yield* jobs.readPrepared("job-1")).toEqual(receipt);
        expect(yield* jobs.readPrepared("missing")).toBeUndefined();
      }),
    ),
);

it.effect("prepared manifests survive database closure and do not share caller-owned objects", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-prepared-" });
    const filename = path.join(directory, "state.sqlite");
    const receipt = yield* fixture.pipe(
      Effect.flatMap(({ jobs }) => jobs.retainPrepared(manifest)),
      Effect.provide(NodeSqliteClient.layer({ filename })),
    );
    Reflect.set(receipt.manifest.command, "argv", ["mutated return value"]);
    yield* Effect.gen(function* () {
      expect(yield* runMigrations()).toEqual([]);
      const jobs = yield* makeProjectWorkVerificationJobs({ environmentId: "environment-1" });
      expect((yield* jobs.readPrepared("job-1"))?.manifest).toEqual(manifest);
      expect(yield* jobs.retainPrepared(manifest)).toEqual(yield* jobs.readPrepared("job-1"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("equal retries and concurrent contenders preserve exactly one immutable winner", () =>
  database(
    Effect.gen(function* () {
      const { jobs } = yield* fixture;
      const equal = yield* Effect.all(
        [jobs.retainPrepared(manifest), jobs.retainPrepared(manifest)],
        { concurrency: "unbounded" },
      );
      expect(equal[0]).toEqual(equal[1]);
      const first = { ...manifest, jobId: "race", planHash: "3".repeat(64) };
      const second = { ...first, planHash: "4".repeat(64) };
      const outcomes = yield* Effect.all(
        [
          jobs.retainPrepared(first).pipe(Effect.result),
          jobs.retainPrepared(second).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual(["Failure", "Success"]);
      const retained = yield* jobs.readPrepared("race");
      expect([first, second]).toContainEqual(retained?.manifest);
      expect(yield* jobs.retainPrepared(retained!.manifest)).toEqual(retained);
    }),
  ),
);

it.effect("the canonical digest binds every command, target, capture and revision field", () =>
  database(
    Effect.gen(function* () {
      const { jobs } = yield* fixture;
      const original = yield* jobs.retainPrepared(manifest);
      const changes = [
        {
          ...manifest,
          projectId: ProjectVerificationJobManifest.fields.projectId.make("other-project"),
        },
        { ...manifest, taskId: ProjectVerificationJobManifest.fields.taskId.make("other-task") },
        { ...manifest, specRevision: 5 },
        { ...manifest, specificationHash: "5".repeat(64) },
        { ...manifest, planRevision: 3 },
        { ...manifest, planHash: "5".repeat(64) },
        { ...manifest, criteria: [{ ...manifest.criteria[0]!, revision: 4 }] },
        {
          ...manifest,
          criteria: [
            {
              ...manifest.criteria[0]!,
              criterionId: ProjectWorkCriterionId.make("other-criterion"),
            },
          ],
        },
        { ...manifest, dispatchId: "other-dispatch" },
        { ...manifest, bindingId: "other-binding" },
        { ...manifest, generation: 8 },
        { ...manifest, workspaceReceiptHash: "5".repeat(64) },
        { ...manifest, command: { ...manifest.command, argv: ["changed"] } },
        {
          ...manifest,
          command: {
            ...manifest.command,
            limits: { ...manifest.command.limits, maxDurationMs: 1 },
          },
        },
        {
          ...manifest,
          command: {
            ...manifest.command,
            limits: { ...manifest.command.limits, maxOutputBytes: 1 },
          },
        },
        {
          ...manifest,
          command: { ...manifest.command, executable: "/other-runner" },
          executable: { ...manifest.executable, target: "/other-runner" },
        },
        { ...manifest, target: { ...manifest.target, repository: "/other-project" } },
        { ...manifest, target: { ...manifest.target, worktree: "/other-worktree" } },
        { ...manifest, target: { ...manifest.target, branchRef: "refs/heads/other" } },
        { ...manifest, target: { ...manifest.target, baseSha: "5".repeat(40) } },
        {
          ...manifest,
          target: { ...manifest.target, headSha: "5".repeat(40), testedCommit: "5".repeat(40) },
        },
        { ...manifest, target: { ...manifest.target, testedTree: "5".repeat(40) } },
        { ...manifest, executable: { ...manifest.executable, sha256: "5".repeat(64) } },
        {
          ...manifest,
          executable: { ...manifest.executable, runtimeClosureSha256: "5".repeat(64) },
        },
      ];
      for (const changed of changes) {
        expect((yield* jobs.retainPrepared(changed).pipe(Effect.result))._tag).toBe("Failure");
        const different = yield* database(
          Effect.gen(function* () {
            const { jobs } = yield* fixture;
            return yield* jobs.retainPrepared(changed);
          }),
        );
        expect(different.sha256).not.toBe(original.sha256);
        expect(different.manifest).toEqual(changed);
      }
      expect(yield* jobs.readPrepared("job-1")).toEqual(original);
    }),
  ),
);

it.effect("foreign environments cannot retain or read another owner's prepared manifest", () =>
  database(
    Effect.gen(function* () {
      const { jobs } = yield* fixture;
      yield* jobs.retainPrepared(manifest);
      const foreign = yield* makeProjectWorkVerificationJobs({ environmentId: "foreign" });
      expect(yield* foreign.readPrepared("job-1")).toBeUndefined();
      expect((yield* foreign.retainPrepared(manifest).pipe(Effect.result))._tag).toBe("Failure");
      const owned = {
        ...manifest,
        environmentId: ProjectVerificationJobManifest.fields.environmentId.make("foreign"),
      };
      expect((yield* foreign.retainPrepared(owned)).manifest).toEqual(owned);
      expect((yield* jobs.readPrepared("job-1"))?.manifest).toEqual(manifest);
    }),
  ),
);

it.effect("captures exact options and manifest values synchronously while SQL is held", () =>
  database(
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocker = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const options = { environmentId: "environment-1" };
      const constructing = makeProjectWorkVerificationJobs(options);
      options.environmentId = "changed-environment";
      const jobs = yield* constructing;
      const caller = {
        ...manifest,
        command: { ...manifest.command, argv: [...manifest.command.argv] },
        criteria: manifest.criteria.map((criterion) => ({ ...criterion })),
        target: { ...manifest.target },
      };
      const pending = jobs.retainPrepared(caller);
      caller.jobId = "changed-job";
      caller.command.argv[0] = "changed argument";
      caller.criteria[0]!.revision = 99;
      caller.target.testedTree = "9".repeat(40);
      const writer = yield* pending.pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(blocker);
      expect((yield* Fiber.join(writer)).manifest).toEqual(manifest);
      expect((yield* jobs.readPrepared("job-1"))?.manifest).toEqual(manifest);
      expect(yield* jobs.readPrepared("changed-job")).toBeUndefined();
    }),
  ),
);

for (const operation of ["retainPrepared", "readPrepared"] as const) {
  it.effect("denies " + operation + " execution under caller transaction ownership", () =>
    database(
      Effect.gen(function* () {
        const { sql, jobs } = yield* fixture;
        const pending =
          operation === "retainPrepared"
            ? jobs.retainPrepared(manifest).pipe(Effect.asVoid)
            : jobs.readPrepared("job-1").pipe(Effect.asVoid);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const json = canonicalProjectWorkPayload(manifest);
              yield* sql`INSERT INTO project_work_verification_jobs VALUES ('environment-1','job-1','project-1','task-1',${json},${manifestHash})`;
              expect((yield* pending.pipe(Effect.result))._tag).toBe("Failure");
              return yield* Effect.fail("caller rollback");
            }),
          )
          .pipe(Effect.result);
        expect(yield* jobs.readPrepared("job-1")).toBeUndefined();
        expect((yield* jobs.retainPrepared(manifest)).manifest).toEqual(manifest);
      }),
    ),
  );
}

it.effect("a failed SQLite COMMIT cannot expose an uncommitted prepared manifest", () =>
  database(
    Effect.gen(function* () {
      const { sql, jobs } = yield* fixture;
      yield* sql`PRAGMA foreign_keys=ON`;
      yield* sql`CREATE TABLE controlled_parent(id INTEGER PRIMARY KEY)`;
      yield* sql`CREATE TABLE controlled_child(parent_id INTEGER REFERENCES controlled_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      yield* sql`CREATE TRIGGER controlled_commit_failure AFTER INSERT ON project_work_verification_jobs BEGIN INSERT INTO controlled_child(parent_id) VALUES(1); END`;
      const pending = jobs.retainPrepared(manifest);
      const retained = yield* pending.pipe(Effect.exit);
      const uncommittedRead = yield* jobs.readPrepared("job-1").pipe(Effect.exit);
      const counts = yield* Effect.scoped(
        Effect.gen(function* () {
          // Test cleanup owns the physical connection loan; production never rolls back a foreign owner.
          const reserved = yield* sql.reserve;
          const before = yield* reserved.execute(
            "SELECT count(*) AS count FROM project_work_verification_jobs",
            [],
            undefined,
          );
          yield* reserved.executeUnprepared("ROLLBACK", [], undefined);
          const after = yield* reserved.execute(
            "SELECT count(*) AS count FROM project_work_verification_jobs",
            [],
            undefined,
          );
          yield* reserved.executeUnprepared(
            "DROP TRIGGER controlled_commit_failure",
            [],
            undefined,
          );
          return { before, after };
        }),
      );
      expect(retained._tag).toBe("Failure");
      if (retained._tag === "Failure")
        expect(Cause.pretty(retained.cause)).toContain("FOREIGN KEY constraint failed");
      expect(counts).toEqual({ before: [{ count: 1 }], after: [{ count: 0 }] });
      expect(uncommittedRead._tag === "Failure" || uncommittedRead.value === undefined).toBe(true);
      expect(yield* jobs.readPrepared("job-1")).toBeUndefined();
      expect((yield* pending).manifest).toEqual(manifest);
      expect(yield* jobs.readPrepared("job-1")).toEqual(yield* jobs.retainPrepared(manifest));
    }),
  ),
);

it.effect("a real SQLite write failure yields no receipt and permits the exact pending retry", () =>
  database(
    Effect.gen(function* () {
      const { sql, jobs } = yield* fixture;
      yield* sql`CREATE TRIGGER controlled_prepared_write_failure BEFORE INSERT ON project_work_verification_jobs BEGIN SELECT RAISE(ABORT,'controlled write failure'); END`;
      const pending = jobs.retainPrepared(manifest);
      expect((yield* pending.pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* jobs.readPrepared("job-1")).toBeUndefined();
      yield* sql`DROP TRIGGER controlled_prepared_write_failure`;
      expect((yield* pending).manifest).toEqual(manifest);
    }),
  ),
);

it.effect("rejects unknown, normalized, wrong-version and oversized manifests before storage", () =>
  database(
    Effect.gen(function* () {
      const { sql, jobs } = yield* fixture;
      const path = "/" + "界".repeat(4_095);
      for (const candidate of [
        { ...manifest, jobId: " job-1 " },
        {
          ...manifest,
          projectId: ProjectVerificationJobManifest.fields.projectId.make(" project-1 "),
        },
        { ...manifest, approved: true },
        { ...manifest, status: "prepared" },
        { ...manifest, command: { ...manifest.command, env: { TOKEN: "secret" } } },
        {
          ...manifest,
          target: { ...manifest.target, repository: path, worktree: path },
          command: {
            ...manifest.command,
            executable: path,
            argv: Array(4).fill("x".repeat(4_096)),
          },
          executable: { ...manifest.executable, target: path },
        },
      ])
        expect((yield* jobs.retainPrepared(candidate).pipe(Effect.result))._tag).toBe("Failure");
      const future = { ...manifest };
      Reflect.set(future, "version", 2);
      expect((yield* jobs.retainPrepared(future).pipe(Effect.result))._tag).toBe("Failure");
      for (const environmentId of ["", " environment-1 ", "x".repeat(257)])
        expect(
          (yield* makeProjectWorkVerificationJobs({ environmentId }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      for (const jobId of ["", " job-1 ", "x".repeat(257)])
        expect((yield* jobs.readPrepared(jobId).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* sql`SELECT * FROM project_work_verification_jobs`).toEqual([]);
    }),
  ),
);

it.effect(
  "changed SQL affinity cannot return another owner's uncommitted manifest or receipt",
  () =>
    database(
      Effect.gen(function* () {
        const { jobs } = yield* fixture;
        const pendingRead = jobs.readPrepared("job-1");
        const pendingRetain = jobs.retainPrepared(manifest);
        yield* database(
          Effect.gen(function* () {
            const { sql } = yield* fixture;
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const json = canonicalProjectWorkPayload(manifest);
                  yield* sql`INSERT INTO project_work_verification_jobs VALUES ('environment-1','job-1','project-1','task-1',${json},${manifestHash})`;
                  for (const pending of [
                    pendingRead.pipe(Effect.asVoid),
                    pendingRetain.pipe(Effect.asVoid),
                  ])
                    expect((yield* pending.pipe(Effect.result))._tag).toBe("Failure");
                  return yield* Effect.fail("foreign rollback");
                }),
              )
              .pipe(Effect.result);
          }),
        );
        expect(yield* jobs.readPrepared("job-1")).toBeUndefined();
        expect((yield* jobs.retainPrepared(manifest)).manifest).toEqual(manifest);
      }),
    ),
);

const observe = Effect.fn("fixture.observePreparedReads")(function* (sql: SqlClient.SqlClient) {
  const reserved = yield* sql.reserve;
  const physicalReads: Array<{ count: number; manifests: unknown[] }> = [];
  const connection: Connection = {
    ...reserved,
    execute(query, params, rowTransform) {
      return reserved.execute(query, params, rowTransform).pipe(
        Effect.tap((rows) =>
          Effect.sync(() =>
            physicalReads.push({
              count: rows.length,
              manifests: rows.map((row) => Reflect.get(row, "manifest_json")),
            }),
          ),
        ),
      );
    },
  };
  const reader = yield* SqlClient.make({
    acquirer: Effect.succeed(connection),
    transactionAcquirer: Effect.succeed(connection),
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [],
  }).pipe(Effect.provide(Reactivity.layer));
  const jobs = yield* makeProjectWorkVerificationJobs({ environmentId: "environment-1" }).pipe(
    Effect.provideService(SqlClient.SqlClient, reader),
  );
  return { reader, jobs, physicalReads };
});

it.effect("bounds corrupt duplicate rows to two sentinels before denying an ambiguous job", () =>
  database(
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, jobs } = yield* fixture;
        yield* jobs.retainPrepared(manifest);
        yield* sql`CREATE TABLE corrupt_jobs AS SELECT * FROM project_work_verification_jobs`;
        yield* sql`DROP TABLE project_work_verification_jobs`;
        yield* sql`ALTER TABLE corrupt_jobs RENAME TO project_work_verification_jobs`;
        for (let index = 0; index < 4; index++)
          yield* sql`INSERT INTO project_work_verification_jobs SELECT * FROM project_work_verification_jobs LIMIT 1`;
        expect(yield* sql`SELECT count(*) AS count FROM project_work_verification_jobs`).toEqual([
          { count: 5 },
        ]);
        const observed = yield* observe(sql);
        expect(
          (yield* observed.jobs
            .readPrepared("job-1")
            .pipe(Effect.provideService(SqlClient.SqlClient, observed.reader), Effect.result))._tag,
        ).toBe("Failure");
        expect(observed.physicalReads.map((read) => read.count)).toEqual([2]);
      }),
    ),
  ),
);

for (const corruption of [
  "hash",
  "noncanonical",
  "changed-manifest",
  "duplicate-key",
  "unknown-key",
  "normalization",
  "owner",
  "task",
  "oversized",
  "future-version",
] as const) {
  it.effect("fails closed on " + corruption + " prepared manifest corruption", () =>
    database(
      Effect.scoped(
        Effect.gen(function* () {
          const { sql, jobs } = yield* fixture;
          yield* jobs.retainPrepared(manifest);
          yield* sql`DROP TRIGGER project_work_verification_jobs_immutable`;
          yield* sql`PRAGMA ignore_check_constraints=ON`;
          if (corruption === "hash")
            yield* sql`UPDATE project_work_verification_jobs SET sha256=${"0".repeat(64)}`;
          if (corruption === "noncanonical")
            yield* sql`UPDATE project_work_verification_jobs SET manifest_json=${" " + canonicalProjectWorkPayload(manifest)}`;
          if (corruption === "changed-manifest")
            yield* sql`UPDATE project_work_verification_jobs SET manifest_json=json_set(manifest_json,'$.generation',99)`;
          if (corruption === "duplicate-key")
            yield* sql`UPDATE project_work_verification_jobs SET manifest_json=${canonicalProjectWorkPayload(manifest).replace('"jobId":"job-1"', '"jobId":"job-1","jobId":"job-1"')}`;
          if (corruption === "unknown-key")
            yield* sql`UPDATE project_work_verification_jobs SET manifest_json=json_set(manifest_json,'$.approved',1)`;
          if (corruption === "normalization")
            yield* sql`UPDATE project_work_verification_jobs SET manifest_json=json_set(manifest_json,'$.projectId',' project-1 ')`;
          if (corruption === "owner")
            yield* sql`UPDATE project_work_verification_jobs SET project_id='foreign-project'`;
          if (corruption === "task")
            yield* sql`UPDATE project_work_verification_jobs SET task_id='foreign-task'`;
          if (corruption === "oversized")
            yield* sql`UPDATE project_work_verification_jobs SET manifest_json=${'"' + "é".repeat(32_768) + '"'}`;
          if (corruption === "future-version")
            yield* sql`UPDATE project_work_verification_jobs SET manifest_json=json_set(manifest_json,'$.version',2)`;
          expect((yield* jobs.readPrepared("job-1").pipe(Effect.result))._tag).toBe("Failure");
          expect((yield* jobs.retainPrepared(manifest).pipe(Effect.result))._tag).toBe("Failure");
          if (corruption === "oversized") {
            const observed = yield* observe(sql);
            expect(
              (yield* observed.jobs
                .readPrepared("job-1")
                .pipe(Effect.provideService(SqlClient.SqlClient, observed.reader), Effect.result))
                ._tag,
            ).toBe("Failure");
            expect(observed.physicalReads).toEqual([{ count: 1, manifests: [null] }]);
          }
        }),
      ),
    ),
  );
}
