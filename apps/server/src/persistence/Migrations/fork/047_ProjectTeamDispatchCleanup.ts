import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Cleanup closes new admission without changing the original stage or native receipt identities. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_team_dispatch ADD COLUMN cleanup_claim_revision INTEGER
    CHECK(cleanup_claim_revision IS NULL OR (cleanup_claim_revision >= 0 AND cleanup_claim_revision <= revision))`;
  yield* sql`CREATE TRIGGER project_team_dispatch_cleanup_claim_insert
    BEFORE INSERT ON project_team_dispatch WHEN NEW.cleanup_claim_revision IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'A dispatch cannot begin with cleanup ownership'); END`;
  yield* sql`CREATE TRIGGER project_team_dispatch_cleanup_claim_immutable
    BEFORE UPDATE ON project_team_dispatch WHEN
      (OLD.cleanup_claim_revision IS NOT NULL AND NEW.cleanup_claim_revision IS NOT OLD.cleanup_claim_revision)
      OR (OLD.cleanup_claim_revision IS NULL AND NEW.cleanup_claim_revision IS NOT NULL AND
        (OLD.stage <> 'assignment-observed' OR NEW.stage <> OLD.stage OR NEW.cleanup_claim_revision <> OLD.revision OR
         NEW.revision <> OLD.revision OR NEW.claim_generation <> OLD.claim_generation OR OLD.claim_generation < 1))
    BEGIN SELECT RAISE(ABORT,'Dispatch cleanup claim is immutable and requires its current observed revision'); END`;
});
