import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ensureProjectTeamsTables } from "../../../projectWork/ProjectTeamsPersistence.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureProjectTeamsTables(sql);
});
