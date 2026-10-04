import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ProjectWorkFoundationCommitCommand,
  ManagedSkillKey,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpClient } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makePiDriver } from "../provider/Drivers/PiDriver.ts";
import { ProviderAdapterValidationError } from "../provider/Errors.ts";
import { makeProviderInstanceRegistry } from "../provider/Layers/ProviderInstanceRegistryLive.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  PiManagedRuntime,
  PiManagedRuntimeError,
  type PiManagedRuntimeInstance,
} from "../provider/pi/PiManagedRuntime.ts";
import { makePiModelCatalogue, PiModelCatalogue } from "../provider/pi/PiModelCatalogue.ts";
import type { PiProductionRuntimeAssets } from "../provider/pi/PiProductionRuntime.ts";
import * as Settings from "../serverSettings.ts";
import * as Skills from "../skills/ManagedSkillRepository.ts";
import { SkillMaterializationService } from "../skills/SkillMaterializationService.ts";
import {
  at,
  attribution,
  projectId,
  scoped,
  seed,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamExecutionResources } from "./ProjectTeamExecutionResources.ts";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";

const model = "inclusionai/ling-3.1-flash:free";
const instanceId = ProviderInstanceId.make("pi");
const driverKind = ProviderDriverKind.make("piAgent");
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const unused = Effect.fail(
  new PiManagedRuntimeError({
    code: "denied",
    detail: "No worker operations in resource-loan tests",
  }),
);
const runtime: PiManagedRuntimeInstance = {
  inspect: unused,
  prepareOperation: () => unused,
  readSession: () => unused,
  readThread: () => unused,
  requestStop: () => unused,
  stopAll: unused,
  authorizeSkills: () => unused,
  discoverNativeSkills: () => unused,
};
const withServices = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  scoped(
    body.pipe(
      Effect.provide(
        Layer.mergeAll(
          Settings.layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true }),
          Skills.layer.pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "execution-resources-" }),
            ),
          ),
        ),
      ),
    ),
  );
const fixtureForSelection = (roleHasMore = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "execution-resources-" });
    const primary = path.join(scratch, "primary");
    const managed = path.join(scratch, "managed");
    const protectedRoot = path.join(scratch, "protected");
    for (const root of [primary, managed, protectedRoot]) yield* fs.makeDirectory(root);
    yield* fs.chmod(managed, 0o700);
    const worktree = path.join(managed, "original");
    const skillRepository = yield* Skills.ManagedSkillRepository;
    const ownedSkill = yield* skillRepository.createGlobal({
      expectedRevision: 0,
      content: {
        key: ManagedSkillKey.make("owned"),
        name: "Owned",
        body: "Original owned content",
      },
    });
    const skillIds = [ownedSkill.manifest.id];
    const allowedSkill = roleHasMore
      ? yield* skillRepository.createGlobal({
          expectedRevision: 0,
          content: {
            key: ManagedSkillKey.make("allowed-only"),
            name: "Allowed only",
            body: "Available but unselected",
          },
        })
      : undefined;
    const roleSkillIds = allowedSkill ? [...skillIds, allowedSkill.manifest.id] : skillIds;
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    yield* seed("implementer", "reserved", {
      roleTools: ["pi.read", "pi.write"],
      toolIds: ["pi.read", "pi.write"],
      issueCredential: false,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (command) => {
          if (command.type === "project-work.foundation.commit") {
            if (command.transition?.kind === "claim") {
              pending = command;
              return Effect.fail(
                new ProjectWorkPolicyError("invalid-state", "Capture original uncommitted claim"),
              );
            }
            return repository.execute({
              ...command,
              records: command.records.map((record) =>
                record.kind === "role-revision"
                  ? {
                      ...record,
                      model,
                      skills: roleSkillIds,
                      tools: roleHasMore ? [...record.tools, "pi.edit"] : record.tools,
                    }
                  : record,
              ),
            });
          }
          return repository.execute(command);
        },
      }),
      Effect.result,
    );
    if (!pending || pending.transition?.kind !== "claim")
      return yield* Effect.die("Missing original claim");
    yield* repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "limits",
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution,
        committedAt: at,
        records: [
          {
            kind: "limits",
            projectId,
            recordId: "limits",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "configured",
            environmentModelCalls: 4,
            projectWritableWorkers: 1,
            modelCalls: 2,
            delegationDepth: 2,
            repairAllowance: 2,
            model,
            tokenLimit: 2000,
            durationLimitMs: 2000,
          },
        ],
      }),
    );
    yield* TestClock.setTime(Date.parse(at) + 1);
    yield* sql`UPDATE projection_projects SET workspace_root=${primary} WHERE project_id=${projectId}`;
    const claim = yield* decodeCommit({
      ...pending,
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      transition: {
        ...pending.transition,
        binding: {
          ...pending.transition.binding,
          model,
          branch: "refs/heads/original",
          worktree,
          configuration: {
            ...pending.transition.binding.configuration,
            instructionsHash: NodeCrypto.createHash("sha256").update("Task").digest("hex"),
            runtimeVersion: "0.99.1",
            skillIds,
          },
        },
      },
    });
    const request: ProjectTeamDispatchRequest = {
      dispatchId: "dispatch",
      claim,
      git: {
        effectId: "dispatch",
        runId: "binding",
        generation: 0,
        primaryRoot: primary,
        commonGitDirectory: path.join(primary, ".git"),
        worktreePath: worktree,
        branchRef: "refs/heads/original",
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: "owner",
        policyHash: "b".repeat(64),
      },
      setupId: "setup",
      initializeOperationId: "initialize",
      assignmentOperationId: "assignment",
      assignment: "Task",
    };
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const snapshot = yield* journal.reserve(request);
    const settings = yield* Settings.ServerSettingsService;
    const providerInstances = { [instanceId]: { driver: driverKind, enabled: true, config: {} } };
    yield* settings.updateSettings({ providerInstances });
    const adapterDenied = Effect.fail(
      new ProviderAdapterValidationError({
        provider: driverKind,
        operation: "fixture",
        issue: "No adapter operations in resource tests",
      }),
    );
    const driver = makePiDriver({
      makeAdapter: () =>
        Effect.succeed({
          provider: driverKind,
          capabilities: {
            sessionModelSwitch: "unsupported",
            supportsConversationRollback: false,
            remoteHttpMcp: "unsupported",
            projectMcpProxy: "unsupported",
            sessionMcpCatalog: "unsupported",
            promptlessTurnContinuation: false,
            activeTurnSteer: false,
          },
          startSession: () => adapterDenied,
          sendTurn: () => adapterDenied,
          interruptTurn: () => adapterDenied,
          respondToRequest: () => adapterDenied,
          respondToUserInput: () => adapterDenied,
          stopSession: () => Effect.void,
          listSessions: () => Effect.succeed([]),
          hasSession: () => Effect.succeed(false),
          readThread: () => adapterDenied,
          rollbackThread: () => adapterDenied,
          stopAll: () => Effect.void,
          streamEvents: Stream.empty,
        }),
    });
    const registered = yield* makeProviderInstanceRegistry({
      drivers: [driver],
      configMap: providerInstances,
    }).pipe(
      Effect.provideService(PiManagedRuntime, { forInstance: () => Effect.succeed(runtime) }),
      Effect.provideService(SkillMaterializationService, {
        materialize: () => Effect.die("No skill staging"),
        dispose: () => Effect.void,
        disposeSession: () => Effect.void,
      }),
    );
    const fresh = {
      source: "https://api.commandcode.ai/provider/v1/models",
      fetchedAt: at,
      selectedEntry: {
        id: model,
        owned_by: "command-code",
        context_length: 262144,
        supported_endpoints: ["/chat/completions"],
      },
    };
    const payload = encodeJson(fresh);
    yield* sql`INSERT INTO project_team_pi_catalogue VALUES (${fresh.source},${at},${payload})`;
    const catalogue = yield* makePiModelCatalogue.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("No model/catalogue network requests")),
      ),
    );
    const pi = yield* makeProjectTeamPiRuntime();
    let borrowed = 0;
    let resourceCheck: Effect.Effect<void, PiManagedRuntimeError> = Effect.void;
    const assets: PiProductionRuntimeAssets = {
      instanceConfiguration: { enabled: true, configuration: {} },
      runtimeFacts: { runtimeVersion: "0.99.1", maxInputTokens: 100, maxOutputTokens: 100 },
      runtimeFiles: [],
      revalidate: Effect.suspend(() => resourceCheck),
      borrow: (body) =>
        Effect.sync(() => {
          borrowed++;
        }).pipe(
          Effect.andThen(body),
          Effect.ensuring(
            Effect.sync(() => {
              borrowed--;
            }),
          ),
        ),
    };
    yield* pi.publishAssets(instanceId, assets, runtime);
    const resources = yield* makeProjectTeamExecutionResources({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
      managedWorktreesRoot: managed,
      protectedRoots: [primary, protectedRoot],
    }).pipe(
      Effect.provideService(ProjectTeamPiRuntime, pi),
      Effect.provideService(ProviderInstanceRegistry, registered.registry),
      Effect.provideService(PiModelCatalogue, catalogue),
    );
    return {
      sql,
      config,
      projectWorkRepository: repository,
      skillRepository,
      ownedSkill,
      fs,
      path,
      primary,
      managed,
      protectedRoot,
      worktree,
      journal,
      snapshot,
      resources,
      settings,
      pi,
      registry: registered.registry,
      mutator: registered.mutator,
      catalogue,
      assets,
      payload,
      borrowed: () => borrowed,
      setResourceCheck: (check: Effect.Effect<void, PiManagedRuntimeError>) => {
        resourceCheck = check;
      },
    };
  });

const fixture = fixtureForSelection();

it.effect(
  "borrows current resources across a committed claim and legitimate workspace creation",
  () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const before = yield* f.sql`SELECT * FROM project_team_dispatch`;
          yield* f.resources.withCurrent(f.snapshot, (loan) =>
            Effect.gen(function* () {
              expect(f.borrowed()).toBe(1);
              expect(loan.modelSelection).toEqual({ instanceId, model, options: [] });
              yield* loan.assertResources;
              expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual(before);
              const claimed = yield* f.journal.claimEffect(f.snapshot.fence);
              yield* f.fs.makeDirectory(f.worktree);
              yield* loan.assertCurrent(claimed);
              expect(
                (yield* f.sql`SELECT claim_generation FROM project_team_dispatch`)[0]
                  ?.claim_generation,
              ).toBe(1);
            }),
          );
          expect(f.borrowed()).toBe(0);
          expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
        }),
      ),
    ),
);

it.effect("revokes captured resource checks after the callback ends", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const retained = yield* f.resources.withCurrent(f.snapshot, (loan) => Effect.succeed(loan));
        expect(f.borrowed()).toBe(0);
        expect((yield* retained.assertResources.pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* retained.assertCurrent(f.snapshot).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }),
    ),
  ),
);

for (const failure of ["typed", "defect", "interruption"] as const) {
  it.effect(`preserves the original consumer ${failure} and releases its resource loan`, () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const original = new Error(`Original consumer ${failure}`);
          const exit = yield* f.resources
            .withCurrent(f.snapshot, () =>
              failure === "typed"
                ? Effect.fail(original)
                : failure === "defect"
                  ? Effect.die(original)
                  : Effect.interrupt,
            )
            .pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit) && failure !== "interruption")
            expect(Cause.squash(exit.cause)).toBe(original);
          if (Exit.isFailure(exit) && failure === "interruption")
            expect(Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(f.borrowed()).toBe(0);
          expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
        }),
      ),
    ),
  );
}

it.effect("preserves both consumer failure and a replaced Pi epoch at loan release", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const original = new Error("Original failed consumer");
        const before = yield* f.sql`SELECT * FROM project_team_dispatch`;
        const exit = yield* f.resources
          .withCurrent(f.snapshot, () =>
            f.pi
              .publishAssets(instanceId, f.assets, runtime)
              .pipe(Effect.andThen(Effect.fail(original))),
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errors = exit.cause.reasons
            .filter(Cause.isFailReason)
            .map((reason) => reason.error);
          expect(errors).toHaveLength(2);
          expect(errors).toContain(original);
          expect(errors.find((error) => error !== original)).toMatchObject({
            _tag: "ProjectTeamDispatchJournalError",
            cause: { _tag: "PiManagedRuntimeError", code: "denied" },
          });
        }
        expect(f.borrowed()).toBe(0);
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual(before);
      }),
    ),
  ),
);

it.effect("retains the original runtime validation error through the typed resource boundary", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const original = new PiManagedRuntimeError({
          code: "denied",
          detail: "Original asset validation failed",
        });
        f.setResourceCheck(Effect.fail(original));
        const exit = yield* f.resources
          .withCurrent(f.snapshot, () => Effect.die("Consumer must not run"))
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) expect(error.value.cause).toBe(original);
        }
        expect(f.borrowed()).toBe(0);
      }),
    ),
  ),
);

it.effect(
  "denies feature changes during the last asset revalidation and preserves the original owner",
  () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const before = yield* f.sql`SELECT * FROM project_team_dispatch`;
          yield* f.resources.withCurrent(f.snapshot, (loan) =>
            Effect.gen(function* () {
              let checks = 0;
              f.setResourceCheck(
                Effect.sync(() => ++checks).pipe(
                  Effect.flatMap((count) =>
                    count === 2
                      ? f.settings
                          .updateSettings({ projectTeamExecutionEnabled: false })
                          .pipe(Effect.asVoid, Effect.orDie)
                      : Effect.void,
                  ),
                ),
              );
              expect((yield* loan.assertResources.pipe(Effect.result))._tag).toBe("Failure");
              expect(checks).toBe(2);
              f.setResourceCheck(Effect.void);
              yield* f.settings.updateSettings({ projectTeamExecutionEnabled: true });
              yield* loan.assertResources;
            }),
          );
          expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual(before);
          expect(f.borrowed()).toBe(0);
        }),
      ),
    ),
);

for (const change of [
  "disabled",
  "configuration",
  "catalogue",
  "epoch",
  "primary",
  "managed",
] as const) {
  it.effect(`retains ownership and denies current ${change} resource changes`, () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const before = yield* f.sql`SELECT * FROM project_team_dispatch`;
          const result = yield* f.resources
            .withCurrent(f.snapshot, (loan) =>
              Effect.gen(function* () {
                yield* loan.assertResources;
                if (change === "disabled")
                  yield* f.settings.updateSettings({ projectTeamExecutionEnabled: false });
                if (change === "configuration")
                  yield* f.settings.updateSettings({
                    providerInstances: {
                      [instanceId]: {
                        driver: driverKind,
                        enabled: true,
                        config: { agentDirectory: "/changed" },
                      },
                    },
                  });
                if (change === "catalogue")
                  yield* f.sql`UPDATE project_team_pi_catalogue SET payload_json=json_set(payload_json,'$.selectedEntry.context_length',262143)`;
                if (change === "epoch") yield* f.pi.publishAssets(instanceId, f.assets, runtime);
                if (change === "primary")
                  yield* f.sql`UPDATE projection_projects SET workspace_root=${f.protectedRoot} WHERE project_id=${projectId}`;
                if (change === "managed") yield* f.fs.chmod(f.managed, 0o755);
                expect((yield* loan.assertResources.pipe(Effect.result))._tag).toBe("Failure");
                if (change === "disabled")
                  yield* f.settings.updateSettings({ projectTeamExecutionEnabled: true });
                if (change === "configuration")
                  yield* f.settings.updateSettings({
                    providerInstances: {
                      [instanceId]: { driver: driverKind, enabled: true, config: {} },
                    },
                  });
                if (change === "catalogue")
                  yield* f.sql`UPDATE project_team_pi_catalogue SET payload_json=${f.payload}`;
                if (change === "primary")
                  yield* f.sql`UPDATE projection_projects SET workspace_root=${f.primary} WHERE project_id=${projectId}`;
                if (change === "managed") yield* f.fs.chmod(f.managed, 0o700);
                if (change !== "epoch") yield* loan.assertResources;
              }),
            )
            .pipe(Effect.result);
          expect(result._tag).toBe(change === "epoch" ? "Failure" : "Success");
          expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual(before);
          expect(f.borrowed()).toBe(0);
        }),
      ),
    ),
  );
}

it.effect("checks catalogue metadata inside the captured SQL transaction without a refresh", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.resources.withCurrent(f.snapshot, (loan) =>
          f.sql.withTransaction(
            Effect.gen(function* () {
              yield* loan.assertCurrent(f.snapshot);
              yield* f.sql`UPDATE project_team_pi_catalogue SET fetched_at='2099-01-01T00:00:00.000Z'`;
              expect((yield* loan.assertResources.pipe(Effect.result))._tag).toBe("Failure");
              yield* f.sql`UPDATE project_team_pi_catalogue SET fetched_at=${at}`;
              yield* loan.assertResources;
            }),
          ),
        );
      }),
    ),
  ),
);

it.effect("refuses a foreign captured-client callback and an expired attempt", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const other = Context.get(
          yield* Layer.build(Layer.fresh(SqlitePersistenceMemory)),
          SqlClient.SqlClient,
        );
        yield* f.resources.withCurrent(f.snapshot, (loan) =>
          Effect.gen(function* () {
            expect(
              (yield* loan.assertResources.pipe(
                Effect.provideService(SqlClient.SqlClient, other),
                Effect.result,
              ))._tag,
            ).toBe("Failure");
            yield* loan.assertResources;
            yield* TestClock.setTime(f.snapshot.intent.limits.deadlineAtMs);
            expect((yield* loan.assertResources.pipe(Effect.result))._tag).toBe("Failure");
          }),
        );
      }),
    ),
  ),
);

const control = <E>(
  name: string,
  run: (f: Effect.Success<typeof fixture>) => Effect.Effect<unknown, E, Scope.Scope>,
) =>
  it.effect(name, () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const before = yield* f.sql`SELECT * FROM project_team_dispatch`;
          yield* run(f);
          expect(f.borrowed()).toBe(0);
          expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
          expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual(before);
        }),
      ),
    ),
  );
control("regression concurrent late catalogue write after its SQL receipt is denied", (f) =>
  f.resources.withCurrent(f.snapshot, (loan) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let checks = 0;
      f.setResourceCheck(
        Effect.sync(() => ++checks).pipe(
          Effect.flatMap((count) =>
            count === 2
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
          ),
        ),
      );
      const fiber = yield* loan.assertResources.pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      const write =
        yield* f.sql`UPDATE project_team_pi_catalogue SET payload_json=json_set(payload_json,'$.selectedEntry.context_length',262143) RETURNING source`;
      expect(write).toHaveLength(1);
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(fiber);
      f.setResourceCheck(Effect.void);
      const subsequent = yield* loan.assertResources.pipe(Effect.result);
      const rows =
        yield* f.sql`SELECT json_extract(payload_json,'$.selectedEntry.context_length') AS length FROM project_team_pi_catalogue`;

      expect(checks).toBe(2);
      expect(rows[0]?.length).toBe(262143);
      expect(subsequent._tag).toBe("Failure");
      expect(result._tag).toBe("Failure");
    }),
  ),
);

for (const mutation of ["unchanged", "role", "selected-skill", "primary-sql"] as const) {
  control(`regression late ${mutation} current-resource check`, (f) =>
    f.resources.withCurrent(f.snapshot, (loan) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let checks = 0;
        f.setResourceCheck(
          Effect.sync(() => ++checks).pipe(
            Effect.flatMap((count) =>
              count === 2
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
            ),
          ),
        );
        const fiber = yield* loan.assertCurrent(f.snapshot).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        if (mutation === "role")
          yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.foundationRecords[' || (SELECT key FROM json_each(state_json,'$.foundationRecords') WHERE json_extract(value,'$.kind')='role-revision' AND json_extract(value,'$.recordId')='role') || '].instructions','Changed') WHERE project_id=${projectId} RETURNING project_id`;
        if (mutation === "selected-skill")
          yield* f.fs.writeFileString(
            f.path.join(f.ownedSkill.packagePath, "SKILL.md"),
            "Changed owned content",
          );
        if (mutation === "primary-sql")
          yield* f.sql`UPDATE projection_projects SET workspace_root=${f.protectedRoot} WHERE project_id=${projectId} RETURNING project_id`;
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(fiber);
        f.setResourceCheck(Effect.void);
        const subsequent = yield* loan.assertCurrent(f.snapshot).pipe(Effect.result);

        expect(checks).toBe(2);
        expect(subsequent._tag).toBe(mutation === "unchanged" ? "Success" : "Failure");
        expect(result._tag).toBe(mutation === "unchanged" ? "Success" : "Failure");
      }),
    ),
  );
}

control(
  "regression changed catalogue before initial callback entry prevents consumer execution",
  (f) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let checks = 0;
      let consumerEntries = 0;
      f.setResourceCheck(
        Effect.sync(() => ++checks).pipe(
          Effect.flatMap((count) =>
            count === 4
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
          ),
        ),
      );
      const fiber = yield* f.resources
        .withCurrent(f.snapshot, () =>
          Effect.sync(() => {
            consumerEntries++;
          }),
        )
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      const changed =
        yield* f.sql`UPDATE project_team_pi_catalogue SET payload_json=json_set(payload_json,'$.selectedEntry.context_length',262143) RETURNING source`;
      expect(changed).toHaveLength(1);
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(fiber);

      expect(result._tag).toBe("Failure");
      expect(consumerEntries).toBe(0);
    }),
);

it.effect("regression journal-approved tool and skill subset preserves original selection", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixtureForSelection(true);
        const current = yield* f.journal.inspect(f.snapshot.fence.dispatchId);
        expect(current).toEqual(f.snapshot);
        let consumerEntries = 0;
        const outcome = yield* f.resources
          .withCurrent(f.snapshot, (loan) =>
            Effect.gen(function* () {
              consumerEntries++;
              expect(loan.modelSelection).toEqual({ instanceId, model, options: [] });
              yield* loan.assertCurrent(f.snapshot);
            }),
          )
          .pipe(Effect.result);

        expect(outcome._tag).toBe("Success");
        expect(consumerEntries).toBe(1);
        expect(f.borrowed()).toBe(0);
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
      }),
    ),
  ),
);

for (const mutation of [
  "role-tools",
  "selected-content",
  "tombstone",
  "unselected-content",
] as const) {
  it.effect(`retains the original role and selected subset across ${mutation}`, () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixtureForSelection(true);
          const before = yield* f.sql`SELECT * FROM project_team_dispatch`;
          yield* f.resources.withCurrent(f.snapshot, (loan) =>
            Effect.gen(function* () {
              if (mutation === "role-tools")
                yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.foundationRecords[' || (SELECT key FROM json_each(state_json,'$.foundationRecords') WHERE json_extract(value,'$.kind')='role-revision' AND json_extract(value,'$.recordId')='role') || '].tools',json('["pi.read","pi.write"]')) WHERE project_id=${projectId}`;
              if (mutation === "selected-content")
                yield* f.fs.writeFileString(
                  f.path.join(f.ownedSkill.packagePath, "SKILL.md"),
                  "Changed owned content",
                );
              if (mutation === "tombstone")
                yield* f.skillRepository.setProjectDisabled({
                  projectRoot: f.primary,
                  key: f.ownedSkill.manifest.key,
                });
              if (mutation === "unselected-content")
                yield* f.fs.writeFileString(
                  f.path.join(f.path.dirname(f.ownedSkill.packagePath), "allowed-only", "SKILL.md"),
                  "Changed unselected content",
                );
              expect((yield* loan.assertResources.pipe(Effect.result))._tag).toBe(
                mutation === "unselected-content" ? "Success" : "Failure",
              );
              expect((yield* f.journal.inspect(f.snapshot.fence.dispatchId)).intent).toEqual(
                f.snapshot.intent,
              );
            }),
          );
          expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual(before);
          expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
          expect(f.borrowed()).toBe(0);
        }),
      ),
    ),
  );
}

const resourcesWith = (
  f: Effect.Success<typeof fixture>,
  sql = f.sql,
  repository = f.skillRepository,
  settings = f.settings,
) =>
  makeProjectTeamExecutionResources({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    managedWorktreesRoot: f.managed,
    protectedRoots: [f.primary, f.protectedRoot],
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provideService(ServerConfig, f.config),
    Effect.provideService(ProjectWorkRepository, f.projectWorkRepository),
    Effect.provideService(Path.Path, f.path),
    Effect.provideService(Settings.ServerSettingsService, settings),
    Effect.provideService(Skills.ManagedSkillRepository, repository),
    Effect.provideService(ProjectTeamPiRuntime, f.pi),
    Effect.provideService(ProviderInstanceRegistry, f.registry),
    Effect.provideService(PiModelCatalogue, f.catalogue),
  );

for (const heldRead of [2, 4] as const) {
  for (const mutation of ["unchanged", "selected-content", "tombstone"] as const) {
    it.effect(`checks ${mutation} after owned skill read receipt ${heldRead}`, () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const entered = yield* Deferred.make<void>();
            const resume = yield* Deferred.make<void>();
            let reads = 0;
            let hold = false;
            const repository = Skills.ManagedSkillRepository.of({
              ...f.skillRepository,
              listProject: (root) =>
                f.skillRepository
                  .listProject(root)
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => (hold ? ++reads : 0)).pipe(
                        Effect.flatMap((count) =>
                          count === heldRead
                            ? Deferred.succeed(entered, undefined).pipe(
                                Effect.andThen(Deferred.await(resume)),
                              )
                            : Effect.void,
                        ),
                      ),
                    ),
                  ),
            });
            const resources = yield* resourcesWith(f, f.sql, repository);
            yield* resources.withCurrent(f.snapshot, (loan) =>
              Effect.gen(function* () {
                hold = true;
                const fiber = yield* loan.assertResources.pipe(Effect.result, Effect.forkScoped);
                yield* Deferred.await(entered);
                if (mutation === "selected-content")
                  yield* f.fs.writeFileString(
                    f.path.join(f.ownedSkill.packagePath, "SKILL.md"),
                    "Changed after catalogue receipt",
                  );
                if (mutation === "tombstone")
                  yield* f.skillRepository.setProjectDisabled({
                    projectRoot: f.primary,
                    key: f.ownedSkill.manifest.key,
                  });
                yield* Deferred.succeed(resume, undefined);
                expect((yield* Fiber.join(fiber))._tag).toBe(
                  mutation === "unchanged" ? "Success" : "Failure",
                );
              }),
            );
            expect(f.borrowed()).toBe(0);
            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
          }),
        ),
      ),
    );
  }
}

for (const mutation of [
  "unchanged",
  "expiry",
  "selected-content",
  "primary-inode",
  "epoch",
  "disabled",
  "configuration",
  "registry",
] as const) {
  it.effect(`checks ${mutation} after its owned SQL snapshot closes`, () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          let hold = false;
          const withTransaction: typeof f.sql.withTransaction = (body) =>
            f.sql
              .withTransaction(body)
              .pipe(
                Effect.tap(() =>
                  Effect.suspend(() =>
                    hold
                      ? Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(resume)),
                        )
                      : Effect.void,
                  ),
                ),
              );
          const sql = new Proxy(f.sql, {
            get: (target, key) =>
              key === "withTransaction" ? withTransaction : Reflect.get(target, key),
          });
          const resources = yield* resourcesWith(f, sql);
          yield* resources
            .withCurrent(f.snapshot, (loan) =>
              Effect.gen(function* () {
                hold = true;
                const fiber = yield* loan.assertResources.pipe(Effect.result, Effect.forkScoped);
                yield* Deferred.await(entered);
                if (mutation === "expiry")
                  yield* TestClock.setTime(f.snapshot.intent.limits.deadlineAtMs);
                if (mutation === "selected-content")
                  yield* f.fs.writeFileString(
                    f.path.join(f.ownedSkill.packagePath, "SKILL.md"),
                    "Changed after SQL close",
                  );
                if (mutation === "primary-inode") {
                  yield* f.fs.rename(f.primary, f.primary + "-old");
                  yield* f.fs.makeDirectory(f.primary);
                }
                if (mutation === "epoch") yield* f.pi.publishAssets(instanceId, f.assets, runtime);
                if (mutation === "disabled")
                  yield* f.settings.updateSettings({ projectTeamExecutionEnabled: false });
                if (mutation === "configuration")
                  yield* f.settings.updateSettings({
                    providerInstances: {
                      [instanceId]: {
                        driver: driverKind,
                        enabled: true,
                        config: { agentDirectory: "/changed" },
                      },
                    },
                  });
                if (mutation === "registry")
                  yield* f.mutator.reconcile({
                    [instanceId]: {
                      driver: driverKind,
                      enabled: true,
                      displayName: "Replacement",
                      config: {},
                    },
                  });
                yield* Deferred.succeed(resume, undefined);
                expect((yield* Fiber.join(fiber))._tag).toBe(
                  mutation === "unchanged" ? "Success" : "Failure",
                );
                hold = false;
              }),
            )
            .pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.result,
              Effect.tap((result) =>
                Effect.sync(() =>
                  expect(result._tag).toBe(mutation === "epoch" ? "Failure" : "Success"),
                ),
              ),
            );
          expect(f.borrowed()).toBe(0);
        }),
      ),
    ),
  );
}

for (const writer of ["captured", "external"] as const) {
  for (const mutation of ["unchanged", "catalogue", "role", "primary", "unrelated"] as const) {
    it.effect(`checks ${writer} SQL ${mutation} after the final settings read receipt`, () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            let captured = f.sql;
            let mutationSql = f.sql;
            if (writer === "external") {
              const filename = f.path.join(f.managed, "disposable.sqlite");
              yield* f.sql`VACUUM INTO ${filename}`;
              const clients = NodeSqliteClient.layer({ filename });
              captured = Context.get(yield* Layer.build(Layer.fresh(clients)), SqlClient.SqlClient);
              mutationSql = Context.get(
                yield* Layer.build(Layer.fresh(clients)),
                SqlClient.SqlClient,
              );
              expect(captured).not.toBe(mutationSql);
            }
            const entered = yield* Deferred.make<void>();
            const resume = yield* Deferred.make<void>();
            let hold = false;
            let reads = 0;
            const settings = Settings.ServerSettingsService.of({
              ...f.settings,
              getSettings: f.settings.getSettings.pipe(
                Effect.tap(() =>
                  Effect.suspend(() =>
                    hold && ++reads === 2
                      ? Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(resume)),
                        )
                      : Effect.void,
                  ),
                ),
              ),
            });
            const resources = yield* resourcesWith(f, captured, f.skillRepository, settings);
            yield* resources
              .withCurrent(f.snapshot, (loan) =>
                Effect.gen(function* () {
                  hold = true;
                  const fiber = yield* loan.assertResources.pipe(Effect.result, Effect.forkScoped);
                  yield* Deferred.await(entered);
                  if (mutation === "catalogue")
                    yield* mutationSql`UPDATE project_team_pi_catalogue SET fetched_at='2099-01-01T00:00:00.000Z' RETURNING source`;
                  if (mutation === "role")
                    yield* mutationSql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.foundationRecords[' || (SELECT key FROM json_each(state_json,'$.foundationRecords') WHERE json_extract(value,'$.kind')='role-revision' AND json_extract(value,'$.recordId')='role') || '].instructions','Changed') WHERE project_id=${projectId} RETURNING project_id`;
                  if (mutation === "primary")
                    yield* mutationSql`UPDATE projection_projects SET workspace_root=${f.protectedRoot} WHERE project_id=${projectId} RETURNING project_id`;
                  if (mutation === "unrelated")
                    yield* mutationSql`UPDATE projection_projects SET title='Unrelated title' WHERE project_id=${projectId} RETURNING project_id`;
                  yield* Deferred.succeed(resume, undefined);
                  expect((yield* Fiber.join(fiber))._tag).toBe(
                    mutation === "unchanged" ? "Success" : "Failure",
                  );
                  hold = false;
                  if (mutation === "unrelated") yield* loan.assertResources;
                }),
              )
              .pipe(Effect.provideService(SqlClient.SqlClient, captured));
            expect(f.borrowed()).toBe(0);
            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
          }),
        ),
      ),
    );
  }
}

it.effect(
  "final resource assertion uses its caller's actual SQL transaction without a savepoint",
  () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.resources.withCurrent(f.snapshot, (loan) =>
            f.sql.withTransaction(
              Effect.gen(function* () {
                const transaction = yield* Effect.contextWith((ambient: Context.Context<never>) => {
                  const current = Context.getOption(ambient, f.sql.transactionService);
                  return Option.isSome(current)
                    ? Effect.succeed(current.value)
                    : Effect.die("Actual caller transaction is unavailable");
                });
                const [connection, depth] = transaction;
                const statements: string[] = [];
                const executeUnprepared: typeof connection.executeUnprepared = (...args) => {
                  statements.push(args[0]);
                  return connection.executeUnprepared(...args);
                };
                const observed = new Proxy(connection, {
                  get: (target, key) =>
                    key === "executeUnprepared" ? executeUnprepared : Reflect.get(target, key),
                });
                yield* loan.assertResources.pipe(
                  Effect.provideService(f.sql.transactionService, [observed, depth]),
                );
                expect(statements).toEqual([]);
                yield* f.sql`UPDATE project_team_pi_catalogue SET fetched_at='2099-01-01T00:00:00.000Z'`;
                expect((yield* loan.assertResources.pipe(Effect.result))._tag).toBe("Failure");
                yield* f.sql`UPDATE project_team_pi_catalogue SET fetched_at=${at}`;
                yield* loan.assertResources;
              }),
            ),
          );
        }),
      ),
    ),
);

it.effect("in-flight detached resource checks lose lexical authority when the callback ends", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let checks = 0;
        const detached = yield* f.resources.withCurrent(f.snapshot, (loan) =>
          Effect.gen(function* () {
            f.setResourceCheck(
              Effect.sync(() => ++checks).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Deferred.succeed(entered, undefined).pipe(
                        Effect.andThen(Deferred.await(resume)),
                      )
                    : Effect.void,
                ),
              ),
            );
            const fiber = yield* loan.assertResources.pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            return fiber;
          }),
        );
        yield* Deferred.succeed(resume, undefined);
        expect(Exit.isFailure(yield* Fiber.await(detached))).toBe(true);
        expect(f.borrowed()).toBe(0);
      }),
    ),
  ),
);

it.effect("resource callback retains its caller Scope and finalizer lifetime", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const scope = yield* Scope.make();
        let finalized = false;
        yield* f.resources
          .withCurrent(f.snapshot, () =>
            Effect.gen(function* () {
              expect(yield* Scope.Scope).toBe(scope);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalized = true;
                }),
              );
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, scope));
        expect(finalized).toBe(false);
        yield* Scope.close(scope, Exit.void);
        expect(finalized).toBe(true);
      }),
    ),
  ),
);

for (const collision of ["unchanged", "global-id", "project-id", "unrelated-body"] as const) {
  control(`regression R3 final getter catalogue ${collision} collision`, (f) =>
    Effect.gen(function* () {
      const extra = yield* collision === "project-id"
        ? f.skillRepository.setProjectOverride({
            projectRoot: f.primary,
            key: ManagedSkillKey.make("additional"),
            content: { name: "Additional", body: "Unselected content" },
          })
        : f.skillRepository.createGlobal({
            expectedRevision: 0,
            content: {
              key: ManagedSkillKey.make("additional"),
              name: "Additional",
              body: "Unselected content",
            },
          });
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let hold = false;
      let reads = 0;
      const settings = Settings.ServerSettingsService.of({
        ...f.settings,
        getSettings: f.settings.getSettings.pipe(
          Effect.tap(() =>
            Effect.suspend(() =>
              hold && ++reads === 2
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
            ),
          ),
        ),
      });
      const resources = yield* resourcesWith(f, f.sql, f.skillRepository, settings);
      yield* resources.withCurrent(f.snapshot, (loan) =>
        Effect.gen(function* () {
          hold = true;
          const fiber = yield* loan.assertResources.pipe(Effect.result, Effect.forkScoped);
          yield* Deferred.await(entered);
          if (collision === "unrelated-body")
            yield* f.fs.writeFileString(
              f.path.join(extra.packagePath, "SKILL.md"),
              "Changed unselected body",
            );
          if (collision === "global-id")
            yield* f.fs.writeFileString(
              f.path.join(extra.packagePath, "t3-skill.json"),
              encodeJson({ ...extra.manifest, id: f.ownedSkill.manifest.id }),
            );
          if (collision === "project-id")
            yield* f.fs.writeFileString(
              f.path.join(extra.packagePath, "t3-skill.json"),
              encodeJson({
                ...extra.manifest,
                id: f.ownedSkill.manifest.id,
                projectState: "override",
              }),
            );
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(fiber);
          hold = false;
          const next = yield* loan.assertResources.pipe(Effect.result);
          if (collision === "global-id" || collision === "project-id") {
            const entries = [
              ...(yield* f.skillRepository.listGlobal()),
              ...(yield* f.skillRepository.listProject(f.primary)),
            ];
            const matching = entries.filter(
              (entry) => entry.manifest?.id === f.ownedSkill.manifest.id,
            );
            expect(matching).toHaveLength(2);
            expect(matching.every((entry) => entry.diagnostics.length === 0)).toBe(true);
          }
          expect(next._tag).toBe(
            collision === "unchanged" || collision === "unrelated-body" ? "Success" : "Failure",
          );
          expect(result._tag).toBe(
            collision === "unchanged" || collision === "unrelated-body" ? "Success" : "Failure",
          );
        }),
      );
    }),
  );
}

for (const scope of ["global", "project"] as const) {
  for (const collision of ["unchanged", "duplicate-id"] as const) {
    control(`regression R3 initial callback ${scope} ${collision} catalogue receipt`, (f) =>
      Effect.gen(function* () {
        const extra = yield* scope === "global"
          ? f.skillRepository.createGlobal({
              expectedRevision: 0,
              content: {
                key: ManagedSkillKey.make("additional"),
                name: "Additional",
                body: "Unselected content",
              },
            })
          : f.skillRepository.setProjectOverride({
              projectRoot: f.primary,
              key: ManagedSkillKey.make("additional"),
              content: { name: "Additional", body: "Unselected content" },
            });
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let reads = 0;
        let entries = 0;
        const settings = Settings.ServerSettingsService.of({
          ...f.settings,
          getSettings: f.settings.getSettings.pipe(
            Effect.tap(() =>
              Effect.suspend(() =>
                ++reads === 4
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(resume)),
                    )
                  : Effect.void,
              ),
            ),
          ),
        });
        const resources = yield* resourcesWith(f, f.sql, f.skillRepository, settings);
        const fiber = yield* resources
          .withCurrent(f.snapshot, () =>
            Effect.sync(() => {
              entries++;
            }),
          )
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        if (collision === "duplicate-id")
          yield* f.fs.writeFileString(
            f.path.join(extra.packagePath, "t3-skill.json"),
            encodeJson({
              ...extra.manifest,
              id: f.ownedSkill.manifest.id,
              ...(scope === "project" ? { projectState: "override" } : {}),
            }),
          );
        yield* Deferred.succeed(resume, undefined);
        const outcome = yield* Fiber.join(fiber);
        expect(outcome._tag).toBe(collision === "unchanged" ? "Success" : "Failure");
        expect(entries).toBe(collision === "unchanged" ? 1 : 0);
      }),
    );
  }
}

for (const scope of ["global", "project"] as const) {
  for (const mutation of ["unchanged", "new-duplicate"] as const) {
    control(`regression R3 empty ${scope} catalogue ${mutation}`, (f) =>
      Effect.gen(function* () {
        if (scope === "global") {
          const project = yield* f.skillRepository.setProjectOverride({
            projectRoot: f.primary,
            key: f.ownedSkill.manifest.key,
            content: { name: "Owned", body: f.ownedSkill.content.body },
          });
          yield* f.fs.writeFileString(
            f.path.join(project.packagePath, "t3-skill.json"),
            encodeJson({
              ...project.manifest,
              id: f.ownedSkill.manifest.id,
              projectState: "override",
            }),
          );
          yield* f.skillRepository.deleteGlobal({
            skillId: f.ownedSkill.manifest.id,
            expectedHash: f.ownedSkill.manifest.revision.hash,
          });
          expect(yield* f.skillRepository.listGlobal()).toEqual([]);
        } else expect(yield* f.skillRepository.listProject(f.primary)).toEqual([]);
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let hold = false;
        let reads = 0;
        const settings = Settings.ServerSettingsService.of({
          ...f.settings,
          getSettings: f.settings.getSettings.pipe(
            Effect.tap(() =>
              Effect.suspend(() =>
                hold && ++reads === 2
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(resume)),
                    )
                  : Effect.void,
              ),
            ),
          ),
        });
        const resources = yield* resourcesWith(f, f.sql, f.skillRepository, settings);
        yield* resources.withCurrent(f.snapshot, (loan) =>
          Effect.gen(function* () {
            hold = true;
            const fiber = yield* loan.assertResources.pipe(Effect.result, Effect.forkScoped);
            yield* Deferred.await(entered);
            if (mutation === "new-duplicate") {
              const extra = yield* scope === "global"
                ? f.skillRepository.createGlobal({
                    expectedRevision: 0,
                    content: {
                      key: ManagedSkillKey.make("additional"),
                      name: "Additional",
                      body: "Unselected content",
                    },
                  })
                : f.skillRepository.setProjectOverride({
                    projectRoot: f.primary,
                    key: ManagedSkillKey.make("additional"),
                    content: { name: "Additional", body: "Unselected content" },
                  });
              yield* f.fs.writeFileString(
                f.path.join(extra.packagePath, "t3-skill.json"),
                encodeJson({
                  ...extra.manifest,
                  id: f.ownedSkill.manifest.id,
                  ...(scope === "project" ? { projectState: "override" } : {}),
                }),
              );
            }
            yield* Deferred.succeed(resume, undefined);
            expect((yield* Fiber.join(fiber))._tag).toBe(
              mutation === "unchanged" ? "Success" : "Failure",
            );
            hold = false;
            expect((yield* loan.assertResources.pipe(Effect.result))._tag).toBe(
              mutation === "unchanged" ? "Success" : "Failure",
            );
          }),
        );
      }),
    );
  }
}

for (const scope of ["global", "project"] as const) {
  for (const duplicate of [false, true] as const) {
    control(`regression R3 hidden ${scope} manifest duplicate ${duplicate}`, (f) =>
      Effect.gen(function* () {
        const extra = yield* scope === "global"
          ? f.skillRepository.createGlobal({
              expectedRevision: 0,
              content: {
                key: ManagedSkillKey.make("additional"),
                name: "Additional",
                body: "Unselected content",
              },
            })
          : f.skillRepository.setProjectOverride({
              projectRoot: f.primary,
              key: ManagedSkillKey.make("additional"),
              content: { name: "Additional", body: "Unselected content" },
            });
        if (duplicate)
          yield* f.fs.writeFileString(
            f.path.join(extra.packagePath, "t3-skill.json"),
            encodeJson({
              ...extra.manifest,
              id: f.ownedSkill.manifest.id,
              ...(scope === "project" ? { projectState: "override" } : {}),
            }),
          );
        const blocked = f.path.join(extra.packagePath, "blocked");
        yield* f.fs.symlink("SKILL.md", blocked);
        const before = yield* scope === "global"
          ? f.skillRepository.listGlobal()
          : f.skillRepository.listProject(f.primary);
        expect(
          before.find((entry) => entry.directoryName === "additional")?.manifest,
        ).toBeUndefined();
        let entries = 0;
        const outcome = yield* f.resources
          .withCurrent(f.snapshot, (loan) =>
            Effect.gen(function* () {
              entries++;
              yield* f.fs.remove(blocked);
              expect((yield* loan.assertResources.pipe(Effect.result))._tag).toBe(
                duplicate ? "Failure" : "Success",
              );
            }),
          )
          .pipe(Effect.result);
        expect(outcome._tag).toBe(duplicate ? "Failure" : "Success");
        expect(entries).toBe(duplicate ? 0 : 1);
      }),
    );
  }
}
