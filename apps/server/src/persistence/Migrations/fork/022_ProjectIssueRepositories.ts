import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { importLegacyIssueRepositories } from "../../../projectWork/ProjectIssueRepositoryMigration.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* importLegacyIssueRepositories(sql);
});
