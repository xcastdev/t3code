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
    readonly isManaged: (input: {
      readonly cwd: string;
      readonly threadId?: ThreadId;
    }) => Effect.Effect<boolean, ProjectWorkPublicationGuardError>;
    readonly check: (input: {
      readonly cwd: string;
      readonly threadId?: ThreadId;
    }) => Effect.Effect<void, ProjectWorkPublicationGuardError>;
  }
>()("t3/projectWork/ProjectWorkPublicationGuard") {}

/** Classify host-owned workspaces before choosing the managed or ordinary publication path. */
export const layer = Layer.effect(
  ProjectWorkPublicationGuard,
  Effect.gen(function* () {
    const authority = yield* ProjectTeamAuthorization;
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const isManaged = Effect.fn("ProjectWorkPublicationGuard.isManaged")(
      function* (input: { readonly cwd: string; readonly threadId?: ThreadId }) {
        if (input.threadId !== undefined && (yield* authority.hasManagedThread(input.threadId)))
          return true;
        const cwd = yield* fs.realPath(input.cwd);
        const rows = yield* sql`
      SELECT dispatch_id FROM project_team_workspace_receipt
      WHERE ${cwd}=json_extract(receipt_json,'$.worktree.path')
        OR substr(${cwd},1,length(json_extract(receipt_json,'$.worktree.path'))+1)=json_extract(receipt_json,'$.worktree.path') || ${path.sep}
        OR ${cwd}=json_extract(assignment_json,'$.worktreePath')
        OR substr(${cwd},1,length(json_extract(assignment_json,'$.worktreePath'))+1)=json_extract(assignment_json,'$.worktreePath') || ${path.sep}
      LIMIT 1`;
        return rows.length !== 0;
      },
      Effect.mapError((error) =>
        isGuardError(error)
          ? error
          : new ProjectWorkPublicationGuardError({ reason: "history-unavailable" }),
      ),
    );
    const check = Effect.fn("ProjectWorkPublicationGuard.check")(function* (input: {
      readonly cwd: string;
      readonly threadId?: ThreadId;
    }) {
      if (yield* isManaged(input))
        return yield* new ProjectWorkPublicationGuardError({
          reason: "managed-publication-unavailable",
        });
    });
    return ProjectWorkPublicationGuard.of({ check, isManaged });
  }),
);
