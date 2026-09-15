# Database migrations

The server runs two independent migration sequences on startup, each tracked in
its own table. They are defined in `apps/server/src/persistence/Migrations.ts`.

| Sequence | Ids                      | Tracking table          | Lives in           |
| -------- | ------------------------ | ----------------------- | ------------------ |
| Upstream | 1 and up, as shipped     | `effect_sql_migrations` | `Migrations/`      |
| Fork     | 1 and up, this repo only | `t3_fork_migrations`    | `Migrations/fork/` |

## Why there are two

The migrator records applied ids and runs only those greater than the highest id
in its table. With a single shared sequence, upstream and this fork both hand out
the same next number to different schema changes. A database that recorded
upstream's version of an id then skips ours forever, because the id no longer
looks pending, and the server later fails on a column that was never created.
Renumbering on every sync is the same trap deferred: the id is already recorded
in someone's database by then, and jumping to a high band is worse, since it
makes every future upstream id look already applied.

Two tables remove the shared counter. Upstream keeps its numbering exactly as
released, so a database written by upstream T3 Code and one written here agree
on what an id means. Fork ids are compared only against fork ids, so upstream
can add numbers indefinitely without colliding with, skipping, or reordering
anything here.

## Adding a migration

Put new schema work in `Migrations/fork/`, named `NNN_DescriptiveName.ts`, and
append it to `forkMigrationEntries`. Only touch `migrationEntries` when carrying
an upstream migration across during a sync.

Upstream runs to completion before fork does, so a fork migration may depend on
upstream tables. The reverse is not true, and an upstream migration must never
assume a fork table exists.

## Testing a migration

`runMigrations` takes a boundary per sequence. Use `toForkMigrationInclusive` to
reconstruct the schema as it looked just before the migration under test, then
run it:

```ts
yield * runMigrations({ toForkMigrationInclusive: 4 }); // state before fork 005
// seed rows here
yield * runMigrations({ toForkMigrationInclusive: 5 }); // run fork 005
```

Pass `0` to run no fork migrations at all, which reproduces a database from
before the fork sequence existed. `toMigrationInclusive` does the same for the
upstream sequence. `runUpstreamMigrations` and `runForkMigrations` run a single
sequence when a test needs them apart.

`Migrations.forkSequence.test.ts` covers the property that matters: fork
migrations still run when the upstream table holds ids in the same numeric range.
