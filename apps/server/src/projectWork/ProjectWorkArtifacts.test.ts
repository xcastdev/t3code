import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { canonicalProjectWorkPayload, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  makeProjectWorkArtifacts,
  ProjectWorkArtifactApplicability,
} from "./ProjectWorkArtifacts.ts";

const applicability = Schema.decodeUnknownSync(ProjectWorkArtifactApplicability)({
  projectId: "project-1",
  taskId: "task-1",
  specRevision: 2,
  planRevision: 3,
  repository: "owner/repo",
  worktree: "/sandbox/work",
  testedTree: "tree-1",
  testedCommit: "commit-1",
  baseSha: "base-1",
  headSha: "head-1",
  command: "vp test run focused.test.ts",
  exitCode: 0,
  environmentSummary: "Controlled verification",
  integration: false,
});
const options = { environmentId: "environment-1", maximumArtifactBytes: 1_048_576 };
const input = {
  artifactId: "artifact-1",
  sourceId: "verification-1",
  applicability,
  bytes: new Uint8Array([0, 255, 128, 13, 10, 0]),
};
const database = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  body.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("retains exact binary bytes and a receipt bound to its immutable applicability", () =>
  database(
    Effect.gen(function* () {
      yield* runMigrations();
      const artifacts = yield* makeProjectWorkArtifacts(options);
      const receipt = yield* artifacts.retain(input);
      expect(receipt).toMatchObject({
        artifactId: "artifact-1",
        sourceId: "verification-1",
        applicability,
        byteCount: 6,
      });
      expect(receipt.sha256).toBe(
        "192345604f36cfa29999f86d1cb4805fa790075df3d053d566d3b9fb4d680cdc",
      );
      const retained = yield* artifacts.readRetained("artifact-1");
      expect(retained?.bytes).toEqual(new Uint8Array([0, 255, 128, 13, 10, 0]));
      expect(
        yield* artifacts.retainedIdsFor({
          applicability,
          artifactIds: ["artifact-1", "attachment-1"],
        }),
      ).toEqual(["artifact-1"]);
    }),
  ),
);

const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* makeProjectWorkArtifacts(options);
  return { sql, artifacts };
});

it.effect("binary and empty artifacts survive closing and reopening the migrated database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-artifacts-" });
    const filename = path.join(directory, "state.sqlite");
    yield* Effect.gen(function* () {
      const { artifacts } = yield* fixture;
      yield* artifacts.retain(input);
      const empty = yield* artifacts.retain({
        ...input,
        artifactId: "empty",
        bytes: new Uint8Array(),
      });
      expect(empty.byteCount).toBe(0);
      expect(empty.sha256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    yield* Effect.gen(function* () {
      expect(yield* runMigrations()).toEqual([]);
      const artifacts = yield* makeProjectWorkArtifacts(options);
      expect((yield* artifacts.readRetained("artifact-1"))?.bytes).toEqual(input.bytes);
      expect((yield* artifacts.readRetained("empty"))?.bytes).toEqual(new Uint8Array());
      expect(yield* artifacts.readRetained("absent")).toBeUndefined();
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("identical and conflicting concurrent retain calls preserve one immutable winner", () =>
  database(
    Effect.gen(function* () {
      const { artifacts } = yield* fixture;
      const identical = yield* Effect.all([artifacts.retain(input), artifacts.retain(input)], {
        concurrency: "unbounded",
      });
      expect(identical[0]).toEqual(identical[1]);
      const other = { ...input, artifactId: "concurrent", bytes: new Uint8Array([11]) };
      const competing = { ...other, sourceId: "second-writer", bytes: new Uint8Array([22]) };
      const outcomes = yield* Effect.all(
        [
          artifacts.retain(other).pipe(Effect.result),
          artifacts.retain(competing).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual(["Failure", "Success"]);
      const retained = yield* artifacts.readRetained("concurrent");
      expect(retained?.bytes).toEqual(
        retained?.sourceId === other.sourceId ? other.bytes : competing.bytes,
      );
      expect(
        (yield* artifacts.retain({ ...input, sourceId: "different" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* artifacts
          .retain({ ...input, bytes: new Uint8Array([0, 255, 128, 13, 10, 1]) })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* artifacts.readRetained("artifact-1"))?.bytes).toEqual(input.bytes);
    }),
  ),
);

it.effect("each immutable applicability field must match before a retained ID is returned", () =>
  database(
    Effect.gen(function* () {
      const { artifacts } = yield* fixture;
      yield* artifacts.retain(input);
      const changed = [
        { ...applicability, projectId: ProjectId.make("other-project") },
        { ...applicability, taskId: ProjectWorkTaskId.make("other-task") },
        { ...applicability, specRevision: 3 },
        { ...applicability, planRevision: 4 },
        { ...applicability, repository: "other/repo" },
        { ...applicability, worktree: "/other/work" },
        { ...applicability, testedTree: "different-tree" },
        { ...applicability, testedCommit: "different-commit" },
        { ...applicability, baseSha: "different-base" },
        { ...applicability, headSha: "different-head" },
        { ...applicability, command: "another command" },
        { ...applicability, exitCode: 1 },
        { ...applicability, environmentSummary: "different environment" },
        { ...applicability, integration: true },
      ];
      const { testedCommit: _commit, ...withoutCommit } = applicability;
      for (const target of [...changed, withoutCommit]) {
        expect(
          yield* artifacts.retainedIdsFor({ applicability: target, artifactIds: ["artifact-1"] }),
        ).toEqual([]);
        expect(
          (yield* artifacts.retain({ ...input, applicability: target }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      expect(
        yield* artifacts.retainedIdsFor({ applicability, artifactIds: ["artifact-1"] }),
      ).toEqual(["artifact-1"]);
    }),
  ),
);

it.effect("environment ownership prevents foreign reads but permits independent ID reuse", () =>
  database(
    Effect.gen(function* () {
      const { artifacts } = yield* fixture;
      yield* artifacts.retain(input);
      const foreign = yield* makeProjectWorkArtifacts({
        ...options,
        environmentId: "environment-2",
      });
      expect(yield* foreign.readRetained("artifact-1")).toBeUndefined();
      expect(yield* foreign.retainedIdsFor({ applicability, artifactIds: ["artifact-1"] })).toEqual(
        [],
      );
      yield* foreign.retain({ ...input, bytes: new Uint8Array([42]) });
      expect((yield* foreign.readRetained("artifact-1"))?.bytes).toEqual(new Uint8Array([42]));
      const read = yield* artifacts.readRetained("artifact-1");
      read?.bytes.fill(88);
      expect((yield* artifacts.readRetained("artifact-1"))?.bytes).toEqual(input.bytes);
    }),
  ),
);

it.effect(
  "a receipt for a failed command retains bytes without granting success qualification",
  () =>
    database(
      Effect.gen(function* () {
        const { artifacts } = yield* fixture;
        const failed = { ...applicability, exitCode: 1, integration: true };
        yield* artifacts.retain({ ...input, applicability: failed });
        expect(
          yield* artifacts.retainedIdsFor({ applicability: failed, artifactIds: ["artifact-1"] }),
        ).toEqual(["artifact-1"]);
        expect(
          yield* artifacts.retainedIdsFor({ applicability, artifactIds: ["artifact-1"] }),
        ).toEqual([]);
      }),
    ),
);

it.effect("existing worker evidence and attachment IDs do not establish raw retention", () =>
  database(
    Effect.gen(function* () {
      const { sql, artifacts } = yield* fixture;
      yield* sql`INSERT INTO project_work_evidence (evidence_id,project_id,task_id,kind,summary,recorded_at,revision,output_artifact_ids_json)
      VALUES ('worker-evidence','project-1','task-1','test-result','Worker claims success','2026-10-06T00:00:00Z',1,'["worker-output","attachment-id"]')`;
      expect(
        yield* artifacts.retainedIdsFor({
          applicability,
          artifactIds: ["worker-evidence", "worker-output", "attachment-id"],
        }),
      ).toEqual([]);
    }),
  ),
);

it.effect(
  "captures caller options, identity, applicability and bytes synchronously while SQL is held",
  () =>
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
        const callerOptions = { ...options };
        const constructing = makeProjectWorkArtifacts(callerOptions);
        callerOptions.environmentId = "changed-environment";
        const artifacts = yield* constructing;
        const caller = {
          ...input,
          applicability: { ...applicability },
          bytes: new Uint8Array(input.bytes),
        };
        const pending = artifacts.retain(caller);
        caller.artifactId = "changed-id";
        caller.sourceId = "changed-source";
        caller.applicability.command = "changed command";
        caller.bytes.fill(99);
        const writer = yield* pending.pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(blocker);
        expect((yield* Fiber.join(writer)).artifactId).toBe("artifact-1");
        const stored = yield* artifacts.readRetained("artifact-1");
        expect(stored?.sourceId).toBe("verification-1");
        expect(stored?.applicability.command).toBe("vp test run focused.test.ts");
        expect(stored?.bytes).toEqual(input.bytes);
        expect(yield* artifacts.readRetained("changed-id")).toBeUndefined();
        const selection = { applicability: { ...applicability }, artifactIds: ["artifact-1"] };
        const selected = artifacts.retainedIdsFor(selection);
        selection.applicability.command = "new command";
        selection.artifactIds[0] = "changed-id";
        expect(yield* selected).toEqual(["artifact-1"]);
      }),
    ),
);

it.effect("rejects normalized, unknown, oversized and malformed input without retaining rows", () =>
  database(
    Effect.gen(function* () {
      const { sql, artifacts } = yield* fixture;
      const invalid = [
        { ...input, artifactId: " artifact-1 " },
        { ...input, sourceId: "" },
        { ...input, artifactId: "x".repeat(257) },
        { ...input, unknown: true },
        { ...input, applicability: { ...applicability, repository: " owner/repo " } },
        { ...input, applicability: { ...applicability, projectId: ProjectId.make(" project-1 ") } },
        { ...input, applicability: { ...applicability, status: "current" } },
        {
          ...input,
          applicability: { ...applicability, specRevision: Number.MAX_SAFE_INTEGER + 1 },
        },
        { ...input, bytes: new Uint8Array(1_048_577) },
        {
          ...input,
          applicability: {
            ...applicability,
            command: "é".repeat(32_000),
            worktree: "é".repeat(4_000),
          },
        },
      ];
      for (const candidate of invalid)
        expect((yield* artifacts.retain(candidate).pipe(Effect.result))._tag).toBe("Failure");
      const small = yield* makeProjectWorkArtifacts({ ...options, maximumArtifactBytes: 1 });
      expect((yield* small.retain(input).pipe(Effect.result))._tag).toBe("Failure");
      for (const maximumArtifactBytes of [0, -1, 1.5, 1_048_577, Number.MAX_SAFE_INTEGER + 1])
        expect(
          (yield* makeProjectWorkArtifacts({ ...options, maximumArtifactBytes }).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
      for (const environmentId of ["", " environment ", "x".repeat(257)])
        expect(
          (yield* makeProjectWorkArtifacts({ ...options, environmentId }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      for (const artifactIds of [
        ["duplicate", "duplicate"],
        Array.from({ length: 129 }, (_, index) => "id-" + index),
        [" untrimmed "],
      ])
        expect(
          (yield* artifacts.retainedIdsFor({ applicability, artifactIds }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      expect(yield* artifacts.retainedIdsFor({ applicability, artifactIds: [] })).toEqual([]);
      expect(yield* sql`SELECT * FROM project_work_artifacts`).toEqual([]);
    }),
  ),
);

it.effect(
  "accepts the exact configured raw-byte boundary and returns selected IDs in requested order",
  () =>
    database(
      Effect.gen(function* () {
        const { artifacts } = yield* fixture;
        yield* artifacts.retain({ ...input, bytes: new Uint8Array(1_048_576) });
        yield* artifacts.retain({ ...input, artifactId: "second" });
        expect((yield* artifacts.readRetained("artifact-1"))?.byteCount).toBe(1_048_576);
        const ids = [
          "second",
          ...Array.from({ length: 126 }, (_, index) => "absent-" + index),
          "artifact-1",
        ];
        expect(yield* artifacts.retainedIdsFor({ applicability, artifactIds: ids })).toEqual([
          "second",
          "artifact-1",
        ]);
        const smaller = yield* makeProjectWorkArtifacts({ ...options, maximumArtifactBytes: 1 });
        expect((yield* smaller.readRetained("artifact-1").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }),
    ),
);

for (const operation of ["retain", "readRetained", "retainedIdsFor"] as const) {
  it.effect("rejects execution of " + operation + " inside a caller-owned transaction", () =>
    database(
      Effect.gen(function* () {
        const { sql, artifacts } = yield* fixture;
        yield* artifacts.retain(input);
        const uncommitted = { ...input, artifactId: "uncommitted" };
        const pending =
          operation === "retain"
            ? artifacts.retain({ ...input, artifactId: "owned-insert" }).pipe(Effect.asVoid)
            : operation === "readRetained"
              ? artifacts.readRetained(uncommitted.artifactId).pipe(Effect.asVoid)
              : artifacts
                  .retainedIdsFor({
                    applicability,
                    artifactIds: [uncommitted.artifactId],
                  })
                  .pipe(Effect.asVoid);
        const rolledBack = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const manifest = canonicalProjectWorkPayload({
                artifactId: uncommitted.artifactId,
                sourceId: uncommitted.sourceId,
                applicability,
              });
              yield* sql`INSERT INTO project_work_artifacts
              SELECT environment_id,${uncommitted.artifactId},project_id,task_id,source_id,${manifest},sha256,byte_count,raw_bytes
              FROM project_work_artifacts WHERE artifact_id='artifact-1'`;
              expect((yield* pending.pipe(Effect.result))._tag).toBe("Failure");
              expect(
                yield* sql`SELECT artifact_id FROM project_work_artifacts ORDER BY artifact_id`,
              ).toEqual([{ artifact_id: "artifact-1" }, { artifact_id: "uncommitted" }]);
              return yield* Effect.fail("caller rollback");
            }),
          )
          .pipe(Effect.result);
        expect(rolledBack._tag).toBe("Failure");
        expect(yield* artifacts.readRetained(uncommitted.artifactId)).toBeUndefined();
        expect(yield* artifacts.readRetained("owned-insert")).toBeUndefined();
        expect((yield* artifacts.readRetained("artifact-1"))?.bytes).toEqual(input.bytes);
        expect(
          yield* artifacts.retainedIdsFor({ applicability, artifactIds: ["artifact-1"] }),
        ).toEqual(["artifact-1"]);
      }),
    ),
  );
}

it.effect("an actual SQLite write failure yields no receipt and the same retention can retry", () =>
  database(
    Effect.gen(function* () {
      const { sql, artifacts } = yield* fixture;
      yield* sql`CREATE TRIGGER controlled_artifact_write_failure BEFORE INSERT ON project_work_artifacts
        BEGIN SELECT RAISE(ABORT,'controlled write failure'); END`;
      const pending = artifacts.retain(input);
      expect((yield* pending.pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* artifacts.readRetained("artifact-1")).toBeUndefined();
      yield* sql`DROP TRIGGER controlled_artifact_write_failure`;
      expect((yield* pending).artifactId).toBe("artifact-1");
      expect((yield* artifacts.readRetained("artifact-1"))?.bytes).toEqual(input.bytes);
    }),
  ),
);

it.effect("bounds duplicate corrupt rows to two sentinels before denying ambiguous retention", () =>
  database(
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, artifacts } = yield* fixture;
        yield* artifacts.retain({ ...input, bytes: new Uint8Array(1_048_576) });
        // Destroy uniqueness on the actual migrated table, retaining its physical rows.
        yield* sql`CREATE TABLE corrupt_artifacts AS SELECT * FROM project_work_artifacts`;
        yield* sql`DROP TABLE project_work_artifacts`;
        yield* sql`ALTER TABLE corrupt_artifacts RENAME TO project_work_artifacts`;
        for (let index = 0; index < 4; index++)
          yield* sql`INSERT INTO project_work_artifacts SELECT * FROM project_work_artifacts LIMIT 1`;
        expect(yield* sql`SELECT count(*) AS count FROM project_work_artifacts`).toEqual([
          { count: 5 },
        ]);
        const reserved = yield* sql.reserve;
        const returnedRowCounts: number[] = [];
        const connection: Connection = {
          ...reserved,
          execute(query, params, rowTransform) {
            return reserved
              .execute(query, params, rowTransform)
              .pipe(Effect.tap((rows) => Effect.sync(() => returnedRowCounts.push(rows.length))));
          },
        };
        const reader = yield* SqlClient.make({
          acquirer: Effect.succeed(connection),
          transactionAcquirer: Effect.succeed(connection),
          compiler: Statement.makeCompilerSqlite(),
          spanAttributes: [],
        }).pipe(Effect.provide(Reactivity.layer));
        const observed = yield* makeProjectWorkArtifacts(options).pipe(
          Effect.provideService(SqlClient.SqlClient, reader),
        );
        expect(
          (yield* observed
            .readRetained("artifact-1")
            .pipe(Effect.provideService(SqlClient.SqlClient, reader), Effect.result))._tag,
        ).toBe("Failure");
        expect(returnedRowCounts).toEqual([2]);
        returnedRowCounts.length = 0;
        expect(
          (yield* observed
            .retainedIdsFor({ applicability, artifactIds: ["artifact-1"] })
            .pipe(Effect.provideService(SqlClient.SqlClient, reader), Effect.result))._tag,
        ).toBe("Failure");
        expect(returnedRowCounts).toEqual([2]);
      }),
    ),
  ),
);

for (const corruption of [
  "hash",
  "blob",
  "count",
  "manifest-json",
  "manifest-binding",
  "unknown-key",
  "duplicate-key",
  "normalization",
  "owner-binding",
  "oversized-manifest",
  "oversized-blob",
]) {
  it.effect("fails closed when a retained artifact has " + corruption + " corruption", () =>
    database(
      Effect.gen(function* () {
        const { sql, artifacts } = yield* fixture;
        yield* artifacts.retain(input);
        // Inject physical corruption after migrating the real immutable schema.
        yield* sql`DROP TRIGGER project_work_artifacts_immutable`;
        yield* sql`PRAGMA ignore_check_constraints=ON`;
        const rows = yield* sql<{
          manifest_json: string;
        }>`SELECT manifest_json FROM project_work_artifacts`;
        const manifest = rows[0]!.manifest_json;
        if (corruption === "hash")
          yield* sql`UPDATE project_work_artifacts SET sha256=${"0".repeat(64)}`;
        if (corruption === "blob")
          yield* sql`UPDATE project_work_artifacts SET raw_bytes=${new Uint8Array([0, 255, 128, 13, 10, 1])}`;
        if (corruption === "count") yield* sql`UPDATE project_work_artifacts SET byte_count=1`;
        if (corruption === "manifest-json")
          yield* sql`UPDATE project_work_artifacts SET manifest_json=${" {} "}`;
        if (corruption === "manifest-binding")
          yield* sql`UPDATE project_work_artifacts SET source_id='other-source'`;
        if (corruption === "unknown-key")
          yield* sql`UPDATE project_work_artifacts SET manifest_json=json_set(manifest_json,'$.unknown',1)`;
        if (corruption === "duplicate-key")
          yield* sql`UPDATE project_work_artifacts SET manifest_json=${manifest.replace('"artifactId":"artifact-1"', '"artifactId":"artifact-1","artifactId":"artifact-1"')}`;
        if (corruption === "normalization")
          yield* sql`UPDATE project_work_artifacts SET manifest_json=json_set(manifest_json,'$.applicability.repository',' owner/repo ')`;
        if (corruption === "owner-binding")
          yield* sql`UPDATE project_work_artifacts SET project_id='foreign-project'`;
        if (corruption === "oversized-manifest")
          yield* sql`UPDATE project_work_artifacts SET manifest_json=${'"' + "é".repeat(32_768) + '"'}`;
        if (corruption === "oversized-blob")
          yield* sql`UPDATE project_work_artifacts SET raw_bytes=${new Uint8Array(1_048_577)},byte_count=1048577`;
        expect((yield* artifacts.readRetained("artifact-1").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* artifacts
            .retainedIdsFor({ applicability, artifactIds: ["artifact-1"] })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* artifacts.retain(input).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
  );
}
