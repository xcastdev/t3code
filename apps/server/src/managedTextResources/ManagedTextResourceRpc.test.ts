// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ManagedTextResourceCatalogRevision,
  ManagedTextResourceKey,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as ManagedTextResourceCatalogService from "./ManagedTextResourceCatalogService.ts";
import {
  managedTextResourceChangeAffectsScope,
  resolveAuthoritativeManagedTextResourceScope,
} from "./ManagedTextResourceRpc.ts";

const resourceKey = (value: string) => ManagedTextResourceKey.make(value);

const withTemporaryRoot = <A, E>(use: (root: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-managed-text-rpc-test-")),
    ),
    use,
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );

const withService = <A, E>(
  run: (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly stateDir: string;
    readonly threadId: ThreadId;
    readonly service: ManagedTextResourceCatalogService.ManagedTextResourceCatalogServiceShape;
  }) => Effect.Effect<A, E>,
) =>
  withTemporaryRoot((root) =>
    Effect.gen(function* () {
      const stateDir = NodePath.join(root, "state");
      const projectRoot = NodePath.join(root, "project");
      yield* Effect.promise(() => NodeFSP.mkdir(projectRoot));
      const service = yield* ManagedTextResourceCatalogService.makeWith(stateDir);
      return yield* run({
        environmentId: EnvironmentId.make("environment-test"),
        projectId: ProjectId.make("project-test"),
        projectRoot,
        stateDir,
        threadId: ThreadId.make("thread-test"),
        service,
      });
    }),
  );

describe("ManagedTextResourceRpc", () => {
  it.effect("resolves the thread's authoritative worktree and rejects mismatched scopes", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-test");
      const threadId = ThreadId.make("thread-test");
      const projection = {
        getThreadShellById: (requested: ThreadId) =>
          Effect.succeed(
            requested === threadId
              ? Option.some({ projectId, worktreePath: "/authoritative/worktree" })
              : Option.none(),
          ),
        getProjectShellById: (requested: ProjectId) =>
          Effect.succeed(
            requested === projectId
              ? Option.some({ id: projectId, workspaceRoot: "/project" })
              : Option.none(),
          ),
      };

      const resolved = yield* resolveAuthoritativeManagedTextResourceScope(projection, {
        threadId,
      });
      assert.equal(resolved.projectRoot, "/authoritative/worktree");
      assert.equal(resolved.projectId, projectId);

      const mismatch = yield* resolveAuthoritativeManagedTextResourceScope(projection, {
        threadId,
        projectId: ProjectId.make("other-project"),
      }).pipe(Effect.flip);
      assert.equal(mismatch.code, "invalid-override");
    }),
  );

  it.effect(
    "keeps catalogs body-free, reads content by revision, and enforces thread overlays",
    () =>
      withService(({ environmentId, projectId, projectRoot, service, threadId }) =>
        Effect.gen(function* () {
          const empty = yield* service.list({ environmentId });
          const created = yield* service.createEnvironment({
            environmentId,
            expectedCatalogRevision: empty.catalogRevision,
            kind: "command",
            key: resourceKey("review"),
            name: "Review changes",
            body: "Review $ARGUMENTS",
          });
          const definition = created.summaries[0];
          assert.isDefined(definition);
          assert.isFalse("body" in definition);
          if (created.audit.id === undefined || created.audit.revision === undefined) {
            throw new Error("The created definition should have an ID and revision.");
          }
          const content = yield* service.content({
            environmentId,
            kind: "command",
            id: created.audit.id,
            expectedRevision: created.audit.revision,
          });
          assert.equal(content.body, "Review $ARGUMENTS");

          const projectCatalog = yield* service.list({ environmentId, projectId, projectRoot });
          const disabled = yield* service.setProjectDisabled({
            environmentId,
            projectId,
            projectRoot,
            expectedCatalogRevision: projectCatalog.catalogRevision,
            kind: "command",
            key: resourceKey("review"),
          });
          const disabledSummary = disabled.summaries[0];
          assert.isDefined(disabledSummary);
          assert.equal(disabledSummary.scope, "project");
          assert.equal(disabledSummary.projectState, "disabled");
          assert.isFalse(disabledSummary.effective);
          assert.isUndefined(disabledSummary.id);

          const threadScope = { environmentId, projectId, projectRoot, threadId };
          const withDisabledProject = yield* service.list(threadScope);
          const rejectedEnable = yield* service
            .setThreadEnabled({
              ...threadScope,
              expectedCatalogRevision: withDisabledProject.catalogRevision,
              kind: "command",
              key: resourceKey("review"),
              enabled: true,
            })
            .pipe(Effect.flip);
          assert.equal(rejectedEnable.code, "invalid-override");

          const beforeThreadDisable = yield* service.list({ environmentId });
          const inherited = yield* service.createEnvironment({
            environmentId,
            expectedCatalogRevision: beforeThreadDisable.catalogRevision,
            kind: "snippet",
            key: resourceKey("thanks"),
            body: "Thanks for the report.",
          });
          assert.equal(inherited.audit.action, "create");

          const current = yield* service.list(threadScope);
          const turnedOff = yield* service.setThreadEnabled({
            ...threadScope,
            expectedCatalogRevision: current.catalogRevision,
            kind: "snippet",
            key: resourceKey("thanks"),
            enabled: false,
          });
          assert.isFalse(turnedOff.summaries[0]?.effective);

          const afterDisable = yield* service.list(threadScope);
          const turnedOn = yield* service.setThreadEnabled({
            ...threadScope,
            expectedCatalogRevision: afterDisable.catalogRevision,
            kind: "snippet",
            key: resourceKey("thanks"),
            enabled: true,
          });
          assert.isTrue(turnedOn.summaries[0]?.effective);

          const afterEnable = yield* service.list(threadScope);
          const reset = yield* service.resetThread({
            ...threadScope,
            expectedCatalogRevision: afterEnable.catalogRevision,
            kind: "snippet",
            key: resourceKey("thanks"),
          });
          assert.isTrue(reset.summaries[0]?.effective);
          assert.lengthOf(reset.changedKeys, 1);
        }),
      ),
  );

  it.effect("shows malformed project entries and blocks inherited definitions", () =>
    withService(({ environmentId, projectId, projectRoot, service }) =>
      Effect.gen(function* () {
        const beforeCreate = yield* service.list({ environmentId });
        yield* service.createEnvironment({
          environmentId,
          expectedCatalogRevision: beforeCreate.catalogRevision,
          kind: "command",
          key: resourceKey("broken"),
          body: "This inherited definition must stay blocked.",
        });

        const projectCommands = NodePath.join(projectRoot, ".t3code", "commands");
        yield* Effect.promise(() => NodeFSP.mkdir(projectCommands, { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(projectCommands, "broken.json"), "{not json"),
        );

        const catalog = yield* service.list({ environmentId, projectId, projectRoot });
        const malformed = catalog.entries.find(
          (entry) => entry.kind === "command" && entry.key === "broken",
        );
        assert.isDefined(malformed);
        assert.equal(malformed.scope, "project");
        assert.equal(malformed.projectState, "invalid");
        assert.isFalse(malformed.effective);
        assert.isUndefined(malformed.id);
      }),
    ),
  );

  it.effect("disables and restores environment entries without bypassing scope effectiveness", () =>
    withService(({ environmentId, projectId, projectRoot, service, threadId }) =>
      Effect.gen(function* () {
        const empty = yield* service.list({ environmentId });
        const created = yield* service.createEnvironment({
          environmentId,
          expectedCatalogRevision: empty.catalogRevision,
          kind: "command",
          key: resourceKey("deploy"),
          body: "Deploy $ARGUMENTS",
        });
        if (created.audit.id === undefined || created.audit.revision === undefined) {
          throw new Error("The created definition should have an ID and revision.");
        }

        const disabled = yield* service.setEnvironmentEnabled({
          environmentId,
          kind: "command",
          id: created.audit.id,
          expectedRevision: created.audit.revision,
          enabled: false,
        });
        const disabledSummary = disabled.summaries[0];
        assert.isDefined(disabledSummary);
        assert.equal(disabledSummary.scope, "environment");
        assert.equal(disabledSummary.environmentState, "disabled");
        assert.equal(disabledSummary.id, created.audit.id);
        assert.isFalse(disabledSummary.effective);
        if (disabled.audit.revision === undefined) {
          throw new Error("The disabled definition should have a revision.");
        }

        const editableContent = yield* service.content({
          environmentId,
          kind: "command",
          id: created.audit.id,
          expectedRevision: disabled.audit.revision,
        });
        assert.equal(editableContent.body, "Deploy $ARGUMENTS");

        const stale = yield* service
          .setEnvironmentEnabled({
            environmentId,
            kind: "command",
            id: created.audit.id,
            expectedRevision: created.audit.revision,
            enabled: true,
          })
          .pipe(Effect.flip);
        assert.equal(stale.code, "revision-conflict");

        const scope = { environmentId, projectId, projectRoot, threadId };
        const blockedSelection = yield* service
          .content({
            ...scope,
            kind: "command",
            id: created.audit.id,
            expectedRevision: disabled.audit.revision,
          })
          .pipe(Effect.flip);
        assert.equal(blockedSelection.code, "invalid-override");

        const projectCatalog = yield* service.list(scope);
        const projectOverride = yield* service.setProjectOverride({
          environmentId,
          projectId,
          projectRoot,
          expectedCatalogRevision: projectCatalog.catalogRevision,
          kind: "command",
          key: resourceKey("deploy"),
          body: "Deploy from project.",
        });
        const overridden = projectOverride.summaries[0];
        assert.isDefined(overridden);
        assert.equal(overridden.scope, "project");
        assert.equal(overridden.environmentState, "disabled");
        assert.isTrue(overridden.effective);
        if (
          projectOverride.audit.id === undefined ||
          projectOverride.audit.revision === undefined
        ) {
          throw new Error("The project override should have an ID and revision.");
        }
        const selectedOverride = yield* service.content({
          ...scope,
          kind: "command",
          id: projectOverride.audit.id,
          expectedRevision: projectOverride.audit.revision,
        });
        assert.equal(selectedOverride.body, "Deploy from project.");

        const restored = yield* service.setEnvironmentEnabled({
          environmentId,
          kind: "command",
          id: created.audit.id,
          expectedRevision: disabled.audit.revision,
          enabled: true,
        });
        assert.equal(restored.summaries[0]?.environmentState, "active");
        const stillOverridden = yield* service.list(scope);
        assert.equal(stillOverridden.entries[0]?.scope, "project");
        assert.isTrue(stillOverridden.entries[0]?.effective);
        assert.equal(stillOverridden.entries[0]?.environmentState, "active");
      }),
    ),
  );

  it.effect("starts subscriptions with a body-free invalidation and filters scope changes", () =>
    withService(({ environmentId, projectId, projectRoot, service, threadId }) =>
      Effect.gen(function* () {
        const scope = { environmentId, projectId, projectRoot, threadId };
        const initial = yield* Stream.runHead(service.subscribe(scope));
        if (Option.isNone(initial)) {
          throw new Error("Subscription should emit its initial invalidation.");
        }
        assert.equal(initial.value.scope, "environment");
        assert.deepEqual(initial.value.changedKeys, []);

        assert.isTrue(
          managedTextResourceChangeAffectsScope(scope, {
            scope: "environment",
            scopeId: environmentId,
            catalogRevision: ManagedTextResourceCatalogRevision.make(1),
            changedKeys: [],
          }),
        );
        assert.isFalse(
          managedTextResourceChangeAffectsScope(scope, {
            scope: "project",
            scopeId: "another-project",
            catalogRevision: ManagedTextResourceCatalogRevision.make(1),
            changedKeys: [],
          }),
        );
        assert.isFalse(
          managedTextResourceChangeAffectsScope(scope, {
            scope: "thread",
            scopeId: "another-thread",
            catalogRevision: ManagedTextResourceCatalogRevision.make(1),
            changedKeys: [],
          }),
        );
      }),
    ),
  );
});
