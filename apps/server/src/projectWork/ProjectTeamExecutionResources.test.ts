import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  ProjectWorkFoundationCommitCommand,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
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
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "execution-resources-" }),
            ),
          ),
        ),
      ),
    ),
  );
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "execution-resources-" });
  const primary = path.join(scratch, "primary");
  const managed = path.join(scratch, "managed");
  const protectedRoot = path.join(scratch, "protected");
  for (const root of [primary, managed, protectedRoot]) yield* fs.makeDirectory(root);
  yield* fs.chmod(managed, 0o700);
  const worktree = path.join(managed, "original");
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
              record.kind === "role-revision" ? { ...record, model } : record,
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
    assets,
    payload,
    borrowed: () => borrowed,
    setResourceCheck: (check: Effect.Effect<void, PiManagedRuntimeError>) => {
      resourceCheck = check;
    },
  };
});

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
