import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { at, projectId, scoped, seed } from "../ProjectTeamAuthorization.testFixtures.ts";
import { readProjectMemoryObservations } from "./ProjectMemoryRetrieval.ts";

it.effect(
  "degrades malformed physical observation identities without transferring their bodies",
  () =>
    scoped(
      Effect.gen(function* () {
        yield* seed();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO project_team_memory_observation
      (record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES ('foreign-hit','foreign-project','current',0,0,${at},'foreign body must not be decoded')`;
        const empty = yield* readProjectMemoryObservations(sql, projectId, "bounded task");
        expect(empty).toMatchObject({ status: "available", records: [], omitted: [] });
        const badId = "x".repeat(1025);
        yield* sql`INSERT INTO project_team_memory_observation
      (record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES (${badId},${projectId},'current',0,0,${at},'deliberately not an authority payload')`;
        expect(
          yield* sql`SELECT length(CAST(record_id AS BLOB)) AS bytes
      FROM project_team_memory_observation WHERE project_id=${projectId}`,
        ).toEqual([{ bytes: 1025 }]);
        const result = yield* readProjectMemoryObservations(sql, projectId, "bounded task");
        expect(result).toMatchObject({
          status: "degraded",
          records: [],
          omitted: ["Observation candidate identity is unavailable"],
        });
        expect(result.provenance).not.toEqual(empty.provenance);
      }),
    ),
);
