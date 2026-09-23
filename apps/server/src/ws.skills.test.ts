import { ProjectId, ThreadId, ProviderInstanceId, SkillCatalogRevision } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveAuthoritativeSkillScope, skillChangeAffectsScope } from "./skills/SkillRpcScope.ts";

it("skills subscriptions exclude unrelated projects and sessions", () => {
  const scope = {
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make("thread"),
    providerInstanceId: ProviderInstanceId.make("codex"),
  };
  const base = { catalogRevision: SkillCatalogRevision.make(1), changedKeys: [] };
  assert.isTrue(skillChangeAffectsScope(scope, { ...base, scope: "global", scopeId: "global" }));
  assert.isTrue(skillChangeAffectsScope(scope, { ...base, scope: "project", scopeId: "project" }));
  assert.isFalse(skillChangeAffectsScope(scope, { ...base, scope: "project", scopeId: "other" }));
  assert.isFalse(skillChangeAffectsScope(scope, { ...base, scope: "session", scopeId: "other" }));
  assert.isFalse(skillChangeAffectsScope(scope, { ...base, scope: "provider", scopeId: "claude" }));
  assert.isTrue(skillChangeAffectsScope({}, { ...base, scope: "provider", scopeId: "claude" }));
});

it.effect("skills RPC scope uses the authoritative thread worktree", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const resolved = yield* resolveAuthoritativeSkillScope(
      {
        getThreadShellById: () =>
          Effect.succeed(Option.some({ projectId, worktreePath: "/server/worktree" })),
        getProjectShellById: () =>
          Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/server/project" })),
      },
      { threadId, projectId },
    );

    assert.strictEqual(resolved.projectRoot, "/server/worktree");
  }),
);

it.effect("skills RPC scope rejects a thread and project mismatch", () =>
  Effect.gen(function* () {
    const result = yield* resolveAuthoritativeSkillScope(
      {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              projectId: ProjectId.make("actual-project"),
              worktreePath: "/server/worktree",
            }),
          ),
        getProjectShellById: () => Effect.succeed(Option.none()),
      },
      {
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("client-project"),
      },
    ).pipe(Effect.flip);

    assert.strictEqual(result.code, "scope_mismatch");
  }),
);

it.effect("skills RPC scope rejects an unknown project for install requests", () =>
  Effect.gen(function* () {
    const result = yield* resolveAuthoritativeSkillScope(
      {
        getThreadShellById: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
      },
      {
        projectId: ProjectId.make("missing-project"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ).pipe(Effect.flip);
    assert.strictEqual(result.code, "project_not_found");
  }),
);

it.effect("skills RPC scope rejects a provider different from the thread session", () =>
  Effect.gen(function* () {
    const result = yield* resolveAuthoritativeSkillScope(
      {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              projectId: ProjectId.make("project-1"),
              worktreePath: "/server/worktree",
              session: { providerInstanceId: ProviderInstanceId.make("codex") },
            }),
          ),
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({ id: ProjectId.make("project-1"), workspaceRoot: "/server/project" }),
          ),
      },
      {
        threadId: ThreadId.make("thread-1"),
        providerInstanceId: ProviderInstanceId.make("claude"),
      },
    ).pipe(Effect.flip);

    assert.strictEqual(result.code, "scope_mismatch");
  }),
);
