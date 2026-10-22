import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ManagedSkillKey,
  ProjectId,
  ProviderInstanceId,
  SkillCatalogRevision,
  type SkillCatalogChanged,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";

import * as ServerConfig from "../config.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as Repository from "./ManagedSkillRepository.ts";
import * as Index from "./SkillCatalogIndex.ts";
import * as Native from "./NativeSkillObservationService.ts";
import { acceptCatalogIndexChange, make } from "./SkillCatalogService.ts";
import { SkillWatchService } from "./SkillWatchService.ts";

const dependencies = Index.layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(Native.layer),
  Layer.provideMerge(layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-skill-catalog-" })),
  Layer.provideMerge(NodeServices.layer),
);

const registry = Layer.effect(
  ProviderInstanceRegistry,
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<void>();
    return ProviderInstanceRegistry.of({
      getInstance: () => Effect.succeed(undefined),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes),
    });
  }),
);

const retainDesiredAdmission = Effect.fn("SkillCatalogServiceTest.retainDesiredAdmission")(
  function* (snapshot: {
    readonly configurationHash: string;
    readonly resourceRevision: string;
    readonly skillIds: readonly string[];
  }) {
    const sql = yield* SqlClient.SqlClient;
    const json = JSON.stringify({
      providerInstanceId: "codex",
      skillIds: snapshot.skillIds,
      instructionSnapshot: snapshot,
    });
    yield* sql`INSERT INTO t3_workflow_v2_run_admissions
    (admission_id,project_id,binding_id,root_id,root_task_id,thread_id,run_id,generation,fence,command_id,phase,depth,writable,root_deadline,expires_at,snapshot_json,limits_json)
    VALUES ('admission','project','binding','root','task','thread','run',1,1,'command','admitted',0,1,'2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',${json},'{}')`;
    return json;
  },
);

const withoutNotificationId = (changes: readonly SkillCatalogChanged[]) =>
  changes.map(({ eventId: _eventId, ...change }) => change);

describe("SkillCatalogService", () => {
  it.effect("only reports selected hashes applied after an exact provider receipt", () =>
    Effect.gen(function* () {
      const index = yield* Index.SkillCatalogIndex;
      const catalog = yield* make.pipe(
        Effect.provideService(SkillWatchService, {
          acquireProject: index.acquireProject,
          releaseProject: index.releaseProject,
          invalidateGlobal: Effect.void,
          invalidateProject: () => Effect.void,
        }),
      );
      const created = yield* catalog.createGlobal({
        expectedRevision: 0,
        content: {
          key: ManagedSkillKey.make("deploy"),
          name: "Deploy",
          body: "trusted instructions",
        },
      });
      const input = {
        threadId: "thread",
        providerInstanceId: ProviderInstanceId.make("codex"),
        cwd: process.cwd(),
        desiredRevision: created.catalogRevision,
        appliedRevision: SkillCatalogRevision.make(0),
      };
      const prepared = yield* catalog.prepareSession(input);
      assert.equal(prepared.resources[0]!.body, "trusted instructions");
      assert.equal(prepared.application.status, "pending_new_session");
      const resources = prepared.resources.map(({ id, key, hash, revision }) => ({
        id,
        key,
        hash,
        revision,
      }));
      yield* catalog.recordPreparedResources({
        resourceRevision: "snapshot",
        catalogRevision: created.catalogRevision,
        resources,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json)
        VALUES ('run','thread',1,'codex','codex','running','2026-01-01T00:00:00.000Z','{}')`;
      const snapshotValue = {
        configurationHash: "configuration",
        resourceRevision: "snapshot",
        skillIds: resources.map((item) => item.id),
      };
      const snapshot = JSON.stringify(snapshotValue);
      const desiredJson = yield* retainDesiredAdmission(snapshotValue);
      yield* sql`INSERT INTO t3_workflow_v2_instruction_deliveries
        (run_attempt_id,thread_id,run_id,provider_thread_id,provider_session_id,run_ordinal,requested_snapshot_json,state,created_at)
        VALUES ('attempt','thread','run','pt','ps',1,${snapshot},'pending','2026-01-01T00:00:00.000Z')`;
      assert.equal((yield* catalog.describeSession(input)).status, "pending_new_session");
      const pull = yield* Stream.toPull(catalog.subscribe(input));
      const initial = (yield* pull)[0]!;
      yield* sql`UPDATE t3_workflow_v2_instruction_deliveries SET state='applied',applied_snapshot_json=${snapshot} WHERE run_attempt_id='attempt'`;
      yield* catalog.notifyApplicationChanged(input);
      const acknowledged = (yield* pull)[0]!;
      assert.equal(acknowledged.catalogRevision, initial.catalogRevision);
      assert.isDefined(acknowledged.eventId);
      assert.notEqual(acknowledged.eventId, initial.eventId);
      const overlappingPull = yield* Stream.toPull(catalog.subscribe(input));
      yield* overlappingPull;
      yield* catalog.notifyApplicationChanged(input);
      yield* catalog.notifyApplicationChanged(input);
      const repeatedBatch = yield* pull;
      const overlappingBatch = yield* overlappingPull;
      assert.lengthOf(repeatedBatch, 1);
      assert.lengthOf(overlappingBatch, 1);
      const repeated = repeatedBatch[0]!;
      assert.equal(repeated.eventId, overlappingBatch[0]!.eventId);
      assert.equal(repeated.catalogRevision, acknowledged.catalogRevision);
      assert.notEqual(repeated.eventId, acknowledged.eventId);
      assert.equal((yield* catalog.describeSession(input)).status, "applied");
      yield* sql`INSERT INTO t3_workflow_v2_instruction_deliveries
        (run_attempt_id,thread_id,run_id,provider_thread_id,provider_session_id,run_ordinal,requested_snapshot_json,state,created_at)
        VALUES ('retry','thread','run','pt','ps',1,${snapshot},'pending','2026-01-01T00:00:00.000Z')`;
      assert.equal((yield* catalog.describeSession(input)).status, "pending_new_session");
      yield* sql`UPDATE t3_workflow_v2_instruction_deliveries SET state='applied',applied_snapshot_json=${snapshot} WHERE run_attempt_id='retry'`;
      assert.equal((yield* catalog.describeSession(input)).status, "applied");
      yield* catalog.createGlobal({
        expectedRevision: yield* catalog.currentRevision,
        content: { key: ManagedSkillKey.make("other"), name: "Other", body: "other" },
      });
      const available = yield* catalog.prepareSession(input);
      const added = available.resources.find((item) => item.key === "other")!;
      const addedSelection = {
        configurationHash: "selection-added",
        resourceRevision: "snapshot-added",
        skillIds: [...snapshotValue.skillIds, added.id],
      };
      const addedDesired = JSON.stringify({
        providerInstanceId: "codex",
        skillIds: addedSelection.skillIds,
        instructionSnapshot: addedSelection,
      });
      yield* sql`UPDATE t3_workflow_v2_run_admissions SET generation=2,snapshot_json=${addedDesired} WHERE admission_id='admission'`;
      assert.equal((yield* catalog.describeSession(input)).status, "pending_new_session");
      const changedSelection = {
        configurationHash: "selection2",
        resourceRevision: "snapshot2",
        skillIds: [],
      };
      const changedDesired = JSON.stringify({
        providerInstanceId: "codex",
        skillIds: [],
        instructionSnapshot: changedSelection,
      });
      yield* sql`UPDATE t3_workflow_v2_run_admissions SET generation=2,snapshot_json=${changedDesired} WHERE admission_id='admission'`;
      assert.equal((yield* catalog.describeSession(input)).status, "pending_new_session");
      yield* sql`UPDATE t3_workflow_v2_run_admissions SET generation=3,snapshot_json=${desiredJson} WHERE admission_id='admission'`;
      assert.equal((yield* catalog.describeSession(input)).status, "applied");
      const source = yield* catalog.source(prepared.resources[0]!.id);
      yield* catalog.updateGlobal({
        skillId: prepared.resources[0]!.id,
        expectedHash: source.hash,
        content: { name: "Deploy", body: "updated" },
      });
      assert.equal((yield* catalog.describeSession(input)).status, "pending_new_session");
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );

  it.effect("does not attach a project override receipt to its shadowed global package", () =>
    Effect.gen(function* () {
      const index = yield* Index.SkillCatalogIndex;
      const catalog = yield* make.pipe(
        Effect.provideService(SkillWatchService, {
          acquireProject: index.acquireProject,
          releaseProject: index.releaseProject,
          invalidateGlobal: Effect.void,
          invalidateProject: () => Effect.void,
        }),
      );
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-shadow-" });
      const projectId = ProjectId.make("project");
      const created = yield* catalog.createGlobal({
        expectedRevision: 0,
        content: { key: ManagedSkillKey.make("same"), name: "Same", body: "global" },
      });
      const override = yield* catalog.setProjectOverride({
        projectId,
        projectRoot,
        key: ManagedSkillKey.make("same"),
        expectedRevision: created.catalogRevision,
        content: { name: "Same", body: "project" },
      });
      const input = {
        projectId,
        projectRoot,
        threadId: "thread",
        providerInstanceId: ProviderInstanceId.make("codex"),
        cwd: projectRoot,
        desiredRevision: override.catalogRevision,
        appliedRevision: SkillCatalogRevision.make(0),
      };
      const prepared = yield* catalog.prepareSession(input);
      assert.equal(prepared.resources[0]!.body, "project");
      const resources = prepared.resources.map(({ id, key, hash, revision }) => ({
        id,
        key,
        hash,
        revision,
      }));
      yield* catalog.recordPreparedResources({
        resourceRevision: "snapshot",
        catalogRevision: override.catalogRevision,
        resources,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('run','thread',1,'codex','codex','running','2026-01-01T00:00:00.000Z','{}')`;
      const snapshotValue = {
        configurationHash: "configuration",
        resourceRevision: "snapshot",
        skillIds: resources.map((item) => item.id),
      };
      const snapshot = JSON.stringify(snapshotValue);
      yield* retainDesiredAdmission(snapshotValue);
      yield* sql`INSERT INTO t3_workflow_v2_instruction_deliveries(run_attempt_id,thread_id,run_id,provider_thread_id,provider_session_id,run_ordinal,requested_snapshot_json,applied_snapshot_json,state,created_at) VALUES('attempt','thread','run','pt','ps',1,${snapshot},${snapshot},'applied','2026-01-01T00:00:00.000Z')`;
      const listed = yield* catalog.list(input);
      assert.isUndefined(
        listed.entries.find((entry) => entry.origin === "managed" && entry.scope === "global")!
          .application,
      );
      assert.equal(
        listed.entries.find((entry) => entry.origin === "managed" && entry.scope === "project")!
          .application?.status,
        "applied",
      );
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );

  it.effect("releases each subscription's project watch when its scope closes", () =>
    Effect.gen(function* () {
      const index = yield* Index.SkillCatalogIndex;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-lease-" });
      const acquired: string[] = [];
      const released: string[] = [];
      const catalog = yield* make.pipe(
        Effect.provideService(SkillWatchService, {
          acquireProject: (projectRoot) =>
            index
              .acquireProject(projectRoot)
              .pipe(Effect.tap(() => Effect.sync(() => acquired.push(projectRoot)))),
          releaseProject: (projectRoot) =>
            index
              .releaseProject(projectRoot)
              .pipe(Effect.tap(() => Effect.sync(() => released.push(projectRoot)))),
          invalidateGlobal: Effect.void,
          invalidateProject: () => Effect.void,
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* catalog.watchScope({ projectRoot: root, projectId: ProjectId.make("project") });
          yield* Effect.scoped(
            catalog.watchScope({ projectRoot: root, projectId: ProjectId.make("project") }),
          );
          assert.deepEqual(acquired, [root, root]);
          assert.deepEqual(released, [root]);
        }),
      );
      assert.deepEqual(released, [root, root]);
      assert.isTrue(Result.isFailure(yield* index.getProject(root).pipe(Effect.result)));
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );

  it.effect("coalesces a paused reader's relevant changes and releases its project lease", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-subscribe-" });
      const released: string[] = [];
      const catalog = yield* make.pipe(
        Effect.provideService(SkillWatchService, {
          acquireProject: () =>
            Effect.succeed({
              scope: "project",
              scopeId: "project-scope",
              catalogRevision: 0,
              availability: "available",
              entries: [],
            }),
          releaseProject: (projectRoot) =>
            Effect.sync(() => {
              released.push(projectRoot);
            }),
          invalidateGlobal: Effect.void,
          invalidateProject: () => Effect.void,
        }),
      );
      const key = ManagedSkillKey.make("deploy");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const created = yield* catalog.createGlobal({
        expectedRevision: 0,
        content: { key, name: "Deploy", body: "instructions" },
      });
      const context = {
        projectId: ProjectId.make("project"),
        projectRoot: root,
        threadId: "wanted",
        providerInstanceId,
      };
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const pull = yield* Stream.toPull(catalog.subscribe(context)).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      assert.deepEqual(withoutNotificationId(yield* pull), [
        {
          scope: "session",
          scopeId: "wanted",
          catalogRevision: created.catalogRevision,
          changedKeys: [],
        },
      ]);
      let revision = created.catalogRevision;
      for (let index = 0; index < 129; index++) {
        const changed = yield* catalog.setSessionEnabled({
          threadId: "wanted",
          providerInstanceId,
          key,
          enabled: index % 2 === 0,
          expectedRevision: revision,
        });
        revision = changed.catalogRevision;
      }
      const relevantRevision = revision;
      const otherRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-unrelated-" });
      revision = (yield* catalog.setProjectDisabled({
        projectId: ProjectId.make("other-project"),
        projectRoot: otherRoot,
        key,
        expectedRevision: revision,
      })).catalogRevision;
      for (let index = 0; index < 129; index++) {
        const changed = yield* catalog.setSessionEnabled({
          threadId: "other",
          providerInstanceId,
          key,
          enabled: false,
          expectedRevision: revision,
        });
        revision = changed.catalogRevision;
      }
      assert.deepEqual(withoutNotificationId(yield* pull), [
        { scope: "session", scopeId: "wanted", catalogRevision: relevantRevision, changedKeys: [] },
      ]);
      const listed = yield* catalog.list(context);
      assert.equal(listed.catalogRevision, revision);
      assert.isTrue(listed.entries.find((entry) => entry.key === key)!.effective);
      yield* catalog.notifyApplicationChanged({ threadId: "wanted", providerInstanceId });
      yield* catalog.notifyApplicationChanged({ threadId: "other", providerInstanceId });
      assert.deepEqual(withoutNotificationId(yield* pull), [
        { scope: "session", scopeId: "wanted", catalogRevision: revision, changedKeys: [] },
      ]);
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Exit.isFailure(yield* pull.pipe(Effect.exit)));
      assert.deepEqual(released, [root]);
      yield* catalog.notifyApplicationChanged({ threadId: "wanted", providerInstanceId });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const next = yield* Stream.toPull(catalog.subscribe(context));
          assert.deepEqual(withoutNotificationId(yield* next), [
            { scope: "session", scopeId: "wanted", catalogRevision: revision, changedKeys: [] },
          ]);
        }),
      );
      assert.deepEqual(released, [root, root]);
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );

  it("deduplicates catalog index invalidations by scope revision", () => {
    const published = new Map<string, number>();
    const change = {
      scope: "global" as const,
      scopeId: "global",
      catalogRevision: 4,
      changedKeys: [],
    };

    assert.isTrue(acceptCatalogIndexChange(published, change));
    assert.isFalse(acceptCatalogIndexChange(published, change));
    assert.isFalse(acceptCatalogIndexChange(published, { ...change, catalogRevision: 3 }));
    assert.isTrue(acceptCatalogIndexChange(published, { ...change, catalogRevision: 5 }));
  });

  it.effect("refuses external native preview and import before touching local files", () =>
    Effect.gen(function* () {
      const index = yield* Index.SkillCatalogIndex;
      const watches = SkillWatchService.of({
        acquireProject: index.acquireProject,
        releaseProject: index.releaseProject,
        invalidateGlobal: Effect.void,
        invalidateProject: () => Effect.void,
      });
      const catalog = yield* make.pipe(Effect.provideService(SkillWatchService, watches));
      const discovery = yield* (yield* Native.NativeSkillObservationService).discover({
        providerInstanceId: ProviderInstanceId.make("remote-opencode"),
        scopeId: "/remote",
        discovery: Effect.succeed([
          {
            nativeIdentity: "remote-skill",
            nativePath: "/a/path/on/the/external/server/SKILL.md",
            contentAccess: "external",
            key: "deploy",
            displayName: "Deploy",
            source: "opencode",
            scopeSummary: "project",
          },
        ]),
      });
      const observationId = discovery.observations[0]!.observationId;
      assert.equal(
        (yield* catalog.nativeContent({ observationId, maxBytes: 1024 }).pipe(Effect.flip)).code,
        "external_filesystem",
      );
      assert.equal(
        (yield* catalog
          .importNative({ observationId, expectedRevision: 0, key: ManagedSkillKey.make("deploy") })
          .pipe(Effect.flip)).code,
        "external_filesystem",
      );
      assert.equal((yield* catalog.list()).entries.length, 0);
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );
  it.effect("reports an unsafe native import without hiding the cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-import-error-" });
      const packageRoot = path.join(root, "source");
      yield* fs.makeDirectory(packageRoot);
      yield* fs.writeFileString(
        path.join(packageRoot, "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy\n---\nBody",
      );
      yield* fs.symlink("source", path.join(root, "redirect"));
      const index = yield* Index.SkillCatalogIndex;
      const catalog = yield* make.pipe(
        Effect.provideService(
          SkillWatchService,
          SkillWatchService.of({
            acquireProject: index.acquireProject,
            releaseProject: index.releaseProject,
            invalidateGlobal: Effect.void,
            invalidateProject: () => Effect.void,
          }),
        ),
      );
      const discovery = yield* (yield* Native.NativeSkillObservationService).discover({
        providerInstanceId: ProviderInstanceId.make("claude"),
        scopeId: root,
        discovery: Effect.succeed([
          {
            nativeIdentity: "redirected-deploy",
            nativePath: path.join(root, "redirect", "SKILL.md"),
            contentAccess: "local",
            key: "deploy",
            displayName: "Deploy",
            source: "claude",
            scopeSummary: "user",
          },
        ]),
      });
      const error = yield* catalog
        .importNative({
          observationId: discovery.observations[0]!.observationId,
          expectedRevision: 0,
          key: ManagedSkillKey.make("deploy"),
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "unsafe_native_package");
      assert.equal((yield* catalog.list()).entries.length, 0);
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );
  it.effect("persists shallow overlays, resets them, and rejects concurrent stale mutations", () =>
    Effect.gen(function* () {
      const index = yield* Index.SkillCatalogIndex;
      const watches = SkillWatchService.of({
        acquireProject: index.acquireProject,
        releaseProject: index.releaseProject,
        invalidateGlobal: Effect.void,
        invalidateProject: () => Effect.void,
      });
      const build = make.pipe(Effect.provideService(SkillWatchService, watches));
      const catalog = yield* build;
      const key = ManagedSkillKey.make("deploy");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const created = yield* catalog.createGlobal({
        expectedRevision: 0,
        content: { key, name: "Deploy", body: "Run the deployment checks." },
      });
      const input = {
        threadId: "thread",
        providerInstanceId,
        key,
        expectedRevision: created.catalogRevision,
        enabled: false,
      };
      const attempts = yield* Effect.all(
        [
          catalog.setSessionEnabled(input).pipe(Effect.result),
          catalog.setSessionEnabled(input).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(attempts.filter(Result.isSuccess).length, 1);
      assert.equal(attempts.filter(Result.isFailure).length, 1);
      const reconstructed = yield* build;
      const context = { threadId: "thread", providerInstanceId };
      const disabled = yield* reconstructed.list(context);
      assert.isFalse(disabled.entries.find((entry) => entry.key === key)!.effective);
      assert.equal(disabled.catalogRevision, created.catalogRevision + 1);
      yield* reconstructed.resetSession({ ...context, expectedRevision: disabled.catalogRevision });
      const afterReset = yield* build;
      assert.isTrue(
        (yield* afterReset.list(context)).entries.find((entry) => entry.key === key)!.effective,
      );
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );

  it.effect("session resolution leaves project watchers scoped to catalog subscriptions", () =>
    Effect.gen(function* () {
      const index = yield* Index.SkillCatalogIndex;
      const config = yield* ServerConfig.ServerConfig;
      const roots: string[] = [];
      const watches = SkillWatchService.of({
        acquireProject: (root) =>
          Effect.sync(() => {
            roots.push(root);
            return {
              scope: "project" as const,
              scopeId: "project-scope",
              catalogRevision: 0,
              availability: "available" as const,
              entries: [],
            };
          }),
        releaseProject: index.releaseProject,
        invalidateGlobal: Effect.void,
        invalidateProject: () => Effect.void,
      });
      const catalog = yield* make.pipe(Effect.provideService(SkillWatchService, watches));
      const projectRoot = config.stateDir;
      const projectId = ProjectId.make("project");
      const key = ManagedSkillKey.make("deploy");
      yield* catalog.describeSession({
        threadId: "thread",
        providerInstanceId: ProviderInstanceId.make("codex"),
        projectId,
        projectRoot,
        cwd: projectRoot,
        desiredRevision: SkillCatalogRevision.make(1),
        appliedRevision: SkillCatalogRevision.make(0),
      });
      assert.deepEqual(roots, []);
      const first = yield* catalog.setProjectOverride({
        projectId,
        projectRoot,
        key,
        expectedRevision: 0,
        content: { name: "Deploy", body: "first" },
      });
      const second = yield* catalog.setProjectOverride({
        projectId,
        projectRoot,
        key,
        expectedRevision: first.catalogRevision,
        content: { name: "Deploy", body: "second" },
      });
      yield* catalog.setProjectDisabled({
        projectId,
        projectRoot,
        key,
        expectedRevision: second.catalogRevision,
      });
      const entries = yield* (yield* Repository.ManagedSkillRepository).listProject(projectRoot);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.projectState, "disabled");
      assert.deepEqual(roots, []);
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );
});
