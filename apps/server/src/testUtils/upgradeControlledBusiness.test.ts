// @effect-diagnostics nodeBuiltinImport:off -- Only synthetic SQL and caller-owned temporary fixtures are used.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as MemoryRuntime from "../assistants/AssistantMemoryRuntime.ts";
import * as DateTime from "effect/DateTime";
import { RunAdmission } from "../orchestration-v2/RunAdmission.ts";
import * as Stream from "effect/Stream";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ControlledProviderTranscript, controlledResponse } from "./upgradeControlledProviders.ts";
import { MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HttpClient from "effect/http/HttpClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { AssistantProvisioning } from "../assistants/AssistantProvisioning.ts";
import { AssistantRepository } from "../assistants/AssistantRepository.ts";
import { AssistantMemory } from "../assistants/AssistantMemory.ts";
import { AssistantSettledMemorySource } from "../assistants/AssistantMemorySources.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { controlledScmPaths, controlledScmCommitMessage } from "./upgradeControlledNative.ts";
import { AssistantService } from "../assistants/AssistantService.ts";
import { configuration } from "../assistants/AssistantTestHelpers.ts";
import { controlledProviderId, controlledProviderModel } from "./upgradeControlledProviders.ts";
import { EnvironmentId, CommandId } from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { prepareUpgradeSnapshot } from "./prepareUpgradeSnapshot.ts";
import { upgradeValidationBaseRuntime } from "./upgradeValidationRuntime.ts";
import { layerControlledBusiness } from "./upgradeControlledBusiness.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as WorktreeSetup from "../project/WorktreeSetupTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as OwnerDeadline from "../orchestration-v2/OwnerDeadlineControl.ts";
import * as Cleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

it.live("runs assistant chat, automatic memory and staged-only Git over a controlled fixture", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-controlled-business-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    NodeFS.mkdirSync(NodePath.join(root, "source"));
    const dbPath = NodePath.join(root, "source", "statev2.sqlite");
    const disposableRoot = NodePath.join(root, "disposable");
    NodeFS.mkdirSync(disposableRoot);
    yield* runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    const snapshot = yield* Effect.promise(() =>
      prepareUpgradeSnapshot({
        configured: { dbPath },
        disposableRoot,
        activeDatabasePaths: [dbPath],
      }),
    );
    const base = upgradeValidationBaseRuntime(snapshot);
    const externals = Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({}),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("External HTTP is disabled")),
      ),
      Layer.mock(TerminalManager.TerminalManager)({}),
      Layer.mock(OwnerDeadline.OwnerDeadlineControl)({}),
      Layer.mock(Cleanup.ResourceCleanupService)({}),
      Layer.succeed(Environment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture")),
        getDescriptor: Effect.die("unused"),
      }),
    );
    const infrastructure = Layer.mergeAll(
      AuthSessions.layer,
      WorkspacePaths.layer,
      WorktreeSetup.layer,
      externals,
    ).pipe(Layer.provideMerge(base));
    const processedMemory = yield* Deferred.make<void>();
    const observedMemory = Layer.effect(
      AssistantMemory,
      Effect.gen(function* () {
        const actual = yield* AssistantMemory;
        return AssistantMemory.of({
          ...actual,
          process: (key) =>
            actual
              .process(key)
              .pipe(Effect.tap(() => Deferred.succeed(processedMemory, undefined))),
        });
      }),
    ).pipe(Layer.provideMerge(layerControlledBusiness(snapshot)));
    const automatic = MemoryRuntime.workerLayer.pipe(Layer.provideMerge(observedMemory));
    yield* Effect.gen(function* () {
      const projects = yield* ProjectService;
      assert.deepEqual(yield* projects.listShells(), []);
      const assistants = yield* AssistantService;
      const created = yield* assistants.create({
        environmentId: EnvironmentId.make("fixture"),
        commandId: CommandId.make("controlled-create"),
        configuration: {
          ...configuration,
          modelSelection: { instanceId: controlledProviderId, model: controlledProviderModel },
        },
      });
      const provisioning = yield* AssistantProvisioning;
      const repository = yield* AssistantRepository;
      const ensured = yield* provisioning.ensure(yield* repository.get(created.summary));
      assert.equal(ensured.detail.summary.provisioningState, "ready");
      assert.equal((yield* projects.listShells()).length, 1);
      const idleTranscript = yield* ControlledProviderTranscript;
      assert.equal((yield* idleTranscript.turns).length, 0);
      assert.isFalse(yield* Deferred.isDone(processedMemory));
      const threads = yield* ThreadManagementService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sink = yield* EventSinkV2;
      const afterSequence = yield* sink.latestSequence();
      const dispatched = yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("controlled-chat"),
        threadId: created.summary.binding.canonicalThreadId,
        messageId: MessageId.make("controlled-message"),
        createdBy: "user",
        creationSource: "web",
        text: "Remember the project uses a blue release label",
        attachments: [],
        modelSelection: { instanceId: controlledProviderId, model: controlledProviderModel },
        dispatchMode: { type: "start_immediately" },
      });
      assert.include(
        dispatched.storedEvents.map(({ event }) => event.type),
        "run.created",
      );
      const admission = yield* RunAdmission;
      const beforeStart = yield* threads.getThreadProjection(
        created.summary.binding.canonicalThreadId,
      );
      const decision = yield* admission.check({
        threadId: created.summary.binding.canonicalThreadId,
        runId: beforeStart.runs[0]!.id,
        now: DateTime.formatIso(yield* DateTime.now),
        operation: "start",
      });
      assert.equal(decision._tag, "admitted", JSON.stringify(decision));
      yield* worker.drain();
      const terminal = yield* sink.stream({ afterSequence }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" &&
            ["waiting", "failed", "cancelled", "interrupted"].includes(event.payload.status),
        ),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.equal(terminal.length, 1);
      yield* worker.drain();
      assert.equal(
        terminal[0]?.event.type === "run.updated" ? terminal[0].event.payload.status : "missing",
        "waiting",
      );
      const transcript = yield* ControlledProviderTranscript;
      assert.equal((yield* transcript.turns).length, 1);
      const projection = yield* threads.getThreadProjection(
        created.summary.binding.canonicalThreadId,
      );
      assert.equal(projection.runs[0]?.status, "completed");
      assert.isTrue(projection.messages.some((message) => message.text === controlledResponse));
      const memory = yield* AssistantMemory;
      const sources = yield* AssistantSettledMemorySource;
      const evidence = yield* sources.forRun(
        created.summary.binding.canonicalThreadId,
        projection.runs[0]!.id,
      );
      assert.isNotNull(evidence);
      yield* Deferred.await(processedMemory);
      assert.include(
        (yield* memory.context(yield* repository.get(created.summary))).text,
        "blue release label",
      );
      const record = yield* repository.get(created.summary);
      const cwd = record.workspaceRoot!;
      NodeFS.writeFileSync(NodePath.join(cwd, controlledScmPaths[0]), "staged fixture\n");
      NodeFS.writeFileSync(NodePath.join(cwd, controlledScmPaths[1]), "unstaged fixture\n");
      const git = yield* GitWorkflowService;
      const status = yield* git.indexStatus({ cwd });
      assert.equal(status.unstaged.length, 2);
      const staged = yield* git.mutateIndex({
        cwd,
        action: "stage",
        paths: [controlledScmPaths[0]],
        expected: status.fingerprint,
      });
      assert.deepEqual(
        staged.staged.map((file) => file.path),
        [controlledScmPaths[0]],
      );
      const unstaged = yield* git.mutateIndex({
        cwd,
        action: "unstage",
        paths: [controlledScmPaths[0]],
        expected: staged.fingerprint,
      });
      assert.equal(unstaged.staged.length, 0);
      const reviewed = yield* git.mutateIndex({
        cwd,
        action: "stage",
        paths: [controlledScmPaths[0]],
        expected: unstaged.fingerprint,
      });
      const committed = yield* git.commitStaged({
        cwd,
        expected: reviewed.fingerprint,
        message: controlledScmCommitMessage,
        push: false,
      });
      assert.equal(committed.push, "not_requested");
      const afterCommit = yield* git.indexStatus({ cwd });
      assert.equal(afterCommit.staged.length, 0);
      assert.deepEqual(
        afterCommit.unstaged.map((file) => file.path),
        [controlledScmPaths[1]],
      );
      const history = yield* git.history({ cwd, limit: 10 });
      assert.equal(history.commits[0]?.subject, controlledScmCommitMessage);
      const diff = yield* git.historyDiff({
        cwd,
        commitSha: committed.commitSha,
        path: controlledScmPaths[0],
      });
      assert.include(diff.patch, "+staged fixture");
      assert.notInclude(diff.patch, "unstaged fixture");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const deniedIndex = yield* spawner
        .spawn(
          ChildProcess.make("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
            cwd,
            env: { GIT_INDEX_FILE: "/tmp/p21-outside-index" },
          }),
        )
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(deniedIndex));
      const configPath = NodePath.join(cwd, ".git", "config");
      const originalConfig = NodeFS.readFileSync(configPath, "utf8");
      NodeFS.appendFileSync(configPath, "\n[include]\n\tpath = /tmp/p21-untrusted-config\n");
      const deniedConfig = yield* spawner
        .spawn(ChildProcess.make("git", ["rev-parse", "--verify", "HEAD"], { cwd }))
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(deniedConfig));
      NodeFS.writeFileSync(configPath, originalConfig);
    }).pipe(
      Effect.provide(
        EffectWorker.layer
          .pipe(Layer.provideMerge(automatic))
          .pipe(Layer.provide(infrastructure), Layer.provide(NodeServices.layer)),
      ),
    );
  }).pipe(Effect.scoped),
);
