import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Verification from "./ProjectWorkVerification.ts";
import { verificationError } from "./ProjectWorkVerificationError.ts";
import { ensureTable, output, setup } from "./ProjectWorkVerification.testFixtures.ts";

it.live("executes the exact approved invocation once and atomically applies retained success", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0;
      let checks = 0;
      let applied = 0;
      const fixture = yield* setup((request) =>
        Effect.sync(() => {
          calls++;
          assert.equal(request.command, fixture.executable);
          assert.deepStrictEqual(request.args, ["--exact", "a b"]);
          assert.equal(request.cwd, fixture.repo);
          assert.equal(request.extendEnv, false);
          assert.equal(request.env?.PWD, fixture.repo);
          assert.equal(request.maxOutputBytes, 4096);
          return output;
        }),
      );
      yield* Effect.gen(function* () {
        yield* ensureTable;
        const service = yield* Verification.ProjectWorkVerification;
        const manifest = yield* service.capture(fixture.input, [fixture.executable]);
        yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
        const sql = yield* SqlClient.SqlClient;
        const authority: Verification.VerificationExecutionAuthority = {
          assertCurrent: () =>
            Effect.sync(() => {
              checks++;
            }),
          applyEvidence: (_result, _manifest, markApplied) =>
            Effect.gen(function* () {
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* markApplied;
                  assert.isTrue(Option.isSome(yield* Effect.serviceOption(sql.transactionService)));
                  applied++;
                }),
              );
            }).pipe(Effect.mapError(() => verificationError("storage"))),
        };
        const first = yield* service.execute(manifest.projectId, manifest.jobId, authority);
        assert.equal(first.stage, "applied");
        assert.equal(first.result?.outcome, "success");
        assert.equal(first.result?.stdout, "verified");
        const replay = yield* service.execute(manifest.projectId, manifest.jobId, authority);
        assert.deepStrictEqual(replay, first);
        assert.equal(calls, 1);
        assert.equal(checks, 4);
        assert.equal(applied, 1);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.live("rejects executable replacement and changed source HEAD before external execution", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0;
      const fixture = yield* setup(() =>
        Effect.sync(() => {
          calls++;
          return output;
        }),
      );
      yield* Effect.gen(function* () {
        yield* ensureTable;
        const service = yield* Verification.ProjectWorkVerification;
        const manifest = yield* service.capture(fixture.input, [fixture.executable]);
        yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
        fixture.replace();
        assert.isTrue(
          Exit.isFailure(
            yield* service
              .execute(manifest.projectId, manifest.jobId, {
                assertCurrent: () => Effect.void,
                applyEvidence: () => Effect.void,
              })
              .pipe(Effect.exit),
          ),
        );
        assert.equal(calls, 0);
        const recaptured = yield* service.capture({ ...fixture.input, jobId: "second" }, [
          fixture.executable,
        ]);
        yield* service.prepare(
          { manifest: recaptured, runtimeFiles: [fixture.executable] },
          Effect.void,
        );
        fixture.changeHead();
        assert.isTrue(
          Exit.isFailure(
            yield* service
              .execute(recaptured.projectId, recaptured.jobId, {
                assertCurrent: () => Effect.void,
                applyEvidence: () => Effect.void,
              })
              .pipe(Effect.exit),
          ),
        );
        assert.equal(calls, 0);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.live("retains timeout and partial outcomes without applying or rerunning them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0;
      let applied = 0;
      const fixture = yield* setup(() =>
        Effect.sync(() => {
          calls++;
          return { ...output, code: null, timedOut: true };
        }),
      );
      yield* Effect.gen(function* () {
        yield* ensureTable;
        const service = yield* Verification.ProjectWorkVerification;
        const manifest = yield* service.capture(fixture.input, [fixture.executable]);
        yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
        const authority = {
          assertCurrent: () => Effect.void,
          applyEvidence: () =>
            Effect.sync(() => {
              applied++;
            }),
        };
        const receipt = yield* service.execute(manifest.projectId, manifest.jobId, authority);
        assert.equal(receipt.stage, "finished");
        assert.equal(receipt.result?.outcome, "timed-out");
        assert.deepStrictEqual(
          yield* service.execute(manifest.projectId, manifest.jobId, authority),
          receipt,
        );
        assert.equal(calls, 1);
        assert.equal(applied, 0);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.live(
  "changed source and revoked authority after a successful command cannot apply evidence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let applied = 0;
        let revoked = false;
        const fixture = yield* setup(() =>
          Effect.sync(() => {
            revoked = true;
            return output;
          }),
        );
        yield* Effect.gen(function* () {
          yield* ensureTable;
          const service = yield* Verification.ProjectWorkVerification;
          const manifest = yield* service.capture(fixture.input, [fixture.executable]);
          yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
          const receipt = yield* service.execute(manifest.projectId, manifest.jobId, {
            assertCurrent: () =>
              revoked ? Effect.fail(verificationError("authority")) : Effect.void,
            applyEvidence: () =>
              Effect.sync(() => {
                applied++;
              }),
          });
          assert.equal(receipt.result?.outcome, "stale");
          assert.equal(applied, 0);
          assert.isTrue(Option.isSome(yield* service.read(manifest.projectId, manifest.jobId)));
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
);

it.live(
  "an interrupted or unknown prior claim survives service reconstruction and never reruns",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const fixture = yield* setup(() =>
          Effect.sync(() => {
            calls++;
            return output;
          }),
        );
        yield* Effect.gen(function* () {
          yield* ensureTable;
          const service = yield* Verification.ProjectWorkVerification;
          const manifest = yield* service.capture(fixture.input, [fixture.executable]);
          yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE t3_workflow_v2_verification_jobs SET stage='claimed',claim_id='prior' WHERE job_id=${manifest.jobId}`;
          const receipt = yield* service.execute(manifest.projectId, manifest.jobId, {
            assertCurrent: () => Effect.void,
            applyEvidence: () => Effect.void,
          });
          assert.equal(receipt.stage, "claimed");
          assert.equal(receipt.claimId, "prior");
          assert.equal(calls, 0);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
);

it.live(
  "retains success as stale when the command moves source HEAD before evidence application",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let applied = 0;
        const fixture = yield* setup(() =>
          Effect.sync(() => {
            fixture.changeHead();
            return output;
          }),
        );
        yield* Effect.gen(function* () {
          yield* ensureTable;
          const service = yield* Verification.ProjectWorkVerification;
          const manifest = yield* service.capture(fixture.input, [fixture.executable]);
          yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
          const receipt = yield* service.execute(manifest.projectId, manifest.jobId, {
            assertCurrent: () => Effect.void,
            applyEvidence: () =>
              Effect.sync(() => {
                applied++;
              }),
          });
          assert.equal(receipt.stage, "finished");
          assert.equal(receipt.result?.outcome, "stale");
          assert.equal(receipt.result?.stdout, "verified");
          assert.equal(applied, 0);
          const stored = yield* service.read(manifest.projectId, manifest.jobId);
          assert.isTrue(Option.isSome(stored));
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
);

it.live(
  "records output overflow and process uncertainty without supplying successful evidence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const fixture = yield* setup(() => {
          calls++;
          return calls === 1
            ? Effect.succeed({ ...output, stdoutTruncated: true })
            : Effect.die("lost process result");
        });
        yield* Effect.gen(function* () {
          yield* ensureTable;
          const service = yield* Verification.ProjectWorkVerification;
          const authority = {
            assertCurrent: () => Effect.void,
            applyEvidence: () => Effect.die("must not apply"),
          };
          for (const jobId of ["overflow", "unknown"]) {
            const manifest = yield* service.capture({ ...fixture.input, jobId }, [
              fixture.executable,
            ]);
            yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
            const receipt = yield* service.execute(manifest.projectId, jobId, authority);
            assert.equal(receipt.stage, "finished");
            assert.equal(receipt.result?.outcome, jobId === "overflow" ? "failed" : "unknown");
            assert.deepStrictEqual(
              yield* service.execute(manifest.projectId, jobId, authority),
              receipt,
            );
          }
          assert.equal(calls, 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
);

it.live("retains the claim before spawn and rolls evidence back when application fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let claimObserved = false;
      const fixture = yield* setup(() =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            stage: string;
            claim_id: string;
          }>`SELECT stage,claim_id FROM t3_workflow_v2_verification_jobs`;
          assert.equal(rows[0]?.stage, "claimed");
          assert.isString(rows[0]?.claim_id);
          claimObserved = true;
          return output;
        }).pipe(Effect.orDie),
      );
      yield* Effect.gen(function* () {
        yield* ensureTable;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE verification_test_evidence (id TEXT PRIMARY KEY)`;
        const service = yield* Verification.ProjectWorkVerification;
        const manifest = yield* service.capture(fixture.input, [fixture.executable]);
        yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
        const receipt = yield* service.execute(manifest.projectId, manifest.jobId, {
          assertCurrent: () => Effect.void,
          applyEvidence: (_result, _manifest, markApplied) =>
            sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO verification_test_evidence VALUES ('evidence')`;
                  yield* markApplied;
                  return yield* verificationError("authority");
                }),
              )
              .pipe(Effect.mapError(() => verificationError("authority"))),
        });
        assert.isTrue(claimObserved);
        assert.equal(receipt.result?.outcome, "stale");
        assert.equal((yield* sql`SELECT * FROM verification_test_evidence`).length, 0);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.live("interruption retains an unknown terminal result before the runner scope exits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let calls = 0;
      const fixture = yield* setup(() =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      );
      yield* Effect.gen(function* () {
        yield* ensureTable;
        const service = yield* Verification.ProjectWorkVerification;
        const manifest = yield* service.capture(fixture.input, [fixture.executable]);
        yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
        const authority = {
          assertCurrent: () => Effect.void,
          applyEvidence: () => Effect.die("must not apply"),
        };
        const fiber = yield* service
          .execute(manifest.projectId, manifest.jobId, authority)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const stored = yield* service.read(manifest.projectId, manifest.jobId);
        assert.isTrue(Option.isSome(stored));
        if (Option.isNone(stored)) return;
        assert.equal(stored.value.stage, "finished");
        assert.equal(stored.value.result?.outcome, "unknown");
        assert.deepStrictEqual(
          yield* service.execute(manifest.projectId, manifest.jobId, authority),
          stored.value,
        );
        assert.equal(calls, 1);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.live(
  "hidden assume-unchanged and skip-worktree source edits never claim an executable job",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
          let calls = 0;
          const fixture = yield* setup(() =>
            Effect.sync(() => {
              calls++;
              return output;
            }),
          );
          yield* Effect.gen(function* () {
            yield* ensureTable;
            const service = yield* Verification.ProjectWorkVerification;
            const manifest = yield* service.capture(fixture.input, [fixture.executable]);
            yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
            fixture.git(["update-index", flag, "source"]);
            const fs = process.getBuiltinModule("fs");
            fs.writeFileSync(`${fixture.repo}/source`, "UNAPPROVED hidden source");
            assert.equal(fixture.git(["status", "--porcelain=v1"]), "");
            assert.isTrue(
              Exit.isFailure(
                yield* service
                  .execute(manifest.projectId, manifest.jobId, {
                    assertCurrent: () => Effect.void,
                    applyEvidence: () => Effect.die("must not apply"),
                  })
                  .pipe(Effect.exit),
              ),
            );
            const stored = yield* service.read(manifest.projectId, manifest.jobId);
            assert.isTrue(Option.isSome(stored));
            if (Option.isSome(stored)) assert.equal(stored.value.stage, "prepared");
            assert.equal(calls, 0);
          }).pipe(Effect.provide(fixture.layer));
        }
      }),
    ),
);

it.live(
  "external source and runtime replacements during evidence preparation roll back evidence and retain stale output once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const artifact of ["source", "runtime", "hidden-source", "new-source", "head"]) {
          const entered = yield* Deferred.make<void>();
          const changed = yield* Deferred.make<void>();
          let calls = 0;
          const fixture = yield* setup(() =>
            Effect.sync(() => {
              calls++;
              return output;
            }),
          );
          yield* Effect.gen(function* () {
            yield* ensureTable;
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE verification_test_late_evidence (id TEXT PRIMARY KEY)`;
            const service = yield* Verification.ProjectWorkVerification;
            const manifest = yield* service.capture(fixture.input, [fixture.executable]);
            yield* service.prepare({ manifest, runtimeFiles: [fixture.executable] }, Effect.void);
            const writer = yield* Effect.gen(function* () {
              yield* Deferred.await(entered);
              if (artifact === "runtime") fixture.replace();
              else if (artifact === "head") fixture.changeHead();
              else if (artifact === "new-source")
                process
                  .getBuiltinModule("fs")
                  .writeFileSync(`${fixture.repo}/new-source`, "external new source");
              else {
                if (artifact === "hidden-source")
                  fixture.git(["update-index", "--assume-unchanged", "source"]);
                process
                  .getBuiltinModule("fs")
                  .writeFileSync(`${fixture.repo}/source`, "external changed source");
              }
              yield* Deferred.succeed(changed, undefined);
            }).pipe(Effect.forkScoped);
            const authority: Verification.VerificationExecutionAuthority = {
              assertCurrent: () => Effect.void,
              applyEvidence: (_result, _manifest, markApplied) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(changed);
                  yield* sql.withTransaction(
                    Effect.gen(function* () {
                      yield* sql`INSERT INTO verification_test_late_evidence VALUES ('must-roll-back')`;
                      yield* markApplied;
                    }),
                  );
                }).pipe(Effect.mapError(() => verificationError("authority"))),
            };
            const receipt = yield* service.execute(manifest.projectId, manifest.jobId, authority);
            yield* Fiber.join(writer);
            assert.equal(receipt.stage, "finished");
            assert.equal(receipt.result?.outcome, "stale");
            assert.equal(receipt.result?.stdout, "verified");
            assert.equal((yield* sql`SELECT * FROM verification_test_late_evidence`).length, 0);
            assert.deepStrictEqual(
              yield* service.execute(manifest.projectId, manifest.jobId, authority),
              receipt,
            );
            assert.equal(calls, 1);
          }).pipe(Effect.provide(fixture.layer));
        }
      }),
    ),
);

it.live(
  "final snapshot rejects runtime replacement before its baseline instead of accepting a new closure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const artifact of ["executable", "identical-executable", "dependency"]) {
          const snapshotReached = yield* Deferred.make<void>();
          const replaced = yield* Deferred.make<void>();
          let commandFinished = false;
          let stageCalls = 0;
          let calls = 0;
          let applications = 0;
          const fixture = yield* setup(
            () =>
              Effect.sync(() => {
                calls++;
                commandFinished = true;
                return output;
              }),
            (request) =>
              Effect.gen(function* () {
                if (commandFinished && request.args.includes("--stage") && ++stageCalls === 2) {
                  yield* Deferred.succeed(snapshotReached, undefined);
                  yield* Deferred.await(replaced);
                }
              }),
          );
          const fs = process.getBuiltinModule("fs");
          const dependency = `${fixture.root}/runtime-dependency`;
          fs.writeFileSync(dependency, "approved runtime dependency");
          const runtimeFiles = [fixture.executable, dependency];
          yield* Effect.gen(function* () {
            yield* ensureTable;
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE verification_test_replaced_runtime_evidence (id TEXT PRIMARY KEY)`;
            const service = yield* Verification.ProjectWorkVerification;
            const manifest = yield* service.capture(fixture.input, runtimeFiles);
            yield* service.prepare({ manifest, runtimeFiles }, Effect.void);
            const writer = yield* Effect.gen(function* () {
              yield* Deferred.await(snapshotReached);
              if (artifact === "executable") fixture.replace();
              else if (artifact === "dependency")
                fs.writeFileSync(dependency, "unapproved runtime dependency");
              else {
                const replacement = `${fixture.root}/identical-runtime`;
                fs.writeFileSync(replacement, fs.readFileSync(fixture.executable), { mode: 0o700 });
                fs.renameSync(replacement, fixture.executable);
              }
              yield* Deferred.succeed(replaced, undefined);
            }).pipe(Effect.forkScoped);
            const authority: Verification.VerificationExecutionAuthority = {
              assertCurrent: () => Effect.void,
              applyEvidence: (_result, _manifest, markApplied) =>
                sql
                  .withTransaction(
                    Effect.gen(function* () {
                      applications++;
                      yield* sql`INSERT INTO verification_test_replaced_runtime_evidence VALUES ('must-not-commit')`;
                      yield* markApplied;
                    }),
                  )
                  .pipe(Effect.mapError(() => verificationError("authority"))),
            };
            const receipt = yield* service.execute(manifest.projectId, manifest.jobId, authority);
            yield* Fiber.join(writer);
            assert.equal(stageCalls, 2);
            assert.equal(calls, 1);
            assert.equal(applications, 0);
            assert.equal(receipt.stage, "finished");
            assert.equal(receipt.result?.outcome, "stale");
            assert.equal(receipt.result?.stdout, "verified");
            assert.equal(
              (yield* sql`SELECT * FROM verification_test_replaced_runtime_evidence`).length,
              0,
            );
            assert.deepStrictEqual(
              yield* service.execute(manifest.projectId, manifest.jobId, authority),
              receipt,
            );
            assert.equal(calls, 1);
          }).pipe(Effect.provide(fixture.layer));
        }
      }),
    ),
);
