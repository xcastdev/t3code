import type { EnvironmentId, MemoryOwner } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectMemoryError, ownerId } from "../projectWork/memory/ProjectMemoryRepository.ts";
import { AssistantRepository } from "./AssistantRepository.ts";
const isMemoryError = Schema.is(ProjectMemoryError);

export const makeAssistantMemoryRecipientMetadata = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* ServerEnvironment;
  const repository = yield* AssistantRepository;
  return Effect.fn("AssistantMemory.recipientMetadata")(
    function* (input: { environmentId: EnvironmentId; owner: MemoryOwner }) {
      if (input.environmentId !== (yield* environment.getEnvironmentId))
        return yield* new ProjectMemoryError({ reason: "forbidden" });
      const retained = (yield* sql<{
        revision: number;
        deleted: number;
      }>`SELECT revision,deleted FROM t3_workflow_v2_memory_owners WHERE environment_id=${input.environmentId} AND owner_kind=${input.owner.kind} AND owner_id=${ownerId(input.owner)}`)[0];
      if (retained?.deleted === 1) return yield* new ProjectMemoryError({ reason: "stale" });
      if (input.owner.kind === "assistant") {
        const record = yield* repository.get({
          environmentId: input.environmentId,
          assistantId: input.owner.assistantId,
        });
        if (retained !== undefined && retained.revision !== record.ownerRevision)
          return yield* new ProjectMemoryError({ reason: "stale" });
        return {
          ...input,
          ownerRevision: record.ownerRevision,
          title: record.detail.configuration.configuration.name,
        };
      }
      if ((yield* repository.findByProject(input.owner.projectId)) !== null)
        return yield* new ProjectMemoryError({ reason: "forbidden" });
      const project = (yield* sql<{
        title: string;
      }>`SELECT title FROM projection_projects WHERE project_id=${input.owner.projectId} AND deleted_at IS NULL`)[0];
      if (project === undefined) return yield* new ProjectMemoryError({ reason: "stale" });
      return { ...input, ownerRevision: retained?.revision ?? 0, title: project.title };
    },
    Effect.mapError((cause) =>
      isMemoryError(cause) ? cause : new ProjectMemoryError({ reason: "unavailable", cause }),
    ),
  );
});
