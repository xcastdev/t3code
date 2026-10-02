import { SkillCatalogRevision } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
import { makeProjectTeamPiOperations } from "../../projectWork/ProjectTeamPiOperations.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as Authorization from "../../projectWork/ProjectTeamAuthorization.ts";
import { ProjectWorkRepositoryLive } from "../../projectWork/ProjectWorkRepository.ts";
import { ProjectWorkQueryLive } from "../../projectWork/ProjectWorkQuery.ts";
import { ProjectWorkSearchLive } from "../../projectWork/ProjectWorkSearch.ts";
import { ProjectWorkNarrativeLive } from "../../projectWork/ProjectWorkNarrative.ts";
import { ProjectWorkBriefingLive } from "../../projectWork/ProjectWorkBriefing.ts";
import { ProjectWorkGatewayLive } from "../../projectWork/ProjectWorkGateway.ts";
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
const parseTransportBody = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
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
    protectedRoots: [protectedRoot, main],
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
