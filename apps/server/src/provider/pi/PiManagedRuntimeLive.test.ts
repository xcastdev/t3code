import { vi } from "vite-plus/test";
import * as SessionRuntime from "./PiSessionRuntime.ts";
import * as ManagedProcess from "./PiManagedProcess.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { preparePiRuntimeAssets } from "./PiRuntimeAssets.ts";
import {
  PiManagedRuntimeError,
  type PiManagedOperationRequest,
  type PiManagedPreparedOperation,
  type PiManagedRuntimeInstance,
} from "./PiManagedRuntime.ts";
import {
  canonicalProjectWorkPayload,
  CommandId,
  MessageId,
  ProjectWorkTaskRead,
  ProjectWorkWriteResult,
  ProjectWorkEvidenceRead,
  ProjectWorkComment,
  ProjectTeamMemorySourcesRead,
  ProjectTeamMemoryProcessIntent,
  ManagedSkillKey,
  SkillCatalogRevision,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkTaskId,
  ThreadId,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
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
  attribution,
  projectId,
  createManagedAssignment,
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
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
} from "../../projectWork/ProjectWorkRepository.ts";
import { ProjectWorkPolicyError } from "../../projectWork/ProjectWorkPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
  type ProjectTeamDispatchRequest,
} from "../../projectWork/ProjectTeamDispatchJournal.ts";
import { makeProjectTeamContext } from "../../projectWork/ProjectTeamContext.ts";
import { projectTeamScopeHash } from "../../projectWork/ProjectTeamPolicy.ts";
import * as RequiredContext from "../../projectWork/ProjectTeamContext.ts";
import { readCurrentState } from "../../projectWork/ProjectWorkRepository.ts";
import {
  ProjectMemoryPorts,
  type ProjectMemoryProcessingConfiguration,
} from "../../projectWork/memory/ProjectMemoryPorts.ts";
import { makeProjectMemoryProcessingConsumer } from "../../projectWork/memory/ProjectMemoryProcessing.ts";
import { MemoryIndexManifest, MemoryBackendError } from "../../projectWork/memory/MemoryBackend.ts";
import {
  ProjectMemoryJobOwner,
  makeProjectMemoryModelAccounting,
} from "../../projectWork/memory/ProjectMemoryModelAccounting.ts";
import {
  ProjectMemoryServiceError,
  makeProjectMemoryService,
} from "../../projectWork/memory/ProjectMemoryService.ts";
import {
  ProjectWorkContentGuard,
  layer as ProjectWorkContentGuardLive,
} from "../../projectWork/ProjectWorkContentGuard.ts";
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
const decodeReportReceipt = Schema.decodeEffect(Schema.fromJsonString(ProjectWorkWriteResult));
const decodeReportTask = Schema.decodeUnknownEffect(ProjectWorkTaskRead);
const decodeReportEvidence = Schema.decodeUnknownEffect(Schema.Array(ProjectWorkEvidenceRead));
const decodeReportComments = Schema.decodeUnknownEffect(Schema.Array(ProjectWorkComment));
const decodeMemorySources = Schema.decodeUnknownEffect(ProjectTeamMemorySourcesRead);
const decodeMemoryOwnerRequest = Schema.decodeUnknownEffect(ProjectTeamMemoryProcessIntent);
const decodeMemorySourceComment = Schema.decodeUnknownEffect(ProjectWorkComment);
const isManagedRuntimeError = Schema.is(PiManagedRuntimeError);
const controlledCallbackError = (cause: unknown) =>
  isManagedRuntimeError(cause)
    ? cause
    : new PiManagedRuntimeError({ code: "uncertain", detail: "Controlled callback failed" });
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
const reviewerFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const role = { ...f.role, revision: f.role.revision + 1, role: "reviewer" as const };
  yield* restoreHistoricalBinding(role);
  return { ...f, role };
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

for (const branch of ["task", "refs/heads/task"]) {
  it.effect(
    `admits an isolated branch ${branch} through real Git without allocating a worker`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* restoreHistoricalBinding({
            ...f.binding,
            revision: f.binding.revision + 1,
            branch,
          });
          const skills = yield* f.instance.authorizeSkills({
            runtime: {
              providerInstanceId,
              cwd: f.worktree,
              sessionId: `thread-${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`,
              threadId,
            },
            desiredRevision: SkillCatalogRevision.make(0),
            skills: [],
          });
          expect(skills).toEqual([]);
          expect(f.launches).toBe(0);
          expect(f.transports).toBe(0);
          expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
          expect((yield* f.sql`SELECT * FROM project_team_pi_process`).length).toBe(0);
        }),
      ),
  );
}
it.effect("denies full primary and mismatching Git refs before worker allocation", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = {
        runtime: {
          providerInstanceId,
          cwd: f.worktree,
          sessionId: `thread-${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`,
          threadId,
        },
        desiredRevision: SkillCatalogRevision.make(0),
        skills: [],
      };
      for (const [index, branch] of ["refs/heads/other", "refs/tags/task"].entries()) {
        yield* restoreHistoricalBinding({
          ...f.binding,
          revision: f.binding.revision + index + 1,
          branch,
        });
        yield* rejected(f.instance.authorizeSkills(request));
      }
      yield* f.git(["-C", f.main, "branch", "-m", "primary-protected"]);
      yield* f.git(["-C", f.worktree, "branch", "-m", "main"]);
      yield* restoreHistoricalBinding({
        ...f.binding,
        revision: f.binding.revision + 3,
        branch: "refs/heads/main",
      });
      yield* rejected(f.instance.authorizeSkills(request));
      expect(f.launches).toBe(0);
      expect(f.transports).toBe(0);
      expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
      expect((yield* f.sql`SELECT * FROM project_team_pi_process`).length).toBe(0);
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
  () => {
    const checkSelection = (
      toolIds: string[],
      available: boolean,
      roleTools = [
        "pi.read",
        "pi.write",
        "pi.edit",
        "pi.bash",
        "terminal",
        "pull-requests",
        "external-mcp",
      ],
    ) =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* restoreHistoricalBinding({
            ...f.role,
            revision: f.role.revision + 1,
            tools: roleTools,
          });
          yield* restoreHistoricalBinding({
            ...f.binding,
            revision: f.binding.revision + 1,
            configuration: { ...f.binding.configuration, toolIds },
          });
          const before = (yield* f.sql`SELECT * FROM project_team_pi_process`).length;
          if (available) {
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
          } else {
            yield* rejected(
              f.instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
            );
            expect((yield* f.sql`SELECT * FROM project_team_pi_process`).length).toBe(before);
          }
          expect(f.transports).toBe(0);
        }),
      );
    return Effect.gen(function* () {
      for (const toolIds of [[], ["pi.read"], ["pi.write"], ["pi.edit"], ["pi.bash"]])
        yield* checkSelection(toolIds, true);
      for (const toolIds of [
        ["terminal"],
        ["pull-requests"],
        ["external-mcp"],
        ["pi.search"],
        ["pi.delegate"],
      ])
        yield* checkSelection(toolIds, false);
      yield* checkSelection(["pi.write"], false, ["pi.read"]);
    });
  },
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
describe.runIf(process.env.PI_MANAGED_RUNTIME_INITIALIZATION_GATE === "1")(
  "initial native publication",
  () => {
    for (const selected of [false, true]) {
      it.effect(
        "publishes durable initial native progression " + (selected ? "selected" : "ordinary"),
        () =>
          scoped(
            Effect.gen(function* () {
              const selectedFixture = selected ? yield* selectedRuntimeFixture() : undefined;
              const f = selectedFixture ?? (yield* fixture);
              const distributionDirectory = process.env.PI_MANAGED_RUNTIME_INITIALIZATION_DIST;
              const evidence = process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE;
              if (!distributionDirectory || !evidence)
                return yield* Effect.die("Owned current distribution and evidence are required");
              const stage = yield* f.fs.makeTempDirectoryScoped();
              yield* f.fs.chmod(stage, 0o700);
              yield* Effect.addFinalizer(() => f.fs.chmod(stage, 0o700).pipe(Effect.orDie));
              const assets = yield* preparePiRuntimeAssets({
                distributionDirectory,
                stagingDirectory: stage,
                protectedRoots: [f.main],
              });
              const closure = yield* Effect.forEach(assets.runtimeFiles, (file) =>
                f.fs.readFile(file.source).pipe(
                  Effect.map((bytes) => ({
                    ...file,
                    bytes: bytes.length,
                    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
                  })),
                ),
              );
              const name = selected ? "selected" : "ordinary";
              yield* f.fs.writeFileString(evidence + "/" + name + "-closure.json", json(closure));
              const operations = yield* makeProjectTeamPiOperations({
                environmentId: "environment",
              });
              const initial = yield* operations.current({ providerInstanceId, threadId }, true);
              const actualAt = DateTime.formatIso(DateTime.nowUnsafe());
              yield* TestClock.setTime(Date.parse(actualAt));
              yield* restoreHistoricalBinding({
                ...initial.binding,
                revision: initial.binding.revision + 1,
                updatedAt: actualAt,
              });
              const before = yield* operations.current({ providerInstanceId, threadId }, true);
              let calls = 0;
              const runtime = yield* makePiManagedRuntimeLive({
                ...f.options,
                ...assets,
                revalidateRuntime: assets.revalidate.pipe(
                  Effect.mapError(
                    () =>
                      new PiManagedRuntimeError({
                        code: "conflict",
                        detail: "Owned initialization runtime assets changed",
                      }),
                  ),
                ),
                ...(selectedFixture
                  ? { allocateSkillStage: makePiSkillStageLifetime(selectedFixture.cache) }
                  : {}),
                workerArgv: (identity, operation) =>
                  assets.workerArgv(identity, operation, "/state/sessions"),
                memoryBytes: 536870912,
                maxInputTokens: 18000,
                cleanupDeadlineMs: 5000,
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
                transport: async () => {
                  calls++;
                  throw Error("Initialization must not call model transport");
                },
              });
              const instance = yield* runtime.forInstance({
                instanceId: providerInstanceId,
                enabled: true,
                configuration: {},
              });
              const prepared = yield* instance.prepareOperation(
                {
                  threadId,
                  kind: "initialize",
                  ...(selectedFixture ? { skillPlan: selectedFixture.plan } : {}),
                },
                () => Effect.void,
              );
              const result = yield* prepared.run.pipe(Effect.result);
              yield* instance.requestStop(threadId);
              const current = yield* operations.current({ providerInstanceId, threadId });
              const owners = yield* f.sql<{ owner_json: string; drain_json: string }>`
                SELECT owner_json,drain_json FROM project_team_pi_process`;
              const rows = yield* f.sql`SELECT * FROM project_team_pi_operation`;
              const requests = yield* f.sql`SELECT * FROM project_team_model_request`;
              yield* f.fs.writeFileString(
                evidence + "/" + name + "-publication.json",
                json({
                  result,
                  before: before.binding,
                  current: current.binding,
                  owners,
                  rows,
                  requests,
                  calls,
                }),
              );
              expect(owners).toHaveLength(1);
              for (const row of owners) {
                const owner = parseOwner(row.owner_json);
                const drain = parseFullDrain(row.drain_json);
                expect(drain.invocation).toBe(owner.invocation);
                expect(drain.unit).toBe(owner.unit);
                expect(drain.kernel === "removed" || drain.kernel.includes("populated 0")).toBe(
                  true,
                );
                expect(drain.ownerPid).toBe(owner.pid);
                for (const pid of [owner.pid, drain.launcherPid, drain.childPid])
                  expect(yield* f.fs.exists(`/proc/${pid}`)).toBe(false);
                if (yield* f.fs.exists(drain.cgroup + "/cgroup.events"))
                  expect(yield* f.fs.readFileString(drain.cgroup + "/cgroup.events")).toContain(
                    "populated 0",
                  );
              }
              expect(calls).toBe(0);
              expect(requests).toEqual([]);
              expect(result._tag).toBe("Success");
              if (result._tag !== "Success") return;
              expect(result.success.terminal.outcome).toBe("success");
              expect(result.success.session.status).toBe("ready");
              expect(current.binding).toEqual({
                ...before.binding,
                revision: before.binding.revision + 1,
                status: "running",
                sessionId: result.success.terminal.native!.sessionId,
                updatedAt: actualAt,
              });
              expect(rows).toMatchObject([{ status: "settled" }]);
            }),
          ).pipe(Effect.provide(selectedRuntimeLayer)),
        30000,
      );
    }
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
for (const outcome of ["findings", "complete"] as const)
  it.effect(`retains committed ${outcome} reports across the return fence`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* restoreHistoricalBinding({
          ...f.role,
          revision: f.role.revision + 1,
          tools: ["project-work.report"],
        });
        yield* restoreHistoricalBinding({
          ...f.binding,
          revision: f.binding.revision + 1,
          configuration: { ...f.binding.configuration, toolIds: ["project-work.report"] },
        });
        const initial = yield* readCurrentState(f.sql, f.binding.projectId);
        const membership = initial.foundationRecords!.find(
          (record) => record.kind === "task-membership" && record.taskId === f.binding.taskId,
        );
        if (membership?.kind !== "task-membership") return yield* Effect.die("No membership");
        yield* restoreHistoricalBinding({
          ...membership,
          revision: membership.revision + 1,
          deliverableKind: "non-code",
        });
        yield* settledNativeForRead(f, piManagedSkillResourceIdentity([]));
        // Capture the real Runtime callbacks without acquiring a process or importing the SDK.
        let session: SessionRuntime.PiSessionRuntimeOptions | undefined;
        const original = SessionRuntime.makePiSessionRuntime;
        const capture = vi
          .spyOn(SessionRuntime, "makePiSessionRuntime")
          .mockImplementation((input) => {
            session = input;
            return original(input);
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => capture.mockRestore()));
        yield* f.instance.prepareOperation(
          { threadId, kind: "prompt", prompt: "Retain the assignment report" },
          () => Effect.void,
        );
        if (!session) return yield* Effect.die("No controlled session captured");
        const captured = session;
        const before = yield* readCurrentState(f.sql, f.binding.projectId);
        const task = before.tasks.find((entry) => entry.taskId === f.binding.taskId)!;
        const assignment = before.foundationRecords!.find(
          (record) => record.kind === "task-membership" && record.taskId === task.taskId,
        )!;
        const intent = {
          type: "project-team.assignment.report",
          projectId: task.projectId,
          taskId: task.taskId,
          commandId: CommandId.make(`controlled-report-${outcome}`),
          expectedRevision: before.revision,
          expectedTaskRevision: task.revision,
          assignmentId: assignment.recordId,
          expectedAssignmentRevision: assignment.revision,
          specRevision: 1,
          planRevision: 1,
          summary: "The retained source supports the non-code deliverable",
          evidenceIds: [],
          outputArtifactIds: [],
          outputs: before.criteria
            .filter((entry) => entry.taskId === task.taskId)
            .map((entry) => ({
              criterionId: entry.criterionId,
              kind: "observation",
              detail: "Retained fixture source evidence for the required output",
            })),
          outcome,
        };
        const input = { arguments: { intentJSON: json(intent) } };
        const text = json(input);
        const call = {
          type: "tool-call" as const,
          callId: 1,
          nativeCallId: "controlled-report-call",
          lifecycleId: 1,
          toolName: "project_work_report",
          execution: "bridge" as const,
          input: { transferId: "controlled-input", totalBytes: Buffer.byteLength(text) },
        };
        const signal = new AbortController().signal;
        const returned = yield* Effect.tryPromise({
          try: () => captured.executeBridgeTool(call, input, signal),
          catch: controlledCallbackError,
        }).pipe(Effect.result);
        const after = yield* readCurrentState(f.sql, task.projectId);
        const receipts = yield* f.sql`SELECT * FROM project_work_command_receipts
          WHERE project_id=${task.projectId} AND command_id=${intent.commandId}`;
        expect(receipts).toHaveLength(1);
        expect(
          (yield* decodeReportReceipt(String(receipts[0]!.result_json))).receipt,
        ).toMatchObject({
          commandId: intent.commandId,
          status: "accepted",
          projectId: task.projectId,
        });
        expect(after.evidence.some((entry) => entry.detail === intent.summary)).toBe(true);
        expect((after.comments ?? []).some((entry) => entry.body === intent.summary)).toBe(true);
        expect(after.tasks.find((entry) => entry.taskId === task.taskId)?.state).toBe(
          outcome === "complete" ? "completed" : task.state,
        );
        expect(
          after.foundationRecords!.find((entry) => entry.recordId === f.binding.recordId)?.status,
        ).toBe(outcome === "complete" ? "stopping" : "running");
        const gateway = yield* ProjectWorkGateway;
        const publicViews = {
          task: yield* gateway.read({
            projectId: task.projectId,
            taskId: task.taskId,
            operation: "task",
          }),
          evidence: yield* gateway.read({
            projectId: task.projectId,
            taskId: task.taskId,
            operation: "evidence",
          }),
          comments: yield* gateway.read({
            projectId: task.projectId,
            taskId: task.taskId,
            operation: "comments",
          }),
        };
        expect((yield* decodeReportTask(publicViews.task)).state).toBe(
          outcome === "complete" ? "completed" : task.state,
        );
        expect(
          (yield* decodeReportEvidence(publicViews.evidence)).some(
            (entry) => entry.detail === intent.summary,
          ),
        ).toBe(true);
        expect(
          (yield* decodeReportComments(publicViews.comments)).some(
            (entry) => entry.body === intent.summary,
          ),
        ).toBe(true);
        const probes: Array<{ phase: string; result: unknown }> = [];
        if (outcome === "complete") {
          for (const phase of [
            "beforeToolReturn",
            "beforeToolInvoke",
            "beforeStart",
            "beforeControl",
          ] as const) {
            const result = yield* Effect.tryPromise({
              try: () =>
                captured.authorizeCurrent(
                  { identity: captured.identity, operation: captured.operation, phase },
                  signal,
                ),
              catch: controlledCallbackError,
            }).pipe(Effect.result);
            probes.push({ phase, result });
            expect(result._tag).toBe("Failure");
          }
          const modelAdmission = yield* Effect.tryPromise({
            try: () => captured.broker.authorizeCurrent("beforeReserve", signal),
            catch: controlledCallbackError,
          }).pipe(Effect.result);
          probes.push({ phase: "beforeModelReserve", result: modelAdmission });
          expect(modelAdmission._tag).toBe("Failure");
          yield* Effect.tryPromise({
            try: () =>
              captured.persistTerminal(
                {
                  identity: captured.identity,
                  operation: captured.operation,
                  outcome: "failed",
                  ownerCaptured: false,
                  native: null,
                  drain: null,
                  accountingReceipts: [],
                  failureCode: "CONTROLLED_RETURN_FENCE",
                },
                signal,
              ),
            catch: controlledCallbackError,
          });
          const retained = yield* readCurrentState(f.sql, task.projectId);
          expect(retained.tasks.find((entry) => entry.taskId === task.taskId)?.state).toBe(
            "completed",
          );
          expect(retained.evidence.some((entry) => entry.detail === intent.summary)).toBe(true);
          expect(
            (yield* decodeReportTask(
              yield* gateway.read({
                projectId: task.projectId,
                taskId: task.taskId,
                operation: "task",
              }),
            )).state,
          ).toBe("completed");
          const replay = yield* Effect.tryPromise({
            try: () => captured.executeBridgeTool(call, input, signal),
            catch: controlledCallbackError,
          }).pipe(Effect.result);
          expect(replay._tag).toBe("Failure");
          expect(
            yield* f.sql`SELECT * FROM project_work_command_receipts
            WHERE project_id=${task.projectId} AND command_id=${intent.commandId}`,
          ).toEqual(receipts);
        }
        const evidence = process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE;
        if (evidence)
          yield* f.fs.writeFileString(
            evidence + `/controlled-observation-${outcome}.json`,
            json({
              outcome,
              beforeRevision: before.revision,
              after,
              receipts,
              returned,
              publicViews,
              probes,
              operations:
                yield* f.sql`SELECT operation_kind,status,terminal_json FROM project_team_pi_operation`,
              transports: f.transports,
              launches: f.launches,
              models: yield* f.sql`SELECT * FROM project_team_model_request`,
              processes:
                yield* f.sql`SELECT status,owner_json,drain_json FROM project_team_pi_process`,
            }),
          );
        expect(f.transports).toBe(0);
        expect((yield* f.sql`SELECT * FROM project_team_model_request`).length).toBe(0);
        const processes = yield* f.sql<{
          owner_json: string | null;
        }>`SELECT owner_json FROM project_team_pi_process`;
        expect(processes).toHaveLength(2);
        expect(processes.every((entry) => entry.owner_json === null)).toBe(true);
        expect(returned._tag).toBe(outcome === "complete" ? "Failure" : "Success");
        if (returned._tag === "Success")
          expect(returned.success).toEqual({
            kind: "text",
            text: String(receipts[0]!.result_json),
          });
      }),
    ),
  );
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

// Durable metadata below is synthetic; these cases exercise real SQL and the real
// nonmutating file reader without starting a Pi process or model transport.
const stableReplayFixtureFor = (prompt = false, reviewer = false) =>
  Effect.gen(function* () {
    const f = yield* reviewer ? reviewerFixture : fixture;
    const request: PiManagedOperationRequest = prompt
      ? {
          threadId,
          kind: "prompt",
          prompt: "Original approved assignment",
          operationId: "root-stable-assignment",
        }
      : { threadId, kind: "initialize", operationId: "root-stable-initialize" };
    const operationDirectory =
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
        .digest("hex");
    yield* f.fs.makeDirectory(operationDirectory + "/sessions", { recursive: true });
    const allocate = preallocatePiManagedProcess({
      workspaceRoot: f.worktree,
      workspaceAccess: "readonly",
      nativeStateRoot: operationDirectory,
      protectedRoots: f.options.protectedRoots,
      runtimeFiles: f.options.runtimeFiles,
      argv: ["/bin/true"],
      memoryBytes: f.options.memoryBytes,
      runtimeSeconds: 10,
    });
    const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
    if (prompt) {
      const initializeRequest: PiManagedOperationRequest = {
        threadId,
        kind: "initialize",
        operationId: "root-stable-initialize",
      };
      const initialize = yield* operations.prepare(
        { providerInstanceId, threadId },
        initializeRequest,
        NodeCrypto.createHash("sha256")
          .update(canonicalProjectWorkPayload(initializeRequest))
          .digest("hex"),
        {
          allocation: yield* allocate,
          operationId: initializeRequest.operationId!,
          workerId: "original-initialize-worker",
          resourceHash: piManagedSkillResourceIdentity([]),
        },
      );
      expect(
        yield* operations.persistTerminal(initialize, {
          identity: { workerId: initialize.workerId, generation: 0 },
          operation: initialize.operation,
          outcome: "canceled",
          ownerCaptured: false,
          native: null,
          drain: null,
          accountingReceipts: [],
        }),
      ).toBe("drained");
      expect(yield* f.sql`SELECT operation_kind,status FROM project_team_pi_operation`).toEqual([
        { operation_kind: "initialize", status: "settled" },
      ]);
      expect(yield* f.sql`SELECT status FROM project_team_pi_process`).toEqual([
        { status: "drained" },
      ]);
      yield* restoreHistoricalBinding({
        ...f.binding,
        revision: f.binding.revision + 1,
        status: "running",
        sessionId: "original-native",
      });
    }
    const allocation = yield* allocate;
    const requestHash = NodeCrypto.createHash("sha256")
      .update(canonicalProjectWorkPayload(request))
      .digest("hex");
    const op = yield* operations.prepare({ providerInstanceId, threadId }, request, requestHash, {
      allocation,
      operationId: request.operationId!,
      workerId: "original-worker",
      resourceHash: piManagedSkillResourceIdentity([]),
    });
    const owner = {
      type: "owner" as const,
      unit: allocation.unit,
      nonce: allocation.nonce,
      invocation: "a".repeat(32),
      cgroup: `/sys/fs/cgroup/${allocation.unit}`,
      pid: 123,
      memoryBytes: allocation.policy.memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
    };
    yield* operations.persistence(op).claimActivation(allocation);
    yield* operations.persistence(op).beforeStart(owner);
    const native = {
      sessionId: "original-native",
      sessionReference: "sessions/original.jsonl",
      leafId: "original-leaf",
      persisted: true,
    };
    yield* operations.persistNative(op, native);
    const terminal = {
      identity: { workerId: op.workerId, generation: 0 },
      operation: op.operation,
      outcome: "success" as const,
      ownerCaptured: true,
      native,
      accountingReceipts: [],
      drain: {
        unit: owner.unit,
        invocation: owner.invocation,
        cgroup: owner.cgroup,
        ownerPid: owner.pid,
        memoryBytes: owner.memoryBytes,
        swapBytes: 0,
        oomGroup: 1,
        launcherPid: 124,
        childPid: 125,
        childExitCode: 0,
        kernel: "removed",
      },
    };
    yield* operations.persistTerminal(op, terminal);
    const nativeFile = operationDirectory + "/sessions/original.jsonl";
    const bytes =
      [
        json({
          type: "session",
          version: 3,
          id: native.sessionId,
          timestamp: at,
          cwd: "/workspace",
        }),
        json({
          type: "custom",
          id: native.leafId,
          parentId: null,
          timestamp: at,
          customType: "stable-fixture",
          data: { retained: true },
        }),
      ].join("\n") + "\n";
    yield* f.fs.writeFileString(nativeFile, bytes);
    // Configuration inspection is cached and read-only; no credential is resolved.
    yield* f.fs.writeFileString(
      f.options.agentDirectory + "/settings.json",
      json({
        defaultProvider: "command-code",
        defaultModel: model,
        packages: [],
        extensions: [],
        skills: [],
        promptTemplates: [],
      }),
    );
    return {
      ...f,
      request,
      op,
      terminal,
      nativeFile,
      bytes,
      get launches() {
        return f.launches;
      },
      get transports() {
        return f.transports;
      },
    };
  });
for (const mode of [
  "restart",
  "prompt-restart",
  "changed-request",
  "bad-id",
  "active",
  "uncertain",
  "missing-native",
  "changed-native",
  "expired",
  "retired",
  "held-stop",
  "run-expired",
] as const) {
  it.effect(`replays stable Pi receipts without allocation or event effects: ${mode}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* stableReplayFixtureFor(mode === "prompt-restart");
        const originalOperations = yield* f.sql`SELECT operation_id FROM project_team_pi_operation`;
        let request: PiManagedOperationRequest = f.request;
        if (mode === "changed-request")
          request = { ...request, kind: "prompt", prompt: "different" };
        if (mode === "bad-id") request = { ...request, operationId: "../outside" };
        if (mode === "active" || mode === "uncertain")
          yield* f.sql`UPDATE project_team_pi_operation SET status=${mode === "active" ? "running" : "quarantine"}`;
        if (mode === "missing-native") yield* f.fs.remove(f.nativeFile);
        if (mode === "changed-native")
          yield* f.fs.writeFileString(f.nativeFile, f.bytes.replace("original-leaf", "other-leaf"));
        if (mode === "expired") yield* TestClock.setTime(f.op.deadlineAtMs);
        if (mode === "retired") {
          const binding = (yield* readCurrentState(
            f.sql,
            f.binding.projectId,
          )).foundationRecords?.find(
            (record) => record.kind === "run-binding" && record.recordId === f.binding.recordId,
          );
          if (binding?.kind !== "run-binding") return yield* Effect.die("binding missing");
          yield* restoreHistoricalBinding({
            ...binding,
            revision: binding.revision + 1,
            status: "settled",
          });
        }
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let held = false;
        const observedSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (
              mode !== "held-stop" ||
              held ||
              !statement
                .compile()[0]
                .includes("SELECT * FROM project_team_pi_operation WHERE operation_id=")
            )
              return statement;
            return statement.pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  held = true;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }),
              ),
            );
          },
        });
        let events = 0;
        let allocations = 0;
        const runtime = yield* makePiManagedRuntimeLive({
          ...f.options,
          allocateSkillStage: Effect.sync(() => {
            allocations++;
            throw Error("unexpected allocation");
          }),
        }).pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        const instance = yield* runtime
          .forInstance({ instanceId: providerInstanceId, enabled: true, configuration: {} })
          .pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        const pending = yield* instance
          .prepareOperation(request, () =>
            Effect.sync(() => {
              events++;
            }),
          )
          .pipe(
            Effect.result,
            Effect.provideService(SqlClient.SqlClient, observedSql),
            Effect.forkChild,
          );
        if (mode === "held-stop") {
          yield* Deferred.await(entered);
          const stop = yield* instance.requestStop(threadId).pipe(Effect.forkChild);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(stop);
        }
        const result = yield* Fiber.join(pending);
        if (mode === "restart" || mode === "prompt-restart" || mode === "run-expired") {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return yield* Effect.die("replay denied");
          expect(result.success.operation).toEqual(f.op.operation);
          if (result.success.kind === "prompt")
            expect(result.success.turnId).toBe(f.op.operation.operationId);
          if (mode === "run-expired") {
            yield* TestClock.setTime(f.op.deadlineAtMs);
            yield* rejected(
              result.success.run.pipe(Effect.provideService(SqlClient.SqlClient, observedSql)),
            );
          } else {
            const receipt = yield* result.success.run.pipe(
              Effect.provideService(SqlClient.SqlClient, observedSql),
            );
            expect(receipt.terminal).toEqual(f.terminal);
            expect(receipt.session.resumeCursor).toEqual(f.terminal.native);
            expect(
              (yield* result.success.run.pipe(
                Effect.provideService(SqlClient.SqlClient, observedSql),
              )).terminal,
            ).toEqual(f.terminal);
            yield* rejected(result.success.steer("steer", "later"));
            yield* rejected(result.success.interrupt);
            expect(yield* f.fs.readFileString(f.nativeFile)).toBe(f.bytes);
          }
        } else expect(result._tag).toBe("Failure");
        expect(f.launches).toBe(0);
        expect(f.transports).toBe(0);
        expect(allocations).toBe(0);
        expect(events).toBe(0);
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual(
          originalOperations,
        );
        expect((yield* f.sql`SELECT reservation_id FROM project_team_model_request`).length).toBe(
          0,
        );
      }),
    ),
  );
}

for (const mode of [
  "unchanged",
  "stop-after-prepare",
  "stopAll-after-prepare",
  "held-run-stop",
  "held-run-stopAll",
  "native-root-replacement",
  "native-final-boundary",
  "changed-native-root",
] as const) {
  it.effect(`replay review repair fences receipt lifetime and native ownership: ${mode}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* stableReplayFixtureFor();
        const original = yield* f.sql`SELECT * FROM project_team_pi_operation`;
        const originalProcesses = yield* f.sql`SELECT * FROM project_team_pi_process`;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let hold = false;
        let replaceAtFence = false;
        const replaceNative = Effect.gen(function* () {
          const state = f.nativeFile.slice(0, -"/sessions/original.jsonl".length);
          yield* f.fs.rename(state, state + "-original");
          yield* f.fs.makeDirectory(state + "/sessions", { recursive: true });
          yield* f.fs.writeFileString(
            f.nativeFile,
            f.bytes.replace('"retained":true', '"retained":false'),
          );
        });
        const observedSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            return mode === "native-final-boundary" &&
              statement.compile()[0].includes("ORDER BY operation_ordinal DESC LIMIT 1")
              ? statement.pipe(Effect.tap(() => (replaceAtFence ? replaceNative : Effect.void)))
              : statement;
          },
        });
        const runtime = yield* makePiManagedRuntimeLive({
          ...f.options,
          readCatalogue: f.options.readCatalogue.pipe(
            Effect.tap(() =>
              hold
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
            ),
          ),
        }).pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const prepared = yield* instance
          .prepareOperation(f.request, () => Effect.die("unexpected replay event"))
          .pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        const run = prepared.run.pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        if (mode === "native-root-replacement") {
          yield* replaceNative;
        }
        if (mode === "native-final-boundary") replaceAtFence = true;
        if (mode === "changed-native-root") {
          // Recreate the runtime with a different configured root; it must not discover/replay a same-ID copy.
          const other = f.options.nativeStateRoot + "-other";
          yield* f.fs.makeDirectory(other, { recursive: true });
          const otherRuntime = yield* makePiManagedRuntimeLive({
            ...f.options,
            nativeStateRoot: other,
          });
          const otherInstance = yield* otherRuntime.forInstance({
            instanceId: providerInstanceId,
            enabled: true,
            configuration: {},
          });
          yield* rejected(otherInstance.prepareOperation(f.request, () => Effect.void));
        } else if (mode === "stop-after-prepare" || mode === "stopAll-after-prepare") {
          yield* mode === "stop-after-prepare" ? instance.requestStop(threadId) : instance.stopAll;
          yield* rejected(run);
          yield* rejected(run);
        } else if (mode === "held-run-stop" || mode === "held-run-stopAll") {
          hold = true;
          const running = yield* run.pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* mode === "held-run-stop" ? instance.requestStop(threadId) : instance.stopAll;
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(running))._tag).toBe("Failure");
          yield* rejected(run);
        } else if (mode === "native-root-replacement" || mode === "native-final-boundary")
          yield* rejected(run);
        else expect((yield* run).terminal).toEqual(f.terminal);
        expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toEqual(original);
        expect(yield* f.sql`SELECT * FROM project_team_pi_process`).toEqual(originalProcesses);
        expect(f.launches).toBe(0);
        expect(f.transports).toBe(0);
      }),
    ),
  );
}

for (const mode of [
  "no-stop",
  "explicit-stop",
  "completed-old",
  "canceled-old",
  "completed-stop",
  "completed-stopAll",
  "repeat",
  "held-old-new-writer",
  "old-new-preparing",
] as const) {
  it.effect(`replay completion releases only its own lifetime: ${mode}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* stableReplayFixtureFor();
        const original =
          yield* f.sql`SELECT * FROM project_team_pi_operation WHERE operation_id=${f.op.operation.operationId}`;
        const originalProcess =
          yield* f.sql`SELECT * FROM project_team_pi_process WHERE operation_id=${f.op.operation.operationId}`;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let hold = false;
        const runtime = yield* makePiManagedRuntimeLive({
          ...f.options,
          readCatalogue: f.options.readCatalogue.pipe(
            Effect.tap(() =>
              hold
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
            ),
          ),
        });
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const old = yield* instance.prepareOperation(f.request, () =>
          Effect.die("unexpected replay event"),
        );
        if (mode === "canceled-old") yield* instance.requestStop(threadId);
        else expect((yield* old.run).terminal).toEqual(f.terminal);
        expect(f.launches).toBe(0);
        expect(f.transports).toBe(0);
        const nextRequest: PiManagedOperationRequest = {
          threadId,
          kind: "prompt",
          prompt: "Next approved assignment",
          operationId: "root-stable-next-prompt",
        };
        if (mode === "repeat" || mode === "completed-stop" || mode === "completed-stopAll") {
          expect((yield* old.run).terminal).toEqual(f.terminal);
          expect((yield* old.run).terminal).toEqual(f.terminal);
          if (mode === "completed-stop" || mode === "completed-stopAll") {
            yield* mode === "completed-stop" ? instance.requestStop(threadId) : instance.stopAll;
            yield* rejected(old.run);
            yield* rejected(old.run);
          }
        } else {
          if (mode === "explicit-stop") yield* instance.requestStop(threadId);
          const heldRead =
            mode === "held-old-new-writer"
              ? yield* Effect.gen(function* () {
                  hold = true;
                  const running = yield* old.run.pipe(Effect.result, Effect.forkChild);
                  yield* Effect.raceFirst(
                    Deferred.await(entered),
                    Fiber.join(running).pipe(
                      Effect.flatMap(() => Effect.die("Replay returned before held read")),
                    ),
                  );
                  yield* instance.requestStop(threadId);
                  hold = false;
                  return running;
                })
              : undefined;
          let next: PiManagedPreparedOperation;
          if (mode === "old-new-preparing") {
            hold = true;
            const preparing = yield* instance
              .prepareOperation(nextRequest, () => Effect.void)
              .pipe(Effect.forkChild);
            yield* Effect.raceFirst(
              Deferred.await(entered),
              Fiber.join(preparing).pipe(
                Effect.flatMap(() => Effect.die("Preparation returned before held read")),
              ),
            );
            yield* rejected(old.run);
            yield* Deferred.succeed(release, undefined);
            next = yield* Fiber.join(preparing);
          } else next = yield* instance.prepareOperation(nextRequest, () => Effect.void);
          expect(next.operation.operationId).toBe(nextRequest.operationId);
          expect(f.launches).toBe(1);
          if (heldRead) {
            yield* Deferred.succeed(release, undefined);
            expect((yield* Fiber.join(heldRead))._tag).toBe("Failure");
          }
          if (
            ["completed-old", "canceled-old", "held-old-new-writer", "old-new-preparing"].includes(
              mode,
            )
          ) {
            yield* rejected(old.run);
            yield* rejected(old.interrupt);
            yield* rejected(old.steer("steer", "old control"));
            yield* rejected(
              instance.prepareOperation(
                { ...nextRequest, operationId: "third-root-prompt" },
                () => Effect.void,
              ),
            );
            // A cleared JavaScript slot would preallocate before SQL detects the new writer.
            expect(f.launches).toBe(1);
            expect(
              (yield* f.sql`SELECT status FROM project_team_pi_operation WHERE operation_id=${nextRequest.operationId}`)[0]
                ?.status,
            ).toBe("prepared");
          }
          yield* instance.requestStop(threadId);
        }
        expect(
          yield* f.sql`SELECT * FROM project_team_pi_operation WHERE operation_id=${f.op.operation.operationId}`,
        ).toEqual(original);
        expect(
          yield* f.sql`SELECT * FROM project_team_pi_process WHERE operation_id=${f.op.operation.operationId}`,
        ).toEqual(originalProcess);
        expect(f.transports).toBe(0);
      }),
    ),
  );
}

for (const api of ["requestStop", "stopAll"] as const) {
  it.effect(`replay completion retains final SQL cancellation: ${api}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* stableReplayFixtureFor();
        const original =
          yield* f.sql`SELECT * FROM project_team_pi_operation WHERE operation_id=${f.op.operation.operationId}`;
        let instance: PiManagedRuntimeInstance | undefined;
        let armed = false;
        const observedSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (!statement.compile()[0].includes("ORDER BY operation_ordinal DESC LIMIT 1"))
              return statement;
            return statement.pipe(
              Effect.tap(() =>
                Effect.suspend(() => {
                  if (!armed || !instance) return Effect.void;
                  return api === "requestStop" ? instance.requestStop(threadId) : instance.stopAll;
                }),
              ),
            );
          },
        });
        const runtime = yield* makePiManagedRuntimeLive(f.options).pipe(
          Effect.provideService(SqlClient.SqlClient, observedSql),
        );
        instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const old = yield* instance
          .prepareOperation(f.request, () => Effect.die("unexpected replay event"))
          .pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        armed = true;
        yield* rejected(old.run.pipe(Effect.provideService(SqlClient.SqlClient, observedSql)));
        armed = false;
        yield* rejected(old.run.pipe(Effect.provideService(SqlClient.SqlClient, observedSql)));
        expect(f.launches).toBe(0);
        const next = yield* instance
          .prepareOperation(
            {
              threadId,
              kind: "prompt",
              prompt: "Next approved assignment",
              operationId: "root-after-final-stop",
            },
            () => Effect.void,
          )
          .pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        expect(next.operation.operationId).toBe("root-after-final-stop");
        expect(f.launches).toBe(1);
        yield* instance
          .requestStop(threadId)
          .pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        expect(
          yield* f.sql`SELECT * FROM project_team_pi_operation WHERE operation_id=${f.op.operation.operationId}`,
        ).toEqual(original);
        expect(f.transports).toBe(0);
      }),
    ),
  );
}

for (const prompt of [false, true]) {
  it.effect(
    `reviewer freshness refuses unqualified ${prompt ? "prompt" : "initialize"} replay`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* stableReplayFixtureFor(prompt, true);
          const restarted = yield* makePiManagedRuntimeLive(f.options);
          const instance = yield* restarted.forInstance({
            instanceId: providerInstanceId,
            enabled: true,
            configuration: {},
          });
          const result = yield* instance
            .prepareOperation(f.request, () => Effect.void)
            .pipe(Effect.result);
          expect(result).toMatchObject({ _tag: "Failure" });
          expect(f.launches).toBe(0);
          expect(f.transports).toBe(0);
          expect(
            yield* f.sql`SELECT operation_id FROM project_team_pi_operation ORDER BY operation_ordinal`,
          ).toEqual(
            prompt
              ? [
                  { operation_id: "root-stable-initialize" },
                  { operation_id: "root-stable-assignment" },
                ]
              : [{ operation_id: "root-stable-initialize" }],
          );
        }),
      ),
  );
}

for (const mode of ["fresh", "fresh-prompt", "inherited", "wrong-briefing"] as const) {
  it.effect(`reviewer freshness qualifies only the host briefing before publication: ${mode}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* reviewerFixture;
        const original = SessionRuntime.makePiSessionRuntime;
        let nativeFile = "";
        const capture = vi
          .spyOn(SessionRuntime, "makePiSessionRuntime")
          .mockImplementation((input) =>
            original(input).pipe(
              Effect.map((session) => ({
                ...session,
                run: () =>
                  Effect.gen(function* () {
                    // Synthetic child and kernel receipts exercise the real parent/SQL/file boundary.
                    // This fixture never acquires a managed process or calls a model.
                    const allocation = input.persistence.allocation;
                    const owner = {
                      type: "owner" as const,
                      unit: allocation.unit,
                      nonce: allocation.nonce,
                      invocation: "a".repeat(32),
                      cgroup: `/sys/fs/cgroup/${allocation.unit}`,
                      pid: 99999999,
                      memoryBytes: allocation.policy.memoryBytes,
                      swapBytes: 0,
                      oomGroup: 1,
                    };
                    yield* input.persistence.claimActivation(allocation);
                    yield* input.persistence.beforeStart(owner);
                    const briefing = input.transferTexts.find(
                      (entry) => entry.transferId === "context",
                    )?.text;
                    if (!briefing) return yield* Effect.die("No original host briefing");
                    const native = {
                      sessionId: "fresh-review-session",
                      sessionReference: "sessions/fresh-review.jsonl",
                      leafId: mode === "inherited" ? "inherited-leaf" : "briefing-leaf",
                      persisted: true,
                    };
                    const entries = [
                      {
                        type: "session",
                        version: 3,
                        id: native.sessionId,
                        timestamp: at,
                        cwd: "/workspace",
                      },
                      {
                        type: "message",
                        id: "briefing-leaf",
                        parentId: null,
                        timestamp: at,
                        message: {
                          role: "user",
                          content: [
                            {
                              type: "text",
                              text: mode === "wrong-briefing" ? "Inherited instructions" : briefing,
                            },
                          ],
                          timestamp: Date.parse(at),
                        },
                      },
                      ...(mode === "inherited"
                        ? [
                            {
                              type: "message",
                              id: "inherited-leaf",
                              parentId: "briefing-leaf",
                              timestamp: at,
                              message: {
                                role: "assistant",
                                content: [{ type: "text", text: "Prior implementer conversation" }],
                                timestamp: Date.parse(at),
                              },
                            },
                          ]
                        : []),
                    ];
                    const state = allocation.launch.nativeStateRoot;
                    yield* f.fs.makeDirectory(state + "/sessions", { recursive: true });
                    nativeFile = state + "/sessions/fresh-review.jsonl";
                    yield* f.fs.writeFileString(
                      nativeFile,
                      entries.map((entry) => json(entry)).join("\n") + "\n",
                    );
                    const signal = new AbortController().signal;
                    yield* Effect.tryPromise(() =>
                      input.persistNative(
                        {
                          version: 1,
                          ...input.identity,
                          ...input.operation,
                          sequence: 0,
                          message: { type: "initialized", native },
                        },
                        signal,
                      ),
                    );
                    const terminal: SessionRuntime.PiSessionTerminal = {
                      identity: input.identity,
                      operation: input.operation,
                      outcome: "success",
                      ownerCaptured: true,
                      native,
                      accountingReceipts: [],
                      drain: {
                        unit: owner.unit,
                        invocation: owner.invocation,
                        cgroup: owner.cgroup,
                        ownerPid: owner.pid,
                        memoryBytes: owner.memoryBytes,
                        swapBytes: 0,
                        oomGroup: 1,
                        launcherPid: 99999998,
                        childPid: 99999997,
                        childExitCode: 0,
                        kernel: "removed",
                      },
                    };
                    yield* Effect.tryPromise(() => input.persistTerminal(terminal, signal));
                    return terminal;
                  }).pipe(
                    Effect.mapError(
                      () =>
                        new SessionRuntime.PiSessionRuntimeError({
                          code: "SYNTHETIC_SESSION_FAILURE",
                        }),
                    ),
                  ),
              })),
            ),
          );
        yield* Effect.addFinalizer(() => Effect.sync(() => capture.mockRestore()));
        const prepared = yield* f.instance.prepareOperation(
          { threadId, kind: "initialize", operationId: "fresh-review-initialize" },
          () => Effect.void,
        );
        const result = yield* prepared.run.pipe(Effect.result);
        const rows = yield* f.sql<{
          native_jsonl: string;
        }>`SELECT native_jsonl FROM project_team_review_freshness`;
        if (mode === "fresh" || mode === "fresh-prompt") {
          expect(result._tag).toBe("Success");
          expect(rows).toEqual([{ native_jsonl: yield* f.fs.readFileString(nativeFile) }]);
          const restart = yield* makePiManagedRuntimeLive(f.options);
          const instance = yield* restart.forInstance({
            instanceId: providerInstanceId,
            enabled: true,
            configuration: {},
          });
          const replay = yield* instance.prepareOperation(
            { threadId, kind: "initialize", operationId: "fresh-review-initialize" },
            () => Effect.void,
          );
          expect((yield* replay.run).terminal.outcome).toBe("success");
          if (mode === "fresh-prompt") {
            const assignment = yield* instance.prepareOperation(
              {
                threadId,
                kind: "prompt",
                operationId: "fresh-review-assignment",
                prompt: "Review the assigned revision",
              },
              () => Effect.void,
            );
            expect(assignment.kind).toBe("prompt");
            expect(
              yield* f.sql`SELECT operation_kind FROM project_team_pi_operation ORDER BY operation_ordinal`,
            ).toEqual([{ operation_kind: "initialize" }, { operation_kind: "prompt" }]);
            return;
          }
          yield* f.sql`DELETE FROM project_team_review_freshness`;
          expect(
            (yield* instance
              .prepareOperation(
                { threadId, kind: "initialize", operationId: "fresh-review-initialize" },
                () => Effect.void,
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        } else {
          expect(result._tag).toBe("Failure");
          expect(rows).toEqual([]);
        }
        expect(f.transports).toBe(0);
      }),
    ),
  );
}

const decodeRequiredFoundation = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const decodeRequiredJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeMemoryLedgerOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryJobOwner),
);
const decodeMemoryCompanionInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      protocolVersion: Schema.Literal(1),
      requestId: Schema.String,
      operation: Schema.Literals(["index", "reconcile"]),
      input: MemoryIndexManifest,
    }),
  ),
  { onExcessProperty: "error" },
);

// Required-context cases intercept only session execution; no managed worker or model is run.
const requiredTransferFixture = Effect.fn("requiredTransferFixture")(function* (
  reviewer = false,
  child = !reviewer,
  readonlyKind?: "planning" | "review" | "investigation",
  memory = false,
) {
  yield* TestClock.setTime(Date.parse(at) + 1);
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const fs = yield* FileSystem.FileSystem;
  const scratch = yield* fs.makeTempDirectoryScoped();
  const main = scratch + "/main";
  const assigned = scratch + "/assigned";
  const agentDirectory = scratch + "/agent";
  const nativeStateRoot = scratch + "/state";
  yield* fs.makeDirectory(agentDirectory);
  yield* fs.makeDirectory(nativeStateRoot);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* spawner.spawn(ChildProcess.make("/usr/bin/git", args));
        const [stdout, code] = yield* Effect.all(
          [collectUint8StreamText({ stream: process.stdout, maxBytes: 8192 }), process.exitCode],
          { concurrency: "unbounded" },
        );
        expect(Number(code)).toBe(0);
        return stdout.text.trim();
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
  const baseOid = yield* git(["-C", main, "rev-parse", "HEAD"]);
  yield* git(["-C", main, "worktree", "add", "-qb", "required-root", assigned]);
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  const captureClaim = {
    ...repository,
    execute: (command: ProjectWorkCommand) => {
      if (
        command.type === "project-work.foundation.commit" &&
        command.transition?.kind === "claim"
      ) {
        pending = command;
        return Effect.fail(new ProjectWorkPolicyError("invalid-state", "Retain new context claim"));
      }
      if (command.type === "project-work.foundation.commit")
        return repository.execute({
          ...command,
          records: command.records.map((r) =>
            r.kind === "role-revision"
              ? {
                  ...r,
                  model,
                  ...(memory
                    ? {
                        memoryAccess: "project",
                        tools: ["project-work.write", "project-work.read-task"],
                      }
                    : {}),
                }
              : r,
          ),
        });
      return repository.execute(command);
    },
  };
  yield* seed(reviewer && readonlyKind === undefined ? "reviewer" : "implementer", "reserved", {
    nativeSessionId: null,
    roleTools: [],
    toolIds: [],
    issueCredential: false,
  }).pipe(Effect.provideService(ProjectWorkRepository, captureClaim), Effect.result);
  if (!pending || pending.transition?.kind !== "claim")
    return yield* Effect.die("Missing original context claim");
  yield* repository.execute(
    yield* decodeRequiredFoundation({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "required-limits",
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      attribution,
      committedAt: at,
      records: [
        {
          kind: "limits",
          projectId,
          recordId: "required-limits",
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "configured",
          environmentModelCalls: 4,
          projectWritableWorkers: 2,
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
  const role = (yield* readCurrentState(sql, projectId)).foundationRecords?.find(
    (r) => r.kind === "role-revision",
  );
  if (role?.kind !== "role-revision") return yield* Effect.die("Missing required role");
  const configuration = {
    ...pending.transition.binding.configuration,
    runtimeVersion: "0.99.1",
    instructionsHash: NodeCrypto.createHash("sha256").update(role.instructions).digest("hex"),
    ...(memory ? { toolIds: [...role.tools] } : {}),
  };
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  const reserve = Effect.fn("requiredTransferFixture.reserve")(function* (
    claim: typeof ProjectWorkFoundationCommitCommand.Type,
    path: string,
    branch: string,
    id: string,
  ) {
    if (claim.transition?.kind !== "claim") return yield* Effect.die("Missing context transition");
    const binding = {
      ...claim.transition.binding,
      worktree: path,
      branch,
      model,
      configuration: {
        ...claim.transition.binding.configuration,
        runtimeVersion: "0.99.1",
        ...(memory ? { toolIds: [...role.tools] } : {}),
        ...(readonlyKind === undefined || id === "required-root"
          ? { instructionsHash: configuration.instructionsHash }
          : {}),
      },
      ...(id === "required-root" && child
        ? { threadId: ThreadId.make("required-parent-thread") }
        : {}),
    };
    const request: ProjectTeamDispatchRequest = {
      dispatchId: id,
      claim: {
        ...claim,
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        transition: { ...claim.transition, binding },
      },
      git: {
        effectId: id,
        runId: binding.recordId,
        generation: binding.generation,
        primaryRoot: main,
        commonGitDirectory: main + "/.git",
        worktreePath: path,
        branchRef: branch,
        baseRef: "refs/heads/main",
        baseOid,
        ownershipToken: id + "-owner",
        policyHash: "b".repeat(64),
      },
      setupId: id + "-setup",
      initializeOperationId: id + "-initialize",
      assignmentOperationId: id + "-assignment",
      assignment: "Implement the approved retained context",
    };
    const snapshot = yield* journal.claimEffect((yield* journal.reserve(request)).fence);
    yield* journal.readStageReceipts(snapshot.fence.dispatchId);
    return { request, snapshot, binding };
  });
  let retained = yield* reserve(pending, assigned, "refs/heads/required-root", "required-root");
  if (child) {
    const parentOperations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
    const parentRequest = {
      threadId: retained.binding.threadId,
      kind: "initialize" as const,
      operationId: retained.request.initializeOperationId,
    };
    const parentAllocation = yield* preallocatePiManagedProcess({
      workspaceRoot: retained.binding.worktree,
      workspaceAccess: "readonly",
      nativeStateRoot,
      protectedRoots: [main],
      runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
      argv: ["/bin/true"],
      memoryBytes: 33554432,
      runtimeSeconds: 10,
    });
    const parent = yield* parentOperations.prepare(
      { providerInstanceId, threadId: retained.binding.threadId },
      parentRequest,
      NodeCrypto.createHash("sha256")
        .update(canonicalProjectWorkPayload(parentRequest))
        .digest("hex"),
      {
        allocation: parentAllocation,
        workerId: "required-parent",
        operationId: retained.request.initializeOperationId,
        resourceHash: piManagedSkillResourceIdentity([]),
      },
    );
    yield* parentOperations.persistNative(parent, {
      sessionId: "required-parent-session",
      sessionReference: "sessions/parent.jsonl",
      leafId: null,
      persisted: false,
    });
    yield* sql`UPDATE project_team_pi_operation SET status='settled' WHERE operation_id=${parent.operation.operationId}`;
    if (readonlyKind !== undefined) {
      let state = yield* readCurrentState(sql, projectId);
      const parentTask = state.tasks.find((task) => task.taskId === retained.binding.taskId);
      const specification = state.foundationRecords?.find(
        (record) =>
          record.kind === "gate" &&
          record.taskId === parentTask?.taskId &&
          record.gate === "specification",
      );
      const plan = state.foundationRecords?.find(
        (record) => record.kind === "plan-revision" && record.taskId === parentTask?.taskId,
      );
      const planGate = state.foundationRecords?.find(
        (record) =>
          record.kind === "gate" && record.taskId === parentTask?.taskId && record.gate === "plan",
      );
      if (
        !parentTask ||
        specification?.kind !== "gate" ||
        plan?.kind !== "plan-revision" ||
        planGate?.kind !== "gate"
      )
        return yield* Effect.die("Missing real retained parent scope");
      const human = {
        actor: { kind: "human", id: "readonly-runtime-human" },
        source: { kind: "web", id: "readonly-runtime-browser" },
        recordedAt: at,
      } as const;
      const envelope = {
        projectId,
        taskId: parentTask.taskId,
        commandId: "readonly-runtime-grant",
        expectedRevision: state.revision,
        expectedTaskRevision: parentTask.revision,
      };
      yield* repository.execute(
        yield* decodeRequiredFoundation({
          type: "project-work.foundation.commit",
          projectId,
          commandId: envelope.commandId,
          expectedRevision: state.revision,
          attribution: human,
          committedAt: at,
          records: [],
          guided: {
            intent:
              readonlyKind === "investigation"
                ? {
                    ...envelope,
                    type: "project-team.investigation.start",
                    objective: "Investigate original bounded scope",
                    outputDescriptions: ["Sourced investigation findings"],
                  }
                : {
                    ...envelope,
                    type: "project-team.assignment.start",
                    assignmentKind: readonlyKind,
                    objective:
                      readonlyKind === "planning"
                        ? "Draft the first child plan"
                        : "Review original approved scope",
                    outputDescriptions: [
                      readonlyKind === "planning"
                        ? "Proposed first plan"
                        : "Independent review findings",
                    ],
                    specRevision: parentTask.specRevision,
                    specificationGateId: specification.recordId,
                    expectedSpecificationGateRevision: specification.revision,
                    parentPlan: {
                      recordId: plan.recordId,
                      expectedRecordRevision: plan.revision,
                      planRevision: plan.planRevision,
                      gateId: planGate.recordId,
                      expectedGateRevision: planGate.revision,
                    },
                  },
          },
        }),
      );
      state = yield* readCurrentState(sql, projectId);
      const grant = state.foundationRecords?.find(
        (record) =>
          record.kind === "gate" &&
          record.taskId !== parentTask.taskId &&
          (record.gate === "assignment" || record.gate === "investigation"),
      );
      const task = state.tasks.find(
        (task) => task.taskId === (grant?.kind === "gate" ? grant.taskId : undefined),
      );
      const generatedRole = state.foundationRecords?.find(
        (record) => record.kind === "role-revision" && record.recordId !== "role",
      );
      if (!task || grant?.kind !== "gate" || generatedRole?.kind !== "role-revision")
        return yield* Effect.die("Missing real readonly child scope");
      const roleRecord = {
        ...generatedRole,
        recordId: "readonly-runtime-role",
        roleId: "readonly-runtime-role",
        revision: 0,
        model,
        delegationDepth: role.delegationDepth,
      };
      yield* repository.execute(
        yield* decodeRequiredFoundation({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "readonly-runtime-configure",
          expectedRevision: state.revision,
          attribution: human,
          committedAt: at,
          records: [
            roleRecord,
            {
              kind: "member",
              projectId,
              recordId: "readonly-runtime-member",
              revision: 0,
              generation: 0,
              updatedAt: at,
              status: "active",
              name: "Readonly context worker",
              coordinator: false,
              roleRevisionId: roleRecord.recordId,
            },
          ],
        }),
      );
      state = yield* readCurrentState(sql, projectId);
      const binding = {
        kind: "run-binding",
        projectId,
        recordId: "required-child-binding",
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "reserved",
        taskId: task.taskId,
        attemptId: "required-child-attempt",
        memberId: "readonly-runtime-member",
        roleRevisionId: roleRecord.recordId,
        parentRunId: retained.binding.recordId,
        providerInstanceId,
        threadId,
        environmentId: "environment",
        model,
        configuration: {
          ...configuration,
          instructionsHash: NodeCrypto.createHash("sha256")
            .update(roleRecord.instructions)
            .digest("hex"),
        },
        worktree: "/workspace",
        branch: "task",
        leaseGeneration: 0,
        specRevision: task.specRevision,
        planRevision: 0,
        authorizationGateId: grant.recordId,
        scopeHash: projectTeamScopeHash(state, task.taskId),
      };
      pending = yield* decodeRequiredFoundation({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "readonly-runtime-claim",
        expectedRevision: state.revision,
        attribution,
        committedAt: at,
        records: [],
        transition: {
          kind: "claim",
          taskId: task.taskId,
          expectedTaskRevision: task.revision,
          authorizationGateId: grant.recordId,
          expectedGateRevision: grant.revision,
          binding,
          claim: {
            type: "project-work.task.claim",
            projectId,
            taskId: task.taskId,
            commandId: "readonly-runtime-claim",
            attemptId: binding.attemptId,
            leaseToken: "readonly-runtime-lease",
            leasedUntil: "2030-01-01T00:00:00.000Z",
            claimedAt: at,
          },
        },
      });
    } else {
      yield* repository.execute({
        type: "project-work.task.create",
        projectId,
        taskId: ProjectWorkTaskId.make("required-child"),
        commandId: CommandId.make("required-child-create"),
        title: "Child task",
        createdAt: at,
      });
      yield* repository.execute(
        yield* decodeRequiredFoundation({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "required-child-membership",
          expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
          attribution,
          committedAt: at,
          records: [
            {
              kind: "task-membership",
              projectId,
              recordId: "required-child-membership",
              revision: 0,
              generation: 0,
              updatedAt: at,
              status: "active",
              taskId: "required-child",
              parentTaskId: retained.binding.taskId,
              executionKind: "managed",
              deliverableKind: "code",
              controlState: "active",
            },
          ],
        }),
      );
      pending = undefined;
      yield* createManagedAssignment({
        taskId: ProjectWorkTaskId.make("required-child"),
        recordId: "required-child-binding",
        attemptId: "required-child-attempt",
        commandId: "required-child-claim",
        providerInstanceId,
        threadId,
        role,
        status: "reserved",
        configuration,
        parentRunId: retained.binding.recordId,
      }).pipe(Effect.provideService(ProjectWorkRepository, captureClaim), Effect.result);
      if (!pending) return yield* Effect.die("Missing child claim");
    }
    const childPath = scratch + "/child";
    yield* git(["-C", main, "worktree", "add", "-qb", "required-child", childPath]);
    retained = yield* reserve(pending, childPath, "refs/heads/required-child", "required-child");
  }
  let allocations = 0;
  let transports = 0;
  const options: PiManagedRuntimeLiveOptions = {
    environmentId: "environment",
    agentDirectory,
    nativeStateRoot,
    protectedRoots: [main],
    runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
    workerArgv: () => {
      allocations++;
      return ["/bin/true"];
    },
    memoryBytes: 33554432,
    cleanupDeadlineMs: 1000,
    maxInputTokens: 100,
    maxOutputTokens: 100,
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
      throw Error("Required context transport forbidden");
    },
  };
  const runtime = yield* makePiManagedRuntimeLive(options);
  const instance = yield* runtime.forInstance({
    instanceId: providerInstanceId,
    enabled: true,
    configuration: {},
  });
  const reader = yield* makeProjectTeamContext({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 128,
  });
  return {
    sql,
    repository,
    fs,
    options,
    instance,
    reader,
    ...retained,
    get allocations() {
      return allocations;
    },
    get transports() {
      return transports;
    },
  };
});

for (const compactProof of [
  undefined,
  "beforeAcquire",
  "beforeStart",
  "afterAwait",
  "successorReplay",
  "memoryAdmission",
  "memoryAccounting",
  "memoryPipeline",
  "memoryFailure",
] as const)
  it.effect(
    compactProof === undefined
      ? "managed compact transfers current required context after durable association and replays without another execution"
      : compactProof === "memoryAdmission"
        ? "retains exact memory selection against the executing operation before processing and replays after terminal"
        : compactProof === "memoryAccounting"
          ? "accounts memory and ordinary stages against the same executing operation and shared capacity"
          : compactProof === "memoryPipeline"
            ? "processes an exact admitted source through shared model accounting and the configured index consumer"
            : compactProof === "memoryFailure"
              ? "retains a committed memory selection and unknown charge until authenticated local drain without resend"
              : compactProof === "successorReplay"
                ? "retained compact replay preserves the latest successful native head without another execution"
                : `compact fences protected context at ${compactProof} while permitting accounting and clock drift`,
    () =>
      scoped(
        Effect.gen(function* () {
          let memoryReady = false;
          let consumeMemory:
            | ((
                principal: Authorization.ProjectTeamPrincipal,
                effectId: string,
              ) => Effect.Effect<void, ProjectMemoryServiceError>)
            | undefined;
          let memoryExchanges = 0;
          let memoryBackendCalls = 0;
          let memoryPipelineFailure = "";
          let memoryPipelineError: ProjectMemoryServiceError | undefined;
          const memoryDrains = new Set<string>();
          let reconcileMemory:
            | ((id: string) => Effect.Effect<void, ProjectMemoryServiceError>)
            | undefined;
          const f = yield* requiredTransferFixture(
            false,
            false,
            undefined,
            compactProof === "memoryAdmission" ||
              compactProof === "memoryAccounting" ||
              compactProof === "memoryPipeline" ||
              compactProof === "memoryFailure",
          ).pipe(
            Effect.provideService(ProjectMemoryPorts, {
              assertConfigured: () =>
                memoryReady
                  ? Effect.void
                  : Effect.fail(
                      new ProjectMemoryServiceError({
                        reason: "Controlled processing is not configured",
                      }),
                    ),
              consume: (principal, effectId) =>
                consumeMemory === undefined ? Effect.void : consumeMemory(principal, effectId),
            }),
          );
          let memoryRequest: typeof ProjectTeamMemoryProcessIntent.Type | undefined;
          let memoryReceipt: typeof ProjectWorkWriteResult.Type | undefined;
          let memorySourceId: string | undefined;
          const journal = yield* makeProjectTeamDispatchJournal({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 4,
            // These stage receipts sequence the disposable SQL/Git fixture, not a native worker.
            verifyStage: (receipt, original) =>
              receipt.evidence.bindingId === original.intent.request.git.runId
                ? Effect.void
                : Effect.fail(
                    new ProjectTeamDispatchJournalError({ reason: "Foreign controlled stage" }),
                  ),
          });
          let snapshot = f.snapshot;
          const stage = Effect.fn("compactLive.controlledStage")(function* (
            value:
              | "workspace-ready"
              | "setup-complete"
              | "session-bound"
              | "assignment-intent"
              | "assignment-observed",
          ) {
            snapshot = yield* journal.readRetained(
              (yield* journal.advanceStage(snapshot.fence, {
                receiptId: `compact-live-${value}`,
                stage: value,
                evidence: { bindingId: f.binding.recordId },
              })).fence.dispatchId,
            );
          });
          yield* stage("workspace-ready");
          yield* stage("setup-complete");
          let runs = 0;
          let constructed = 0;
          let runEntries = 0;
          let diagnostic = "";
          let compactText = "";
          let expectedContext = "";
          let expectedProvenance = "";
          let expectedPredecessor = f.request.assignmentOperationId;
          let expectedRequestId = "live-compact-original";
          const entries: Array<{
            type: string;
            id: string;
            parentId: string | null;
            timestamp: string;
            message: {
              role: string;
              content: Array<{ type: string; text: string }>;
              timestamp: number;
            };
          }> = [];
          const original = SessionRuntime.makePiSessionRuntime;
          const executionServices = yield* Effect.context<
            | SqlClient.SqlClient
            | ProjectWorkRepository
            | Authorization.ProjectTeamAuthorization
            | ProjectWorkGateway
          >();
          const spy = vi.spyOn(SessionRuntime, "makePiSessionRuntime").mockImplementation((input) =>
            original(input).pipe(
              Effect.tapCause((cause) =>
                Effect.sync(() => {
                  diagnostic = "construction: " + Cause.pretty(cause);
                }),
              ),
              Effect.map((session) => {
                constructed++;
                return {
                  ...session,
                  run: () => {
                    runEntries++;
                    return Effect.gen(function* () {
                      runs++;
                      const rows = yield* f.sql<{
                        status: string;
                        intent_json: string;
                        deadline_at_ms: number;
                      }>`SELECT status,intent_json,deadline_at_ms
          FROM project_team_pi_operation WHERE operation_id=${input.operation.operationId}`;
                      const row = rows[0];
                      if (rows.length !== 1 || !row)
                        return yield* Effect.die(
                          "Missing durable operation before controlled execution",
                        );
                      expect(row.status).toBe("prepared");
                      if (input.operation.operationKind === "compact") {
                        compactText =
                          input.transferTexts.find((entry) => entry.transferId === "context")
                            ?.text ?? "";
                        expect(input.bootstrap.prompt).toBeNull();
                        expect(input.bootstrap.native?.leafId).toBe(entries.at(-1)?.id);
                        expect(compactText).toContain(expectedContext);
                        expect(row.intent_json).toContain(expectedProvenance);
                        expect(row.intent_json).toContain(
                          NodeCrypto.createHash("sha256").update(compactText).digest("hex"),
                        );
                        expect(decodeRequiredJson(row.intent_json)).toMatchObject({
                          compaction: {
                            dispatchId: snapshot.fence.dispatchId,
                            predecessorOperationId: expectedPredecessor,
                            requestId: expectedRequestId,
                            contextProvenanceSha256: expectedProvenance,
                          },
                        });
                      }
                      const allocation = input.persistence.allocation;
                      // Synthetic owner/drain and accounted ports; no managed worker, SDK or model is launched.
                      const owner = {
                        type: "owner" as const,
                        unit: allocation.unit,
                        nonce: allocation.nonce,
                        invocation: "a".repeat(32),
                        cgroup: `/sys/fs/cgroup/${allocation.unit}`,
                        pid: 99999999,
                        memoryBytes: allocation.policy.memoryBytes,
                        swapBytes: 0,
                        oomGroup: 1,
                      };
                      yield* input.persistence.claimActivation(allocation);
                      yield* input.persistence.beforeStart(owner);
                      const native = {
                        sessionId: "required-compact-session",
                        sessionReference: "sessions/required-compact.jsonl",
                        leafId:
                          input.operation.operationKind === "compact"
                            ? `required-compact-${input.operation.operationId}`
                            : `required-${input.operation.operationKind}`,
                        persisted: true,
                      };
                      entries.push({
                        type: "message",
                        id: native.leafId,
                        parentId: entries.at(-1)?.id ?? null,
                        timestamp: at,
                        message: {
                          role: "user",
                          content: [
                            {
                              type: "text",
                              text:
                                input.transferTexts.find((entry) => entry.transferId === "context")
                                  ?.text ?? "",
                            },
                          ],
                          timestamp: Date.parse(at),
                        },
                      });
                      yield* f.fs.makeDirectory(allocation.launch.nativeStateRoot + "/sessions", {
                        recursive: true,
                      });
                      yield* f.fs.writeFileString(
                        allocation.launch.nativeStateRoot + "/" + native.sessionReference,
                        [
                          {
                            type: "session",
                            version: 3,
                            id: native.sessionId,
                            timestamp: at,
                            cwd: "/workspace",
                          },
                          ...entries,
                        ]
                          .map((entry) => json(entry))
                          .join("\n") + "\n",
                      );
                      const signal = yield* Effect.abortSignal;
                      yield* Effect.tryPromise(() =>
                        input.persistNative(
                          {
                            version: 1,
                            ...input.identity,
                            ...input.operation,
                            sequence: 0,
                            message:
                              input.operation.operationKind === "initialize"
                                ? { type: "initialized", native }
                                : {
                                    type: "native",
                                    lifecycleId: 1,
                                    native,
                                  },
                          },
                          signal,
                        ),
                      );
                      const accountingReceipts: Array<
                        SessionRuntime.PiSessionTerminal["accountingReceipts"][number]
                      > = [];
                      if (input.operation.operationKind !== "initialize") {
                        const fields = {
                          workerId: input.identity.workerId,
                          generation: input.identity.generation,
                          operationId: input.operation.operationId,
                          requestId: 1,
                          routeId: input.broker.routeId,
                          provider: input.broker.provider,
                          model: input.broker.model,
                          maxInputTokens: input.broker.maxInputTokens,
                          maxOutputTokens: input.broker.maxOutputTokens,
                          callCount: 1 as const,
                          deadlineAtMs: row.deadline_at_ms,
                        };
                        const reserved = yield* Effect.tryPromise(() =>
                          input.broker.reserveRequest(fields, signal),
                        );
                        const bindRequestInput = input.broker.bindRequestInput;
                        if (bindRequestInput)
                          yield* Effect.tryPromise(() =>
                            bindRequestInput(
                              {
                                reservationId: reserved.reservationId,
                                encodedRequestSha256: "d".repeat(64),
                              },
                              signal,
                            ),
                          );
                        const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
                        const settled = yield* Effect.tryPromise(() =>
                          input.broker.settleRequest({
                            ...fields,
                            reservationId: reserved.reservationId,
                            transportDrained: true,
                            outcome: "reported",
                            chargedInputTokens: 10,
                            chargedOutputTokens: 2,
                            reportedModel: input.broker.model,
                            reportedUsage: usage,
                          }),
                        );
                        accountingReceipts.push({
                          requestId: 1,
                          reservationId: reserved.reservationId,
                          accountingReceiptId: settled.accountingReceiptId,
                          routeId: fields.routeId,
                          provider: fields.provider,
                          model: fields.model,
                          reportedModel: fields.model,
                          usage,
                        });
                      }
                      if (
                        (compactProof === "memoryAdmission" ||
                          compactProof === "memoryAccounting" ||
                          compactProof === "memoryPipeline" ||
                          compactProof === "memoryFailure") &&
                        input.operation.operationKind === "prompt"
                      ) {
                        const gateway = yield* ProjectWorkGateway;
                        const authorization = yield* Authorization.ProjectTeamAuthorization;
                        const credential = yield* authorization.issueCredential({
                          providerInstanceId,
                          threadId,
                        });
                        if (credential === undefined)
                          return yield* Effect.die("Original memory credential missing");
                        const principal = {
                          actor: {
                            kind: "agent" as const,
                            id: Authorization.managedActorId(credential.credential),
                          },
                          managed: credential.credential,
                        };
                        const comment = yield* decodeMemorySourceComment({
                          commentId: "live-memory-comment",
                          projectId,
                          taskId: f.binding.taskId,
                          body: "The approved operation retains exact parser provenance.",
                          revision: 0,
                          createdAt: at,
                        });
                        yield* gateway.write(
                          {
                            type: "project-work.comment.add",
                            commandId: CommandId.make("live-memory-comment-add"),
                            projectId,
                            comment,
                            addedAt: at,
                          },
                          principal.actor,
                          { kind: "mcp", id: input.identity.workerId },
                          principal,
                        );
                        const contentGuard = yield* Effect.gen(function* () {
                          return yield* ProjectWorkContentGuard;
                        }).pipe(Effect.provide(ProjectWorkContentGuardLive));
                        const memory = makeProjectMemoryService({
                          sql: f.sql,
                          repository: f.repository,
                          authorization,
                          contentGuard,
                          environmentId: f.binding.environmentId,
                        });
                        yield* memory.capture(principal, {
                          kind: "comment",
                          retainedId: comment.commentId,
                        });
                        const page = yield* gateway
                          .read(
                            {
                              operation: "memory-sources",
                              projectId,
                              taskId: f.binding.taskId,
                              limit: 32,
                            },
                            principal,
                          )
                          .pipe(Effect.flatMap(decodeMemorySources));
                        const selection = page.items[0]?.selection;
                        const state = yield* readCurrentState(f.sql, projectId);
                        const task = state.tasks.find((entry) => entry.taskId === f.binding.taskId);
                        if (selection === undefined || task === undefined)
                          return yield* Effect.die("Memory selector missing");
                        const request = yield* decodeMemoryOwnerRequest({
                          type: "project-team.memory.process",
                          commandId: "live-memory-select",
                          projectId,
                          taskId: task.taskId,
                          expectedRevision: state.revision,
                          expectedTaskRevision: task.revision,
                          specRevision: task.specRevision,
                          planRevision: f.binding.planRevision,
                          selection,
                        });
                        const toolInput = { arguments: { intentJSON: json(request) } };
                        const call = {
                          type: "tool-call" as const,
                          callId: 1,
                          nativeCallId: "live-memory-select",
                          lifecycleId: 1,
                          toolName: "project_work_write",
                          execution: "bridge" as const,
                          input: {
                            transferId: "live-memory-select-input",
                            totalBytes: Buffer.byteLength(json(toolInput)),
                          },
                        };
                        const disabled = yield* Effect.tryPromise({
                          try: () => input.executeBridgeTool(call, toolInput, signal),
                          catch: controlledCallbackError,
                        }).pipe(Effect.result);
                        expect(disabled._tag).toBe("Failure");
                        expect(
                          yield* f.sql`SELECT owner_json,receipt_json FROM project_team_memory_job
                          WHERE effect_id=${selection.effectId}`,
                        ).toEqual([{ owner_json: null, receipt_json: null }]);
                        expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(
                          state.revision,
                        );
                        memoryReady = true;
                        const changedSelector = yield* Effect.tryPromise({
                          try: () =>
                            input.executeBridgeTool(
                              call,
                              {
                                arguments: {
                                  intentJSON: json({
                                    ...request,
                                    selection: { ...selection, contentHash: "0".repeat(64) },
                                  }),
                                },
                              },
                              signal,
                            ),
                          catch: controlledCallbackError,
                        }).pipe(Effect.result);
                        expect(changedSelector._tag).toBe("Failure");
                        const forgedOwner = yield* Effect.tryPromise({
                          try: () =>
                            input.executeBridgeTool(
                              call,
                              {
                                arguments: {
                                  intentJSON: json({
                                    ...request,
                                    owner: { operationId: input.operation.operationId },
                                    model: "unapproved",
                                  }),
                                },
                              },
                              signal,
                            ),
                          catch: controlledCallbackError,
                        }).pipe(Effect.result);
                        expect(forgedOwner._tag).toBe("Failure");
                        expect(
                          yield* f.sql`SELECT owner_json,receipt_json FROM project_team_memory_job
                          WHERE effect_id=${selection.effectId}`,
                        ).toEqual([{ owner_json: null, receipt_json: null }]);
                        expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(
                          state.revision,
                        );
                        if (compactProof === "memoryPipeline" || compactProof === "memoryFailure") {
                          const drained = memoryDrains;
                          const indexed = new Set<string>();
                          const configuration: ProjectMemoryProcessingConfiguration = {
                            version: 1,
                            extraction: {
                              endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
                              routeId: "controlled-ling",
                              credentialRef: "controlled-extraction",
                              maximumInputTokens: 800,
                              maximumOutputTokens: 50,
                            },
                            embedding: {
                              endpoint: "https://openrouter.ai/api/v1/embeddings",
                              routeId: "controlled-nvidia",
                              credentialRef: "controlled-embedding",
                              maximumInputTokens: 400,
                              maximumOutputTokens: 1,
                            },
                            companion: {
                              executable: "/runtime/python",
                              scriptTarget: "/runtime/mem0.py",
                              storeRoot: "/controlled/memory",
                              memoryBytes: 16777216,
                              runtimeFiles: [
                                { source: "/controlled/python", target: "/runtime/python" },
                              ],
                            },
                          };
                          const consumer = yield* makeProjectMemoryProcessingConsumer({
                            environmentId: "environment",
                            maximumConcurrentCalls: 2,
                            maximumConcurrentModelCalls: 2,
                            readConfiguration: Effect.succeed(configuration),
                            assertAdmission: Effect.void,
                            readCredential: () => Effect.succeed("controlled-memory-credential"),
                            confirmModelTransportDrained: (id) =>
                              drained.has(id)
                                ? Effect.void
                                : Effect.fail(
                                    new ProjectMemoryServiceError({
                                      reason: "Controlled drain absent",
                                    }),
                                  ),
                            exchange: (exchange, id) =>
                              Effect.gen(function* () {
                                const saved = yield* f.sql<{ owner: string; status: string }>`SELECT
                                owner_json AS owner,status FROM project_team_memory_job WHERE effect_id=${selection.effectId}`;
                                expect(saved).toHaveLength(1);
                                expect(saved[0]?.status).toBe("claimed");
                                expect(decodeRequiredJson(saved[0]?.owner ?? "null")).toMatchObject(
                                  { commandId: request.commandId },
                                );
                                expect(
                                  yield* f.sql`SELECT request_lane AS lane,status,operation_id FROM project_team_model_request
                                WHERE reservation_id=${id}`,
                                ).toEqual([
                                  {
                                    lane: "memory",
                                    status: "held",
                                    operation_id: input.operation.operationId,
                                  },
                                ]);
                                expect(exchange.credential).toBe("controlled-memory-credential");
                                memoryExchanges += 1;
                                if (compactProof === "memoryFailure")
                                  return yield* new ProjectMemoryServiceError({
                                    reason:
                                      "Controlled exchange outcome is unknown; cancellation has not drained",
                                  });
                                drained.add(id);
                                return {
                                  reportedModel: exchange.model,
                                  inputTokens: 50,
                                  outputTokens: exchange.phase === "extract" ? 5 : 0,
                                  value:
                                    exchange.phase === "extract"
                                      ? [
                                          {
                                            key: "parser-provenance",
                                            body: "The approved parser retains exact provenance.",
                                            quote: "exact parser provenance",
                                          },
                                        ]
                                      : [Array.from({ length: 2048 }, () => 0.125)],
                                };
                              }).pipe(
                                Effect.mapError((error) =>
                                  error._tag === "ProjectMemoryServiceError"
                                    ? error
                                    : new ProjectMemoryServiceError({
                                        reason: "Controlled exchange SQL is unavailable",
                                      }),
                                ),
                              ),
                            companion: (_owner, _configuration, bytes) =>
                              Effect.gen(function* () {
                                const envelope = yield* decodeMemoryCompanionInput(
                                  new TextDecoder().decode(bytes),
                                );
                                memoryBackendCalls += 1;
                                expect(memoryExchanges).toBe(2);
                                expect(envelope.input.projectId).toBe(projectId);
                                const ids = envelope.input.observations.map(
                                  (row) => row.observationId,
                                );
                                if (envelope.operation === "index")
                                  for (const id of ids) indexed.add(id);
                                return new TextEncoder().encode(
                                  json({
                                    protocolVersion: 1,
                                    requestId: envelope.requestId,
                                    operation: envelope.operation,
                                    result:
                                      envelope.operation === "index"
                                        ? { writtenObservationIds: ids }
                                        : {
                                            complete: ids.every((id) => indexed.has(id)),
                                            missingObservationIds: ids.filter(
                                              (id) => !indexed.has(id),
                                            ),
                                            invalidObservationIds: [],
                                            unexpectedBackendIds: [],
                                          },
                                  }),
                                );
                              }).pipe(
                                Effect.mapError(
                                  () =>
                                    new MemoryBackendError({
                                      code: "invalid-request",
                                      message: "Controlled companion envelope is invalid",
                                    }),
                                ),
                              ),
                          }).pipe(Effect.provideService(ProjectWorkContentGuard, contentGuard));
                          consumeMemory = (principal, effectId) =>
                            consumer.consume === undefined
                              ? Effect.die("Configured consumer missing")
                              : consumer.consume(principal, effectId).pipe(
                                  Effect.tapError((error) =>
                                    Effect.sync(() => {
                                      memoryPipelineError = error;
                                    }),
                                  ),
                                  Effect.tapCause((cause) =>
                                    Effect.sync(() => {
                                      memoryPipelineFailure = Cause.pretty(cause);
                                    }),
                                  ),
                                );
                          reconcileMemory = consumer.reconcileTransportDrain;
                        }
                        const selected = yield* Effect.tryPromise({
                          try: () => input.executeBridgeTool(call, toolInput, signal),
                          catch: controlledCallbackError,
                        });
                        if (selected.kind !== "text")
                          return yield* Effect.die("Memory selection returned no receipt");
                        memoryReceipt = yield* decodeReportReceipt(selected.text);
                        memoryRequest = request;
                        const jobs = yield* f.sql<{
                          owner: string;
                          status: string;
                          receipt: string | null;
                        }>`SELECT
                          owner_json AS owner,status,receipt_json AS receipt FROM project_team_memory_job
                          WHERE effect_id=${selection.effectId}`;
                        expect(jobs).toHaveLength(1);
                        const operationCaps = yield* f.sql<{
                          maximum: number;
                        }>`SELECT maximum_tokens AS maximum
                          FROM project_team_pi_operation WHERE operation_id=${input.operation.operationId}`;
                        expect(decodeRequiredJson(jobs[0]?.owner ?? "null")).toMatchObject({
                          version: 1,
                          commandId: request.commandId,
                          selection,
                          operation: {
                            operationId: input.operation.operationId,
                            workerId: input.identity.workerId,
                            bindingId: f.binding.recordId,
                            taskId: task.taskId,
                            generation: input.identity.generation,
                            operationMaximumTokens: operationCaps[0]?.maximum,
                          },
                        });
                        if (compactProof === "memoryPipeline") {
                          expect({ failure: memoryPipelineFailure }).toEqual({ failure: "" });
                          expect(jobs[0]?.status).toBe("settled");
                          expect(decodeRequiredJson(jobs[0]?.receipt ?? "null")).toMatchObject({
                            kind: "index-complete",
                          });
                          expect(memoryExchanges).toBe(2);
                          expect(memoryBackendCalls).toBe(3);
                          const observed =
                            (yield* readCurrentState(f.sql, projectId)).foundationRecords ?? [];
                          expect(
                            observed.filter((row) => row.kind === "memory-observation"),
                          ).toHaveLength(1);
                          expect(
                            observed.find((row) => row.kind === "memory-extraction"),
                          ).toMatchObject({ status: "indexed" });
                          const available = yield* gateway
                            .read(
                              { operation: "memory-sources", projectId, taskId: f.binding.taskId },
                              principal,
                            )
                            .pipe(Effect.flatMap(decodeMemorySources));
                          expect(available.items[0]?.status).toBe("indexed");
                        } else if (compactProof === "memoryFailure") {
                          expect(jobs[0]).toMatchObject({ status: "uncertain", receipt: null });
                          expect(memoryReceipt.receipt.status).toBe("accepted");
                          expect(memoryPipelineError).toMatchObject({
                            reason:
                              "Controlled exchange outcome is unknown; cancellation has not drained",
                          });
                          expect(memoryExchanges).toBe(1);
                          expect(memoryBackendCalls).toBe(0);
                          const reservations = yield* f.sql<{
                            id: string;
                            status: string;
                            capacity: string;
                            input: number;
                            output: number;
                            receipt: string;
                          }>`SELECT reservation_id AS id,status,
                            capacity_state AS capacity,charged_input_tokens AS input,charged_output_tokens AS output,
                            accounting_receipt_id AS receipt FROM project_team_model_request WHERE request_lane='memory'`;
                          expect(reservations).toHaveLength(1);
                          const original = reservations[0];
                          if (original === undefined || reconcileMemory === undefined)
                            return yield* Effect.die("Original unknown memory reservation absent");
                          expect(original).toMatchObject({
                            status: "unknown",
                            capacity: "quarantine",
                            input: 800,
                            output: 50,
                          });
                          expect(
                            yield* reconcileMemory(original.id).pipe(Effect.result),
                          ).toMatchObject({ _tag: "Failure" });
                          expect(
                            yield* f.sql`SELECT capacity_state FROM project_team_model_request
                            WHERE reservation_id=${original.id}`,
                          ).toEqual([{ capacity_state: "quarantine" }]);
                          memoryDrains.add(original.id);
                          yield* reconcileMemory(original.id);
                          expect(
                            yield* f.sql`SELECT status,capacity_state AS capacity,charged_input_tokens AS input,
                            charged_output_tokens AS output,accounting_receipt_id AS receipt FROM project_team_model_request
                            WHERE reservation_id=${original.id}`,
                          ).toEqual([
                            {
                              status: "unknown",
                              capacity: "released",
                              input: 800,
                              output: 50,
                              receipt: original.receipt,
                            },
                          ]);
                          expect(
                            yield* f.sql`SELECT status,receipt_json FROM project_team_memory_job
                            WHERE effect_id=${selection.effectId}`,
                          ).toEqual([{ status: "uncertain", receipt_json: null }]);
                        } else expect(jobs[0]).toMatchObject({ status: "pending", receipt: null });
                        memorySourceId = input.identity.workerId;
                        const charges = yield* f.sql`SELECT * FROM project_team_model_request`;
                        const repeated = yield* Effect.tryPromise({
                          try: () => input.executeBridgeTool(call, toolInput, signal),
                          catch: controlledCallbackError,
                        });
                        expect(repeated).toEqual(selected);
                        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(
                          charges,
                        );
                        if (compactProof === "memoryPipeline") {
                          expect(memoryExchanges).toBe(2);
                          expect(memoryBackendCalls).toBe(3);
                        } else if (compactProof === "memoryFailure") {
                          expect(memoryExchanges).toBe(1);
                          expect(memoryBackendCalls).toBe(0);
                        }
                        if (compactProof === "memoryAccounting") {
                          const admitted = yield* decodeMemoryLedgerOwner(jobs[0]?.owner ?? "null");
                          const operations = yield* makeProjectTeamPiOperations({
                            environmentId: "environment",
                          });
                          const drainedMemory = new Set<string>();
                          const ledger = yield* makeProjectMemoryModelAccounting({
                            environmentId: "environment",
                            maximumConcurrentCalls: 2,
                            maximumConcurrentModelCalls: 2,
                            assertCurrentInTransaction: (saved) =>
                              operations
                                .readMemoryOperationOwnerInTransaction(
                                  {
                                    environmentId: saved.operation.environmentId,
                                    projectId: saved.operation.projectId,
                                    taskId: saved.operation.taskId,
                                    bindingId: saved.operation.bindingId,
                                    generation: saved.operation.generation,
                                    providerInstanceId: saved.operation.providerInstanceId,
                                    threadId: saved.operation.threadId,
                                    operationId: saved.operation.operationId,
                                    workerId: saved.operation.workerId,
                                    ordinal: saved.operation.ordinal,
                                  },
                                  principal,
                                )
                                .pipe(
                                  Effect.mapError(
                                    (error) =>
                                      new ProjectMemoryServiceError({
                                        reason: error.detail ?? error.code,
                                      }),
                                  ),
                                  Effect.flatMap((current) =>
                                    canonicalProjectWorkPayload(current) ===
                                    canonicalProjectWorkPayload(saved.operation)
                                      ? Effect.void
                                      : Effect.fail(
                                          new ProjectMemoryServiceError({ reason: "Owner drift" }),
                                        ),
                                  ),
                                ),
                            assertTransportDrainedInTransaction: (reservationId) =>
                              drainedMemory.has(reservationId)
                                ? Effect.void
                                : Effect.fail(
                                    new ProjectMemoryServiceError({
                                      reason: "Controlled transport is not drained",
                                    }),
                                  ),
                          });
                          expect(admitted.operation.operationMaximumTokens).toBe(1000);
                          const stage = {
                            phase: "extract" as const,
                            routeId: "controlled-command-code",
                            requestId: 1,
                            maxInputTokens: 400,
                            maxOutputTokens: 100,
                            deadlineAtMs: row.deadline_at_ms,
                          };
                          // Twelve ordinary tokens already exist. A memory stage uses
                          // their original operation, rather than a new budget identity.
                          const memoryHeld = yield* ledger.reserve(admitted, stage);
                          expect(memoryHeld.status).toBe("reserved");
                          expect(yield* ledger.reserve(admitted, stage)).toMatchObject({
                            status: "existing",
                            reservationId: memoryHeld.reservationId,
                          });
                          const nativeFields = {
                            workerId: input.identity.workerId,
                            generation: input.identity.generation,
                            operationId: input.operation.operationId,
                            requestId: 2,
                            routeId: input.broker.routeId,
                            provider: input.broker.provider,
                            model: input.broker.model,
                            maxInputTokens: input.broker.maxInputTokens,
                            maxOutputTokens: input.broker.maxOutputTokens,
                            callCount: 1 as const,
                            deadlineAtMs: row.deadline_at_ms,
                          };
                          const ordinaryHeld = yield* Effect.tryPromise(() =>
                            input.broker.reserveRequest(nativeFields, signal),
                          );
                          const beforeDenied =
                            yield* f.sql`SELECT * FROM project_team_model_request`;
                          expect(
                            (yield* ledger
                              .reserve(admitted, {
                                ...stage,
                                phase: "embed",
                                routeId: "controlled-openrouter",
                                maxInputTokens: 1,
                                maxOutputTokens: 1,
                              })
                              .pipe(Effect.result))._tag,
                          ).toBe("Failure");
                          expect(
                            (yield* ledger
                              .reserve(admitted, {
                                ...stage,
                                requestId: 2,
                                maxInputTokens: 300,
                                maxOutputTokens: 100,
                              })
                              .pipe(Effect.result))._tag,
                          ).toBe("Failure");
                          expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(
                            beforeDenied,
                          );
                          const memorySettlement = {
                            ...memoryHeld.reservation,
                            reservationId: memoryHeld.reservationId,
                            outcome: "reported" as const,
                            chargedInputTokens: 100,
                            chargedOutputTokens: 10,
                            transportDrained: true,
                            reportedModel:
                              stage.phase === "extract" ? "inclusionai/ling-3.1-flash:free" : "",
                            reportedInputTokens: 100,
                            reportedOutputTokens: 10,
                          };
                          drainedMemory.add(memoryHeld.reservationId);
                          const settledMemory = yield* ledger.settle(memorySettlement);
                          expect(yield* ledger.settle(memorySettlement)).toEqual(settledMemory);
                          const usage = {
                            prompt_tokens: 10,
                            completion_tokens: 2,
                            total_tokens: 12,
                          };
                          const nativeSettled = yield* Effect.tryPromise(() =>
                            input.broker.settleRequest({
                              ...nativeFields,
                              reservationId: ordinaryHeld.reservationId,
                              outcome: "reported",
                              chargedInputTokens: 10,
                              chargedOutputTokens: 2,
                              reportedModel: nativeFields.model,
                              reportedUsage: usage,
                              transportDrained: true,
                            }),
                          );
                          accountingReceipts.push({
                            requestId: 2,
                            reservationId: ordinaryHeld.reservationId,
                            accountingReceiptId: nativeSettled.accountingReceiptId,
                            routeId: nativeFields.routeId,
                            provider: nativeFields.provider,
                            model: nativeFields.model,
                            reportedModel: nativeFields.model,
                            usage,
                          });
                          const embedding = yield* ledger.reserve(admitted, {
                            ...stage,
                            phase: "embed",
                            routeId: "controlled-openrouter",
                            maxInputTokens: 40,
                            maxOutputTokens: 1,
                          });
                          expect(embedding.reservation.operationId).toBe(
                            input.operation.operationId,
                          );
                          expect(embedding.reservation.requestId).toBe(1);
                          expect(embedding.reservation.scope).not.toBe(
                            memoryHeld.reservation.scope,
                          );
                          const uncertain = yield* ledger.settle({
                            ...embedding.reservation,
                            reservationId: embedding.reservationId,
                            outcome: "unknown",
                            chargedInputTokens: 40,
                            chargedOutputTokens: 1,
                            transportDrained: false,
                          });
                          expect(
                            yield* f.sql`SELECT status,capacity_state FROM project_team_model_request
                            WHERE reservation_id=${embedding.reservationId}`,
                          ).toEqual([{ status: "unknown", capacity_state: "quarantine" }]);
                          const awaitingDrain = yield* ledger.reserve(admitted, {
                            ...stage,
                            requestId: 3,
                            maxInputTokens: 1,
                            maxOutputTokens: 1,
                          });
                          const afterDrainRequest = {
                            ...stage,
                            phase: "embed" as const,
                            routeId: "controlled-openrouter",
                            requestId: 2,
                            maxInputTokens: 1,
                            maxOutputTokens: 1,
                          };
                          expect(
                            (yield* ledger.reserve(admitted, afterDrainRequest).pipe(Effect.result))
                              ._tag,
                          ).toBe("Failure");
                          expect(
                            (yield* ledger
                              .confirmTransportDrained(selection.effectId, embedding.reservationId)
                              .pipe(Effect.result))._tag,
                          ).toBe("Failure");
                          drainedMemory.add(embedding.reservationId);
                          expect(
                            yield* ledger.confirmTransportDrained(
                              selection.effectId,
                              embedding.reservationId,
                            ),
                          ).toEqual(uncertain);
                          expect(
                            yield* ledger.confirmTransportDrained(
                              selection.effectId,
                              embedding.reservationId,
                            ),
                          ).toEqual(uncertain);
                          expect(
                            yield* f.sql`SELECT status,capacity_state FROM project_team_model_request
                            WHERE reservation_id=${embedding.reservationId}`,
                          ).toEqual([{ status: "unknown", capacity_state: "released" }]);
                          const afterDrain = yield* ledger.reserve(admitted, afterDrainRequest);
                          for (const held of [awaitingDrain, afterDrain]) {
                            drainedMemory.add(held.reservationId);
                            yield* ledger.settle({
                              ...held.reservation,
                              reservationId: held.reservationId,
                              outcome: "reported",
                              chargedInputTokens: 0,
                              chargedOutputTokens: 0,
                              reportedModel: held.reservation.model,
                              reportedInputTokens: 0,
                              reportedOutputTokens: 0,
                              transportDrained: true,
                            });
                          }
                          const physical = yield* f.sql<{
                            lane: string;
                            operation: string;
                            tokens: number;
                          }>`SELECT
                            request_lane AS lane,operation_id AS operation,
                            SUM(charged_input_tokens+charged_output_tokens) AS tokens
                            FROM project_team_model_request WHERE operation_id=${input.operation.operationId}
                            GROUP BY request_lane,operation_id ORDER BY request_lane`;
                          expect(physical).toEqual([
                            { lane: "memory", operation: input.operation.operationId, tokens: 151 },
                            { lane: "pi", operation: input.operation.operationId, tokens: 24 },
                          ]);
                        }
                      }
                      const terminal: SessionRuntime.PiSessionTerminal = {
                        identity: input.identity,
                        operation: input.operation,
                        outcome: "success",
                        ownerCaptured: true,
                        native,
                        accountingReceipts,
                        drain: {
                          unit: owner.unit,
                          invocation: owner.invocation,
                          cgroup: owner.cgroup,
                          ownerPid: owner.pid,
                          memoryBytes: owner.memoryBytes,
                          swapBytes: 0,
                          oomGroup: 1,
                          launcherPid: 99999998,
                          childPid: 99999997,
                          childExitCode: 0,
                          kernel: "removed",
                        },
                      };
                      yield* Effect.tryPromise(() => input.persistTerminal(terminal, signal));
                      return terminal;
                    }).pipe(
                      Effect.tapCause((cause) =>
                        Effect.sync(() => {
                          diagnostic = input.operation.operationKind + ": " + Cause.pretty(cause);
                        }),
                      ),
                      Effect.mapError(
                        () =>
                          new SessionRuntime.PiSessionRuntimeError({
                            code: "CONTROLLED_COMPACT_FAILURE",
                          }),
                      ),
                      Effect.provide(executionServices),
                    );
                  },
                };
              }),
            ),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
          const initialized = yield* f.instance.prepareOperation(
            { threadId, kind: "initialize", operationId: f.request.initializeOperationId },
            () => Effect.void,
          );
          expect(spy.mock.calls).toHaveLength(1);
          expect(constructed).toBe(1);
          const initializeResult = yield* initialized.run.pipe(Effect.result);
          expect({
            result: initializeResult,
            constructed,
            runEntries,
            runs,
            diagnostic,
          }).toMatchObject({
            diagnostic: "",
            constructed: 1,
            runEntries: 1,
            runs: 1,
            result: { _tag: "Success", success: { terminal: { outcome: "success" } } },
          });
          yield* stage("session-bound");
          yield* stage("assignment-intent");
          const assigned = yield* f.instance.prepareOperation(
            {
              threadId,
              kind: "prompt",
              operationId: f.request.assignmentOperationId,
              prompt: f.request.assignment,
            },
            () => Effect.void,
          );
          const assignmentResult = yield* assigned.run.pipe(Effect.result);
          expect({
            result: assignmentResult,
            constructed,
            runEntries,
            runs,
            diagnostic,
          }).toMatchObject({
            diagnostic: "",
            constructed: 2,
            runEntries: 2,
            runs: 2,
            result: { _tag: "Success", success: { terminal: { outcome: "success" } } },
          });
          yield* stage("assignment-observed");
          if (
            compactProof === "memoryAdmission" ||
            compactProof === "memoryAccounting" ||
            compactProof === "memoryPipeline" ||
            compactProof === "memoryFailure"
          ) {
            if (
              memoryRequest === undefined ||
              memoryReceipt === undefined ||
              memorySourceId === undefined
            )
              return yield* Effect.die("Executing operation did not retain its memory selection");
            const gateway = yield* ProjectWorkGateway;
            const authorization = yield* Authorization.ProjectTeamAuthorization;
            const issued = yield* authorization.issueCredential({ providerInstanceId, threadId });
            if (issued === undefined)
              return yield* Effect.die("Memory historical credential missing");
            const principal = {
              actor: {
                kind: "agent" as const,
                id: Authorization.managedActorId(issued.credential),
              },
              managed: issued.credential,
            };
            const rows = yield* f.sql`SELECT * FROM project_team_memory_job`;
            const charges = yield* f.sql`SELECT * FROM project_team_model_request`;
            const replay = yield* gateway
              .write(memoryRequest, principal.actor, { kind: "mcp", id: memorySourceId }, principal)
              .pipe(Effect.result);
            // The retained source is admitted once; a stopped owner cannot run a
            // new stage. Historical retry is authenticated without a new port.
            expect(replay).toMatchObject({ _tag: "Success", success: memoryReceipt });
            expect(yield* f.sql`SELECT * FROM project_team_memory_job`).toEqual(rows);
            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(charges);
            expect(runs).toBe(2);
            expect(f.transports).toBe(0);
            if (compactProof === "memoryPipeline") {
              expect(memoryExchanges).toBe(2);
              expect(memoryBackendCalls).toBe(3);
            } else if (compactProof === "memoryFailure") {
              expect(memoryExchanges).toBe(1);
              expect(memoryBackendCalls).toBe(0);
              const waiting = yield* gateway
                .read(
                  { operation: "memory-sources", projectId, taskId: f.binding.taskId },
                  principal,
                )
                .pipe(Effect.flatMap(decodeMemorySources));
              expect(waiting.items[0]?.status).toBe("uncertain");
              expect(waiting.items[0]?.reason).toContain("stopped");
            }
            return;
          }
          const current = yield* f.reader.readRequired(snapshot);
          expectedContext = current.text;
          expectedProvenance = NodeCrypto.createHash("sha256")
            .update(json(current.provenance))
            .digest("hex");
          const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
          const supplied = {
            threadId,
            kind: "compact" as const,
            requestId: MessageId.make("live-compact-original"),
          };
          const boundary = yield* operations.readCompaction(
            { providerInstanceId, threadId },
            supplied,
          );
          const request = { ...supplied, operationId: boundary.operationId };
          const addQuestion = Effect.fn("compactLive.addQuestion")(function* () {
            const state = yield* readCurrentState(f.sql, projectId);
            const gate = state.foundationRecords?.find(
              (record) =>
                record.kind === "gate" &&
                record.taskId === f.binding.taskId &&
                record.gate === "specification",
            );
            if (gate?.kind !== "gate") return yield* Effect.die("Missing compact context gate");
            yield* f.repository.execute(
              yield* decodeRequiredFoundation({
                type: "project-work.foundation.commit",
                projectId,
                commandId: `compact-execution-question-${compactProof}`,
                expectedRevision: state.revision,
                attribution,
                committedAt: at,
                records: [
                  {
                    kind: "question",
                    projectId,
                    recordId: `compact-execution-question-${compactProof}`,
                    revision: 0,
                    generation: 0,
                    updatedAt: at,
                    status: "pending",
                    taskId: f.binding.taskId,
                    senderId: f.binding.memberId,
                    targetGateId: gate.recordId,
                    targetRevision: gate.revision,
                    body: "Required answer changed after durable compaction preparation",
                    choices: [],
                  },
                ],
              }),
            );
          });
          let changeDuringAwait = false;
          const compactInstance =
            compactProof === "afterAwait"
              ? yield* (yield* makePiManagedRuntimeLive({
                  ...f.options,
                  revalidateRuntime: Effect.gen(function* () {
                    if (changeDuringAwait) {
                      changeDuringAwait = false;
                      yield* addQuestion();
                    }
                  }).pipe(Effect.mapError(controlledCallbackError)),
                })).forInstance({
                  instanceId: providerInstanceId,
                  enabled: true,
                  configuration: {},
                })
              : f.instance;
          const compact = yield* compactInstance.prepareOperation(request, () => Effect.void);
          if (
            compactProof === "beforeAcquire" ||
            compactProof === "beforeStart" ||
            compactProof === "afterAwait"
          ) {
            const captured = spy.mock.calls.at(-1)?.[0];
            if (!captured || captured.operation.operationKind !== "compact")
              return yield* Effect.die("Compact runtime was not intercepted");
            const phase = compactProof === "afterAwait" ? "beforeStart" : compactProof;
            const signal = new AbortController().signal;
            const authorizationInput = {
              identity: captured.identity,
              operation: captured.operation,
              phase,
            };
            yield* Effect.tryPromise(() => captured.authorizeCurrent(authorizationInput, signal));
            const beforeContext = yield* f.reader.readRequired(snapshot);
            const allocation = captured.persistence.allocation;
            const owner = {
              type: "owner" as const,
              unit: allocation.unit,
              nonce: allocation.nonce,
              invocation: "a".repeat(32),
              cgroup: `/sys/fs/cgroup/${allocation.unit}`,
              pid: 99999999,
              memoryBytes: allocation.policy.memoryBytes,
              swapBytes: 0,
              oomGroup: 1,
            };
            yield* captured.persistence.claimActivation(allocation);
            yield* captured.persistence.beforeStart(owner);
            const operationRows = yield* f.sql<{ deadline_at_ms: number }>`SELECT deadline_at_ms
            FROM project_team_pi_operation WHERE operation_id=${captured.operation.operationId}`;
            const deadlineAtMs = operationRows[0]?.deadline_at_ms;
            if (deadlineAtMs === undefined)
              return yield* Effect.die("Missing compact operation deadline");
            const modelFields = {
              workerId: captured.identity.workerId,
              generation: captured.identity.generation,
              operationId: captured.operation.operationId,
              requestId: 1,
              routeId: captured.broker.routeId,
              provider: captured.broker.provider,
              model: captured.broker.model,
              maxInputTokens: 10,
              maxOutputTokens: 2,
              callCount: 1 as const,
              deadlineAtMs,
            };
            const reserved = yield* Effect.tryPromise(() =>
              captured.broker.reserveRequest(modelFields, signal),
            );
            yield* Effect.tryPromise(() =>
              captured.broker.settleRequest({
                ...modelFields,
                reservationId: reserved.reservationId,
                transportDrained: true,
                outcome: "reported",
                chargedInputTokens: 10,
                chargedOutputTokens: 2,
                reportedModel: captured.broker.model,
                reportedUsage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
              }),
            );
            yield* TestClock.setTime(Date.parse(at) + 2);
            const ledgerContext = yield* f.reader.readRequired(snapshot);
            expect(ledgerContext.required.remaining).not.toEqual(beforeContext.required.remaining);
            yield* Effect.tryPromise(() => captured.authorizeCurrent(authorizationInput, signal));
            const rows =
              yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`;
            const charges = yield* f.sql`SELECT * FROM project_team_model_request`;
            if (compactProof === "afterAwait") changeDuringAwait = true;
            else yield* addQuestion();
            const denied = yield* Effect.tryPromise(() =>
              captured.authorizeCurrent(authorizationInput, signal),
            ).pipe(Effect.result);
            expect(denied).toMatchObject({ _tag: "Failure" });
            const changedContext = yield* f.reader.readRequired(snapshot);
            expect(changedContext.required.questions).not.toEqual(ledgerContext.required.questions);
            expect(changedContext.text).not.toEqual(ledgerContext.text);
            expect(
              yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`,
            ).toEqual(rows);
            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(charges);
            expect(runs).toBe(2);
            expect(runEntries).toBe(2);
            expect(f.transports).toBe(0);
            return;
          }
          const compactResult = yield* compact.run.pipe(Effect.result);
          expect({
            result: compactResult,
            constructed,
            runEntries,
            runs,
            diagnostic,
          }).toMatchObject({
            diagnostic: "",
            constructed: 3,
            runEntries: 3,
            runs: 3,
            result: { _tag: "Success" },
          });
          if (compactResult._tag !== "Success")
            return yield* Effect.die("Controlled compact failed");
          const terminal = compactResult.success.terminal;
          expect(terminal.outcome).toBe("success");
          expect(compactText).toContain(current.text);
          expect(runs).toBe(3);
          const allocations = f.allocations;
          const rows =
            yield* f.sql`SELECT operation_id,status,intent_json FROM project_team_pi_operation ORDER BY operation_ordinal`;
          const budget =
            yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE project_id=${projectId}`;
          const replay = yield* f.instance.prepareOperation(request, () => Effect.void);
          expect(replay.replayHeadOperationId).toBe(terminal.operation.operationId);
          expect((yield* replay.run).terminal).toEqual(terminal);
          expect(runs).toBe(3);
          expect(f.allocations).toBe(allocations);
          expect(
            yield* f.sql`SELECT operation_id,status,intent_json FROM project_team_pi_operation ORDER BY operation_ordinal`,
          ).toEqual(rows);
          expect(
            yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE project_id=${projectId}`,
          ).toEqual(budget);
          expect(f.transports).toBe(0);
          if (compactProof === "successorReplay") {
            const nextContext = yield* f.reader.readRequired(snapshot);
            expectedContext = nextContext.text;
            expectedProvenance = NodeCrypto.createHash("sha256")
              .update(json(nextContext.provenance))
              .digest("hex");
            expectedPredecessor = terminal.operation.operationId;
            expectedRequestId = "live-compact-successor";
            const nextSupplied = {
              ...supplied,
              requestId: MessageId.make("live-compact-successor"),
            };
            const nextBoundary = yield* operations.readCompaction(
              { providerInstanceId, threadId },
              nextSupplied,
            );
            const next = yield* f.instance.prepareOperation(
              { ...nextSupplied, operationId: nextBoundary.operationId },
              () => Effect.void,
            );
            const successor = yield* next.run;
            expect(successor.terminal.outcome).toBe("success");
            const currentRows =
              yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`;
            const currentCharges = yield* f.sql`SELECT * FROM project_team_model_request`;
            const allocationsAfterSuccessor = f.allocations;
            const recreated = yield* (yield* makePiManagedRuntimeLive(f.options)).forInstance({
              instanceId: providerInstanceId,
              enabled: true,
              configuration: {},
            });
            const retained = yield* recreated.prepareOperation(request, () =>
              Effect.die("Retained compact emitted execution"),
            );
            expect(retained.replayHeadOperationId).toBe(successor.terminal.operation.operationId);
            const replayed = yield* retained.run;
            expect(replayed.terminal).toEqual(terminal);
            expect(replayed.session.resumeCursor).toEqual(successor.terminal.native);
            expect(runs).toBe(4);
            expect(f.allocations).toBe(allocationsAfterSuccessor);
            expect(
              yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`,
            ).toEqual(currentRows);
            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(currentCharges);
            expect(f.transports).toBe(0);
            return;
          }
          let processAllocations = 0;
          const originalAllocate = ManagedProcess.preallocatePiManagedProcess;
          const allocationSpy = vi
            .spyOn(ManagedProcess, "preallocatePiManagedProcess")
            .mockImplementation((launch) => {
              processAllocations++;
              return originalAllocate(launch);
            });
          yield* Effect.addFinalizer(() => Effect.sync(() => allocationSpy.mockRestore()));
          const beforeRace = yield* readCurrentState(f.sql, projectId);
          const questionGate = beforeRace.foundationRecords?.find(
            (record) =>
              record.kind === "gate" &&
              record.taskId === f.binding.taskId &&
              record.gate === "specification",
          );
          if (questionGate?.kind !== "gate")
            return yield* Effect.die("Missing compact context target");
          const changed = yield* makePiManagedRuntimeLive({
            ...f.options,
            revalidateRuntime: Effect.gen(function* () {
              const state = yield* readCurrentState(f.sql, projectId);
              yield* f.repository.execute(
                yield* decodeRequiredFoundation({
                  type: "project-work.foundation.commit",
                  projectId,
                  commandId: "compact-live-context-race",
                  expectedRevision: state.revision,
                  attribution,
                  committedAt: at,
                  records: [
                    {
                      kind: "question",
                      projectId,
                      recordId: "compact-live-context-race",
                      revision: 0,
                      generation: 0,
                      updatedAt: at,
                      status: "pending",
                      taskId: f.binding.taskId,
                      senderId: f.binding.memberId,
                      targetGateId: questionGate.recordId,
                      targetRevision: questionGate.revision,
                      body: "Retained context changed before compaction allocation",
                      choices: [],
                    },
                  ],
                }),
              );
            }).pipe(Effect.mapError(controlledCallbackError)),
          });
          const changedInstance = yield* changed.forInstance({
            instanceId: providerInstanceId,
            enabled: true,
            configuration: {},
          });
          const race = yield* changedInstance
            .prepareOperation(
              { threadId, kind: "compact", requestId: MessageId.make("live-compact-context-race") },
              () => Effect.void,
            )
            .pipe(Effect.result);
          expect(race).toMatchObject({
            _tag: "Failure",
            failure: { detail: "Required context provenance changed before allocation" },
          });
          expect(processAllocations).toBe(0);
          expect(runs).toBe(3);
          expect(spy.mock.calls).toHaveLength(3);
          expect(f.transports).toBe(0);
          expect(
            yield* f.sql`SELECT operation_id,status,intent_json FROM project_team_pi_operation ORDER BY operation_ordinal`,
          ).toEqual(rows);
          const argumentsAfterRace = f.allocations;
          const state = yield* readCurrentState(f.sql, projectId);
          const role = state.foundationRecords?.find(
            (record) =>
              record.kind === "role-revision" && record.recordId === f.binding.roleRevisionId,
          );
          if (role?.kind !== "role-revision") return yield* Effect.die("Missing compact role");
          yield* restoreHistoricalBinding({
            ...role,
            revision: role.revision + 1,
            instructions: role.instructions + " changed",
          });
          expect(
            (yield* f.instance
              .prepareOperation(
                { ...request, requestId: MessageId.make("live-compact-drift") },
                () => Effect.void,
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(runs).toBe(3);
          expect(f.allocations).toBe(argumentsAfterRace);
          expect(processAllocations).toBe(0);
          expect(f.transports).toBe(0);
          expect(
            yield* f.sql`SELECT operation_id,status,intent_json FROM project_team_pi_operation ORDER BY operation_ordinal`,
          ).toEqual(rows);
        }),
      ),
  );

for (const readonlyKind of [undefined, "planning", "investigation", "review"] as const)
  for (const kind of readonlyKind === "review"
    ? (["initialize"] as const)
    : (["initialize", "prompt"] as const))
    it.effect(
      `required context transfer includes ${readonlyKind ?? "approved child"} criteria and ancestor caps for ${kind}`,
      () =>
        scoped(
          Effect.gen(function* () {
            const f = yield* requiredTransferFixture(false, true, readonlyKind);
            expect(f.binding.planRevision).toBe(readonlyKind === undefined ? 1 : 0);
            if (readonlyKind !== undefined)
              expect(
                (yield* readCurrentState(f.sql, projectId)).foundationRecords?.filter(
                  (r) => r.kind === "plan-revision" && r.taskId === f.binding.taskId,
                ),
              ).toEqual([]);
            if (kind === "prompt") {
              const operations = yield* makeProjectTeamPiOperations({
                environmentId: "environment",
              });
              const allocation = yield* preallocatePiManagedProcess({
                workspaceRoot: f.binding.worktree,
                workspaceAccess: "readonly",
                nativeStateRoot: f.options.nativeStateRoot,
                protectedRoots: f.options.protectedRoots,
                runtimeFiles: f.options.runtimeFiles,
                argv: ["/bin/true"],
                memoryBytes: f.options.memoryBytes,
                runtimeSeconds: 10,
              });
              const previous = yield* operations.prepare(
                { providerInstanceId, threadId },
                { threadId, kind: "initialize", operationId: f.request.initializeOperationId },
                NodeCrypto.createHash("sha256")
                  .update(
                    canonicalProjectWorkPayload({
                      threadId,
                      kind: "initialize",
                      operationId: f.request.initializeOperationId,
                    }),
                  )
                  .digest("hex"),
                {
                  allocation,
                  workerId: "required-previous",
                  operationId: f.request.initializeOperationId,
                  resourceHash: piManagedSkillResourceIdentity([]),
                },
              );
              yield* operations.persistNative(previous, {
                sessionId: "required-session",
                sessionReference: "sessions/required.jsonl",
                leafId: null,
                persisted: false,
              });
              yield* f.sql`UPDATE project_team_pi_operation SET status='settled' WHERE operation_id=${previous.operation.operationId}`;
            }
            const current = yield* f.reader.readRequired(f.snapshot);
            let transferred: SessionRuntime.PiSessionRuntimeOptions | undefined;
            const original = SessionRuntime.makePiSessionRuntime;
            const spy = vi
              .spyOn(SessionRuntime, "makePiSessionRuntime")
              .mockImplementation((input) =>
                original(input).pipe(
                  Effect.map((runtime) => ({
                    ...runtime,
                    run: () =>
                      Effect.sync(() => {
                        transferred = input;
                      }).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new SessionRuntime.PiSessionRuntimeError({
                              code: "CONTEXT_INTERCEPTED",
                            }),
                          ),
                        ),
                      ),
                  })),
                ),
              );
            yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
            const prepared = yield* f.instance.prepareOperation(
              kind === "initialize"
                ? { threadId, kind, operationId: f.request.initializeOperationId }
                : {
                    threadId,
                    kind,
                    operationId: f.request.assignmentOperationId,
                    prompt: f.request.assignment,
                  },
              () => Effect.void,
            );
            yield* prepared.run.pipe(Effect.result);
            expect(transferred).toBeDefined();
            const text = transferred?.transferTexts.find(
              (entry) => entry.transferId === "context",
            )?.text;
            expect(text).toContain(current.text);
            expect(text).toContain(
              readonlyKind === undefined
                ? '"description":"Requirement"'
                : readonlyKind === "planning"
                  ? '"description":"Proposed first plan"'
                  : readonlyKind === "investigation"
                    ? '"description":"Sourced investigation findings"'
                    : '"description":"Independent review findings"',
            );
            expect(text).toContain('"parentTaskId":"authorization-task"');
            expect(text).toContain('"gate":"specification"');
            expect(text).toContain('"rootRemainingTokens":1000');
            expect(current.required.tasks).toHaveLength(2);
            expect(current.required.approvals).toHaveLength(readonlyKind === undefined ? 5 : 3);
            if (readonlyKind !== undefined) expect(current.required.tasks[0]?.plan).toBeUndefined();
            expect(transferred?.bootstrap.context.totalBytes).toBe(Buffer.byteLength(text ?? ""));
            expect(f.transports).toBe(0);
            expect(
              yield* f.sql`SELECT owner_json FROM project_team_pi_process WHERE owner_json IS NOT NULL`,
            ).toEqual([]);
          }),
        ),
    );

for (const mode of [
  "missing",
  "corrupt",
  "wrong-operation",
  "oversize",
  "prompt-budget",
  "changed-provenance",
] as const)
  it.effect(`required context transfer rejects ${mode} before managed allocation`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredTransferFixture(false, false);
        const addQuestions = Effect.fn("requiredTransferFixture.addQuestions")(function* (
          count: number,
        ) {
          const state = yield* readCurrentState(f.sql, projectId);
          const gate = state.foundationRecords?.find((r) => r.kind === "gate" && r.gate === "plan");
          if (gate?.kind !== "gate") return yield* Effect.die("Missing current question target");
          yield* f.repository.execute(
            yield* decodeRequiredFoundation({
              type: "project-work.foundation.commit",
              projectId,
              commandId: "required-questions",
              expectedRevision: state.revision,
              attribution,
              committedAt: at,
              records: Array.from({ length: count }, (_, i) => ({
                kind: "question",
                projectId,
                recordId: "required-question-" + i,
                revision: 0,
                generation: 0,
                updatedAt: at,
                status: "pending",
                taskId: f.binding.taskId,
                senderId: f.binding.memberId,
                targetGateId: gate.recordId,
                targetRevision: gate.revision,
                body: "é".repeat(2000),
                choices: [],
              })),
            }),
          );
        });
        if (mode === "missing") yield* f.sql`DELETE FROM project_team_dispatch`;
        if (mode === "corrupt") {
          yield* f.sql`DROP TRIGGER project_team_dispatch_immutable`;
          yield* f.sql`UPDATE project_team_dispatch SET intent_json='{}'`;
        }
        if (mode === "oversize") {
          yield* addQuestions(16);
          const context = yield* f.reader.readForOperation({
            projectId,
            bindingId: f.binding.recordId,
            generation: 0,
            providerInstanceId,
            threadId,
            operationId: f.request.initializeOperationId,
            operationKind: "initialize",
          });
          expect(Buffer.byteLength(context.text)).toBeGreaterThan(65536);
          expect(Buffer.byteLength(context.text)).toBeLessThan(262144);
        }
        if (mode === "prompt-budget") {
          const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
          const request = {
            threadId,
            kind: "initialize" as const,
            operationId: f.request.initializeOperationId,
          };
          const allocation = yield* preallocatePiManagedProcess({
            workspaceRoot: f.binding.worktree,
            workspaceAccess: "readonly",
            nativeStateRoot: f.options.nativeStateRoot,
            protectedRoots: f.options.protectedRoots,
            runtimeFiles: f.options.runtimeFiles,
            argv: ["/bin/true"],
            memoryBytes: f.options.memoryBytes,
            runtimeSeconds: 10,
          });
          const previous = yield* operations.prepare(
            { providerInstanceId, threadId },
            request,
            NodeCrypto.createHash("sha256")
              .update(canonicalProjectWorkPayload(request))
              .digest("hex"),
            {
              allocation,
              workerId: "required-budget-previous",
              operationId: request.operationId,
              resourceHash: piManagedSkillResourceIdentity([]),
            },
          );
          yield* operations.persistNative(previous, {
            sessionId: "required-budget-session",
            sessionReference: "sessions/budget.jsonl",
            leafId: null,
            persisted: false,
          });
          yield* f.sql`UPDATE project_team_pi_operation SET status='settled' WHERE operation_id=${previous.operation.operationId}`;
        }
        let allocations = 0;
        let sessions = 0;
        const originalAllocate = ManagedProcess.preallocatePiManagedProcess;
        const allocationSpy = vi
          .spyOn(ManagedProcess, "preallocatePiManagedProcess")
          .mockImplementation((launch) => {
            allocations++;
            return originalAllocate(launch);
          });
        const sessionSpy = vi
          .spyOn(SessionRuntime, "makePiSessionRuntime")
          .mockImplementation(() => {
            sessions++;
            return Effect.die("Unexpected session after rejected required context");
          });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            allocationSpy.mockRestore();
            sessionSpy.mockRestore();
          }),
        );
        const runtime = yield* makePiManagedRuntimeLive({
          ...f.options,
          ...(mode === "changed-provenance"
            ? { revalidateRuntime: addQuestions(1).pipe(Effect.mapError(controlledCallbackError)) }
            : {}),
        });
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const request: PiManagedOperationRequest =
          mode === "prompt-budget"
            ? {
                threadId,
                kind: "prompt",
                operationId: f.request.assignmentOperationId,
                prompt: "é".repeat(32769),
              }
            : {
                threadId,
                kind: "initialize",
                operationId:
                  mode === "wrong-operation"
                    ? "unrelated-initialize"
                    : f.request.initializeOperationId,
              };
        const result = yield* instance
          .prepareOperation(request, () => Effect.void)
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (mode === "oversize" || mode === "prompt-budget")
          expect(result).toMatchObject({
            failure: { detail: "Pi required context exceeds transfer bounds" },
          });
        if (mode === "changed-provenance")
          expect(result).toMatchObject({
            failure: { detail: "Required context provenance changed before allocation" },
          });
        expect(allocations).toBe(0);
        expect(sessions).toBe(0);
        expect(f.transports).toBe(0);
        expect(
          yield* f.sql`SELECT operation_id FROM project_team_pi_operation WHERE operation_id=${mode === "prompt-budget" ? f.request.assignmentOperationId : f.request.initializeOperationId}`,
        ).toEqual([]);
      }),
    ),
  );

for (const readonlyKind of [undefined, "review"] as const)
  it.effect(
    `required context transfer qualifies the exact ${readonlyKind === undefined ? "planned" : "planless"} reviewer text and preserves terminal replay`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* requiredTransferFixture(true, readonlyKind !== undefined, readonlyKind);
          const required = yield* f.reader.readRequired(f.snapshot);
          let briefing = "";
          let runs = 0;
          let promptText: string | undefined;
          const original = SessionRuntime.makePiSessionRuntime;
          const sessionSpy = vi
            .spyOn(SessionRuntime, "makePiSessionRuntime")
            .mockImplementation((input) =>
              original(input).pipe(
                Effect.map((session) => ({
                  ...session,
                  run: () =>
                    Effect.gen(function* () {
                      if (input.operation.operationKind === "prompt") {
                        promptText = input.transferTexts.find(
                          (entry) => entry.transferId === "context",
                        )?.text;
                        return yield* new SessionRuntime.PiSessionRuntimeError({
                          code: "CONTROLLED_PROMPT_CONTEXT",
                        });
                      }
                      // Synthetic native metadata and terminal receipts exercise context qualification only.
                      // No OS owner, managed worker or model is acquired by this controlled session.
                      runs++;
                      const allocation = input.persistence.allocation;
                      const owner = {
                        type: "owner" as const,
                        unit: allocation.unit,
                        nonce: allocation.nonce,
                        invocation: "a".repeat(32),
                        cgroup: `/sys/fs/cgroup/${allocation.unit}`,
                        pid: 99999999,
                        memoryBytes: allocation.policy.memoryBytes,
                        swapBytes: 0,
                        oomGroup: 1,
                      };
                      yield* input.persistence.claimActivation(allocation);
                      yield* input.persistence.beforeStart(owner);
                      briefing =
                        input.transferTexts.find((entry) => entry.transferId === "context")?.text ??
                        "";
                      expect(briefing).toContain(required.text);
                      const native = {
                        sessionId: "required-review-session",
                        sessionReference: "sessions/required-review.jsonl",
                        leafId: "required-briefing",
                        persisted: true,
                      };
                      const state = allocation.launch.nativeStateRoot;
                      yield* f.fs.makeDirectory(state + "/sessions", { recursive: true });
                      yield* f.fs.writeFileString(
                        state + "/" + native.sessionReference,
                        [
                          {
                            type: "session",
                            version: 3,
                            id: native.sessionId,
                            timestamp: at,
                            cwd: "/workspace",
                          },
                          {
                            type: "message",
                            id: native.leafId,
                            parentId: null,
                            timestamp: at,
                            message: {
                              role: "user",
                              content: [{ type: "text", text: briefing }],
                              timestamp: Date.parse(at),
                            },
                          },
                        ]
                          .map((entry) => json(entry))
                          .join("\n") + "\n",
                      );
                      const signal = yield* Effect.abortSignal;
                      yield* Effect.tryPromise(() =>
                        input.persistNative(
                          {
                            version: 1,
                            ...input.identity,
                            ...input.operation,
                            sequence: 0,
                            message: { type: "initialized", native },
                          },
                          signal,
                        ),
                      );
                      const terminal: SessionRuntime.PiSessionTerminal = {
                        identity: input.identity,
                        operation: input.operation,
                        outcome: "success",
                        ownerCaptured: true,
                        native,
                        accountingReceipts: [],
                        drain: {
                          unit: owner.unit,
                          invocation: owner.invocation,
                          cgroup: owner.cgroup,
                          ownerPid: owner.pid,
                          memoryBytes: owner.memoryBytes,
                          swapBytes: 0,
                          oomGroup: 1,
                          launcherPid: 99999998,
                          childPid: 99999997,
                          childExitCode: 0,
                          kernel: "removed",
                        },
                      };
                      yield* Effect.tryPromise(() => input.persistTerminal(terminal, signal));
                      return terminal;
                    }).pipe(
                      Effect.mapError(
                        () =>
                          new SessionRuntime.PiSessionRuntimeError({
                            code: "CONTROLLED_CONTEXT_FAILURE",
                          }),
                      ),
                    ),
                })),
              ),
            );
          yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));
          const request = {
            threadId,
            kind: "initialize" as const,
            operationId: f.request.initializeOperationId,
          };
          const prepared = yield* f.instance.prepareOperation(request, () => Effect.void);
          expect((yield* prepared.run).terminal.outcome).toBe("success");
          const freshness = yield* f.sql<{
            manifest_json: string;
            native_jsonl: string;
          }>`SELECT manifest_json,native_jsonl FROM project_team_review_freshness`;
          expect(freshness).toHaveLength(1);
          const manifest = decodeRequiredJson(freshness[0]?.manifest_json);
          expect(manifest).toMatchObject({
            briefingSHA256: NodeCrypto.createHash("sha256").update(briefing).digest("hex"),
          });
          expect(freshness[0]?.native_jsonl).toContain(json(briefing));
          const state = yield* readCurrentState(f.sql, projectId);
          const gate = state.foundationRecords?.find(
            (record) =>
              record.kind === "gate" &&
              (readonlyKind === undefined
                ? record.gate === "plan"
                : record.recordId === f.binding.authorizationGateId),
          );
          if (gate?.kind !== "gate") return yield* Effect.die("Missing review question target");
          yield* f.repository.execute(
            yield* decodeRequiredFoundation({
              type: "project-work.foundation.commit",
              projectId,
              commandId: "required-review-question",
              expectedRevision: state.revision,
              attribution,
              committedAt: at,
              records: [
                {
                  kind: "question",
                  projectId,
                  recordId: "required-review-question",
                  revision: 0,
                  generation: 0,
                  updatedAt: at,
                  status: "pending",
                  taskId: f.binding.taskId,
                  senderId: f.binding.memberId,
                  targetGateId: gate.recordId,
                  targetRevision: gate.revision,
                  body: "New question after the completed review",
                  choices: [],
                },
              ],
            }),
          );
          expect(
            (yield* f.reader.readForOperation({
              projectId,
              bindingId: f.binding.recordId,
              generation: 0,
              providerInstanceId,
              threadId,
              operationId: request.operationId,
              operationKind: "initialize",
            })).text,
          ).toContain("New question after the completed review");
          let recaptures = 0;
          const originalReader = RequiredContext.makeProjectTeamContext;
          const readerSpy = vi
            .spyOn(RequiredContext, "makeProjectTeamContext")
            .mockImplementation((options) =>
              originalReader(options).pipe(
                Effect.map((reader) => ({
                  ...reader,
                  readForOperation: (input) =>
                    Effect.sync(() => {
                      recaptures++;
                    }).pipe(Effect.andThen(reader.readForOperation(input))),
                })),
              ),
            );
          yield* Effect.addFinalizer(() => Effect.sync(() => readerSpy.mockRestore()));
          const restarted = yield* makePiManagedRuntimeLive(f.options);
          const instance = yield* restarted.forInstance({
            instanceId: providerInstanceId,
            enabled: true,
            configuration: {},
          });
          const replay = yield* instance.prepareOperation(request, () =>
            Effect.die("Unexpected replay emission"),
          );
          expect((yield* replay.run).terminal.outcome).toBe("success");
          expect(recaptures).toBe(0);
          expect(runs).toBe(1);
          expect(
            yield* f.sql`SELECT manifest_json,native_jsonl FROM project_team_review_freshness`,
          ).toEqual(freshness);
          expect(f.transports).toBe(0);
          if (readonlyKind === "review") {
            const current = yield* f.reader.readForOperation({
              projectId,
              bindingId: f.binding.recordId,
              generation: 0,
              providerInstanceId,
              threadId,
              operationId: f.request.assignmentOperationId,
              operationKind: "prompt",
            });
            expect(current.required.tasks[0]?.plan).toBeUndefined();
            const prompt = yield* instance.prepareOperation(
              {
                threadId,
                kind: "prompt",
                operationId: f.request.assignmentOperationId,
                prompt: f.request.assignment,
              },
              () => Effect.void,
            );
            yield* prompt.run.pipe(Effect.result);
            expect(promptText).toContain(current.text);
            expect(promptText).toContain('"description":"Independent review findings"');
            expect(f.transports).toBe(0);
          }
        }),
      ),
  );
