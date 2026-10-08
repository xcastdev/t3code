import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

import * as SqliteClient from "./nodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );
  it.effect(
    "rolls back a failed deferred COMMIT before releasing the connection and preserves subsequent transactions",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys=ON`;
        yield* sql`CREATE TABLE commit_parent(id INTEGER PRIMARY KEY)`;
        yield* sql`CREATE TABLE commit_child(id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO commit_parent(id) VALUES(1)`;
            yield* sql`INSERT INTO commit_child(id) VALUES(1)`;
          }),
        );
        let bodyCompleted = false;
        const failed = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO commit_parent(id) VALUES(2)`;
              yield* sql`INSERT INTO commit_child(id) VALUES(999)`;
              assert.deepEqual(yield* sql`SELECT id FROM commit_child ORDER BY id`, [
                { id: 1 },
                { id: 999 },
              ]);
              bodyCompleted = true;
            }),
          )
          .pipe(Effect.exit);
        assert.equal(bodyCompleted, true);
        assert.equal(failed._tag, "Failure");
        if (failed._tag === "Failure")
          assert.equal(SqlError.isSqlError(Cause.squash(failed.cause)), true);
        // No test-side ROLLBACK: the next borrower must see the original committed rows.
        assert.deepEqual(yield* sql`SELECT id FROM commit_parent ORDER BY id`, [{ id: 1 }]);
        assert.deepEqual(yield* sql`SELECT id FROM commit_child ORDER BY id`, [{ id: 1 }]);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO commit_parent(id) VALUES(2)`;
            yield* sql`INSERT INTO commit_child(id) VALUES(2)`;
          }),
        );
        const bodyFailure = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO commit_parent(id) VALUES(3)`;
              return yield* Effect.fail("controlled-body-failure");
            }),
          )
          .pipe(Effect.result);
        assert.equal(bodyFailure._tag, "Failure");
        if (bodyFailure._tag === "Failure")
          assert.equal(bodyFailure.failure, "controlled-body-failure");
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO commit_parent(id) VALUES(3)`;
            const nested = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO commit_parent(id) VALUES(4)`;
                  return yield* Effect.fail("controlled-savepoint-failure");
                }),
              )
              .pipe(Effect.result);
            assert.equal(nested._tag, "Failure");
            if (nested._tag === "Failure")
              assert.equal(nested.failure, "controlled-savepoint-failure");
            assert.deepEqual(yield* sql`SELECT id FROM commit_parent ORDER BY id`, [
              { id: 1 },
              { id: 2 },
              { id: 3 },
            ]);
            yield* sql.withTransaction(sql`INSERT INTO commit_child(id) VALUES(3)`);
          }),
        );
        assert.deepEqual(yield* sql`SELECT id FROM commit_child ORDER BY id`, [
          { id: 1 },
          { id: 2 },
          { id: 3 },
        ]);
      }),
  );
  it.effect(
    "preserves both COMMIT and rescue ROLLBACK errors through the public transaction finalizer",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE closed_transaction_entries(id INTEGER PRIMARY KEY)`;
        let bodyCompleted = false;
        const failed = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO closed_transaction_entries(id) VALUES(1)`;
              // Deliberately close the body transaction so COMMIT and its rescue
              // both fail. No cleanup follows the public transaction result.
              yield* sql.unsafe("ROLLBACK").unprepared;
              bodyCompleted = true;
            }),
          )
          .pipe(Effect.exit);
        assert.equal(bodyCompleted, true);
        assert.equal(failed._tag, "Failure");
        if (failed._tag === "Failure") {
          assert.equal(failed.cause.reasons.length, 2, Cause.pretty(failed.cause));
          const messages: Array<string> = [];
          for (const reason of failed.cause.reasons) {
            assert.equal(reason._tag, "Die");
            if (reason._tag !== "Die") continue;
            assert.equal(SqlError.isSqlError(reason.defect), true);
            if (!SqlError.isSqlError(reason.defect)) continue;
            assert.equal(reason.defect.reason.operation, "execute");
            const nativeCause = reason.defect.reason.cause;
            assert.equal(nativeCause instanceof Error, true);
            if (nativeCause instanceof Error) messages.push(nativeCause.message);
          }
          assert.deepEqual(messages, [
            "cannot commit - no transaction is active",
            "cannot rollback - no transaction is active",
          ]);
        }
        assert.deepEqual(yield* sql`SELECT id FROM closed_transaction_entries`, []);
        yield* sql.withTransaction(sql`INSERT INTO closed_transaction_entries(id) VALUES(2)`);
        assert.deepEqual(yield* sql`SELECT id FROM closed_transaction_entries`, [{ id: 2 }]);
      }),
  );
});

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);
