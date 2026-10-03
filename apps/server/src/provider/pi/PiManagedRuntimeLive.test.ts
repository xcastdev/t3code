import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { preparePiRuntimeAssets } from "./PiRuntimeAssets.ts";
import { PiManagedRuntimeError } from "./PiManagedRuntime.ts";
import { CommandId, ManagedSkillKey, SkillCatalogRevision } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  seed,
  restoreHistoricalBinding,
  providerInstanceId,
  threadId,
  at,
} from "../../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import * as ManagedSkills from "../../skills/ManagedSkillRepository.ts";
import * as ServerConfig from "../../config.ts";
import { hashSkillPackage } from "../../skills/SkillPackage.ts";
import * as Materialization from "../../skills/SkillMaterializationService.ts";
import { makePiSkillStageLifetime } from "./PiSkillStageLifetime.ts";
import { preallocatePiManagedProcess } from "./PiManagedProcess.ts";
import { piManagedSkillResourceIdentity } from "./PiManagedSkillResources.ts";
import { makeProjectTeamPiOperations } from "../../projectWork/ProjectTeamPiOperations.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as Authorization from "../../projectWork/ProjectTeamAuthorization.ts";
import { ProjectWorkRepositoryLive } from "../../projectWork/ProjectWorkRepository.ts";
import { readCurrentState } from "../../projectWork/ProjectWorkRepository.ts";
import { ProjectWorkQueryLive } from "../../projectWork/ProjectWorkQuery.ts";
import { ProjectWorkSearchLive } from "../../projectWork/ProjectWorkSearch.ts";
import { ProjectWorkNarrativeLive } from "../../projectWork/ProjectWorkNarrative.ts";
import { ProjectWorkBriefingLive } from "../../projectWork/ProjectWorkBriefing.ts";
import {
  ProjectWorkGateway,
  ProjectWorkGatewayLive,
} from "../../projectWork/ProjectWorkGateway.ts";
import {
  ProjectWorkProjection,
  ProjectWorkProjectionLive,
} from "../../projectWork/ProjectWorkProjection.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import {
  makePiManagedRuntimeLive,
  type PiManagedRuntimeLiveOptions,
} from "./PiManagedRuntimeLive.ts";

const decodeClosure = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      sdkVersion: Schema.Literal("0.99.1"),
      files: Schema.Array(
        Schema.Struct({
          source: Schema.String,
          target: Schema.String,
          bytes: Schema.Int,
          sha256: Schema.String,
        }),
      ),
    }),
  ),
);
const decodeAllocationRoots = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ launch: Schema.Struct({ protectedRoots: Schema.Array(Schema.String) }) }),
  ),
);
const decodeBoundaryDrain = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      unit: Schema.String,
      invocation: Schema.String,
      kernel: Schema.String,
      cgroup: Schema.String,
      ownerPid: Schema.Int,
      launcherPid: Schema.Int,
      childPid: Schema.NullOr(Schema.Int),
    }),
  ),
);
const parseTransportBody = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
      tools: Schema.optional(
        Schema.Array(
          Schema.Struct({
            function: Schema.Struct({ name: Schema.String }),
          }),
        ),
      ),
    }),
  ),
);
const decodeLocalTerminal = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      outcome: Schema.String,
      operation: Schema.Struct({ operationId: Schema.String }),
      accountingReceipts: Schema.Array(
        Schema.Struct({ reservationId: Schema.String, accountingReceiptId: Schema.String }),
      ),
    }),
  ),
);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parseOwner = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ unit: Schema.String, invocation: Schema.String, pid: Schema.Int }),
  ),
);
const parseFullDrain = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      unit: Schema.String,
      invocation: Schema.String,
      kernel: Schema.String,
      cgroup: Schema.String,
      ownerPid: Schema.Int,
      launcherPid: Schema.Int,
      childPid: Schema.Int,
      memoryBytes: Schema.Int,
      swapBytes: Schema.Int,
      oomGroup: Schema.Int,
    }),
  ),
);
const parseDrain = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ unit: Schema.String, invocation: Schema.String, kernel: Schema.String }),
  ),
);
const model = "inclusionai/ling-3.1-flash:free";
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(at) + 100);
  const f = yield* seed("investigator", "reserved", {
    nativeSessionId: null,
    roleTools: [],
    toolIds: [],
  });
  const fs = yield* FileSystem.FileSystem;
  const scratch = yield* fs.makeTempDirectoryScoped();
  const agentDirectory = scratch + "/agent";
  const state = scratch + "/state";
  const protectedRoot = scratch + "/protected";
  yield* fs.makeDirectory(agentDirectory);
  yield* fs.makeDirectory(state);
  yield* fs.makeDirectory(protectedRoot);
  const main = scratch + "/main";
  const worktree = scratch + "/assigned";
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make("/usr/bin/git", args));
        const [_, code] = yield* Effect.all(
          [collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }), child.exitCode],
          { concurrency: "unbounded" },
        );
        expect(Number(code)).toBe(0);
      }),
    );
  yield* git(["init", "-q", main]);
  yield* git([
    "-C",
    main,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  yield* git(["-C", main, "worktree", "add", "-qb", "task", worktree]);
  const role = { ...f.role, instructions: "Investigate current assignment", model };
  yield* restoreHistoricalBinding(role);
  const binding = {
    ...f.binding,
    model,
    worktree,
    configuration: {
      ...f.binding.configuration,
      instructionsHash: NodeCrypto.createHash("sha256").update(role.instructions).digest("hex"),
      runtimeVersion: "0.99.1",
      maxDurationMs: 300000,
      maxTokens: 20000,
    },
  };
  yield* restoreHistoricalBinding(binding);
  let transports = 0;
  let launches = 0;
  const options: PiManagedRuntimeLiveOptions = {
    environmentId: "environment",
    agentDirectory,
    nativeStateRoot: state,
    protectedRoots: [protectedRoot],
    runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
    workerArgv: () => {
      launches++;
      return ["/bin/true"];
    },
    memoryBytes: 33554432,
    cleanupDeadlineMs: 1000,
    maxInputTokens: 10000,
    maxOutputTokens: 512,
    readCatalogue: Effect.succeed({
      source: "https://api.commandcode.ai/provider/v1/models",
      fetchedAt: at,
      selectedEntry: {
        id: model,
        owned_by: "command-code",
        context_length: 20000,
        supported_endpoints: ["/chat/completions"],
      },
    }),
    transport: async () => {
      transports++;
      throw Error("Model transport forbidden in authority proof");
    },
  };
  const runtime = yield* makePiManagedRuntimeLive(options);
  const instance = yield* runtime.forInstance({
    instanceId: providerInstanceId,
    enabled: true,
    configuration: {},
  });
  return {
    ...f,
    git,
    fs,
    main,
    worktree,
    role,
    binding,
    options,
    runtime,
    instance,
    get transports() {
      return transports;
    },
    get launches() {
      return launches;
    },
  };
});
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const services = Layer.mergeAll(
        Authorization.layer,
        ProjectWorkRepositoryLive,
        ProjectWorkQueryLive,
        ProjectWorkProjectionLive,
        ProjectWorkSearchLive,
        ProjectWorkNarrativeLive,
        ProjectWorkBriefingLive.pipe(Layer.provide(ProjectWorkQueryLive)),
      );
      const live = ProjectWorkGatewayLive.pipe(
        Layer.provideMerge(services),
        Layer.provide(Layer.mock(EnvironmentAuth)({})),
        Layer.provideMerge(ServerSettings.layerTest({ projectWorkEnabled: true })),
        Layer.provideMerge(makeSqlitePersistenceLive(directory + "/native-runtime.sqlite")),
      );
      return yield* Effect.scoped(effect).pipe(Effect.provide(live));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
const rejected = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => expect(result._tag).toBe("Failure")),
  );
describe.runIf(process.env.PI_MANAGED_RUNTIME_GUIDED_GATE === "1")(
  "actual SDK guided Runtime bridge",
  () => {
    for (const [mode, disposition] of [
      ["report", "ordinary"],
      ["plan", "ordinary"],
      ["report", "held-control"],
      ["report", "held-cancel"],
    ] as const) {
      const caseId = disposition === "ordinary" ? mode : disposition;
      it.effect(`routes ${caseId} through current durable authority`, () =>
        scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const manifest = process.env.PI_MANAGED_RUNTIME_TEST_CLOSURE;
            const evidence = process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE;
            if (!manifest || !evidence) return yield* Effect.die("SDK closure/evidence required");
            const closure = yield* decodeClosure(yield* f.fs.readFileString(manifest));
            for (const file of closure.files) {
              const bytes = yield* f.fs.readFile(file.source);
              expect(bytes.length).toBe(file.bytes);
              expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
            }
            const actualAt = DateTime.formatIso(DateTime.nowUnsafe());
            yield* TestClock.setTime(Date.parse(actualAt));
            const capability = `project-work.${mode}`;
            yield* restoreHistoricalBinding({
              ...f.role,
              revision: f.role.revision + 1,
              role: mode === "plan" ? "coordinator" : "investigator",
              tools: [capability],
            });
            yield* restoreHistoricalBinding({
              ...f.binding,
              revision: f.binding.revision + 1,
              updatedAt: actualAt,
              configuration: { ...f.binding.configuration, toolIds: [capability] },
            });
            yield* f.fs.writeFileString(
              f.options.agentDirectory + "/auth.json",
              json({ "command-code": { type: "api_key", key: "synthetic-guided-key" } }),
            );
            let calls = 0;
            let toolResult = false;
            let intentJSON = "";
            const sequence: string[] = [];
            const entered = yield* Deferred.make<void>();
            const permitHeld = yield* Deferred.make<void>();
            const permitRelease = yield* Deferred.make<void>();
            const testScope = yield* Effect.scope;
            const realGateway = yield* ProjectWorkGateway;
            let permitOwner: Fiber.Fiber<void, SqlError> | undefined;
            const gateway = ProjectWorkGateway.of({
              ...realGateway,
              write: (...args) =>
                Effect.gen(function* () {
                  if (disposition !== "ordinary") {
                    sequence.push("bridge-entered");
                    permitOwner = yield* f.sql
                      .withTransaction(
                        Effect.gen(function* () {
                          sequence.push("actual-sql-permit-held");
                          yield* Deferred.succeed(permitHeld, undefined);
                          yield* Deferred.await(permitRelease);
                          sequence.push("actual-sql-permit-released");
                        }),
                      )
                      .pipe(Effect.forkIn(testScope));
                    yield* Deferred.await(permitHeld);
                    yield* Deferred.succeed(entered, undefined);
                  }
                  const result = yield* realGateway.write(...args);
                  sequence.push("actual-gateway-write-committed");
                  return result;
                }),
            });
            yield* Effect.addFinalizer(() => Deferred.succeed(permitRelease, undefined));
            const runtime = yield* makePiManagedRuntimeLive({
              ...f.options,
              memoryBytes: 536870912,
              maxInputTokens: 18000,
              cleanupDeadlineMs: 5000,
              runtimeFiles: closure.files.map(({ source, target }) => ({ source, target })),
              workerArgv: (identity, operation) => [
                "/runtime/node",
                "--max-old-space-size=512",
                "/runtime/dist/worker.mjs",
                identity.workerId,
                String(identity.generation),
                operation.operationId,
                operation.operationKind,
                "plain",
              ],
              readCatalogue: Effect.succeed({
                source: "https://api.commandcode.ai/provider/v1/models",
                fetchedAt: actualAt,
                selectedEntry: {
                  id: model,
                  owned_by: "command-code",
                  context_length: 20000,
                  supported_endpoints: ["/chat/completions"],
                },
              }),
              transport: async (_url, init) => {
                calls++;
                expect(calls).toBeLessThanOrEqual(2);
                const body = parseTransportBody(init.body);
                expect(body.tools?.map((entry) => entry.function.name)).toEqual([
                  `project_work_${mode}`,
                ]);
                if (calls === 2) {
                  expect(mode).toBe("report");
                  toolResult = body.messages.some(
                    (message) =>
                      message.role === "tool" &&
                      typeof message.content === "string" &&
                      message.content.includes(`native-guided-${caseId}`),
                  );
                  expect(toolResult).toBe(true);
                }
                const delta =
                  calls === 1
                    ? {
                        role: "assistant",
                        tool_calls: [
                          {
                            index: 0,
                            id: "guided-call",
                            type: "function",
                            function: {
                              name: `project_work_${mode}`,
                              arguments: json({ intentJSON }),
                            },
                          },
                        ],
                      }
                    : { role: "assistant", content: "Finding retained" };
                const data = [
                  { model, choices: [{ index: 0, delta, finish_reason: null }] },
                  {
                    model,
                    choices: [
                      { index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" },
                    ],
                  },
                  {
                    model,
                    choices: [],
                    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
                  },
                ];
                return new Response(
                  data.map((entry) => `data: ${json(entry)}\n\n`).join("") + "data: [DONE]\n\n",
                  { headers: { "content-type": "text/event-stream" } },
                );
              },
            }).pipe(Effect.provideService(ProjectWorkGateway, gateway));
            const instance = yield* runtime.forInstance({
              instanceId: providerInstanceId,
              enabled: true,
              configuration: {},
            });
            const initialize = yield* instance.prepareOperation(
              { threadId, kind: "initialize" },
              () => Effect.void,
            );
            yield* initialize.run;
            const before = yield* readCurrentState(f.sql, f.binding.projectId);
            const task = before.tasks.find((entry) => entry.taskId === f.binding.taskId)!;
            const assignment = before.foundationRecords!.find(
              (record) => record.kind === "task-membership" && record.taskId === task.taskId,
            )!;
            const plan = before.foundationRecords!.find(
              (record) => record.kind === "plan-revision" && record.taskId === task.taskId,
            )!;
            const envelope = {
              projectId: f.binding.projectId,
              taskId: task.taskId,
              commandId: `native-guided-${caseId}`,
              expectedRevision: before.revision,
              expectedTaskRevision: task.revision,
              specRevision: 1,
            };
            intentJSON = json(
              mode === "report"
                ? {
                    ...envelope,
                    type: "project-team.assignment.report",
                    planRevision: 1,
                    assignmentId: assignment.recordId,
                    expectedAssignmentRevision: assignment.revision,
                    summary: "The native SDK retained a sourced finding",
                    evidenceIds: [],
                    outputArtifactIds: [],
                    outcome: "findings",
                  }
                : {
                    ...envelope,
                    type: "project-team.plan.propose",
                    previousPlanId: plan.recordId,
                    expectedPreviousPlanRevision: plan.revision,
                    content: "New plan awaits human approval",
                    dependencyTaskIds: [],
                  },
            );
            const prompt = yield* instance.prepareOperation(
              { threadId, kind: "prompt", prompt: "Use guided tool" },
              () => Effect.void,
            );
            let stopInvoked = false;
            let stopJoined = false;
            let abortObserved = false;
            const aborted = Promise.withResolvers<void>();
            const originalAbort = AbortController.prototype.abort;
            if (disposition === "held-cancel")
              AbortController.prototype.abort = function (...args) {
                originalAbort.apply(this, args);
                if (stopInvoked && this.signal.aborted) {
                  abortObserved = true;
                  sequence.push("actual-cancellation-aborted");
                  aborted.resolve();
                }
              };
            let outcome;
            try {
              if (disposition === "ordinary") outcome = yield* prompt.run.pipe(Effect.result);
              else {
                const running = yield* Effect.forkChild(prompt.run.pipe(Effect.result));
                yield* Effect.raceFirst(
                  Deferred.await(entered),
                  Fiber.join(running).pipe(
                    Effect.flatMap((early) =>
                      Effect.die("Operation returned before held SQL permit: " + json(early)),
                    ),
                  ),
                );
                let stopping: Fiber.Fiber<void, PiManagedRuntimeError> | undefined;
                if (disposition === "held-cancel") {
                  sequence.push("request-stop-invoked");
                  stopInvoked = true;
                  stopping = yield* Effect.forkChild(instance.requestStop(threadId));
                  yield* Effect.promise(() => aborted.promise);
                }
                sequence.push("permit-release-requested");
                yield* Deferred.succeed(permitRelease, undefined);
                if (permitOwner) yield* Fiber.join(permitOwner);
                outcome = yield* Fiber.join(running);
                if (stopping) {
                  yield* Fiber.join(stopping);
                  stopJoined = true;
                  sequence.push("stop-joined");
                }
                sequence.push("run-returned-" + outcome._tag);
              }
            } finally {
              AbortController.prototype.abort = originalAbort;
            }
            const after = yield* readCurrentState(f.sql, f.binding.projectId);
            const receipts = yield* f.sql`SELECT * FROM project_work_command_receipts
              WHERE project_id=${f.binding.projectId} AND command_id=${envelope.commandId}`;
            yield* f.fs.writeFileString(
              evidence + `/guided-${caseId}-attempt.json`,
              json({
                disposition,
                sequence,
                stopInvoked,
                stopJoined,
                abortObserved,
                calls,
                outcome,
                beforeRevision: before.revision,
                after,
                receipts,
                operations: yield* f.sql`SELECT * FROM project_team_pi_operation`,
                processes: yield* f.sql`SELECT * FROM project_team_pi_process`,
                modelRequests: yield* f.sql`SELECT * FROM project_team_model_request`,
              }),
            );
            const owners = yield* f.sql<{
              owner_json: string;
              drain_json: string;
            }>`SELECT owner_json,drain_json FROM project_team_pi_process`;
            expect(owners).toHaveLength(2);
            for (const row of owners) {
              const owner = parseOwner(row.owner_json);
              const drain = parseFullDrain(row.drain_json);
              expect(drain.invocation).toBe(owner.invocation);
              expect(drain.unit).toBe(owner.unit);
              expect(drain.kernel === "removed" || drain.kernel.includes("populated 0")).toBe(true);
              for (const pid of [drain.ownerPid, drain.launcherPid, drain.childPid])
                expect(yield* f.fs.exists(`/proc/${pid}`)).toBe(false);
            }
            const canceled = disposition === "held-cancel";
            expect(outcome._tag).toBe(mode === "report" && !canceled ? "Success" : "Failure");
            expect(calls).toBe(mode === "report" && !canceled ? 2 : 1);
            expect(receipts).toHaveLength(canceled ? 0 : 1);
            if (!canceled) expect(after.revision).toBeGreaterThan(before.revision);
            if (canceled) {
              const terminals = yield* f.sql<{ terminal_json: string }>`
                SELECT terminal_json FROM project_team_pi_operation WHERE operation_kind='prompt'`;
              expect(terminals).toHaveLength(1);
              expect((yield* decodeLocalTerminal(terminals[0]!.terminal_json)).outcome).not.toBe(
                "success",
              );
              expect(stopJoined).toBe(true);
              expect(abortObserved).toBe(true);
              expect(after.revision).toBe(before.revision);
              expect(sequence).not.toContain("actual-gateway-write-committed");
              expect(
                after.evidence.some(
                  (entry) => entry.detail === "The native SDK retained a sourced finding",
                ),
              ).toBe(false);
            } else if (mode === "report") {
              expect(
                after.evidence.some(
                  (entry) => entry.detail === "The native SDK retained a sourced finding",
                ),
              ).toBe(true);
            } else {
              expect(
                after.foundationRecords!.some(
                  (record) =>
                    record.kind === "plan-revision" &&
                    record.content === "New plan awaits human approval" &&
                    record.status === "proposed",
                ),
              ).toBe(true);
              yield* rejected(instance.readSession(threadId));
            }
            yield* f.fs.writeFileString(
              evidence + `/guided-${caseId}.json`,
              json({
                mode,
                disposition,
                sequence,
                stopJoined,
                abortObserved,
                calls,
                toolResult,
                beforeRevision: before.revision,
                afterRevision: after.revision,
                receipts,
                owners,
                outcome: outcome._tag,
              }),
            );
          }),
        ),
      );
    }
  },
);
it.effect(
  "inspection reads explicit catalogue and models without credentials, transport or process launch",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const inspection = yield* f.instance.inspect;
        expect(inspection.models[0]?.slug).toBe(model);
        expect(f.launches).toBe(0);
        expect(f.transports).toBe(0);
        const noCatalogue = yield* makePiManagedRuntimeLive({
          ...f.options,
          readCatalogue: Effect.succeed(undefined),
        });
        const instance = yield* noCatalogue.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        yield* rejected(instance.inspect);
      }),
    ),
);
it.effect(
  "resolves durable authority, rejects caller hints and unsupported skills before launch allocation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const hints of [
          { cwd: f.main },
          { runtimeMode: "full-access" as const },
          { modelSelection: { instanceId: providerInstanceId, model: "other" } },
          { resumeCursor: { sessionId: "forged" } },
        ])
          yield* rejected(
            f.instance.prepareOperation(
              { threadId, kind: "initialize", ...hints },
              () => Effect.void,
            ),
          );
        yield* rejected(
          f.instance.authorizeSkills({
            runtime: { providerInstanceId, cwd: f.worktree, sessionId: "native", threadId },
            desiredRevision: SkillCatalogRevision.make(0),
            skills: [],
          }),
        );
        yield* rejected(f.instance.discoverNativeSkills(f.worktree));
        expect(f.launches).toBe(0);
        expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
      }),
    ),
);
it.effect(
  "prepares one committed operation, denies duplicate and joins cancellation before releasing fence",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const prepared = yield* f.instance.prepareOperation(
          { threadId, kind: "initialize" },
          () => Effect.void,
        );
        expect(prepared.operation.operationKind).toBe("initialize");
        yield* rejected(f.sql.withTransaction(prepared.run));
        yield* rejected(prepared.run.pipe(Effect.provide(makeSqlitePersistenceLive(":memory:"))));
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]?.status,
        ).toBe("allocated");
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
            ?.status,
        ).toBe("prepared");
        yield* rejected(
          f.instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
        );
        yield* f.instance.requestStop(threadId);
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
            ?.status,
        ).toBe("settled");
        yield* rejected(prepared.run);
        const next = yield* f.instance.prepareOperation(
          { threadId, kind: "initialize" },
          () => Effect.void,
        );
        expect(next.operation.operationId).not.toBe(prepared.operation.operationId);
        yield* f.instance.stopAll;
        expect(
          (yield* f.sql<{
            status: string;
          }>`SELECT status FROM project_team_pi_operation ORDER BY operation_ordinal DESC LIMIT 1`)[0]
            ?.status,
        ).toBe("settled");
        expect(f.transports).toBe(0);
      }),
    ),
);
it.effect(
  "requires current native session for prompt/compact and denies stale frozen instructions",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* rejected(
          f.instance.prepareOperation(
            { threadId, kind: "prompt", prompt: "Execute" },
            () => Effect.void,
          ),
        );
        yield* rejected(
          f.instance.prepareOperation({ threadId, kind: "compact" }, () => Effect.void),
        );
        yield* restoreHistoricalBinding({
          ...f.role,
          revision: f.role.revision + 1,
          instructions: "Changed instruction",
        });
        yield* rejected(
          f.instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
        );
        expect(f.launches).toBe(0);
      }),
    ),
);
it.effect(
  "checks registered worktree and current branch with actual Git before durable intent",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* restoreHistoricalBinding({
          ...f.binding,
          revision: f.binding.revision + 1,
          worktree: f.main,
        });
        yield* rejected(
          f.instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
        );
        yield* restoreHistoricalBinding({
          ...f.binding,
          revision: f.binding.revision + 2,
          branch: "other",
        });
        yield* rejected(
          f.instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
        );
        yield* f.git(["-C", f.main, "branch", "-m", "primary-protected"]);
        yield* f.git(["-C", f.worktree, "branch", "-m", "main"]);
        yield* restoreHistoricalBinding({
          ...f.binding,
          revision: f.binding.revision + 3,
          branch: "main",
        });
        yield* rejected(
          f.instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
        );
        expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
      }),
    ),
);

describe.runIf(process.env.PI_MANAGED_RUNTIME_LINUX_GATE === "1")(
  "required Linux ownership proof",
  () => {
    it.effect(
      "composes migrated ownership with the real isolated SDK, synthetic broker and bounded native reader",
      () =>
        scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const manifest = process.env.PI_MANAGED_RUNTIME_TEST_CLOSURE;
            if (!manifest)
              return yield* Effect.die(
                "PI_MANAGED_RUNTIME_TEST_CLOSURE is required for the actual SDK ownership proof",
              );
            const closure = yield* decodeClosure(yield* f.fs.readFileString(manifest));
            for (const file of closure.files) {
              const bytes = yield* f.fs.readFile(file.source);
              expect(bytes.length).toBe(file.bytes);
              expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
            }
            const actualAt = DateTime.formatIso(DateTime.nowUnsafe());
            yield* TestClock.setTime(Date.parse(actualAt));
            yield* restoreHistoricalBinding({
              ...f.role,
              revision: f.role.revision + 1,
              tools: ["project-work.read-project"],
            });
            yield* restoreHistoricalBinding({
              ...f.binding,
              revision: f.binding.revision + 1,
              updatedAt: actualAt,
              configuration: { ...f.binding.configuration, toolIds: ["project-work.read-project"] },
            });
            yield* f.fs.writeFileString(
              f.options.agentDirectory + "/auth.json",
              json({ "command-code": { type: "api_key", key: "synthetic-parent-key" } }),
            );
            let calls = 0;
            const transportEntered = Promise.withResolvers<void>();
            let toolReturned = false;
            const options: PiManagedRuntimeLiveOptions = {
              ...f.options,
              memoryBytes: 536870912,
              maxInputTokens: 18000,
              cleanupDeadlineMs: 5000,
              runtimeFiles: closure.files.map(({ source, target }) => ({ source, target })),
              workerArgv: (identity, operation) => [
                "/runtime/node",
                "--max-old-space-size=512",
                "/runtime/dist/worker.mjs",
                identity.workerId,
                String(identity.generation),
                operation.operationId,
                operation.operationKind,
                "plain",
              ],
              readCatalogue: Effect.succeed({
                source: "https://api.commandcode.ai/provider/v1/models",
                fetchedAt: actualAt,
                selectedEntry: {
                  id: model,
                  owned_by: "command-code",
                  context_length: 20000,
                  supported_endpoints: ["/chat/completions"],
                },
              }),
              transport: async (_url, init) => {
                calls++;
                expect(init.headers).toEqual({
                  "Content-Type": "application/json",
                  Authorization: "Bearer synthetic-parent-key",
                });
                if (calls > 2) {
                  transportEntered.resolve();
                  return await new Promise<Response>((_resolve, reject) => {
                    if (init.signal.aborted) reject(Error("Synthetic transport canceled"));
                    else
                      init.signal.addEventListener(
                        "abort",
                        () => reject(Error("Synthetic transport canceled")),
                        { once: true },
                      );
                  });
                }
                const delta =
                  calls === 1
                    ? {
                        role: "assistant",
                        tool_calls: [
                          {
                            index: 0,
                            id: "scoped_read",
                            type: "function",
                            function: {
                              name: "project_work_read",
                              arguments: json({
                                projectId: f.binding.projectId,
                                operation: "task",
                                taskId: f.binding.taskId,
                              }),
                            },
                          },
                        ],
                      }
                    : { role: "assistant", content: "Synthetic result" };
                if (calls === 2) {
                  expect(init.body).toContain('"role":"tool"');
                  expect(
                    parseTransportBody(init.body)
                      .messages.filter((message) => message.role === "tool")
                      .some(
                        (message) =>
                          typeof message.content === "string" &&
                          message.content.includes(f.binding.taskId),
                      ),
                  ).toBe(true);
                  toolReturned = true;
                }
                const data = [
                  { model, choices: [{ index: 0, delta, finish_reason: null }] },
                  {
                    model,
                    choices: [
                      { index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" },
                    ],
                  },
                  {
                    model,
                    choices: [],
                    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
                  },
                ];
                return new Response(
                  data.map((entry) => `data: ${json(entry)}\n\n`).join("") + "data: [DONE]\n\n",
                  { headers: { "content-type": "text/event-stream" } },
                );
              },
            };
            const runtime = yield* makePiManagedRuntimeLive(options);
            const instance = yield* runtime.forInstance({
              instanceId: providerInstanceId,
              enabled: true,
              configuration: {},
            });
            const originalFetch = globalThis.fetch;
            globalThis.fetch = () => {
              throw Error("Ambient fetch forbidden");
            };
            try {
              const initialize = yield* instance.prepareOperation(
                { threadId, kind: "initialize" },
                () => Effect.void,
              );
              const initialized = yield* initialize.run;
              expect(initialized.terminal.outcome).toBe("success");
              expect(calls).toBe(0);
              const events: string[] = [];
              const prompt = yield* instance.prepareOperation(
                { threadId, kind: "prompt", prompt: "Return a synthetic result" },
                (event) =>
                  Effect.sync(() => {
                    events.push(event.type);
                  }),
              );
              const completed = yield* prompt.run.pipe(
                Effect.tapError(() =>
                  Effect.gen(function* () {
                    const evidence = process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE;
                    if (evidence)
                      yield* f.fs.writeFileString(
                        evidence + "/sdk-tool-failure-" + prompt.operation.operationId + ".json",
                        json({
                          calls,
                          operations: yield* f.sql`SELECT * FROM project_team_pi_operation`,
                          requests: yield* f.sql`SELECT * FROM project_team_model_request`,
                        }),
                      );
                  }),
                ),
              );
              expect(completed.terminal.outcome).toBe("success");
              expect(completed.terminal.accountingReceipts).toHaveLength(2);
              expect(calls).toBe(2);
              expect(toolReturned).toBe(true);
              expect(events).toContain("content.delta");
              const snapshot = yield* instance.readThread(threadId);
              expect(snapshot.turns[0]?.items.length).toBeGreaterThan(0);
              const canceled = yield* instance.prepareOperation(
                { threadId, kind: "prompt", prompt: "Wait for cancellation" },
                () => Effect.void,
              );
              const running = yield* Effect.forkChild(canceled.run.pipe(Effect.result));
              yield* Effect.promise(() => transportEntered.promise);
              yield* rejected(canceled.run);
              yield* rejected(instance.readThread(threadId));
              // Current authority is read from the real service before revocation; the old worker still owns its drain.
              const operations = yield* makeProjectTeamPiOperations({
                environmentId: "environment",
              });
              const current = yield* operations.current({ providerInstanceId, threadId });
              yield* restoreHistoricalBinding({
                ...current.binding,
                revision: current.binding.revision + 1,
                status: "revoked",
              });
              yield* instance.requestStop(threadId);
              expect((yield* Fiber.join(running))._tag).toBe("Failure");
              yield* rejected(instance.readThread(threadId));
              const modelRows = yield* f.sql<{
                status: string;
                charged_input_tokens: number;
                charged_output_tokens: number;
              }>`SELECT status,charged_input_tokens,charged_output_tokens FROM project_team_model_request ORDER BY rowid`;
              expect(modelRows).toEqual([
                { status: "reported", charged_input_tokens: 20, charged_output_tokens: 5 },
                { status: "reported", charged_input_tokens: 20, charged_output_tokens: 5 },
                { status: "unknown", charged_input_tokens: 18000, charged_output_tokens: 512 },
              ]);
              const journal = yield* f.sql<{
                status: string;
                operation_ordinal: number;
              }>`SELECT status,operation_ordinal FROM project_team_pi_operation ORDER BY operation_ordinal`;
              expect(journal).toEqual([
                { status: "settled", operation_ordinal: 0 },
                { status: "settled", operation_ordinal: 1 },
                { status: "settled", operation_ordinal: 2 },
              ]);
              const owners = yield* f.sql<{
                owner_json: string;
                drain_json: string;
              }>`SELECT owner_json,drain_json FROM project_team_pi_process`;
              expect(owners).toHaveLength(3);
              const nativeDirectory =
                options.nativeStateRoot +
                "/" +
                NodeCrypto.createHash("sha256")
                  .update(
                    json([
                      "environment",
                      providerInstanceId,
                      threadId,
                      f.binding.recordId,
                      f.binding.generation,
                    ]),
                  )
                  .digest("hex");
              const workerFixtures: string[] = [];
              for (const operation of [initialize.operation, prompt.operation]) {
                const receipt = yield* f.fs.readFileString(
                  nativeDirectory + "/" + operation.operationId + ".fixture.json",
                );
                workerFixtures.push(receipt);
                expect(receipt).not.toContain("OPENAI_API_KEY");
                expect(receipt).not.toContain("AWS_ACCESS_KEY_ID");
              }
              const nativeBytes = yield* f.fs.readFile(
                nativeDirectory +
                  "/sessions/" +
                  completed.terminal.native!.sessionReference.slice(9),
              );
              const evidence = process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE;
              if (evidence)
                yield* f.fs.writeFile(evidence + "/actual-native-session.jsonl", nativeBytes);
              if (evidence)
                yield* f.fs.writeFileString(
                  evidence + "/actual-sdk-ownership.json",
                  json({
                    journal,
                    owners,
                    modelRows,
                    events,
                    calls,
                    toolReturned,
                    workerFixtures,
                    nativeSHA256: NodeCrypto.createHash("sha256").update(nativeBytes).digest("hex"),
                  }),
                );
              for (const row of owners) {
                const owner = parseOwner(row.owner_json);
                const drain = parseDrain(row.drain_json);
                expect(drain.invocation).toBe(owner.invocation);
                expect(drain.unit).toBe(owner.unit);
                expect(drain.kernel === "removed" || drain.kernel.includes("populated 0")).toBe(
                  true,
                );
                expect(yield* f.fs.exists(`/proc/${owner.pid}`)).toBe(false);
              }
            } finally {
              globalThis.fetch = originalFetch;
            }
          }),
        ),
      30000,
    );
  },
);

describe.runIf(process.env.PI_MANAGED_RUNTIME_LINUX_GATE === "1")(
  "actual native publication fence",
  () => {
    for (const mode of [
      "control",
      "stop-one",
      "stop-all",
      "changed-native",
      "publication-stop-one",
      "publication-stop-all",
      "publication-after-commit-stop-one",
      "publication-after-commit-stop-all",
      "publication-changed-native",
      "publication-native-before-commit",
    ] as const) {
      it.effect(
        `actual SDK final handoff ${mode}`,
        () =>
          scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              if (
                !process.env.PI_MANAGED_RUNTIME_TEST_CLOSURE ||
                !process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE
              )
                return yield* Effect.die("Required actual SDK closure/evidence missing");
              const closure = yield* decodeClosure(
                yield* f.fs.readFileString(process.env.PI_MANAGED_RUNTIME_TEST_CLOSURE!),
              );
              const actualAt = DateTime.formatIso(DateTime.nowUnsafe());
              yield* TestClock.setTime(Date.parse(actualAt));
              yield* restoreHistoricalBinding({
                ...f.binding,
                revision: f.binding.revision + 1,
                updatedAt: actualAt,
              });
              const real = yield* Authorization.ProjectTeamAuthorization;
              const projection = yield* ProjectWorkProjection;
              const restore = (record: Parameters<typeof restoreHistoricalBinding>[0]) =>
                restoreHistoricalBinding(record).pipe(
                  Effect.provideService(ProjectWorkProjection, projection),
                  Effect.provideService(SqlClient.SqlClient, f.sql),
                  Effect.orDie,
                );
              const entered = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const canceled = Promise.withResolvers<void>();
              let operationId: string | undefined;
              let settledReads = 0;
              let held = false;
              let changed = false;
              let cancellationObserved = false;
              let stopJoined = false;
              const sequence: string[] = [];
              const wrapped = Authorization.ProjectTeamAuthorization.of({
                ...real,
                issueCredential: (...args) =>
                  Effect.gen(function* () {
                    const authority = yield* real.issueCredential(...args);
                    if (operationId && mode.startsWith("publication-") && !held) {
                      const rows = yield* f.sql<{
                        status: string;
                      }>`SELECT status FROM project_team_pi_operation WHERE operation_id=${operationId}`.pipe(
                        Effect.orDie,
                      );
                      const inside = Option.isSome(
                        yield* Effect.serviceOption(f.sql.transactionService),
                      );
                      if (
                        rows[0]?.status === "settled" &&
                        (mode === "publication-changed-native" || mode.includes("after-commit")
                          ? !inside
                          : inside)
                      ) {
                        if (!authority)
                          return yield* Effect.die("No current native publication authority");
                        held = true;
                        sequence.push(
                          inside ? "final-transaction-authority-held" : "postcommit-authority-held",
                        );
                        if (mode === "publication-native-before-commit") {
                          yield* restore({
                            ...authority.binding,
                            revision: authority.binding.revision + 1,
                            sessionId: "foreign-native-inside-publication",
                          });
                          changed = true;
                        } else {
                          yield* Deferred.succeed(entered, undefined);
                          yield* Deferred.await(release);
                        }
                      }
                    }
                    return authority;
                  }),
                resolve: (...args) =>
                  Effect.gen(function* () {
                    const result = yield* real.resolve(...args);
                    if (
                      !mode.startsWith("publication-") &&
                      operationId &&
                      Option.isNone(yield* Effect.serviceOption(f.sql.transactionService))
                    ) {
                      const rows = yield* f.sql<{
                        status: string;
                      }>`SELECT status FROM project_team_pi_operation WHERE operation_id=${operationId}`.pipe(
                        Effect.orDie,
                      );
                      if (rows[0]?.status === "settled") {
                        settledReads++;
                        if (settledReads === 2) {
                          held = true;
                          sequence.push("actual-final-authority-held");
                          yield* Deferred.succeed(entered, undefined);
                          yield* Deferred.await(release);
                        }
                      }
                    }
                    return result;
                  }),
              });
              const originalFetch = globalThis.fetch;
              globalThis.fetch = async () => {
                throw Error("Unexpected ambient model fetch");
              };
              const options: PiManagedRuntimeLiveOptions = {
                ...f.options,
                memoryBytes: 536870912,
                cleanupDeadlineMs: 5000,
                runtimeFiles: closure.files.map(({ source, target }) => ({ source, target })),
                workerArgv: (identity, operation) => [
                  "/runtime/node",
                  "--max-old-space-size=512",
                  "/runtime/dist/worker.mjs",
                  identity.workerId,
                  String(identity.generation),
                  operation.operationId,
                  operation.operationKind,
                  "plain",
                ],
                readCatalogue: Effect.succeed({
                  source: "https://api.commandcode.ai/provider/v1/models",
                  fetchedAt: actualAt,
                  selectedEntry: {
                    id: model,
                    owned_by: "command-code",
                    context_length: 20000,
                    supported_endpoints: ["/chat/completions"],
                  },
                }),
              };
              const runtime = yield* makePiManagedRuntimeLive(options).pipe(
                Effect.provideService(Authorization.ProjectTeamAuthorization, wrapped),
              );
              const instance = yield* runtime.forInstance({
                instanceId: providerInstanceId,
                enabled: true,
                configuration: {},
              });
              const prepared = yield* instance.prepareOperation(
                { threadId, kind: "initialize" },
                () => Effect.void,
              );
              operationId = prepared.operation.operationId;
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(release, undefined);
                  yield* instance.stopAll;
                  const operations = yield* f.sql`SELECT * FROM project_team_pi_operation`;
                  const processes = yield* f.sql`SELECT * FROM project_team_pi_process`;
                  yield* f.fs.writeFileString(
                    process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE +
                      "/native-tail-" +
                      mode +
                      "-final.json",
                    json({ mode, held, sequence, operations, processes }),
                  );
                }).pipe(Effect.orDie),
              );
              const original = AbortController.prototype.abort;
              AbortController.prototype.abort = function (...args) {
                original.apply(this, args);
                if (held) {
                  cancellationObserved = true;
                  sequence.push("internal-cancellation-abort");
                  canceled.resolve();
                }
              };
              try {
                const running = yield* Effect.forkChild(prepared.run.pipe(Effect.result));
                if (mode !== "publication-native-before-commit")
                  yield* Effect.raceFirst(
                    Deferred.await(entered),
                    Fiber.join(running).pipe(
                      Effect.flatMap((outcome) =>
                        Effect.die(
                          "SDK run completed before the required native authority receipt: " +
                            json(outcome),
                        ),
                      ),
                    ),
                  );
                let stopping: Fiber.Fiber<void, Effect.Error<typeof instance.stopAll>> | undefined;
                if (mode.endsWith("stop-one") || mode.endsWith("stop-all")) {
                  sequence.push(mode + "-invoked");
                  stopping = yield* Effect.forkChild(
                    mode.endsWith("stop-one") ? instance.requestStop(threadId) : instance.stopAll,
                  );
                  yield* Effect.promise(() => canceled.promise);
                }
                if (mode === "changed-native" || mode === "publication-changed-native") {
                  const current = yield* real.resolve({
                    actor: { kind: "agent", id: Authorization.managedActorId(f.principal.managed) },
                    managed: f.principal.managed,
                  });
                  if (!current) return yield* Effect.die("No current fixture authority");
                  yield* restoreHistoricalBinding({
                    ...current.binding,
                    revision: current.binding.revision + 1,
                    sessionId: "changed-native-after-terminal",
                  });
                  changed = true;
                }
                sequence.push("authority-receipt-released");
                yield* Deferred.succeed(release, undefined);
                const outcome = yield* Fiber.join(running);
                sequence.push("run-returned-" + outcome._tag);
                if (stopping) {
                  yield* Fiber.join(stopping);
                  stopJoined = true;
                  sequence.push("stop-joined");
                }
                const rows = yield* f.sql<{
                  owner_json: string;
                  drain_json: string;
                }>`SELECT * FROM project_team_pi_process`;
                yield* f.fs.writeFileString(
                  process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE + "/native-tail-" + mode + ".json",
                  json({
                    mode,
                    settledReads,
                    held,
                    changed,
                    cancellationObserved,
                    stopJoined,
                    sequence,
                    outcome,
                    rows,
                  }),
                );
                for (const row of rows) {
                  const owner = parseOwner(row.owner_json);
                  const drain = parseFullDrain(row.drain_json);
                  expect(owner.invocation).toBe(drain.invocation);
                  expect(owner.unit).toBe(drain.unit);
                  expect(owner.pid).toBe(drain.ownerPid);
                  expect(drain.memoryBytes).toBe(536870912);
                  expect(drain.swapBytes).toBe(0);
                  expect(drain.oomGroup).toBe(1);
                  for (const pid of [owner.pid, drain.launcherPid, drain.childPid])
                    expect(yield* f.fs.exists("/proc/" + pid)).toBe(false);
                  expect(yield* f.fs.exists(drain.cgroup)).toBe(false);
                  expect(drain.kernel === "removed" || drain.kernel.includes("populated 0")).toBe(
                    true,
                  );
                }
                expect(f.transports).toBe(0);
                expect(held).toBe(true);
                expect(outcome._tag).toBe(mode === "control" ? "Success" : "Failure");
              } finally {
                AbortController.prototype.abort = original;
                globalThis.fetch = originalFetch;
              }
            }),
          ),
        30000,
      );
    }
  },
);

it.effect("derives primary and common Git protection without caller hints", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const prepared = yield* f.instance.prepareOperation(
        { threadId, kind: "initialize" },
        () => Effect.void,
      );
      const rows = yield* f.sql<{
        allocation_json: string;
      }>`SELECT allocation_json FROM project_team_pi_process`;
      const allocation = yield* decodeAllocationRoots(rows[0]!.allocation_json);
      expect(allocation.launch.protectedRoots).toContain(f.main);
      expect(allocation.launch.protectedRoots).toContain(f.main + "/.git");
      yield* f.instance.requestStop(threadId);
      yield* rejected(prepared.run);
    }),
  ),
);

it.effect("denies native state inside the dynamically protected primary checkout", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const runtime = yield* makePiManagedRuntimeLive({
        ...f.options,
        nativeStateRoot: f.main + "/state",
      });
      const instance = yield* runtime.forInstance({
        instanceId: providerInstanceId,
        enabled: true,
        configuration: {},
      });
      yield* rejected(
        instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
      );
      expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
    }),
  ),
);

describe.runIf(process.env.PI_MANAGED_RUNTIME_LINUX_GATE === "1")(
  "actual staged assets runtime boundaries",
  () => {
    for (const phase of [
      "control",
      "preallocation",
      "acquire",
      "start",
      "primary-swap",
      "primary-symlink",
      "common-symlink",
      "assigned-swap",
      "primary-branch",
      "primary-head",
      "revoke",
      "cancel",
      "common-swap",
      "agent-swap",
    ] as const) {
      it.effect(
        `staged actual SDK mutation ${phase}`,
        () =>
          scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              const manifest = process.env.PI_MANAGED_RUNTIME_TEST_CLOSURE;
              const evidence = process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE;
              if (!manifest || !evidence)
                return yield* Effect.die("Required actual SDK closure/evidence missing");
              const closure = yield* decodeClosure(yield* f.fs.readFileString(manifest));
              const worker = closure.files.find(
                (file) => file.target === "/runtime/dist/worker.mjs",
              );
              const metadata = closure.files.find(
                (file) => file.target === "/runtime/package.json",
              );
              if (!worker || !metadata)
                return yield* Effect.die("Actual pinned SDK bridge/metadata missing");
              for (const file of [worker, metadata]) {
                const bytes = yield* f.fs.readFile(file.source);
                expect(bytes.length).toBe(file.bytes);
                expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
                  file.sha256,
                );
              }
              const scratch = yield* f.fs.makeTempDirectoryScoped();
              const distributionDirectory = scratch + "/dist";
              const stagingDirectory = scratch + "/stage";
              yield* f.fs.makeDirectory(distributionDirectory + "/pi-sdk", { recursive: true });
              yield* f.fs.makeDirectory(stagingDirectory);
              yield* f.fs.copyFile(worker.source, distributionDirectory + "/pi-worker.mjs");
              yield* f.fs.copyFile(metadata.source, distributionDirectory + "/pi-sdk/package.json");
              const assets = yield* preparePiRuntimeAssets({
                distributionDirectory,
                stagingDirectory,
                protectedRoots: [f.main],
              }).pipe(Effect.provideService(HostProcessPlatform, "linux"));
              yield* Effect.addFinalizer(() =>
                f.fs.chmod(stagingDirectory, 0o700).pipe(Effect.orDie),
              );
              const stagedWorker = assets.runtimeFiles.find(
                (file) => file.target === "/runtime/dist/pi-worker.mjs",
              )!.source;
              const actualAt = DateTime.formatIso(DateTime.nowUnsafe());
              yield* TestClock.setTime(Date.parse(actualAt));
              yield* restoreHistoricalBinding({
                ...f.binding,
                revision: f.binding.revision + 1,
                updatedAt: actualAt,
              });
              const testServices = yield* Effect.context<
                SqlClient.SqlClient | ProjectWorkProjection
              >();
              const assetEntered = yield* Deferred.make<void>();
              const assetRelease = yield* Deferred.make<void>();
              const abortReceipt = Promise.withResolvers<void>();
              let callbackJoined = false;
              let validations = 0;
              let transports = 0;
              const revalidateRuntime = Effect.gen(function* () {
                validations++;
                yield* Effect.gen(function* () {
                  if (
                    validations ===
                    {
                      preallocation: 1,
                      acquire: 2,
                      start: 3,
                      control: 0,
                      "primary-swap": 0,
                      "primary-symlink": 0,
                      "common-symlink": 0,
                      "assigned-swap": 0,
                      "primary-branch": 0,
                      "primary-head": 0,
                      revoke: 0,
                      cancel: 0,
                      "common-swap": 0,
                      "agent-swap": 0,
                    }[phase]
                  ) {
                    yield* f.fs.chmod(stagedWorker, 0o600);
                    yield* f.fs.writeFileString(
                      stagedWorker,
                      "throw Error('mutated closure must never start');\n",
                    );
                  }
                  if (validations === 2) {
                    if (phase === "cancel") {
                      yield* Deferred.succeed(assetEntered, undefined);
                      yield* Deferred.await(assetRelease);
                      callbackJoined = true;
                    }
                    if (phase === "common-swap") {
                      yield* f.fs.rename(f.main + "/.git", f.main + "/.git-held");
                      yield* f.fs.copy(f.main + "/.git-held", f.main + "/.git");
                    }
                    if (
                      phase === "primary-swap" ||
                      phase === "assigned-swap" ||
                      phase === "agent-swap"
                    ) {
                      const directory =
                        phase === "primary-swap"
                          ? f.main
                          : phase === "agent-swap"
                            ? f.options.agentDirectory
                            : f.worktree;
                      yield* f.fs.rename(directory, directory + "-held");
                      yield* f.fs.copy(directory + "-held", directory);
                    }
                    if (phase === "primary-symlink" || phase === "common-symlink") {
                      const directory = phase === "primary-symlink" ? f.main : f.main + "/.git";
                      yield* f.fs.rename(directory, directory + "-held");
                      yield* f.fs.symlink(directory + "-held", directory);
                    }
                    if (phase === "revoke")
                      yield* restoreHistoricalBinding({
                        ...f.binding,
                        revision: f.binding.revision + 2,
                        updatedAt: actualAt,
                        status: "revoked",
                      }).pipe(Effect.provide(testServices));
                    if (phase === "primary-branch")
                      yield* f.git(["-C", f.main, "branch", "-m", "changed-primary"]);
                    if (phase === "primary-head")
                      yield* f.git([
                        "-C",
                        f.main,
                        "-c",
                        "user.name=Fixture",
                        "-c",
                        "user.email=fixture@example.test",
                        "commit",
                        "--allow-empty",
                        "-qm",
                        "primary HEAD may advance",
                      ]);
                  }
                }).pipe(Effect.orDie);
                yield* assets.revalidate.pipe(
                  Effect.mapError(
                    () =>
                      new PiManagedRuntimeError({
                        code: "denied",
                        detail: "Actual staged runtime mutated",
                      }),
                  ),
                );
              });
              const originalFetch = globalThis.fetch;
              globalThis.fetch = async () => {
                throw Error("Unexpected ambient model fetch");
              };
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  globalThis.fetch = originalFetch;
                }),
              );
              const runtime = yield* makePiManagedRuntimeLive({
                ...f.options,
                memoryBytes: 536870912,
                cleanupDeadlineMs: 5000,
                // The held SDK bridge discovers its package at /runtime; this alias is fixture-only.
                runtimeFiles: [
                  ...assets.runtimeFiles,
                  {
                    source: assets.runtimeFiles.find(
                      (file) => file.target === "/runtime/dist/pi-sdk/package.json",
                    )!.source,
                    target: "/runtime/package.json",
                  },
                ],
                revalidateRuntime,
                workerArgv: (identity, operation) => [
                  "/runtime/node",
                  "--max-old-space-size=512",
                  "/runtime/dist/pi-worker.mjs",
                  identity.workerId,
                  String(identity.generation),
                  operation.operationId,
                  operation.operationKind,
                  "plain",
                ],
                readCatalogue: Effect.succeed({
                  source: "https://api.commandcode.ai/provider/v1/models" as const,
                  fetchedAt: actualAt,
                  selectedEntry: {
                    id: model,
                    owned_by: "command-code" as const,
                    context_length: 20000,
                    supported_endpoints: ["/chat/completions"],
                  },
                }),
                transport: async () => {
                  transports++;
                  throw Error("Model forbidden in staged closure proof");
                },
              });
              const instance = yield* runtime.forInstance({
                instanceId: providerInstanceId,
                enabled: true,
                configuration: {},
              });
              yield* Effect.addFinalizer(() => instance.stopAll.pipe(Effect.orDie));
              const preparation = yield* instance
                .prepareOperation({ threadId, kind: "initialize" }, () => Effect.void)
                .pipe(Effect.result);
              if (phase === "preallocation") {
                expect(preparation._tag).toBe("Failure");
                expect((yield* f.sql`SELECT * FROM project_team_pi_process`).length).toBe(0);
              } else {
                if (preparation._tag !== "Success")
                  return yield* Effect.die("Unexpected preparation failure " + json(preparation));
                const originalAbort = AbortController.prototype.abort;
                if (phase === "cancel")
                  AbortController.prototype.abort = function (...args) {
                    originalAbort.apply(this, args);
                    abortReceipt.resolve();
                  };
                let outcome;
                try {
                  const running = yield* Effect.forkChild(
                    preparation.success.run.pipe(Effect.result),
                  );
                  if (phase === "cancel") {
                    yield* Effect.raceFirst(
                      Deferred.await(assetEntered),
                      Fiber.join(running).pipe(
                        Effect.flatMap((early) =>
                          Effect.die(
                            "Run completed before asset revalidation receipt: " + json(early),
                          ),
                        ),
                      ),
                    );
                    const stopping = yield* Effect.forkChild(instance.requestStop(threadId));
                    yield* Effect.promise(() => abortReceipt.promise);
                    yield* Deferred.succeed(assetRelease, undefined);
                    outcome = yield* Fiber.join(running);
                    yield* Fiber.join(stopping);
                    expect(callbackJoined).toBe(true);
                  } else outcome = yield* Fiber.join(running);
                } finally {
                  AbortController.prototype.abort = originalAbort;
                }
                yield* f.fs.writeFileString(
                  evidence + "/assets-runtime-" + phase + "-outcome.json",
                  json({
                    outcome,
                    validations,
                    processes: yield* f.sql`SELECT * FROM project_team_pi_process`,
                    operations: yield* f.sql`SELECT * FROM project_team_pi_operation`,
                  }),
                );
                expect(outcome._tag).toBe(
                  phase === "control" || phase === "primary-head" ? "Success" : "Failure",
                );
              }
              yield* instance.stopAll;
              const rows = yield* f.sql<{
                status: string;
                owner_json: string | null;
                drain_json: string | null;
              }>`SELECT * FROM project_team_pi_process`;
              const operations = yield* f.sql<{
                native_json: string | null;
              }>`SELECT * FROM project_team_pi_operation`;
              expect(validations).toBe(
                phase === "preallocation"
                  ? 1
                  : phase === "start" || phase === "control" || phase === "primary-head"
                    ? 3
                    : 2,
              );
              expect(transports).toBe(0);
              if (phase !== "control" && phase !== "primary-head")
                expect(operations.every((row) => row.native_json === null)).toBe(true);
              for (const row of rows) {
                if (row.owner_json) {
                  const owner = parseOwner(row.owner_json);
                  const drain = yield* decodeBoundaryDrain(row.drain_json!);
                  expect(owner.invocation).toBe(drain.invocation);
                  expect(owner.pid).toBe(drain.ownerPid);
                  for (const pid of [owner.pid, drain.launcherPid, drain.childPid].filter(
                    (pid) => pid !== null,
                  ))
                    expect(yield* f.fs.exists("/proc/" + pid)).toBe(false);
                  expect(yield* f.fs.exists(drain.cgroup)).toBe(false);
                  expect(drain.kernel === "removed" || drain.kernel.includes("populated 0")).toBe(
                    true,
                  );
                }
              }
              expect(rows.filter((row) => row.owner_json).length).toBe(
                phase === "start" || phase === "control" || phase === "primary-head" ? 1 : 0,
              );
              yield* f.fs.writeFileString(
                evidence + "/assets-runtime-" + phase + ".json",
                json({
                  phase,
                  callbackJoined,
                  validations,
                  transports,
                  rows,
                  operations,
                  stagedRuntimeFiles: assets.runtimeFiles,
                }),
              );
            }),
          ),
        30000,
      );
    }
  },
);

it.effect(
  "protects the actual custom credential directory and denies one inside assigned cwd",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const custom = f.main + "-credentials";
        const inside = f.worktree + "/credentials";
        yield* f.fs.makeDirectory(custom);
        yield* f.fs.makeDirectory(inside);
        const outsideInstance = yield* f.runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: { agentDirectory: custom },
        });
        const prepared = yield* outsideInstance.prepareOperation(
          { threadId, kind: "initialize" },
          () => Effect.void,
        );
        const rows = yield* f.sql<{
          allocation_json: string;
        }>`SELECT allocation_json FROM project_team_pi_process`;
        expect(
          (yield* decodeAllocationRoots(rows[0]!.allocation_json)).launch.protectedRoots,
        ).toContain(custom);
        yield* outsideInstance.requestStop(threadId);
        yield* rejected(prepared.run);
        const insideInstance = yield* f.runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: { agentDirectory: inside },
        });
        yield* rejected(
          insideInstance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
        );
        expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(1);
      }),
    ),
);

describe.runIf(process.env.PI_MANAGED_RUNTIME_LINUX_GATE === "1")(
  "late final workspace authority fence",
  () => {
    for (const mode of [
      "unchanged",
      "branch",
      "config",
      "missing-registration",
      "symlink-registration",
      "oversized-head",
      "cancel",
      "during-validator",
      "detached-advance",
    ] as const) {
      it.effect(
        `held final workspace authority ${mode}`,
        () =>
          scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              const manifest = process.env.PI_MANAGED_RUNTIME_TEST_CLOSURE;
              const evidence = process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE;
              if (!manifest || !evidence)
                return yield* Effect.die("Required actual SDK closure/evidence missing");
              const closure = yield* decodeClosure(yield* f.fs.readFileString(manifest));
              const actualAt = DateTime.formatIso(DateTime.nowUnsafe());
              yield* TestClock.setTime(Date.parse(actualAt));
              yield* restoreHistoricalBinding({
                ...f.binding,
                revision: f.binding.revision + 1,
                updatedAt: actualAt,
              });
              if (mode === "detached-advance")
                yield* f.git(["-C", f.main, "checkout", "--detach", "-q"]);
              const real = yield* Authorization.ProjectTeamAuthorization;
              const held = yield* Deferred.make<void>();
              const validatorHeld = yield* Deferred.make<void>();
              const released = yield* Deferred.make<void>();
              let validations = 0;
              let postValidatorCommonStats = 0;
              let workspaceCompleted = false;
              let authorityHeld = false;
              const sequence: string[] = [];
              const filesystem = FileSystem.FileSystem.of({
                ...f.fs,
                stat: (...args) =>
                  Effect.gen(function* () {
                    const value = yield* f.fs.stat(...args);
                    if (validations === 3 && args[0] === f.main + "/.git") {
                      postValidatorCommonStats++;
                      if (postValidatorCommonStats === 2) {
                        workspaceCompleted = true;
                        sequence.push("final-common-identity-read-completed");
                      }
                    }
                    return value;
                  }),
              });
              const authorization = Authorization.ProjectTeamAuthorization.of({
                ...real,
                issueCredential: (...args) =>
                  Effect.gen(function* () {
                    const result = yield* real.issueCredential(...args);
                    if (workspaceCompleted && !authorityHeld && mode !== "during-validator") {
                      authorityHeld = true;
                      sequence.push("last-start-authority-read-held");
                      yield* Deferred.succeed(held, undefined);
                      yield* Deferred.await(released);
                      sequence.push("last-start-authority-read-returned");
                    }
                    return result;
                  }),
              });
              const runtime = yield* makePiManagedRuntimeLive({
                ...f.options,
                memoryBytes: 536870912,
                cleanupDeadlineMs: 5000,
                revalidateRuntime: Effect.gen(function* () {
                  validations++;
                  sequence.push("validator-" + validations);
                  if (mode === "during-validator" && validations === 3) {
                    yield* Deferred.succeed(validatorHeld, undefined);
                    yield* Deferred.await(released);
                    sequence.push("held-validator-returned");
                  }
                }),
                runtimeFiles: closure.files.map(({ source, target }) => ({ source, target })),
                workerArgv: (identity, operation) => [
                  "/runtime/node",
                  "--max-old-space-size=512",
                  "/runtime/dist/worker.mjs",
                  identity.workerId,
                  String(identity.generation),
                  operation.operationId,
                  operation.operationKind,
                  "plain",
                ],
                readCatalogue: Effect.succeed({
                  source: "https://api.commandcode.ai/provider/v1/models",
                  fetchedAt: actualAt,
                  selectedEntry: {
                    id: model,
                    owned_by: "command-code",
                    context_length: 20000,
                    supported_endpoints: ["/chat/completions"],
                  },
                }),
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, filesystem),
                Effect.provideService(Authorization.ProjectTeamAuthorization, authorization),
              );
              const instance = yield* runtime.forInstance({
                instanceId: providerInstanceId,
                enabled: true,
                configuration: {},
              });
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(released, undefined).pipe(
                  Effect.andThen(instance.stopAll),
                  Effect.orDie,
                ),
              );
              const originalFetch = globalThis.fetch;
              globalThis.fetch = async () => {
                throw Error("Ambient fetch forbidden in independent native control");
              };
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  globalThis.fetch = originalFetch;
                }),
              );
              const prepared = yield* instance.prepareOperation(
                { threadId, kind: "initialize" },
                () => Effect.void,
              );
              const running = yield* Effect.forkChild(prepared.run.pipe(Effect.result));
              yield* Effect.raceFirst(
                Deferred.await(mode === "during-validator" ? validatorHeld : held),
                Fiber.join(running).pipe(
                  Effect.flatMap((result) =>
                    Effect.die(
                      "Operation returned before required authority hold: " + json(result),
                    ),
                  ),
                ),
              );
              const before = yield* f.sql`SELECT * FROM project_team_pi_process`;
              const gitDirectory = (yield* f.fs.readFileString(f.worktree + "/.git"))
                .trim()
                .slice("gitdir: ".length);
              if (mode === "missing-registration") yield* f.fs.remove(gitDirectory + "/commondir");
              if (mode === "symlink-registration") {
                yield* f.fs.rename(gitDirectory + "/commondir", gitDirectory + "/commondir-held");
                yield* f.fs.symlink(gitDirectory + "/commondir-held", gitDirectory + "/commondir");
              }
              if (mode === "oversized-head")
                yield* f.fs.writeFileString(gitDirectory + "/HEAD", "x".repeat(16385));
              if (mode === "config")
                yield* f.git(["-C", f.worktree, "config", "core.worktree", f.main]);
              if (mode === "detached-advance")
                yield* f.git([
                  "-C",
                  f.main,
                  "-c",
                  "user.name=Fixture",
                  "-c",
                  "user.email=fixture@example.test",
                  "commit",
                  "--allow-empty",
                  "-qm",
                  "detached primary may advance",
                ]);
              if (mode === "branch" || mode === "during-validator")
                yield* f.git([
                  "-C",
                  f.worktree,
                  "branch",
                  "-m",
                  "changed-after-last-workspace-check",
                ]);
              sequence.push(
                mode === "branch"
                  ? "assigned-branch-changed-externally"
                  : "unchanged-held-authority-control",
              );
              const originalAbort = AbortController.prototype.abort;
              const abortReceipt = Promise.withResolvers<void>();
              let stopJoined = false;
              let outcome;
              if (mode === "cancel")
                AbortController.prototype.abort = function (...args) {
                  originalAbort.apply(this, args);
                  sequence.push("actual-stop-aborted");
                  abortReceipt.resolve();
                };
              try {
                let stopping: Fiber.Fiber<void, PiManagedRuntimeError> | undefined;
                if (mode === "cancel") {
                  stopping = yield* Effect.forkChild(instance.requestStop(threadId));
                  yield* Effect.promise(() => abortReceipt.promise);
                }
                yield* Deferred.succeed(released, undefined);
                outcome = yield* Fiber.join(running);
                if (stopping) {
                  yield* Fiber.join(stopping);
                  stopJoined = true;
                }
              } finally {
                AbortController.prototype.abort = originalAbort;
              }
              sequence.push("run-returned-" + outcome._tag);
              yield* instance.stopAll;
              const processes = yield* f.sql<{
                owner_json: string | null;
                drain_json: string | null;
                status: string;
              }>`SELECT * FROM project_team_pi_process`;
              const operations = yield* f.sql<{
                native_json: string | null;
              }>`SELECT * FROM project_team_pi_operation`;
              yield* f.fs.writeFileString(
                evidence + "/late-final-authority-" + mode + ".json",
                json({
                  mode,
                  stopJoined,
                  validations,
                  postValidatorCommonStats,
                  workspaceCompleted,
                  authorityHeld,
                  sequence,
                  before,
                  outcome,
                  processes,
                  operations,
                  transports: f.transports,
                }),
              );
              for (const row of processes) {
                if (row.owner_json) {
                  const owner = parseOwner(row.owner_json);
                  const drain = yield* decodeBoundaryDrain(row.drain_json!);
                  expect(owner.invocation).toBe(drain.invocation);
                  expect(owner.pid).toBe(drain.ownerPid);
                  for (const pid of [owner.pid, drain.launcherPid, drain.childPid].filter(
                    (pid) => pid !== null,
                  ))
                    expect(yield* f.fs.exists("/proc/" + pid)).toBe(false);
                  expect(yield* f.fs.exists(drain.cgroup)).toBe(false);
                }
              }
              expect(authorityHeld).toBe(mode !== "during-validator");
              if (mode === "cancel") expect(stopJoined).toBe(true);
              expect(validations).toBe(3);
              expect(f.transports).toBe(0);
              if (mode !== "unchanged" && mode !== "detached-advance") {
                expect(operations.every((row) => row.native_json === null)).toBe(true);
                for (const row of processes)
                  expect((yield* decodeBoundaryDrain(String(row.drain_json))).childPid).toBeNull();
              }
              expect(outcome._tag).toBe(
                mode === "unchanged" || mode === "detached-advance" ? "Success" : "Failure",
              );
            }),
          ),
        30000,
      );
    }
  },
);

it.effect(
  "selects native workspace access from only the frozen tools and rejects unavailable grants",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const role = {
          ...f.role,
          revision: f.role.revision + 1,
          tools: [
            "pi.read",
            "pi.write",
            "pi.edit",
            "pi.bash",
            "terminal",
            "pull-requests",
            "external-mcp",
          ],
        };
        yield* restoreHistoricalBinding(role);
        let revision = f.binding.revision + 1;
        for (const toolIds of [[], ["pi.read"], ["pi.write"], ["pi.edit"], ["pi.bash"]]) {
          yield* restoreHistoricalBinding({
            ...f.binding,
            revision: revision++,
            configuration: { ...f.binding.configuration, toolIds },
          });
          const prepared = yield* f.instance.prepareOperation(
            { threadId, kind: "initialize" },
            () => Effect.void,
          );
          const allocations = yield* f.sql<{
            allocation_json: string;
          }>`SELECT allocation_json FROM project_team_pi_process ORDER BY rowid DESC LIMIT 1`;
          const allocation = yield* decodeWorkspaceAccess(allocations[0]!.allocation_json);
          expect(allocation.launch.workspaceAccess).toBe(
            toolIds.some((tool) => tool !== "pi.read") ? "readwrite" : "readonly",
          );
          yield* f.instance.requestStop(threadId);
          yield* rejected(prepared.run);
        }
        const before = (yield* f.sql`SELECT * FROM project_team_pi_process`).length;
        for (const toolIds of [
          ["terminal"],
          ["pull-requests"],
          ["external-mcp"],
          ["pi.search"],
          ["pi.delegate"],
        ]) {
          yield* restoreHistoricalBinding({
            ...f.binding,
            revision: revision++,
            configuration: { ...f.binding.configuration, toolIds },
          });
          yield* rejected(
            f.instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
          );
        }
        yield* restoreHistoricalBinding({
          ...role,
          revision: role.revision + 1,
          tools: ["pi.read"],
        });
        yield* restoreHistoricalBinding({
          ...f.binding,
          revision: revision++,
          configuration: { ...f.binding.configuration, toolIds: ["pi.write"] },
        });
        yield* rejected(
          f.instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
        );
        expect((yield* f.sql`SELECT * FROM project_team_pi_process`).length).toBe(before);
        expect(f.transports).toBe(0);
      }),
    ),
);

const decodeWorkspaceAccess = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      launch: Schema.Struct({ workspaceAccess: Schema.String }),
    }),
  ),
);
const decodeOwnerCgroup = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cgroup: Schema.String })),
);
const decodeLocalClosure = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      sdk: Schema.Literal("0.99.1"),
      files: Schema.Array(
        Schema.Struct({ source: Schema.String, target: Schema.String, sha256: Schema.String }),
      ),
    }),
  ),
);
const parseProcessOutput = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      data: Schema.optional(Schema.String),
    }),
  ),
);
const parseNativeSpawn = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      pid: Schema.optional(Schema.Int),
      remoteCalls: Schema.optional(Schema.Int),
    }),
  ),
);

describe.runIf(process.env.PI_MANAGED_RUNTIME_LINUX_GATE === "1")(
  "managed native local tools",
  () => {
    for (const mode of [
      "read",
      "write",
      "edit",
      "bash",
      "mixed-bridge",
      "readonly-mutation",
      "unselected-mutation",
      "protected-roots",
      "bounded-failure",
      "stale-write-bootstrap",
      "changed-before-invoke",
      "tools-before-invoke",
      "changed-before-return",
      "revoked-before-invoke",
      "expired-before-invoke",
      "stop-before-invoke",
      "cancel-descendants",
    ] as const) {
      it.effect(
        mode,
        () =>
          scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              const manifest = process.env.PI_MANAGED_RUNTIME_LOCAL_TOOL_CLOSURE;
              const evidence = process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE;
              if (!manifest || !evidence)
                return yield* Effect.die(
                  "Actual managed local tool closure and unique evidence directory are required",
                );
              const closure = yield* decodeLocalClosure(yield* f.fs.readFileString(manifest));
              for (const file of closure.files) {
                expect(
                  NodeCrypto.createHash("sha256")
                    .update(yield* f.fs.readFile(file.source))
                    .digest("hex"),
                ).toBe(file.sha256);
              }
              expect(
                closure.files.some((file) => file.target === "/runtime/PiWorkerEntrypoint.mjs"),
              ).toBe(true);
              expect(closure.files.some((file) => file.target === "/bin/bash")).toBe(true);
              const actualAt = DateTime.formatIso(DateTime.nowUnsafe());
              yield* TestClock.setTime(Date.parse(actualAt));
              const expiryAt = Date.parse(actualAt) + 1000;
              const readOnly =
                mode === "read" || mode === "readonly-mutation" || mode === "unselected-mutation";
              const selectedName =
                mode === "mixed-bridge"
                  ? "project_work_read"
                  : mode === "edit"
                    ? "edit"
                    : mode === "write" ||
                        mode === "stale-write-bootstrap" ||
                        mode.includes("before-")
                      ? "write"
                      : mode === "read"
                        ? "read"
                        : "bash";
              const toolIds =
                mode === "mixed-bridge"
                  ? ["pi.read", "project-work.read-project"]
                  : readOnly
                    ? ["pi.read"]
                    : ["pi." + selectedName];
              const role = {
                ...f.role,
                revision: f.role.revision + 1,
                role: mode === "mixed-bridge" ? "coordinator" : f.role.role,
                tools:
                  mode === "mixed-bridge"
                    ? ["pi.read", "project-work.read-project"]
                    : mode === "readonly-mutation"
                      ? ["pi.read"]
                      : [
                          "pi.read",
                          "pi.write",
                          "pi.edit",
                          "pi.bash",
                          "project-work.read-project",
                          "terminal",
                          "pull-requests",
                          "external-mcp",
                        ],
              };
              const binding = {
                ...f.binding,
                revision: f.binding.revision + 1,
                updatedAt: actualAt,
                configuration: { ...f.binding.configuration, toolIds, maxTokens: 100000 },
              };
              yield* restoreHistoricalBinding(role);
              yield* restoreHistoricalBinding(binding);
              yield* f.fs.writeFileString(f.worktree + "/source.txt", "before\n");
              yield* f.fs.writeFileString(
                f.options.agentDirectory + "/auth.json",
                json({ "command-code": { type: "api_key", key: "synthetic-local-key" } }),
              );
              const held = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const descendantReady = Promise.withResolvers<void>();
              const watcher =
                mode === "cancel-descendants"
                  ? process.getBuiltinModule("fs").watch(f.worktree, (_event, filename) => {
                      if (filename === "descendant.ready") descendantReady.resolve();
                    })
                  : undefined;
              yield* Effect.addFinalizer(() => Effect.sync(() => watcher?.close()));
              const real = yield* Authorization.ProjectTeamAuthorization;
              const services = yield* Effect.context<SqlClient.SqlClient | ProjectWorkProjection>();
              let capabilities = 0;
              let joined = false;
              const holdAt = mode === "changed-before-return" ? 3 : 2;
              const authorization = Authorization.ProjectTeamAuthorization.of({
                ...real,
                capability: (...args) =>
                  Effect.gen(function* () {
                    yield* real.capability(...args);
                    if (args[1] !== "pi.write") return;
                    capabilities++;
                    if (mode.includes("before-") && capabilities === holdAt) {
                      yield* Deferred.succeed(held, undefined);
                      yield* Deferred.await(release);
                      joined = true;
                    }
                  }),
              });
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const workerOutputs: string[] = [];
              const nativeReceipts: string[] = [];
              const capturedDescendants = new Set<number>();
              let outputTail = "";
              let nativeTail = "";
              const observeOutput = Effect.fn("managedLocalTools.observeOutput")(function* (
                chunk: Uint8Array,
              ) {
                outputTail += new TextDecoder().decode(chunk);
                if (outputTail.length > 1_048_576)
                  return yield* Effect.die("Native observer exceeded bound");
                const lines = outputTail.split("\n");
                outputTail = lines.pop()!;
                for (const line of lines) {
                  workerOutputs.push(line);
                  const output = parseProcessOutput(line);
                  if (output.type !== "stderr" || !output.data) continue;
                  nativeTail += Buffer.from(output.data, "base64").toString("utf8");
                  const receipts = nativeTail.split("\n");
                  nativeTail = receipts.pop()!;
                  for (const receipt of receipts) {
                    nativeReceipts.push(receipt);
                    const native = parseNativeSpawn(receipt);
                    if (native.type === "native-spawn" || native.type === "descendant-ready") {
                      // The fixture receipt PID is inside the namespace. Capture host identities
                      // from this operation's actual owner cgroup instead of treating it as a host PID.
                      const owners = yield* f.sql<{
                        owner_json: string;
                      }>`SELECT owner_json FROM project_team_pi_process WHERE owner_json IS NOT NULL ORDER BY rowid DESC LIMIT 1`.pipe(
                        Effect.provide(services),
                      );
                      const owner = parseOwner(owners[0]!.owner_json);
                      const cgroup = (yield* decodeOwnerCgroup(owners[0]!.owner_json)).cgroup;
                      for (const raw of (yield* f.fs.readFileString(cgroup + "/cgroup.procs"))
                        .trim()
                        .split("\n")) {
                        const pid = Number(raw);
                        if (pid > 0 && pid !== owner.pid) capturedDescendants.add(pid);
                      }
                    }
                  }
                }
              });
              const observedSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
                ...spawner,
                spawn: (...args) =>
                  spawner.spawn(...args).pipe(
                    Effect.map((child) => ({
                      ...child,
                      stdout:
                        args[0]._tag === "StandardCommand" &&
                        args[0].command === "/usr/bin/systemd-run"
                          ? child.stdout.pipe(
                              Stream.tap((chunk) => observeOutput(chunk).pipe(Effect.orDie)),
                            )
                          : child.stdout,
                    })),
                  ),
              });
              let calls = 0;
              const toolName =
                mode === "readonly-mutation" || mode === "unselected-mutation"
                  ? "write"
                  : selectedName;
              const protectedPaths = [
                f.main + "/sentinel",
                f.main + "/.git/config",
                f.options.agentDirectory + "/auth.json",
                f.options.nativeStateRoot + "/sentinel",
                f.options.protectedRoots[0] + "/sentinel",
                "/workspace/.git",
              ];
              const args =
                toolName === "read"
                  ? { path: "source.txt" }
                  : toolName === "write"
                    ? { path: "result.txt", content: "written\n" }
                    : toolName === "edit"
                      ? { path: "source.txt", edits: [{ oldText: "before", newText: "after" }] }
                      : toolName === "project_work_read"
                        ? {
                            projectId: binding.projectId,
                            operation: "tasks",
                            state: "draft",
                            limit: 1,
                          }
                        : {
                            command:
                              mode === "bounded-failure"
                                ? "printf retained > retained.txt; printf '\\\\%.0s' {1..40000}"
                                : mode === "protected-roots"
                                  ? protectedPaths
                                      .map(
                                        (path) => `if printf altered > '${path}'; then exit 1; fi`,
                                      )
                                      .join("; ") + "; printf protected > result.txt"
                                  : mode === "cancel-descendants"
                                    ? '/runtime/node -e \'const fs = require("node:fs"); fs.watch("/workspace", () => {}); fs.writeFileSync("descendant.ready.tmp", String(process.pid)); fs.renameSync("descendant.ready.tmp", "descendant.ready")\' & wait'
                                    : "printf '%s' \"$PWD\" > result.txt",
                          };
              const runtime = yield* makePiManagedRuntimeLive({
                ...f.options,
                memoryBytes: 536870912,
                maxInputTokens: 18000,
                cleanupDeadlineMs: 5000,
                runtimeFiles: closure.files.map(({ source, target }) => ({ source, target })),
                // This reviewed entry fixture uses the actual production entry and native helper.
                // The legacy SDK fixture and its /runtime/package.json alias stay separate.
                workerArgv: (identity, operation) => [
                  "/runtime/node",
                  "--max-old-space-size=512",
                  "/runtime/p7-worker-entry-local-tools.mjs",
                  "plain",
                  json({
                    identity,
                    operation,
                    sessionDirectory: "/state/sessions",
                    trustedSdkPackageDirectory: "/runtime/pi-sdk",
                  }),
                ],
                readCatalogue: Effect.succeed({
                  source: "https://api.commandcode.ai/provider/v1/models",
                  fetchedAt: actualAt,
                  selectedEntry: {
                    id: model,
                    owned_by: "command-code",
                    context_length: 20000,
                    supported_endpoints: ["/chat/completions"],
                  },
                }),
                transport: async (_url, init) => {
                  calls++;
                  const body = parseTransportBody(init.body);
                  expect(body.tools?.map((tool) => tool.function.name).sort()).toEqual(
                    (mode === "mixed-bridge"
                      ? ["project_work_read", "read"]
                      : [readOnly ? "read" : selectedName]
                    ).sort(),
                  );
                  if (calls === 2) {
                    const result = body.messages.find((message) => message.role === "tool");
                    expect(result).toBeDefined();
                    if (mode === "read") expect(result!.content).toContain("before");
                    if (mode === "mixed-bridge") expect(result!.content).toBe("[]");
                  }
                  expect(calls).toBeLessThanOrEqual(2);
                  const delta =
                    calls === 1
                      ? {
                          role: "assistant",
                          tool_calls: [
                            {
                              index: 0,
                              id: "native_selected",
                              type: "function",
                              function: { name: toolName, arguments: json(args) },
                            },
                          ],
                        }
                      : { role: "assistant", content: "Local tool completed" };
                  return new Response(
                    [
                      { model, choices: [{ index: 0, delta, finish_reason: null }] },
                      {
                        model,
                        choices: [
                          {
                            index: 0,
                            delta: {},
                            finish_reason: calls === 1 ? "tool_calls" : "stop",
                          },
                        ],
                      },
                      {
                        model,
                        choices: [],
                        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
                      },
                    ]
                      .map((entry) => `data: ${json(entry)}\n\n`)
                      .join("") + "data: [DONE]\n\n",
                    { headers: { "content-type": "text/event-stream" } },
                  );
                },
              }).pipe(
                Effect.provideService(Authorization.ProjectTeamAuthorization, authorization),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
              );
              const instance = yield* runtime.forInstance({
                instanceId: providerInstanceId,
                enabled: true,
                configuration: {},
              });
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(release, undefined).pipe(
                  Effect.andThen(instance.stopAll),
                  Effect.orDie,
                ),
              );
              const originalFetch = globalThis.fetch;
              globalThis.fetch = async () => {
                throw Error("Ambient fetch forbidden in actual native local tool proof");
              };
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  globalThis.fetch = originalFetch;
                }),
              );
              const initialize = yield* instance.prepareOperation(
                { threadId, kind: "initialize" },
                () => Effect.void,
              );
              expect((yield* initialize.run).terminal.outcome).toBe("success");
              expect(calls).toBe(0);
              expect(yield* f.fs.exists(f.worktree + "/result.txt")).toBe(false);
              const prompt = yield* instance.prepareOperation(
                { threadId, kind: "prompt", prompt: "Execute exactly the selected synthetic tool" },
                () => Effect.void,
              );
              if (mode === "stale-write-bootstrap")
                yield* restoreHistoricalBinding({
                  ...role,
                  revision: role.revision + 1,
                  tools: ["pi.read"],
                });
              const running = yield* Effect.forkChild(prompt.run.pipe(Effect.result));
              if (mode.includes("before-") || mode === "cancel-descendants") {
                yield* Effect.raceFirst(
                  mode === "cancel-descendants"
                    ? Effect.promise(() => descendantReady.promise)
                    : Deferred.await(held),
                  Fiber.join(running).pipe(
                    Effect.flatMap((result) =>
                      Effect.die("Run completed before causal receipt " + json(result)),
                    ),
                  ),
                );
                if (mode === "cancel-descendants") {
                  const rows = yield* f.sql<{
                    owner_json: string;
                  }>`SELECT owner_json FROM project_team_pi_process WHERE owner_json IS NOT NULL ORDER BY rowid DESC LIMIT 1`;
                  const cgroup = (yield* decodeOwnerCgroup(rows[0]!.owner_json)).cgroup;
                  const namespacePid = (yield* f.fs.readFileString(
                    f.worktree + "/descendant.ready",
                  )).trim();
                  let capturedReady = false;
                  for (const raw of (yield* f.fs.readFileString(cgroup + "/cgroup.procs"))
                    .trim()
                    .split("\n")) {
                    const pid = Number(raw);
                    if (pid <= 0) continue;
                    capturedDescendants.add(pid);
                    const status = yield* f.fs.readFileString("/proc/" + pid + "/status");
                    const namespaceIds = /^NSpid:\s+([0-9\t ]+)$/m
                      .exec(status)?.[1]
                      ?.trim()
                      .split(/\s+/);
                    if (namespaceIds?.at(-1) === namespacePid) capturedReady = true;
                  }
                  expect(capturedReady).toBe(true);
                }
                if (mode === "changed-before-invoke" || mode === "changed-before-return")
                  yield* restoreHistoricalBinding({
                    ...role,
                    revision: role.revision + 1,
                    tools: ["pi.read"],
                  });
                if (mode === "tools-before-invoke") {
                  const operations = yield* makeProjectTeamPiOperations({
                    environmentId: "environment",
                  });
                  const current = yield* operations.current({ providerInstanceId, threadId });
                  yield* restoreHistoricalBinding({
                    ...current.binding,
                    revision: current.binding.revision + 1,
                    configuration: { ...current.binding.configuration, toolIds: ["pi.read"] },
                  });
                }
                if (mode === "revoked-before-invoke") {
                  const operations = yield* makeProjectTeamPiOperations({
                    environmentId: "environment",
                  });
                  const current = yield* operations.current({ providerInstanceId, threadId });
                  yield* restoreHistoricalBinding({
                    ...current.binding,
                    revision: current.binding.revision + 1,
                    status: "revoked",
                  });
                }
                if (mode === "expired-before-invoke") {
                  const current = yield* real.resolve(f.principal);
                  if (!current)
                    return yield* Effect.die("Current native fixture authority is required");
                  const attempt = current.state.attempts.find(
                    (entry) => entry.attemptId === current.binding.attemptId,
                  )!;
                  yield* f.repo.execute({
                    type: "project-work.attempt.renew",
                    projectId: current.binding.projectId,
                    taskId: current.binding.taskId,
                    attemptId: attempt.attemptId,
                    commandId: CommandId.make("expire-held-local-authority"),
                    leaseToken: attempt.leaseToken!,
                    leasedUntil: DateTime.formatIso(DateTime.makeUnsafe(expiryAt)),
                    renewedAt: actualAt,
                  });
                  yield* TestClock.setTime(expiryAt);
                }
                if (mode === "stop-before-invoke" || mode === "cancel-descendants") {
                  const aborted = Promise.withResolvers<void>();
                  const originalAbort = AbortController.prototype.abort;
                  AbortController.prototype.abort = function (...args) {
                    originalAbort.apply(this, args);
                    aborted.resolve();
                  };
                  try {
                    const stopping = yield* Effect.forkChild(instance.requestStop(threadId));
                    yield* Effect.promise(() => aborted.promise);
                    yield* Deferred.succeed(release, undefined);
                    yield* Fiber.join(stopping);
                  } finally {
                    AbortController.prototype.abort = originalAbort;
                  }
                } else yield* Deferred.succeed(release, undefined);
              }
              const outcome = yield* Fiber.join(running);
              yield* instance.stopAll;
              yield* f.fs.writeFileString(
                evidence + "/local-tools-" + mode + "-preassert.json",
                json({
                  mode,
                  calls,
                  capabilities,
                  outcome,
                  modelRows: yield* f.sql`SELECT * FROM project_team_model_request`,
                  nativeReceipts,
                  workerOutputs,
                  operations: yield* f.sql`SELECT * FROM project_team_pi_operation`,
                  processes: yield* f.sql`SELECT * FROM project_team_pi_process`,
                }),
              );
              const succeeds = [
                "read",
                "write",
                "edit",
                "bash",
                "mixed-bridge",
                "protected-roots",
              ].includes(mode);
              expect(outcome._tag).toBe(succeeds ? "Success" : "Failure");
              expect(calls).toBe(succeeds ? 2 : mode === "stale-write-bootstrap" ? 0 : 1);
              if (mode.includes("before-")) expect(joined).toBe(true);
              if (mode === "write" || mode === "changed-before-return")
                expect(yield* f.fs.readFileString(f.worktree + "/result.txt")).toBe("written\n");
              else if (mode === "bash")
                expect(yield* f.fs.readFileString(f.worktree + "/result.txt")).toBe("/workspace");
              else if (mode === "protected-roots")
                expect(yield* f.fs.readFileString(f.worktree + "/result.txt")).toBe("protected");
              else expect(yield* f.fs.exists(f.worktree + "/result.txt")).toBe(false);
              if (mode === "protected-roots") {
                expect(yield* f.fs.exists(f.main + "/sentinel")).toBe(false);
                expect(
                  yield* f.fs.readFileString(f.options.agentDirectory + "/auth.json"),
                ).toContain("synthetic-local-key");
              }
              if (mode === "edit")
                expect(yield* f.fs.readFileString(f.worktree + "/source.txt")).toBe("after\n");
              if (mode === "bounded-failure") {
                expect(yield* f.fs.readFileString(f.worktree + "/retained.txt")).toBe("retained");
                yield* rejected(prompt.run);
                expect(calls).toBe(1);
              }
              const modelRows = yield* f.sql<{
                operation_id: string;
                status: string;
                reservation_id: string;
                accounting_receipt_id: string;
                charged_input_tokens: number;
                charged_output_tokens: number;
              }>`SELECT * FROM project_team_model_request`;
              expect(modelRows).toHaveLength(calls);
              if (mode !== "stale-write-bootstrap") {
                const operationRows = yield* f.sql<{
                  terminal_json: string;
                }>`SELECT terminal_json FROM project_team_pi_operation WHERE operation_kind='prompt'`;
                const terminal = yield* decodeLocalTerminal(operationRows[0]!.terminal_json);
                expect(terminal.outcome).toBe(
                  succeeds
                    ? "success"
                    : mode === "stop-before-invoke" || mode === "cancel-descendants"
                      ? "canceled"
                      : "failed",
                );
                expect(terminal.accountingReceipts).toHaveLength(
                  mode === "readonly-mutation" || mode === "unselected-mutation" ? 0 : calls,
                );
                for (const row of modelRows) {
                  expect(row.operation_id).toBe(terminal.operation.operationId);
                  const unknown = mode === "readonly-mutation" || mode === "unselected-mutation";
                  expect(row.status).toBe(unknown ? "unknown" : "reported");
                  expect(row.charged_input_tokens).toBe(unknown ? 18000 : 20);
                  expect(row.charged_output_tokens).toBe(unknown ? 512 : 5);
                  if (mode !== "readonly-mutation" && mode !== "unselected-mutation")
                    expect(terminal.accountingReceipts).toContainEqual({
                      reservationId: row.reservation_id,
                      accountingReceiptId: row.accounting_receipt_id,
                    });
                }
              }
              const owners = yield* f.sql<{
                owner_json: string | null;
                drain_json: string | null;
              }>`SELECT owner_json,drain_json FROM project_team_pi_process`;
              expect(owners).toHaveLength(2);
              for (const row of owners) {
                if (row.owner_json === null) {
                  expect(mode).toBe("stale-write-bootstrap");
                  continue;
                }
                const owner = parseOwner(row.owner_json);
                const drain = yield* decodeBoundaryDrain(row.drain_json!);
                expect(drain.unit).toBe(owner.unit);
                expect(drain.invocation).toBe(owner.invocation);
                expect(drain.ownerPid).toBe(owner.pid);
                expect(yield* f.fs.exists(drain.cgroup)).toBe(false);
                for (const pid of [
                  owner.pid,
                  drain.launcherPid,
                  drain.childPid,
                  ...capturedDescendants,
                ])
                  if (pid !== null) expect(yield* f.fs.exists("/proc/" + pid)).toBe(false);
              }
              const results = nativeReceipts
                .map((receipt) => parseNativeSpawn(receipt))
                .filter((receipt) => receipt.type === "result");
              expect(results.length).toBeGreaterThanOrEqual(1);
              expect(results.every((receipt) => receipt.remoteCalls === 0)).toBe(true);
              if (mode === "cancel-descendants")
                expect(capturedDescendants.size).toBeGreaterThan(0);
              yield* f.fs.writeFileString(
                evidence + "/local-tools-" + mode + ".json",
                json({
                  mode,
                  toolIds,
                  calls,
                  capabilities,
                  joined,
                  outcome,
                  owners,
                  capturedHostDescendants: [...capturedDescendants],
                  nativeNamespaceReceipts: nativeReceipts,
                  operations: yield* f.sql`SELECT * FROM project_team_pi_operation`,
                  modelRows: yield* f.sql`SELECT * FROM project_team_model_request`,
                  workerOutputs,
                }),
              );
            }),
          ),
        30000,
      );
    }
  },
);

const skillAuthorityLayer = ManagedSkills.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "pi-current-skill-authority-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const catalogueRequest = (cwd: string) => ({
  runtime: {
    providerInstanceId,
    threadId,
    cwd,
    sessionId: `thread-${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`,
  },
  desiredRevision: SkillCatalogRevision.make(1),
  skills: [],
});

it.effect("authorizes only selected current owned skill keys from the complete catalogue", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const repository = yield* ManagedSkills.ManagedSkillRepository;
      const global = yield* repository.createGlobal({
        expectedRevision: 0,
        content: { key: ManagedSkillKey.make("review"), name: "Review", body: "Global review." },
      });
      const unrelated = yield* repository.createGlobal({
        expectedRevision: 0,
        content: { key: ManagedSkillKey.make("deploy"), name: "Deploy", body: "Unselected." },
      });
      const selected = yield* repository.setProjectOverride({
        projectRoot: f.main,
        key: global.manifest.key,
        content: { name: "Project review", body: "Only the primary project override." },
      });
      yield* restoreHistoricalBinding({
        ...f.role,
        revision: f.role.revision + 1,
        skills: [selected.manifest.id],
      });
      yield* restoreHistoricalBinding({
        ...f.binding,
        revision: f.binding.revision + 1,
        configuration: { ...f.binding.configuration, skillIds: [selected.manifest.id] },
      });
      const request = {
        ...catalogueRequest(f.worktree),
        skills: [
          { key: selected.manifest.key, packagePath: selected.packagePath },
          { key: unrelated.manifest.key, packagePath: unrelated.packagePath },
        ],
      };
      const before = yield* hashSkillPackage(selected.packagePath);
      expect(yield* f.instance.authorizeSkills(request)).toEqual([selected.manifest.key]);
      for (const skills of [
        [],
        [{ key: selected.manifest.key, packagePath: global.packagePath }],
        [...request.skills, request.skills[0]!],
      ])
        yield* rejected(f.instance.authorizeSkills({ ...request, skills }));
      expect(yield* hashSkillPackage(selected.packagePath)).toBe(before);
      expect(f.launches).toBe(0);
      expect(f.transports).toBe(0);
      expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toHaveLength(0);
    }),
  ).pipe(Effect.provide(skillAuthorityLayer)),
);

it.effect(
  "authorizes empty frozen selection without repository access or role skill activation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* restoreHistoricalBinding({
          ...f.role,
          revision: f.role.revision + 1,
          skills: ["uninstalled-role-skill"],
        });
        const keys = yield* f.instance.authorizeSkills(catalogueRequest(f.worktree));
        expect(keys).toEqual([]);
        expect(Object.isFrozen(keys)).toBe(true);
        for (const runtime of [
          { ...catalogueRequest(f.worktree).runtime, cwd: f.main },
          { ...catalogueRequest(f.worktree).runtime, sessionId: "forged-session" },
        ])
          yield* rejected(f.instance.authorizeSkills({ ...catalogueRequest(f.worktree), runtime }));
        expect(f.launches).toBe(0);
        expect(f.transports).toBe(0);
      }),
    ),
);

it.effect("rechecks durable skill authority after an owned repository read receipt", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const repository = yield* ManagedSkills.ManagedSkillRepository;
      const selected = yield* repository.createGlobal({
        expectedRevision: 0,
        content: { key: ManagedSkillKey.make("review"), name: "Review", body: "Review." },
      });
      yield* restoreHistoricalBinding({
        ...f.role,
        revision: f.role.revision + 1,
        skills: [selected.manifest.id],
      });
      const binding = {
        ...f.binding,
        revision: f.binding.revision + 1,
        configuration: { ...f.binding.configuration, skillIds: [selected.manifest.id] },
      };
      yield* restoreHistoricalBinding(binding);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const runtime = yield* makePiManagedRuntimeLive(f.options).pipe(
        Effect.provideService(ManagedSkills.ManagedSkillRepository, {
          ...repository,
          readGlobal: (id) =>
            repository.readGlobal(id).pipe(
              Effect.tap(() => Deferred.succeed(entered, undefined)),
              Effect.tap(() => Deferred.await(release)),
            ),
        }),
      );
      const instance = yield* runtime.forInstance({
        instanceId: providerInstanceId,
        enabled: true,
        configuration: {},
      });
      const pending = yield* instance
        .authorizeSkills({
          ...catalogueRequest(f.worktree),
          skills: [{ key: selected.manifest.key, packagePath: selected.packagePath }],
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.raceFirst(
        Deferred.await(entered),
        Fiber.join(pending).pipe(
          Effect.flatMap(() => Effect.die("Authorization finished before its owned read receipt.")),
        ),
      );
      yield* restoreHistoricalBinding({
        ...binding,
        revision: binding.revision + 1,
        status: "stopping",
      });
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      expect(f.launches).toBe(0);
      expect(f.transports).toBe(0);
    }),
  ).pipe(Effect.provide(skillAuthorityLayer)),
);

it.effect("denies expiry during the synchronous final skill admission fence", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const clock = yield* Clock.Clock;
      let expired = false;
      const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" }).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeMillisUnsafe: () =>
            expired ? Date.parse("2030-01-01T00:00:00.000Z") : clock.currentTimeMillisUnsafe(),
        }),
      );
      yield* rejected(
        operations.admitCurrent({ providerInstanceId, threadId }, () => {
          expired = true;
          return Object.freeze(["selected"]);
        }),
      );
      expect(expired).toBe(true);
      expect(f.launches).toBe(0);
      expect(f.transports).toBe(0);
      expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toHaveLength(0);
    }),
  ),
);

for (const mode of ["unchanged", "expired", "queued-stop"] as const)
  it.effect(`linearizes final skill admission at an actual SQL receipt: ${mode}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const repository = yield* ManagedSkills.ManagedSkillRepository;
        const selected = yield* repository.createGlobal({
          expectedRevision: 0,
          content: { key: ManagedSkillKey.make("review"), name: "Review", body: "Review." },
        });
        yield* restoreHistoricalBinding({
          ...f.role,
          revision: f.role.revision + 1,
          skills: [selected.manifest.id],
        });
        const binding = {
          ...f.binding,
          revision: f.binding.revision + 1,
          configuration: { ...f.binding.configuration, skillIds: [selected.manifest.id] },
        };
        yield* restoreHistoricalBinding(binding);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let receipts = 0;
        const observedSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (
              !statement
                .compile()[0]
                .includes("SELECT project_id FROM projection_projects WHERE project_id")
            )
              return statement;
            return statement.pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  receipts++;
                  if (receipts !== 3) return;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }),
              ),
            );
          },
        });
        const authorization = yield* Authorization.ProjectTeamAuthorization.pipe(
          Effect.provide(Layer.fresh(Authorization.layer)),
          Effect.provideService(SqlClient.SqlClient, observedSql),
        );
        const runtime = yield* makePiManagedRuntimeLive(f.options).pipe(
          Effect.provideService(Authorization.ProjectTeamAuthorization, authorization),
        );
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const pending = yield* instance
          .authorizeSkills({
            ...catalogueRequest(f.worktree),
            skills: [{ key: selected.manifest.key, packagePath: selected.packagePath }],
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.raceFirst(
          Deferred.await(entered),
          Fiber.join(pending).pipe(
            Effect.flatMap(() => Effect.die("Admission finished without its final SQL receipt")),
          ),
        );
        if (mode === "expired") yield* TestClock.setTime(Date.parse("2030-01-01T00:00:00.000Z"));
        const stopStarted = yield* Deferred.make<void>();
        let committed = false;
        const stop =
          mode === "queued-stop"
            ? yield* Effect.gen(function* () {
                yield* Deferred.succeed(stopStarted, undefined);
                yield* restoreHistoricalBinding({
                  ...binding,
                  revision: binding.revision + 1,
                  status: "stopping",
                });
                committed = true;
              }).pipe(Effect.forkChild)
            : undefined;
        if (stop) {
          yield* Deferred.await(stopStarted);
          expect(committed).toBe(false);
        }
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(pending);
        expect(result._tag).toBe(mode === "expired" ? "Failure" : "Success");
        if (stop) {
          yield* Fiber.join(stop);
          expect(committed).toBe(true);
          yield* rejected(
            instance.authorizeSkills({
              ...catalogueRequest(f.worktree),
              skills: [{ key: selected.manifest.key, packagePath: selected.packagePath }],
            }),
          );
        }
        expect(f.launches).toBe(0);
        expect(f.transports).toBe(0);
        expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toHaveLength(0);
      }),
    ).pipe(Effect.provide(skillAuthorityLayer)),
  );

const selectedRuntimeLayer = Materialization.layer.pipe(Layer.provideMerge(skillAuthorityLayer));
const selectedRuntimeFixture = Effect.fn("PiManagedRuntimeLive.selectedRuntimeFixture")(
  function* () {
    const f = yield* fixture;
    const repository = yield* ManagedSkills.ManagedSkillRepository;
    const materialization = yield* Materialization.SkillMaterializationService;
    const skill = yield* repository.createGlobal({
      expectedRevision: 0,
      content: {
        key: ManagedSkillKey.make("selected-runtime"),
        name: "Selected Runtime",
        body: "Inert selected package.",
      },
    });
    yield* restoreHistoricalBinding({
      ...f.role,
      revision: f.role.revision + 1,
      skills: [skill.manifest.id],
    });
    yield* restoreHistoricalBinding({
      ...f.binding,
      revision: f.binding.revision + 1,
      configuration: { ...f.binding.configuration, skillIds: [skill.manifest.id] },
    });
    const cache = yield* f.fs.makeTempDirectoryScoped();
    yield* f.fs.chmod(cache, 0o700);
    const runtime = yield* makePiManagedRuntimeLive({
      ...f.options,
      allocateSkillStage: makePiSkillStageLifetime(cache),
    });
    const instance = yield* runtime.forInstance({
      instanceId: providerInstanceId,
      enabled: true,
      configuration: {},
    });
    const desiredRevision = SkillCatalogRevision.make(1);
    const materialized = yield* materialization.materialize({
      sessionId: catalogueRequest(f.worktree).runtime.sessionId,
      providerInstanceId,
      desiredRevision,
      packages: [{ key: skill.manifest.key, sourcePath: skill.packagePath }],
    });
    const plan = {
      providerInstanceId,
      desiredRevision,
      applicationMode: "new_session_required" as const,
      skillKeys: [skill.manifest.key],
      payload: {
        kind: "pi-managed-skills" as const,
        root: materialized.root,
        skills: [
          {
            key: skill.manifest.key,
            path: materialized.skillPaths.get(skill.manifest.key)! + "/SKILL.md",
          },
        ],
      },
    };
    return {
      ...f,
      instance,
      plan,
      skill,
      cache,
      get launches() {
        return f.launches;
      },
      get transports() {
        return f.transports;
      },
    };
  },
);
it.effect(
  "stages selected owned content and removes it only after durable never-started drain",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* selectedRuntimeFixture();
        const prepared = yield* f.instance.prepareOperation(
          { threadId, kind: "initialize", skillPlan: f.plan },
          () => Effect.void,
        );
        const stages = yield* f.fs.readDirectory(f.cache);
        expect(stages).toHaveLength(1);
        expect(
          yield* f.fs.readFileString(f.cache + "/" + stages[0] + "/selected-runtime/SKILL.md"),
        ).toContain("Inert selected package.");
        expect(
          (yield* f.sql<{
            intent_json: string;
          }>`SELECT intent_json FROM project_team_pi_operation`)[0]?.intent_json,
        ).toContain("resourceHash");
        yield* f.instance.requestStop(threadId);
        expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
        expect(
          (yield* f.sql<{
            status: string;
          }>`SELECT status FROM project_team_pi_operation WHERE operation_id=${prepared.operation.operationId}`)[0]
            ?.status,
        ).toBe("settled");
        expect(f.transports).toBe(0);
      }),
    ).pipe(Effect.provide(selectedRuntimeLayer)),
);
it.effect(
  "rejects missing selected plan before allocating a skill stage or durable operation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* selectedRuntimeFixture();
        yield* rejected(
          f.instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
        );
        expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
        expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toHaveLength(0);
        expect(f.transports).toBe(0);
      }),
    ).pipe(Effect.provide(selectedRuntimeLayer)),
);
it.effect("captures the selected plan synchronously before caller mutation", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* selectedRuntimeFixture();
      const request = { threadId, kind: "initialize" as const, skillPlan: f.plan };
      const preparation = f.instance.prepareOperation(request, () => Effect.void);
      Object.assign(request.skillPlan, { desiredRevision: -1 });
      const prepared = yield* preparation;
      expect(prepared.kind).toBe("initialize");
      yield* f.instance.stopAll;
      expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
      expect(f.transports).toBe(0);
    }),
  ).pipe(Effect.provide(selectedRuntimeLayer)),
);
it.effect("rejects changed selected source content before stage allocation", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* selectedRuntimeFixture();
      yield* f.fs.writeFileString(
        f.skill.packagePath + "/SKILL.md",
        "Changed after actual materialization",
      );
      yield* rejected(
        f.instance.prepareOperation(
          { threadId, kind: "initialize", skillPlan: f.plan },
          () => Effect.void,
        ),
      );
      expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
      expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toHaveLength(0);
      expect(f.transports).toBe(0);
    }),
  ).pipe(Effect.provide(selectedRuntimeLayer)),
);

const settledNativeForRead = Effect.fn("PiManagedRuntimeLive.settledNativeForRead")(function* (
  f: Effect.Success<typeof fixture>,
  resourceHash?: string,
) {
  const allocation = yield* preallocatePiManagedProcess({
    workspaceRoot: f.worktree,
    workspaceAccess: "readonly",
    nativeStateRoot: f.options.nativeStateRoot,
    protectedRoots: f.options.protectedRoots,
    runtimeFiles: f.options.runtimeFiles,
    argv: ["/bin/true"],
    memoryBytes: 33554432,
    runtimeSeconds: 10,
  });
  const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
  const operation = yield* operations.prepare(
    { providerInstanceId, threadId },
    { threadId, kind: "initialize" },
    "read fixture",
    {
      allocation,
      workerId: "native-read-fixture",
      operationId: "native-read-fixture",
      ...(resourceHash === undefined ? {} : { resourceHash }),
    },
  );
  const native = {
    sessionId: "native-read-fixture",
    sessionReference: "sessions/native-read-fixture.jsonl",
    leafId: null,
    persisted: false,
  };
  yield* operations.persistNative(operation, native);
  // Synthetic settled SQL verifies read admission; no OS owner or runtime is launched.
  yield* f.sql`UPDATE project_team_pi_operation SET status='settled' WHERE operation_id=${operation.operation.operationId}`;
  return native;
});
it.effect(
  "admits the exact committed native view and rejects a changed durable resource hash without launch",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = yield* settledNativeForRead(f);
        expect((yield* f.instance.readSession(threadId)).resumeCursor).toEqual(native);
        yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json, '$.resourceHash', ${"a".repeat(64)})`;
        yield* rejected(f.instance.readSession(threadId));
        expect(f.launches).toBe(0);
        expect(f.transports).toBe(0);
      }),
    ),
);
it.effect(
  "validates owned selected plans for native views without staging and rejects changed selected content",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* selectedRuntimeFixture();
        const resourceHash = piManagedSkillResourceIdentity([
          {
            skillId: f.skill.manifest.id,
            key: f.skill.manifest.key,
            packagePath: f.skill.packagePath,
            expectedHash: yield* hashSkillPackage(f.skill.packagePath),
          },
        ]);
        const native = yield* settledNativeForRead(f, resourceHash);
        expect((yield* f.instance.readSession(threadId, f.plan)).resumeCursor).toEqual(native);
        expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
        const badPlan = structuredClone(f.plan);
        Object.assign(badPlan, { desiredRevision: -1 });
        yield* rejected(f.instance.readSession(threadId, badPlan));
        yield* f.fs.writeFileString(f.skill.packagePath + "/SKILL.md", "Changed selected source");
        yield* rejected(f.instance.readSession(threadId, f.plan));
        yield* rejected(f.instance.readThread(threadId));
        expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
        expect(f.launches).toBe(0);
        expect(f.transports).toBe(0);
      }),
    ).pipe(Effect.provide(selectedRuntimeLayer)),
);

it.effect("does not activate role-allowed skills when the frozen selection is empty", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* restoreHistoricalBinding({
        ...f.role,
        revision: f.role.revision + 1,
        skills: ["role-only-uninstalled"],
      });
      const runtime = yield* makePiManagedRuntimeLive({
        ...f.options,
        allocateSkillStage: Effect.die("Empty selection must not allocate a skill stage"),
      });
      const instance = yield* runtime.forInstance({
        instanceId: providerInstanceId,
        enabled: true,
        configuration: {},
      });
      const prepared = yield* instance.prepareOperation(
        { threadId, kind: "initialize" },
        () => Effect.void,
      );
      expect(prepared.kind).toBe("initialize");
      yield* instance.stopAll;
      expect(f.transports).toBe(0);
    }),
  ),
);

it.effect("reexecuting a prepared Effect cannot close or replace its selected resource scope", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* selectedRuntimeFixture();
      const preparation = f.instance.prepareOperation(
        { threadId, kind: "initialize", skillPlan: f.plan },
        () => Effect.void,
      );
      const first = yield* preparation;
      const stages = yield* f.fs.readDirectory(f.cache);
      expect(stages).toHaveLength(1);
      yield* rejected(preparation);
      expect(yield* f.fs.readDirectory(f.cache)).toEqual(stages);
      expect(
        yield* f.fs.readFileString(f.cache + "/" + stages[0] + "/selected-runtime/SKILL.md"),
      ).toContain("Inert selected package.");
      expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toHaveLength(1);
      expect(first.kind).toBe("initialize");
      yield* f.instance.stopAll;
      expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
      expect(f.transports).toBe(0);
    }),
  ).pipe(Effect.provide(selectedRuntimeLayer)),
);

it.effect(
  "a concurrent duplicate is denied before resource allocation while the first owned read is held",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* selectedRuntimeFixture();
        const repository = yield* ManagedSkills.ManagedSkillRepository;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let hold = true;
        const observedRepository = ManagedSkills.ManagedSkillRepository.of({
          ...repository,
          readGlobal: (...args) =>
            repository.readGlobal(...args).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (!hold) return;
                  hold = false;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }),
              ),
            ),
        });
        const runtime = yield* makePiManagedRuntimeLive({
          ...f.options,
          allocateSkillStage: makePiSkillStageLifetime(f.cache),
        }).pipe(Effect.provideService(ManagedSkills.ManagedSkillRepository, observedRepository));
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const first = yield* instance
          .prepareOperation({ threadId, kind: "initialize", skillPlan: f.plan }, () => Effect.void)
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* rejected(
          instance.prepareOperation(
            { threadId, kind: "initialize", skillPlan: f.plan },
            () => Effect.void,
          ),
        );
        expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
        expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toHaveLength(0);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(first)).kind).toBe("initialize");
        expect(yield* f.fs.readDirectory(f.cache)).toHaveLength(1);
        yield* instance.stopAll;
        expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
        expect(f.transports).toBe(0);
      }),
    ).pipe(Effect.provide(selectedRuntimeLayer)),
);

for (const mode of ["stop-one", "stop-all"] as const) {
  it.effect("stop held preparation " + mode, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* selectedRuntimeFixture();
        const repository = yield* ManagedSkills.ManagedSkillRepository;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const stopEntered = yield* Deferred.make<void>();
        let hold = true;
        const observedRepository = ManagedSkills.ManagedSkillRepository.of({
          ...repository,
          readGlobal: (...args) =>
            repository.readGlobal(...args).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (!hold) return;
                  hold = false;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }),
              ),
            ),
        });
        const runtime = yield* makePiManagedRuntimeLive({
          ...f.options,
          allocateSkillStage: makePiSkillStageLifetime(f.cache),
        }).pipe(Effect.provideService(ManagedSkills.ManagedSkillRepository, observedRepository));
        const actual = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const first = yield* actual
          .prepareOperation({ threadId, kind: "initialize", skillPlan: f.plan }, () => Effect.void)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        const stopper = yield* Effect.gen(function* () {
          yield* Deferred.succeed(stopEntered, undefined);
          return yield* mode === "stop-one" ? actual.requestStop(threadId) : actual.stopAll;
        }).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(stopEntered);
        expect((yield* Fiber.join(stopper))._tag).toBe("Success");
        const result = yield* Fiber.join(first);
        yield* Deferred.succeed(release, undefined);
        const operations = yield* f.sql`SELECT operation_id,status FROM project_team_pi_operation`;
        expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
        yield* actual.stopAll;
        expect(result._tag).toBe("Failure");
        expect(operations).toEqual([]);
      }),
    ).pipe(Effect.provide(selectedRuntimeLayer)),
  );
}
it.effect("same returned preparation Effect cannot replay after its cancellation", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* selectedRuntimeFixture();
      const pending = f.instance.prepareOperation(
        { threadId, kind: "initialize", skillPlan: f.plan },
        () => Effect.void,
      );
      const first = yield* pending;
      yield* f.instance.requestStop(threadId);
      const replay = yield* Effect.result(pending);
      const operations =
        yield* f.sql`SELECT operation_id,status FROM project_team_pi_operation ORDER BY operation_ordinal`;
      yield* f.instance.stopAll;
      expect(replay._tag).toBe("Failure");
      expect(operations).toHaveLength(1);
      const next = yield* f.instance.prepareOperation(
        { threadId, kind: "initialize", skillPlan: f.plan },
        () => Effect.void,
      );
      expect(next.operation.operationId).not.toBe(first.operation.operationId);
      yield* f.instance.stopAll;
    }),
  ).pipe(Effect.provide(selectedRuntimeLayer)),
);
for (const mode of ["explicit-stop", "scope-close"] as const) {
  it.effect("selected prepared resource cleanup " + mode, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* selectedRuntimeFixture();
        let operationId = "";
        let before: string[] = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makePiManagedRuntimeLive({
              ...f.options,
              allocateSkillStage: makePiSkillStageLifetime(f.cache),
            });
            const actual = yield* runtime.forInstance({
              instanceId: providerInstanceId,
              enabled: true,
              configuration: {},
            });
            const prepared = yield* actual.prepareOperation(
              { threadId, kind: "initialize", skillPlan: f.plan },
              () => Effect.void,
            );
            operationId = prepared.operation.operationId;
            before = yield* f.fs.readDirectory(f.cache);
            if (mode === "explicit-stop") yield* actual.stopAll;
          }),
        );
        const stages = yield* f.fs.readDirectory(f.cache);
        const operations =
          yield* f.sql`SELECT operation_id,status,terminal_json FROM project_team_pi_operation`;
        const processes =
          yield* f.sql`SELECT unit,status,owner_json,drain_json FROM project_team_pi_process`;
        expect(before).toHaveLength(1);
        expect(operations[0]?.operation_id).toBe(operationId);
        expect(operations[0]?.status).toBe("settled");
        expect(processes[0]?.status).toBe("drained");
        expect(stages).toEqual([]);
      }),
    ).pipe(Effect.provide(selectedRuntimeLayer)),
  );
}
for (const view of ["session", "session-plan", "thread"] as const) {
  for (const mode of ["unchanged", "before-hash", "after-hash"] as const) {
    it.effect("valid selected repository update at native final fence " + view + " " + mode, () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* selectedRuntimeFixture();
          const repository = yield* ManagedSkills.ManagedSkillRepository;
          const originalPackageHash = yield* hashSkillPackage(f.skill.packagePath);
          const resourceHash = piManagedSkillResourceIdentity([
            {
              skillId: f.skill.manifest.id,
              key: f.skill.manifest.key,
              packagePath: f.skill.packagePath,
              expectedHash: originalPackageHash,
            },
          ]);
          const originalNative = yield* settledNativeForRead(f, resourceHash);
          if (view === "thread") {
            const native = { ...originalNative, persisted: true, leafId: "retained-leaf" };
            const root =
              f.options.nativeStateRoot +
              "/" +
              NodeCrypto.createHash("sha256")
                .update(
                  json([
                    "environment",
                    providerInstanceId,
                    threadId,
                    f.binding.recordId,
                    f.binding.generation,
                  ]),
                )
                .digest("hex") +
              "/sessions";
            yield* f.fs.makeDirectory(root, { recursive: true, mode: 0o700 });
            yield* f.fs.writeFileString(
              root + "/native-read-fixture.jsonl",
              json({
                type: "session",
                version: 3,
                id: native.sessionId,
                timestamp: at,
                cwd: "/workspace",
              }) +
                "\n" +
                json({
                  type: "custom",
                  id: "retained-leaf",
                  parentId: null,
                  timestamp: at,
                  customType: "harmless-review-fixture",
                  data: { text: "Retained native payload" },
                }) +
                "\n",
            );
            yield* f.sql`UPDATE project_team_pi_operation SET native_json=${json(native)}`;
          }
          let assignedChecks = 0;
          let changed = false;
          const filesystem = FileSystem.FileSystem.of({
            ...f.fs,
            realPath: (path) =>
              f.fs.realPath(path).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (path !== f.worktree) return;
                    assignedChecks++;
                    const late = view === "session-plan" ? 11 : 3;
                    const threshold = mode === "before-hash" ? 1 : late;
                    if (mode !== "unchanged" && !changed && assignedChecks === threshold) {
                      changed = true;
                      yield* repository
                        .updateGlobal({
                          skillId: f.skill.manifest.id,
                          expectedHash: originalPackageHash,
                          content: {
                            name: "Selected Runtime",
                            body: "Valid repository update completed during final workspace revalidation.",
                          },
                        })
                        .pipe(Effect.orDie);
                    }
                  }),
                ),
              ),
          });
          const runtime = yield* makePiManagedRuntimeLive({
            ...f.options,
            allocateSkillStage: makePiSkillStageLifetime(f.cache),
          }).pipe(Effect.provideService(FileSystem.FileSystem, filesystem));
          const actual = yield* runtime.forInstance({
            instanceId: providerInstanceId,
            enabled: true,
            configuration: {},
          });
          const result =
            view === "thread"
              ? yield* Effect.result(actual.readThread(threadId))
              : yield* Effect.result(
                  actual.readSession(threadId, view === "session-plan" ? f.plan : undefined),
                );
          const current = yield* repository.readGlobal(f.skill.manifest.id);
          expect(current.manifest.revision.hash !== originalPackageHash).toBe(changed);
          expect(changed).toBe(mode !== "unchanged");
          expect(result._tag).toBe(mode === "unchanged" ? "Success" : "Failure");
        }),
      ).pipe(Effect.provide(selectedRuntimeLayer)),
    );
  }
}
for (const mode of ["unchanged", "update", "tombstone"] as const) {
  it.effect(`selected sources remain current through the final SQL receipt: ${mode}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* selectedRuntimeFixture();
        const repository = yield* ManagedSkills.ManagedSkillRepository;
        const hash = yield* hashSkillPackage(f.skill.packagePath);
        yield* settledNativeForRead(
          f,
          piManagedSkillResourceIdentity([
            {
              skillId: f.skill.manifest.id,
              key: f.skill.manifest.key,
              packagePath: f.skill.packagePath,
              expectedHash: hash,
            },
          ]),
        );
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let receipts = 0;
        const observedSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (
              !statement
                .compile()[0]
                .includes("SELECT project_id FROM projection_projects WHERE project_id")
            )
              return statement;
            return statement.pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (++receipts !== 3) return;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }),
              ),
            );
          },
        });
        const authorization = yield* Authorization.ProjectTeamAuthorization.pipe(
          Effect.provide(Layer.fresh(Authorization.layer)),
          Effect.provideService(SqlClient.SqlClient, observedSql),
        );
        const runtime = yield* makePiManagedRuntimeLive(f.options).pipe(
          Effect.provideService(Authorization.ProjectTeamAuthorization, authorization),
        );
        const actual = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const pending = yield* actual.readSession(threadId).pipe(Effect.result, Effect.forkChild);
        yield* Effect.raceFirst(
          Deferred.await(entered),
          Fiber.join(pending).pipe(
            Effect.flatMap(() =>
              Effect.die("Native admission finished before its final SQL receipt"),
            ),
          ),
        );
        if (mode === "update")
          yield* repository.updateGlobal({
            skillId: f.skill.manifest.id,
            expectedHash: hash,
            content: {
              name: "Updated selected runtime",
              body: "Updated at the final SQL receipt.",
            },
          });
        if (mode === "tombstone")
          yield* repository.setProjectDisabled({ projectRoot: f.main, key: f.skill.manifest.key });
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(pending))._tag).toBe(
          mode === "unchanged" ? "Success" : "Failure",
        );
        expect(f.transports).toBe(0);
        expect(f.launches).toBe(0);
      }),
    ).pipe(Effect.provide(selectedRuntimeLayer)),
  );
}
it.effect(
  "retains an uncertain terminal stage and joins repeated stop after actual SQL failure",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* selectedRuntimeFixture();
        let fail = true;
        const observedSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (
              !fail ||
              !statement
                .compile()[0]
                .includes("SELECT status,owner_json FROM project_team_pi_process")
            )
              return statement;
            fail = false;
            return statement.pipe(
              Effect.andThen(target.unsafe("SELECT * FROM missing_runtime_terminal_receipt")),
            );
          },
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makePiManagedRuntimeLive({
              ...f.options,
              allocateSkillStage: makePiSkillStageLifetime(f.cache),
            });
            const actual = yield* runtime.forInstance({
              instanceId: providerInstanceId,
              enabled: true,
              configuration: {},
            });
            yield* actual.prepareOperation(
              { threadId, kind: "initialize", skillPlan: f.plan },
              () => Effect.void,
            );
            yield* rejected(actual.requestStop(threadId));
            yield* rejected(actual.requestStop(threadId));
          }).pipe(Effect.provideService(SqlClient.SqlClient, observedSql)),
        );
        expect(fail).toBe(false);
        const stages = yield* f.fs.readDirectory(f.cache);
        expect(stages).toHaveLength(1);
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
            ?.status,
        ).toBe("prepared");
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]?.status,
        ).toBe("allocated");
        expect(f.transports).toBe(0);
        // Reopen only this never-launched temporary fixture for its scoped directory cleanup.
        yield* f.fs.chmod(f.cache + "/" + stages[0], 0o700);
        yield* f.fs.chmod(f.cache + "/" + stages[0] + "/" + f.skill.manifest.key, 0o700);
      }),
    ).pipe(Effect.provide(selectedRuntimeLayer)),
);

it.effect("admits multiple selected packages above one package byte limit", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const repository = yield* ManagedSkills.ManagedSkillRepository;
      const selected = [];
      for (const key of ["large-first", "large-second"])
        selected.push(
          yield* repository.createGlobal({
            expectedRevision: 0,
            content: { key: ManagedSkillKey.make(key), name: key, body: "x".repeat(4_050_000) },
          }),
        );
      const ids = selected.map((skill) => skill.manifest.id);
      yield* restoreHistoricalBinding({ ...f.role, revision: f.role.revision + 1, skills: ids });
      yield* restoreHistoricalBinding({
        ...f.binding,
        revision: f.binding.revision + 1,
        configuration: { ...f.binding.configuration, skillIds: ids },
      });
      expect(
        yield* f.instance.authorizeSkills({
          ...catalogueRequest(f.worktree),
          skills: selected.map((skill) => ({
            key: skill.manifest.key,
            packagePath: skill.packagePath,
          })),
        }),
      ).toEqual(selected.map((skill) => skill.manifest.key));
      expect(f.transports).toBe(0);
      expect(f.launches).toBe(0);
    }),
  ).pipe(Effect.provide(selectedRuntimeLayer)),
);

it.effect("joins a held durable preparation receipt before canceling its never-started stage", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* selectedRuntimeFixture();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const observedSql = new Proxy(f.sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          if (!statement.compile()[0].includes("INSERT INTO project_team_pi_operation"))
            return statement;
          return statement.pipe(
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.tap(() => Deferred.await(release)),
          );
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makePiManagedRuntimeLive({
            ...f.options,
            allocateSkillStage: makePiSkillStageLifetime(f.cache),
          });
          const actual = yield* runtime.forInstance({
            instanceId: providerInstanceId,
            enabled: true,
            configuration: {},
          });
          const first = yield* actual
            .prepareOperation(
              { threadId, kind: "initialize", skillPlan: f.plan },
              () => Effect.void,
            )
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.raceFirst(
            Deferred.await(entered),
            Fiber.join(first).pipe(
              Effect.flatMap(() =>
                Effect.die("Preparation finished without its durable SQL receipt"),
              ),
            ),
          );
          // Run stop through its cancellation flag to the pending durable receipt join.
          const stopper = yield* actual
            .requestStop(threadId)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(first))._tag).toBe("Failure");
          yield* Fiber.join(stopper);
        }).pipe(Effect.provideService(SqlClient.SqlClient, observedSql)),
      );
      expect(
        (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]?.status,
      ).toBe("settled");
      expect(
        (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]?.status,
      ).toBe("drained");
      expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
      expect(f.transports).toBe(0);
    }),
  ).pipe(Effect.provide(selectedRuntimeLayer)),
);
