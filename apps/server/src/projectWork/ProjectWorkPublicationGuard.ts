import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectTeamAuthorization } from "./ProjectTeamAuthorization.ts";

export class ProjectWorkPublicationGuardError extends Schema.TaggedError<ProjectWorkPublicationGuardError>()(
  "ProjectWorkPublicationGuardError",
  { reason: Schema.Literals(["managed-publication-unavailable", "history-unavailable"]) },
) {}
const isGuardError = Schema.is(ProjectWorkPublicationGuardError);
export class ProjectWorkPublicationGuard extends Context.Service<
  ProjectWorkPublicationGuard,
  {
    readonly check: (input: {
      readonly cwd: string;
      readonly threadId?: ThreadId;
    }) => Effect.Effect<void, ProjectWorkPublicationGuardError>;
  }
>()("t3/projectWork/ProjectWorkPublicationGuard") {}

/** Legacy creation has no persisted managed approval resolver yet. Ordinary callers remain available. */
export const layer = Layer.effect(
  ProjectWorkPublicationGuard,
  Effect.gen(function* () {
    const authority = yield* ProjectTeamAuthorization;
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const check = Effect.fn("ProjectWorkPublicationGuard.check")(
      function* (input: { readonly cwd: string; readonly threadId?: ThreadId }) {
        if (input.threadId !== undefined && (yield* authority.hasManagedThread(input.threadId)))
          return yield* new ProjectWorkPublicationGuardError({
            reason: "managed-publication-unavailable",
          });
        const cwd = yield* fs.realPath(input.cwd);
        const rows = yield* sql`
      SELECT dispatch_id FROM project_team_workspace_receipt
      WHERE ${cwd}=json_extract(receipt_json,'$.worktree.path')
        OR substr(${cwd},1,length(json_extract(receipt_json,'$.worktree.path'))+1)=json_extract(receipt_json,'$.worktree.path') || ${path.sep}
        OR ${cwd}=json_extract(assignment_json,'$.worktreePath')
        OR substr(${cwd},1,length(json_extract(assignment_json,'$.worktreePath'))+1)=json_extract(assignment_json,'$.worktreePath') || ${path.sep}
      LIMIT 1`;
        if (rows.length !== 0)
          return yield* new ProjectWorkPublicationGuardError({
            reason: "managed-publication-unavailable",
          });
      },
      Effect.mapError((error) =>
        isGuardError(error)
          ? error
          : new ProjectWorkPublicationGuardError({ reason: "history-unavailable" }),
      ),
    );
    return ProjectWorkPublicationGuard.of({ check });
  }),
);
