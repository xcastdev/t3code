// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  ProjectId,
  ThreadId,
  SkillRpcError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "./config.ts";
import * as AuthSessions from "./persistence/AuthSessions.ts";
import * as Database from "./persistence/Sqlite.ts";
import * as Projects from "./orchestration-v2/ProjectStore.ts";
import * as Projections from "./orchestration-v2/ProjectionStore.ts";
import * as Authority from "./ResourceMutationAuthority.ts";

const sessionId = AuthSessionId.make("resource-writer");
const projectId = ProjectId.make("resource-project");
const dependencies = Layer.mergeAll(
  AuthSessions.layer,
  Projects.layer,
  Layer.mock(Projections.ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) }),
).pipe(
  Layer.provideMerge(Database.layerMemory),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "resource-authority-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = (
  scopes: ReadonlyArray<import("@t3tools/contracts").AuthEnvironmentScope> = [
    AuthSettingsWriteScope,
  ],
) =>
  Effect.gen(function* () {
    const sessions = yield* AuthSessions.AuthSessionRepository;
    const now = yield* DateTime.now;
    yield* sessions.create({
      sessionId,
      subject: "human",
      scopes,
      method: "browser-session-cookie",
      client: {
        label: null,
        ipAddress: null,
        userAgent: null,
        deviceType: "unknown",
        os: null,
        browser: null,
      },
      issuedAt: now,
      expiresAt: DateTime.add(now, { hours: 1 }),
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at,deleted_at)
    VALUES(${projectId},'Resources','/workspace',NULL,'[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`;
    return { sessions, sql, authority: yield* Authority.make };
  });

it.effect("denies a staged file publication after the persisted session is revoked", () =>
  Effect.gen(function* () {
    const { sessions, authority } = yield* fixture();
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const staged = `${root}/staged`;
    const target = `${root}/published`;
    NodeFS.writeFileSync(staged, "body");
    yield* sessions.revoke({ sessionId, revokedAt: yield* DateTime.now });
    const error = yield* authority
      .commit({ sessionId, projectId, workspaceRoot: "/workspace" }, () =>
        NodeFS.renameSync(staged, target),
      )
      .pipe(Effect.flip);
    expect(error._tag).toBe("EnvironmentAuthorizationError");
    expect(NodeFS.existsSync(staged)).toBe(true);
    expect(NodeFS.existsSync(target)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("uses the stored grant and refuses read-only sessions", () =>
  Effect.gen(function* () {
    const { authority } = yield* fixture([AuthOrchestrationReadScope]);
    let committed = false;
    const error = yield* authority
      .commit({ sessionId }, () => {
        committed = true;
      })
      .pipe(Effect.flip);
    expect(error._tag).toBe("EnvironmentAuthorizationError");
    expect(committed).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("rechecks project deletion and workspace changes before publication", () =>
  Effect.gen(function* () {
    const { authority, sql } = yield* fixture();
    let commits = 0;
    yield* sql`UPDATE projection_projects SET workspace_root='/moved' WHERE project_id=${projectId}`;
    expect(
      (yield* authority
        .commit({ sessionId, projectId, workspaceRoot: "/workspace" }, () => {
          commits++;
        })
        .pipe(Effect.flip))._tag,
    ).toBe("ResourceMutationAuthorityError");
    yield* sql`UPDATE projection_projects SET deleted_at='2026-01-02T00:00:00.000Z' WHERE project_id=${projectId}`;
    expect(
      (yield* authority
        .commit({ sessionId, projectId }, () => {
          commits++;
        })
        .pipe(Effect.flip))._tag,
    ).toBe("ResourceMutationAuthorityError");
    expect(commits).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("rejects a missing thread scope and commits valid synchronous publication", () =>
  Effect.gen(function* () {
    const { authority } = yield* fixture();
    let commits = 0;
    expect(
      (yield* authority
        .commit({ sessionId, threadId: ThreadId.make("missing") }, () => {
          commits++;
        })
        .pipe(Effect.flip))._tag,
    ).toBe("ResourceMutationAuthorityError");
    yield* authority.commit({ sessionId, projectId, workspaceRoot: "/workspace" }, () => {
      commits++;
    });
    expect(commits).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("refuses a persisted session that expires while resources are staged", () =>
  Effect.gen(function* () {
    const { authority, sql } = yield* fixture();
    yield* sql`UPDATE auth_sessions SET expires_at='1970-01-01T00:00:00.000Z' WHERE session_id=${sessionId}`;
    let committed = false;
    const error = yield* authority
      .commit({ sessionId }, () => {
        committed = true;
      })
      .pipe(Effect.flip);
    expect(error._tag).toBe("EnvironmentAuthorizationError");
    expect(committed).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("preserves a domain rejection and rolls back an authorized SQL mutation", () =>
  Effect.gen(function* () {
    const { authority, sql } = yield* fixture();
    const rejection = new SkillRpcError({
      code: "revision_conflict",
      message: "The selection changed.",
    });
    const error = yield* authority
      .transact(
        { sessionId, projectId },
        sql`UPDATE projection_projects SET title='Should roll back' WHERE project_id=${projectId}`.pipe(
          Effect.andThen(rejection),
        ),
      )
      .pipe(Effect.flip);
    expect(error).toBe(rejection);
    const rows = yield* sql<{
      title: string;
    }>`SELECT title FROM projection_projects WHERE project_id=${projectId}`;
    expect(rows[0]?.title).toBe("Resources");
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
