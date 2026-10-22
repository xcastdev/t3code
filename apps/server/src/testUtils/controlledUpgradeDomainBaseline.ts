import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { assistantRoutineMigration } from "../persistence/AssistantRoutineMigration.ts";
import { assistantMigration } from "../persistence/AssistantMigration.ts";
import { assistantMemoryMigration } from "../persistence/AssistantMemoryMigration.ts";
import { projectMemoryMigration } from "../persistence/ProjectMemoryMigration.ts";
import { projectMemoryProcessingMigration } from "../persistence/ProjectMemoryProcessingMigration.ts";

const tables = [
  assistantMigration,
  assistantRoutineMigration,
  assistantMemoryMigration,
  projectMemoryMigration,
  projectMemoryProcessingMigration,
].flatMap((migration) =>
  migration.objects.filter((object) => object.type === "table").map((object) => object.name),
);

/** Default recovery is safe only when the copied source has no feature-owned work to resume. */
export const assertControlledUpgradeDomainEmpty = Effect.fn("ControlledUpgrade.assertDomainEmpty")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const name of tables) {
      const rows = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM ${sql(name)}`;
      if (rows[0]?.count !== 0)
        throw new Error(`Controlled fixture requires an empty copied feature domain: ${name}`);
    }
  },
);
