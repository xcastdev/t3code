import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ProjectTeamAuthorization } from "./ProjectTeamAuthorization.ts";
import { ProjectWorkPublicationGuard, layer } from "./ProjectWorkPublicationGuard.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const services = layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(
    Layer.mock(ProjectTeamAuthorization)({
      hasManagedThread: (threadId) => Effect.succeed(threadId === "managed-thread"),
    }),
  ),
);
it.effect(
  "ordinary workspaces pass; managed ownership cannot be bypassed by omitting thread ID or using a child directory",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const guard = yield* ProjectWorkPublicationGuard;
      yield* sql`CREATE TABLE project_team_workspace_receipt (dispatch_id TEXT, receipt_json TEXT, assignment_json TEXT)`;
      const root = yield* fs.realPath(process.cwd());
      const managed = path.join(root, "apps", "server");
      yield* sql`INSERT INTO project_team_workspace_receipt VALUES ('dispatch',${encodeJson({ worktree: { path: managed } })},${encodeJson({ worktreePath: managed })})`;
      expect(yield* guard.check({ cwd: root }).pipe(Effect.result)).toMatchObject({
        _tag: "Success",
      });
      expect(yield* guard.isManaged({ cwd: root })).toBe(false);
      for (const input of [
        { cwd: managed },
        { cwd: path.join(managed, "src") },
        { cwd: root, threadId: ThreadId.make("managed-thread") },
      ]) {
        expect(yield* guard.isManaged(input)).toBe(true);
        expect(yield* guard.check(input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "managed-publication-unavailable" },
        });
      }
    }).pipe(Effect.provide(services), Effect.scoped),
);
it.effect("unavailable managed history rejects a creation instead of falling through", () =>
  Effect.gen(function* () {
    const guard = yield* ProjectWorkPublicationGuard;
    expect(yield* guard.isManaged({ cwd: process.cwd() }).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "history-unavailable" },
    });
    expect(yield* guard.check({ cwd: process.cwd() }).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "history-unavailable" },
    });
  }).pipe(Effect.provide(services), Effect.scoped),
);
